// Authoritative No-Limit Hold'em table. The server owns the deck and all hidden cards;
// each player is sent only what they are allowed to see (see viewFor).
const crypto = require('crypto');
const E = require('./engine.js');
const { BOTS, botDecide } = require('./bots');

const MAX_SEATS = 8;
const SPEED = Number(process.env.POKER_SPEED || 1); // tests set this below 1 to fast-forward every delay
const DELAY = { afterAction: 450, street: 900, runoutStreet: 2200, runoutRiver: 3600, showdown: 6500, foldWin: 3200, botMin: 900, botMax: 2200 };

function newDeck(){
  const d = Array.from({ length: 52 }, (_, i) => i);
  for(let i = 51; i > 0; i--){ const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

class Table {
  constructor(code, settings, onChange){
    this.code = code;
    this.settings = settings;       // { sb, bb, minBuyIn, maxBuyIn, turnSeconds, allowRebuy }
    this.pending = null;            // settings change waiting for the next hand
    this.onChange = onChange;       // called whenever every client should get a fresh view
    this.seats = new Array(MAX_SEATS).fill(null);
    this.players = new Map();       // id -> player
    this.adminId = null;
    this.status = 'waiting';        // waiting | playing | paused
    this.hand = null;
    this.handCount = 0;
    this.dealerSeat = -1;
    this.log = [];
    this.chat = [];
    this.timers = new Set();
    this.turnTimer = null;
    this.lastActivity = Date.now();
  }

  // ---------- helpers ----------
  later(ms, fn){ ms *= SPEED; const t = setTimeout(() => { this.timers.delete(t); try { fn(); } catch(e){ console.error(e); } }, ms); this.timers.add(t); return t; }
  destroy(){ for(const t of this.timers) clearTimeout(t); this.timers.clear(); clearTimeout(this.turnTimer); }
  addLog(text, kind = 'info'){ this.log.unshift({ t: Date.now(), text, kind }); if(this.log.length > 80) this.log.pop(); }
  changed(){ this.lastActivity = Date.now(); this.onChange(this); }
  seated(){ return this.seats.filter(Boolean); }
  humans(){ return [...this.players.values()].filter(p => !p.isBot); }
  inHand(){ return this.hand ? this.hand.order.map(s => this.seats[s]).filter(p => p && p.inHand) : []; }
  live(){ return this.inHand().filter(p => !p.folded); }
  canAct(){ return this.live().filter(p => !p.allIn); }
  potTotal(){ return this.seated().reduce((a, p) => a + (p.inHand ? p.committed : 0), 0) + (this.hand ? this.hand.deadMoney : 0); }

  nextSeat(from, pred){
    for(let i = 1; i <= MAX_SEATS; i++){
      const s = (from + i + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[s];
      if(p && pred(p)) return s;
    }
    return -1;
  }

  // ---------- people ----------
  addPlayer({ name, buyIn, isBot = false, bot = null, token = null }){
    // fill seats so players spread around the table instead of bunching on one side
    const seat = [0, 4, 2, 6, 1, 5, 3, 7].find(i => !this.seats[i]) ?? -1;
    if(seat < 0) throw new Error('The table is full (8 seats).');
    const id = crypto.randomUUID();
    const p = {
      id, token: token || crypto.randomBytes(16).toString('hex'), name, isBot, bot,
      chips: buyIn, buyInTotal: buyIn, seat, connected: true, sittingOut: false,
      leaving: false, inHand: false, folded: false, allIn: false, hole: [], bet: 0, committed: 0,
      lastAction: null, shown: false, joinedAt: Date.now()
    };
    this.seats[seat] = p;
    this.players.set(id, p);
    if(!this.adminId && !isBot) this.adminId = id;
    this.addLog(`${name} sat down with ${buyIn.toLocaleString()} chips.`, 'join');
    this.maybeStart();
    return p;
  }

  removePlayer(id, reason = 'left'){
    const p = this.players.get(id);
    if(!p) return;
    if(this.hand && p.inHand && !p.folded){
      p.leaving = true;
      if(this.hand.actingSeat === p.seat) this.act(p.id, { type: 'fold' }, true);
      else { p.folded = true; p.lastAction = 'Fold'; this.addLog(`${p.name} folded and ${reason}.`); this.afterFoldOutOfTurn(); }
      if(this.hand && p.inHand) return; // removed when the hand ends
    }
    this.seats[p.seat] = null;
    this.players.delete(id);
    this.addLog(`${p.name} ${reason} (net ${fmtNet(p.chips - p.buyInTotal)}).`, 'leave');
    if(this.adminId === id){
      const next = this.humans().sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.adminId = next ? next.id : null;
      if(next) this.addLog(`${next.name} is now the host.`);
    }
  }

  // A player folded without it being their turn (left or kicked): the hand may now be over.
  afterFoldOutOfTurn(){
    if(this.live().length <= 1) { clearTimeout(this.turnTimer); this.later(DELAY.afterAction, () => this.advance()); }
  }

  // ---------- settings & control (host only, checked by the server) ----------
  updateSettings(s){
    const next = { ...this.settings, ...s };
    validateSettings(next);
    if(this.hand){ this.pending = next; this.addLog('New table settings will apply from the next hand.'); }
    else { this.settings = next; this.addLog(`Blinds are ${next.sb}/${next.bb}.`); }
  }
  start(){ if(this.status !== 'playing'){ this.status = 'playing'; this.addLog('The host started the game.'); this.maybeStart(); } }
  pause(){ if(this.status === 'playing'){ this.status = 'paused'; this.addLog(this.hand ? 'The game will pause after this hand.' : 'The game is paused.'); } }

  maybeStart(){
    if(this.status === 'playing' && !this.hand && !this.startPending && this.eligible().length >= 2){
      this.startPending = true;
      this.later(1200, () => { this.startPending = false; this.startHand(); this.changed(); });
    }
  }
  eligible(){ return this.seated().filter(p => p.chips > 0 && !p.sittingOut && !p.leaving && (p.isBot || p.connected)); }

  // ---------- the hand ----------
  startHand(){
    if(this.pending){ this.settings = this.pending; this.pending = null; this.addLog(`Blinds are now ${this.settings.sb}/${this.settings.bb}.`); }
    // players who busted with no rebuy, or who left mid-hand, are cleaned up here
    for(const p of this.seated()) if(p.leaving) this.removePlayer(p.id, 'left');
    const players = this.eligible();
    if(this.status !== 'playing' || players.length < 2){ this.hand = null; return; }

    const isIn = p => players.includes(p);
    this.dealerSeat = this.nextSeat(this.dealerSeat, isIn);
    const headsUp = players.length === 2;
    const sbSeat = headsUp ? this.dealerSeat : this.nextSeat(this.dealerSeat, isIn);
    const bbSeat = this.nextSeat(sbSeat, isIn);
    const order = [];
    for(let s = this.nextSeat(this.dealerSeat, isIn), n = 0; n < players.length; s = this.nextSeat(s, isIn), n++) order.push(s);

    for(const p of this.seated()){
      Object.assign(p, { inHand: isIn(p), folded: false, allIn: false, hole: [], bet: 0, committed: 0, lastAction: null, shown: false });
    }
    const deck = newDeck();
    this.handCount++;
    this.hand = {
      id: this.handCount, deck, board: [], street: 'preflop', order, sbSeat, bbSeat,
      currentBet: 0, minRaise: this.settings.bb, acted: new Set(), actingSeat: -1, turnDeadline: 0,
      deadMoney: 0, result: null, runout: false, dramatic: false, startedAt: Date.now()
    };
    for(let r = 0; r < 2; r++) for(const s of order) this.seats[s].hole.push(deck.pop());

    this.post(this.seats[sbSeat], this.settings.sb, 'Small blind');
    this.post(this.seats[bbSeat], this.settings.bb, 'Big blind');
    this.hand.currentBet = this.settings.bb;
    this.addLog(`Hand #${this.hand.id} — ${this.seats[this.dealerSeat].name} has the button.`, 'hand');

    const first = headsUp ? sbSeat : this.nextSeat(bbSeat, p => p.inHand && !p.allIn);
    // give the deal animation time to play before the first decision
    this.hand.actingSeat = -1;
    this.later(1400 + 160 * order.length, () => { this.setTurn(first); this.changed(); });
  }

  post(p, amount, label){
    const a = Math.min(amount, p.chips);
    p.chips -= a; p.bet += a; p.committed += a;
    if(p.chips === 0) p.allIn = true;
    p.lastAction = label;
  }

  setTurn(seat){
    const h = this.hand;
    const p = this.seats[seat];
    if(!h || !p || !p.inHand || p.folded || p.allIn){ this.advance(); return; }
    h.actingSeat = seat;
    h.turnDeadline = Date.now() + this.settings.turnSeconds * 1000;
    clearTimeout(this.turnTimer);
    const handId = h.id;
    this.turnTimer = setTimeout(() => {
      if(!this.hand || this.hand.id !== handId || this.hand.actingSeat !== seat) return;
      const toCall = this.hand.currentBet - p.bet;
      this.addLog(`${p.name} ran out of time.`);
      this.act(p.id, { type: toCall > 0 ? 'fold' : 'check' }, true);
      this.changed();
    }, (this.settings.turnSeconds * 1000 + 300) * SPEED);
    if(p.isBot || (!p.connected && !p.isBot)){
      // bots think for a moment; a disconnected person gets 10 s to come back before auto check/fold
      const wait = p.isBot ? DELAY.botMin + Math.random() * (DELAY.botMax - DELAY.botMin) : Math.min(10000, this.settings.turnSeconds * 1000);
      this.later(wait, () => {
        if(!this.hand || this.hand.id !== handId || this.hand.actingSeat !== seat) return;
        if(!p.isBot && p.connected) return;   // they came back in time
        const d = p.isBot ? botDecide(this, p) : { type: (this.hand.currentBet - p.bet) > 0 ? 'fold' : 'check' };
        try { this.act(p.id, d, true); } catch(e){ this.act(p.id, { type: (this.hand.currentBet - p.bet) > 0 ? 'fold' : 'check' }, true); }
        this.changed();
      });
    }
  }

  // Legal options for the player whose turn it is.
  options(p){
    const h = this.hand;
    if(!h || h.actingSeat !== p.seat) return null;
    const toCall = Math.min(h.currentBet - p.bet, p.chips);
    const maxTo = p.bet + p.chips;
    const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
    const othersCanAct = this.canAct().some(o => o !== p);
    return {
      toCall, canCheck: toCall === 0, canRaise: maxTo > h.currentBet && othersCanAct,
      minRaiseTo: minTo, maxRaiseTo: maxTo, pot: this.potTotal(), currentBet: h.currentBet, myBet: p.bet
    };
  }

  act(playerId, action, internal = false){
    const h = this.hand;
    const p = this.players.get(playerId);
    if(!h || !p || h.actingSeat !== p.seat) throw new Error("It isn't your turn.");
    const o = this.options(p);
    const type = action.type;
    if(type === 'fold'){
      p.folded = true; p.lastAction = 'Fold';
      this.addLog(`${p.name} folds.`);
    } else if(type === 'check'){
      if(!o.canCheck) throw new Error('You must call, raise or fold.');
      p.lastAction = 'Check';
      this.addLog(`${p.name} checks.`);
    } else if(type === 'call'){
      if(o.toCall === 0) { p.lastAction = 'Check'; this.addLog(`${p.name} checks.`); }
      else {
        this.post(p, o.toCall, 'Call');
        if(p.allIn) p.lastAction = 'All-in';
        this.addLog(`${p.name} calls ${o.toCall.toLocaleString()}${p.allIn ? ' and is all-in' : ''}.`);
      }
    } else if(type === 'raise'){
      if(!o.canRaise) throw new Error("You can't raise here.");
      let to = Math.floor(Number(action.amount));
      if(!Number.isFinite(to)) throw new Error('Choose a raise amount.');
      to = Math.min(to, o.maxRaiseTo);
      if(to < o.minRaiseTo) throw new Error(`The minimum raise is to ${o.minRaiseTo.toLocaleString()}.`);
      const increment = to - h.currentBet;
      const wasBet = h.currentBet === 0;
      this.post(p, to - p.bet, 'Raise');
      if(increment >= h.minRaise){ h.minRaise = increment; h.acted = new Set(); }  // a full raise reopens the betting
      h.currentBet = to;
      p.lastAction = p.allIn ? 'All-in' : (wasBet ? 'Bet' : 'Raise');
      this.addLog(`${p.name} ${p.allIn ? 'goes all-in for' : wasBet ? 'bets' : 'raises to'} ${to.toLocaleString()}.`, 'bet');
    } else throw new Error('Unknown action.');
    h.acted.add(p.seat);
    h.lastActorSeat = p.seat;
    clearTimeout(this.turnTimer);
    h.actingSeat = -1;
    this.later(DELAY.afterAction, () => { this.advance(); this.changed(); });
  }

  advance(){
    const h = this.hand;
    if(!h || h.result) return;
    const live = this.live();
    if(live.length === 1) return this.finishUncontested(live[0]);
    const canAct = this.canAct();
    const needs = p => !h.acted.has(p.seat) || p.bet < h.currentBet;
    const pendingPlayers = canAct.filter(needs);
    const roundOver = pendingPlayers.length === 0 || (canAct.length === 1 && canAct[0].bet >= h.currentBet);
    if(!roundOver){
      // next player after the last actor, in seat order
      const from = h.lastActorSeat != null ? h.lastActorSeat : (h.street === 'preflop' ? h.bbSeat : this.dealerSeat);
      const next = this.nextSeat(from, p => p.inHand && !p.folded && !p.allIn && needs(p));
      return this.setTurn(next);
    }
    // betting round complete
    for(const p of this.inHand()){ p.bet = 0; if(!p.folded && !p.allIn && h.street !== 'river') p.lastAction = null; }
    h.currentBet = 0; h.minRaise = this.settings.bb; h.acted = new Set(); h.lastActorSeat = null;
    if(h.street === 'river') return this.showdown();

    const runout = canAct.length <= 1;
    if(runout && !h.runout){
      h.runout = true;
      for(const p of live) p.shown = true;     // everyone all-in: cards go face up
      this.addLog('All-in — the cards are turned face up.', 'bet');
    }
    const nextStreet = h.street === 'preflop' ? 'flop' : h.street === 'flop' ? 'turn' : 'river';
    const wait = runout ? (nextStreet === 'river' ? DELAY.runoutRiver : DELAY.runoutStreet) : DELAY.street;
    h.streetPending = nextStreet;
    this.later(wait, () => {
      if(!this.hand || this.hand.id !== h.id || h.result) return;
      h.streetPending = null;
      h.deck.pop(); // burn
      const n = nextStreet === 'flop' ? 3 : 1;
      for(let i = 0; i < n; i++) h.board.push(h.deck.pop());
      h.street = nextStreet;
      h.dramatic = runout && nextStreet === 'river';
      this.addLog(`${nextStreet[0].toUpperCase() + nextStreet.slice(1)}: ${h.board.map(cardText).join(' ')}`, 'board');
      if(runout){ this.later(nextStreet === 'flop' ? 2200 : 1600, () => { this.advance(); this.changed(); }); }
      else {
        const first = this.nextSeat(this.dealerSeat, p => p.inHand && !p.folded && !p.allIn);
        this.later(nextStreet === 'flop' ? 1300 : 900, () => { this.setTurn(first); this.changed(); });
      }
      this.changed();
    });
  }

  finishUncontested(winner){
    const h = this.hand;
    clearTimeout(this.turnTimer);
    const pot = this.potTotal();
    // the uncalled part of the last bet simply returns, which the layer split below does automatically
    const payouts = this.splitPots();
    for(const [id, amt] of payouts) this.players.get(id).chips += amt;
    const amount = this.lastWon.get(winner.id) || 0;
    h.result = { uncontested: true, winners: [{ id: winner.id, seat: winner.seat, amount, hand: null }], pot };
    this.addLog(`${winner.name} wins ${amount.toLocaleString()} — everyone else folded.`, 'win');
    h.actingSeat = -1;
    this.endHand(DELAY.foldWin);
  }

  showdown(){
    const h = this.hand;
    clearTimeout(this.turnTimer);
    const live = this.live();
    for(const p of live){ p.shown = true; p.score = E.eval7i(p.hole[0], p.hole[1], ...h.board); p.handName = E.handName(p.score); }
    const pot = this.potTotal();
    const payouts = this.splitPots();
    for(const [id, amt] of payouts) this.players.get(id).chips += amt;
    const winners = [...this.lastWon.entries()].filter(([id, amt]) => this.players.get(id) && !this.players.get(id).folded && amt > 0)
      .map(([id, amount]) => { const p = this.players.get(id); return { id, seat: p.seat, amount, hand: p.handName }; });
    h.result = { uncontested: false, winners, pot, hands: live.map(p => ({ seat: p.seat, hand: p.handName })) };
    for(const p of live) this.addLog(`${p.name} shows ${p.hole.map(cardText).join(' ')} — ${p.handName}.`);
    for(const w of winners) this.addLog(`${this.players.get(w.id).name} wins ${w.amount.toLocaleString()} with ${w.hand}.`, 'win');
    h.actingSeat = -1;
    this.endHand(DELAY.showdown);
  }

  // Side-pot aware split: each contribution level is a layer; only live players who paid into
  // a layer can win it; a layer nobody live paid into goes back to whoever paid it.
  splitPots(){
    const contributors = this.inHand().filter(p => p.committed > 0);
    const levels = [...new Set(contributors.map(p => p.committed))].sort((a, b) => a - b);
    const payouts = new Map();   // everything each player receives (chips)
    const won = new Map();       // the part that was actually won from others (for the banner)
    const add = (id, a, contested = true) => { payouts.set(id, (payouts.get(id) || 0) + a); if(contested) won.set(id, (won.get(id) || 0) + a); };
    let prev = 0;
    for(const level of levels){
      const size = level - prev; prev = level;
      const payers = contributors.filter(p => p.committed >= level);
      const amount = size * payers.length;
      const eligible = payers.filter(p => !p.folded);
      if(eligible.length === 0){ for(const p of payers) add(p.id, size, false); continue; }
      if(eligible.length === 1){ add(eligible[0].id, amount, payers.length > 1); continue; }  // a layer only one player paid = returned bet
      const best = Math.max(...eligible.map(p => p.score));
      const winners = eligible.filter(p => p.score === best)
        .sort((a, b) => ((a.seat - this.dealerSeat + MAX_SEATS) % MAX_SEATS) - ((b.seat - this.dealerSeat + MAX_SEATS) % MAX_SEATS));
      const share = Math.floor(amount / winners.length);
      let rem = amount - share * winners.length;   // odd chips go to the first winners left of the button
      for(const w of winners){ add(w.id, share + (rem > 0 ? 1 : 0)); rem--; }
    }
    if(this.hand.deadMoney && payouts.size){ const first = payouts.keys().next().value; add(first, this.hand.deadMoney); }
    this.lastWon = won;
    return payouts;
  }

  endHand(wait){
    const h = this.hand;
    for(const p of this.seated()){
      if(p.chips === 0 && p.inHand && !p.isBot){ p.sittingOut = true; this.addLog(`${p.name} is out of chips${this.settings.allowRebuy ? ' and can rebuy' : ''}.`); }
      if(p.chips === 0 && p.isBot){ p.leaving = true; }
    }
    this.later(wait, () => {
      if(!this.hand || this.hand.id !== h.id) return;
      for(const p of this.seated()){ p.inHand = false; p.hole = []; p.bet = 0; p.committed = 0; p.folded = false; p.allIn = false; p.shown = false; p.lastAction = null; }
      for(const p of this.seated()) if(p.leaving) this.removePlayer(p.id, p.isBot ? 'left the table' : 'left');
      this.hand = null;
      if(this.status === 'paused') this.addLog('The game is paused.');
      this.maybeStart();
      this.changed();
    });
  }

  // ---------- player utilities ----------
  rebuy(id, amount){
    const p = this.players.get(id);
    if(!p) return;
    if(this.hand && p.inHand) throw new Error('You can top up between hands.');
    if(!this.settings.allowRebuy) throw new Error('The host has turned rebuys off.');
    amount = Math.floor(Number(amount));
    const room = this.settings.maxBuyIn - p.chips;
    if(!(amount > 0) || amount > room) throw new Error(`You can add up to ${Math.max(0, room).toLocaleString()} chips.`);
    p.chips += amount; p.buyInTotal += amount; p.sittingOut = false;
    this.addLog(`${p.name} added ${amount.toLocaleString()} chips.`, 'join');
    this.maybeStart();
  }
  setSittingOut(id, v){
    const p = this.players.get(id);
    if(!p) return;
    if(!v && p.chips === 0) throw new Error('Add chips before sitting back in.');
    p.sittingOut = !!v;
    this.addLog(`${p.name} ${v ? 'is sitting out' : 'is back in'}.`);
    if(!v) this.maybeStart();
  }
  addBot(){
    const used = new Set(this.seated().filter(p => p.isBot).map(p => p.bot.id));
    const bot = BOTS.find(b => !used.has(b.id)) || BOTS[Math.floor(Math.random() * BOTS.length)];
    const buyIn = Math.round((this.settings.minBuyIn + this.settings.maxBuyIn) / 2);
    return this.addPlayer({ name: bot.name, buyIn, isBot: true, bot });
  }

  // ---------- what each person sees ----------
  viewFor(viewerId){
    const h = this.hand;
    const me = this.players.get(viewerId);
    const showAll = h && h.result && !h.result.uncontested;
    const seats = this.seats.map((p, i) => {
      if(!p) return null;
      let cards = null;
      if(p.inHand && p.hole.length){
        if(p.id === viewerId || p.shown || (showAll && !p.folded)) cards = p.hole;
        else if(!p.folded) cards = ['back', 'back'];
      }
      return {
        seat: i, id: p.id, name: p.name, chips: p.chips, bet: p.bet, inHand: p.inHand, folded: p.folded, allIn: p.allIn,
        isBot: p.isBot, botStyle: p.bot ? p.bot.style : null, connected: p.connected, sittingOut: p.sittingOut,
        lastAction: p.lastAction, cards, handName: (p.shown || showAll) && p.handName && !p.folded ? p.handName : null,
        net: p.chips + (p.inHand ? p.committed : 0) - p.buyInTotal, buyInTotal: p.buyInTotal, isAdmin: p.id === this.adminId
      };
    });
    return {
      code: this.code, you: viewerId, youSeat: me ? me.seat : -1, isAdmin: viewerId === this.adminId,
      settings: this.settings, pendingSettings: this.pending, status: this.status, seats,
      hand: h ? {
        id: h.id, board: h.board, street: h.street, dealerSeat: this.dealerSeat, sbSeat: h.sbSeat, bbSeat: h.bbSeat,
        pot: this.potTotal(), potBehind: this.potTotal() - this.inHand().reduce((a, p) => a + p.bet, 0),
        currentBet: h.currentBet, actingSeat: h.actingSeat,
        turnMsLeft: h.actingSeat >= 0 ? Math.max(0, h.turnDeadline - Date.now()) : 0, turnMs: this.settings.turnSeconds * 1000,
        runout: h.runout, dramatic: h.dramatic, streetPending: h.streetPending || null, result: h.result,
        liveOpponents: me && me.inHand && !me.folded ? this.live().length - 1 : 0
      } : null,
      options: me && h ? this.options(me) : null,
      log: this.log.slice(0, 40), chat: this.chat.slice(-40),
      serverTime: Date.now()
    };
  }
}

function cardText(c){ return '23456789TJQKA'[c >> 2] + '♠♥♦♣'[c & 3]; }
function fmtNet(n){ return (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString(); }
function validateSettings(s){
  const ints = ['sb', 'bb', 'minBuyIn', 'maxBuyIn', 'turnSeconds'];
  for(const k of ints){ s[k] = Math.floor(Number(s[k])); if(!Number.isFinite(s[k]) || s[k] <= 0) throw new Error('Settings must be positive whole numbers.'); }
  if(s.sb > s.bb) throw new Error('The small blind can’t be bigger than the big blind.');
  if(s.minBuyIn > s.maxBuyIn) throw new Error('Minimum buy-in must be at most the maximum.');
  if(s.minBuyIn < s.bb * 2) throw new Error('Minimum buy-in must be at least 2 big blinds.');
  if(s.turnSeconds < 10 || s.turnSeconds > 120) throw new Error('Turn time must be between 10 and 120 seconds.');
  if(s.maxBuyIn > 100000000) throw new Error('That buy-in is too large.');
  s.allowRebuy = !!s.allowRebuy;
  return s;
}

module.exports = { Table, validateSettings, MAX_SEATS };
