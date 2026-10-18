// Authoritative No-Limit Hold'em table. The server owns the deck and all hidden cards;
// each player is sent only what they are allowed to see (see viewFor).
const crypto = require('crypto');
const E = require('./engine.js');
const { BOTS, botDecide } = require('./bots');

const MAX_SEATS = 10;
const SPEED = Number(process.env.POKER_SPEED || 1); // tests set this below 1 to fast-forward every delay
const DELAY = { afterAction: 250, street: 400, runoutStreet: 1200, runoutRiver: 1300, showdown: 4200, foldWin: 1900, botMin: 600, botMax: 1500 };
const SEAT_ORDER = [0, 5, 3, 8, 1, 6, 2, 7, 4, 9]; // fill seats so players spread around the table

// Everything the host can change, with defaults.
const DEFAULT_SETTINGS = {
  maxPlayers: 10,
  sb: 10, bb: 20, ante: 0,
  blindUpMinutes: 0,        // 0 = blinds never go up; otherwise they double every N minutes
  timerOn: true, turnSeconds: 30, timeBank: 30,
  defaultBuyIn: 2000,       // suggested amount when someone asks for chips
  runItTwice: false, rabbitHunt: true, muckLosers: false,
  bombEvery: 0, bombBB: 2,  // bomb pot every N hands (0 = off), each player puts in N big blinds
  autoDeal: true,           // deal the next hand automatically, or wait for the host
};

function newDeck(){
  const d = Array.from({ length: 52 }, (_, i) => i);
  for(let i = 51; i > 0; i--){ const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

class Table {
  constructor(code, settings, onChange){
    this.code = code;
    this.settings = settings;
    this.pending = null;            // settings change waiting for the next hand
    this.onChange = onChange;
    this.seats = new Array(MAX_SEATS).fill(null);
    this.players = new Map();       // id -> player
    this.requests = [];             // chip requests waiting for the host
    this.adminId = null;
    this.status = 'waiting';        // waiting | playing | paused
    this.hand = null;
    this.handCount = 0;
    this.dealerSeat = -1;
    this.level = 1;
    this.levelStartedAt = 0;
    this.bombNext = false;
    this.log = [];
    this.chat = [];
    this.timers = new Set();
    this.turnTimer = null;
    this.lastActivity = Date.now();
    this.createdAt = Date.now();
    this.gameKey = `${code}-${this.createdAt}`;
    this.onHand = null;     // (table, records) — set by the server to save hand history
    this.onLeave = null;    // (table, member) — final totals of someone leaving
  }

  // ---------- helpers ----------
  later(ms, fn){ ms *= SPEED; const t = setTimeout(() => { this.timers.delete(t); try { fn(); } catch(e){ console.error(e); } }, ms); this.timers.add(t); return t; }
  destroy(){ for(const t of this.timers) clearTimeout(t); this.timers.clear(); clearTimeout(this.turnTimer); }
  addLog(text, kind = 'info'){ this.log.unshift({ t: Date.now(), text, kind }); if(this.log.length > 120) this.log.pop(); }
  changed(){ this.lastActivity = Date.now(); this.onChange(this); }
  seated(){ return this.seats.filter(Boolean); }
  humans(){ return [...this.players.values()].filter(p => !p.isBot && p.approved); }
  inHand(){ return this.hand ? this.hand.order.map(s => this.seats[s]).filter(p => p && p.inHand) : []; }
  live(){ return this.inHand().filter(p => !p.folded); }
  canAct(){ return this.live().filter(p => !p.allIn); }
  potTotal(){ return this.inHand().reduce((a, p) => a + p.committed, 0); }
  handLive(){ return this.hand && !this.hand.result; }

  nextSeat(from, pred){
    for(let i = 1; i <= MAX_SEATS; i++){
      const s = (from + i + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[s];
      if(p && pred(p)) return s;
    }
    return -1;
  }

  // ---------- people ----------
  // Everyone in the room is a member. Members sit at the table with chips bought in from
  // their wallet, which only the admin can fill.
  addMember({ name, isBot = false, bot = null, approved = true, userId = null }){
    if(this.players.size >= 40) throw new Error('This game is full.');
    const id = crypto.randomUUID();
    const p = {
      id, token: crypto.randomBytes(16).toString('hex'), name, isBot, bot,
      wallet: 0, chips: 0, buyInTotal: 0, pendingChips: 0, seat: -1, connected: true, sittingOut: false,
      leaving: false, standing: false, inHand: false, folded: false, allIn: false, hole: [], bet: 0, committed: 0,
      lastAction: null, shown: false, bank: this.settings.timeBank, handsPlayed: 0, joinedAt: Date.now(), approved,
      userId, handsWon: 0, biggestPot: 0, startStack: 0
    };
    this.players.set(id, p);
    if(!this.adminId && !isBot && approved) this.adminId = id;
    if(!isBot) this.addLog(approved ? `${name} joined the game.` : `${name} is asking to join.`, 'join');
    return p;
  }
  // Everyone who joins with the code waits until the admin lets them in.
  admit(id){
    const p = this.players.get(id);
    if(!p || p.approved) throw new Error('That request is no longer open.');
    p.approved = true; p.joinedAt = Date.now();
    this.addLog(`${p.name} joined the game.`, 'join');
  }
  reject(id){
    const p = this.players.get(id);
    if(!p || p.approved) return;
    this.players.delete(id);
    this.addLog(`The admin declined ${p.name}'s request to join.`);
  }

  // Take a seat with chips from the wallet.
  sit(id, seat, amount){
    const p = this.players.get(id);
    if(!p) throw new Error('You are not in this game.');
    if(!p.approved) throw new Error('The admin has not let you in yet.');
    if(p.seat >= 0) throw new Error('You already have a seat.');
    if(this.seated().length >= this.settings.maxPlayers) throw new Error(`The table is full (${this.settings.maxPlayers} seats).`);
    seat = seat == null || seat < 0 ? SEAT_ORDER.find(i => !this.seats[i]) : Math.floor(Number(seat));
    if(!(seat >= 0 && seat < MAX_SEATS) || this.seats[seat]) throw new Error('That seat is taken.');
    amount = Math.floor(Number(amount));
    if(!(amount > 0)) throw new Error('Enter a buy-in amount.');
    if(amount > p.wallet) throw new Error(`Your wallet has ${p.wallet.toLocaleString()} chips. Ask the admin for more.`);
    p.wallet -= amount; p.chips = amount; p.seat = seat; p.sittingOut = false; p.standing = false; p.leaving = false;
    this.seats[seat] = p;
    this.addLog(`${p.name} sat down with ${amount.toLocaleString()}.`, 'join');
    this.maybeStart();
  }

  // Leave the seat; the stack goes back to the wallet (after the hand if they are in one).
  standUp(id){
    const p = this.players.get(id);
    if(!p || p.seat < 0) return;
    if(this.handLive() && p.inHand && !p.folded){
      p.standing = true;
      if(this.hand.actingSeat === p.seat) this.act(p.id, { type: 'fold' }, true);
      else { p.folded = true; p.lastAction = 'Fold'; this.addLog(`${p.name} folded.`); this.afterFoldOutOfTurn(); }
      return;
    }
    if(this.hand && p.inHand){ p.standing = true; return; }
    this.vacate(p);
  }
  vacate(p){
    this.seats[p.seat] = null;
    p.wallet += p.chips + p.pendingChips; p.chips = 0; p.pendingChips = 0;
    p.seat = -1; p.standing = false; p.sittingOut = false;
    if(!p.leaving) this.addLog(`${p.name} stood up.`);
  }

  // Leave the game entirely (or removed by the admin).
  removePlayer(id, reason = 'left'){
    const p = this.players.get(id);
    if(!p) return;
    this.requests = this.requests.filter(r => r.playerId !== id);
    if(!p.approved){ this.players.delete(id); return; }
    p.leaving = true;
    if(p.seat >= 0){
      this.standUp(id);
      if(p.seat >= 0) return;   // still in a hand: finished when it ends
    }
    if(this.onLeave) try { this.onLeave(this, p); } catch(e){ console.error(e); }
    this.players.delete(id);
    if(!p.isBot) this.addLog(`${p.name} ${reason} (net ${fmtNet(p.wallet - p.buyInTotal)}).`, 'leave');
    if(this.adminId === id){
      const next = this.humans().sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.adminId = next ? next.id : null;
      if(next) this.addLog(`${next.name} is now the admin.`);
    }
  }
  afterFoldOutOfTurn(){
    if(this.live().length <= 1){ clearTimeout(this.turnTimer); this.later(DELAY.afterAction, () => { this.advance(); this.changed(); }); }
  }

  // ---------- chips: only the admin fills wallets ----------
  requestChips(id, amount){
    const p = this.players.get(id);
    if(!p || !p.approved) throw new Error('The admin has not let you in yet.');
    amount = Math.floor(Number(amount));
    if(!(amount > 0) || amount > 1e9) throw new Error('Ask for a positive number of chips.');
    this.requests = this.requests.filter(r => r.playerId !== id);
    this.requests.push({ id: crypto.randomUUID(), playerId: id, amount, t: Date.now() });
    this.addLog(`${p.name} asked the admin for ${amount.toLocaleString()} chips.`, 'join');
  }
  cancelRequest(id){ this.requests = this.requests.filter(r => r.playerId !== id); }
  give(playerId, amount, via = 'gave'){
    const p = this.players.get(playerId);
    if(!p) throw new Error('That player has left.');
    amount = Math.floor(Number(amount));
    if(!(amount > 0) || amount > 1e9) throw new Error('Enter a positive number of chips.');
    p.wallet += amount; p.buyInTotal += amount;
    if(!p.isBot) this.addLog(`The admin ${via} ${p.name} ${amount.toLocaleString()} chips.`, 'join');
    this.requests = this.requests.filter(r => r.playerId !== playerId);
  }
  take(playerId, amount){
    const p = this.players.get(playerId);
    if(!p) throw new Error('That player has left.');
    amount = Math.floor(Number(amount));
    if(!(amount > 0) || amount > p.wallet) throw new Error(`${p.name}'s wallet has ${p.wallet.toLocaleString()} chips${p.seat >= 0 ? ' (chips on the table must be stood up first)' : ''}.`);
    p.wallet -= amount; p.buyInTotal -= amount;   // counts as cashing out, so net stays right
    this.addLog(`The admin took ${amount.toLocaleString()} chips back from ${p.name}.`, 'leave');
  }
  // Move wallet chips onto the table stack (arrives after the hand if they're in one).
  topUp(id, amount){
    const p = this.players.get(id);
    if(!p || p.seat < 0) throw new Error('Take a seat first.');
    amount = Math.floor(Number(amount));
    if(!(amount > 0)) throw new Error('Enter an amount.');
    if(amount > p.wallet) throw new Error(`Your wallet has ${p.wallet.toLocaleString()} chips. Ask the admin for more.`);
    p.wallet -= amount;
    if(this.handLive() && p.inHand) p.pendingChips += amount; else p.chips += amount;
    p.sittingOut = false;
    this.addLog(`${p.name} added ${amount.toLocaleString()} chips to their stack.`, 'join');
    this.maybeStart();
  }
  approve(requestId, amount){
    const r = this.requests.find(x => x.id === requestId);
    if(!r) throw new Error('That request is no longer open.');
    this.give(r.playerId, amount != null ? amount : r.amount, 'approved');
  }
  deny(requestId){
    const r = this.requests.find(x => x.id === requestId);
    if(!r) return;
    this.requests = this.requests.filter(x => x !== r);
    const p = this.players.get(r.playerId);
    if(p) this.addLog(`The host declined ${p.name}'s chip request.`);
  }

  // ---------- settings & control (host only, checked by the server) ----------
  updateSettings(s){
    const next = validateSettings({ ...(this.pending || this.settings), ...s });
    if(this.hand){ this.pending = next; this.addLog('New table settings apply from the next hand.'); }
    else this.applySettings(next);
  }
  applySettings(next){
    const old = this.settings;
    this.settings = next;
    if(next.sb !== old.sb || next.bb !== old.bb || next.ante !== old.ante || next.blindUpMinutes !== old.blindUpMinutes){ this.levelStartedAt = Date.now(); this.level = 1; }
    if(next.timeBank !== old.timeBank) for(const p of this.seated()) p.bank = next.timeBank;
    this.addLog(`Settings updated: blinds ${next.sb}/${next.bb}${next.ante ? `, ante ${next.ante}` : ''}${next.timerOn ? `, ${next.turnSeconds}s turns` : ', no turn timer'}.`);
  }
  start(){
    if(this.status === 'playing') return;
    if(!this.levelStartedAt) this.levelStartedAt = Date.now();
    this.status = 'playing'; this.addLog('The admin started the game.');
    this.maybeStart(true);
  }
  pause(){ if(this.status === 'playing'){ this.status = 'paused'; this.addLog(this.hand ? 'The game will pause after this hand.' : 'The game is paused.'); } }
  dealNext(){ if(this.status !== 'playing') this.start(); else this.maybeStart(true); }
  queueBomb(){ this.bombNext = true; this.addLog('The admin called a bomb pot for the next hand.', 'bet'); }

  maybeStart(force = false){
    if(this.status !== 'playing' || this.hand || this.startPending) return;
    if(!force && !this.settings.autoDeal) return;
    if(this.eligible().length < 2) return;
    this.startPending = true;
    this.later(600, () => { this.startPending = false; this.startHand(); this.changed(); });
  }
  eligible(){ return this.seated().filter(p => p.chips > 0 && !p.sittingOut && !p.leaving && !p.standing && (p.isBot || p.connected)); }

  // ---------- the hand ----------
  startHand(){
    if(this.pending){ this.applySettings(this.pending); this.pending = null; }
    const players = this.eligible();
    if(this.status !== 'playing' || players.length < 2){ this.hand = null; return; }
    const s = this.settings;

    // blinds go up on schedule
    if(s.blindUpMinutes > 0 && Date.now() - this.levelStartedAt >= s.blindUpMinutes * 60000){
      s.sb *= 2; s.bb *= 2; s.ante *= 2; this.level++; this.levelStartedAt = Date.now();
      this.addLog(`Blinds are up: ${s.sb}/${s.bb}${s.ante ? `, ante ${s.ante}` : ''} (level ${this.level}).`, 'bet');
    }

    const isIn = p => players.includes(p);
    this.dealerSeat = this.nextSeat(this.dealerSeat, isIn);
    const headsUp = players.length === 2;
    const sbSeat = headsUp ? this.dealerSeat : this.nextSeat(this.dealerSeat, isIn);
    const bbSeat = this.nextSeat(sbSeat, isIn);
    const order = [];
    for(let x = this.nextSeat(this.dealerSeat, isIn), n = 0; n < players.length; x = this.nextSeat(x, isIn), n++) order.push(x);
    for(const p of this.seated()) Object.assign(p, { inHand: isIn(p), folded: false, allIn: false, hole: [], bet: 0, committed: 0, lastAction: null, shown: false, handName: null, handName2: null, startStack: p.chips });

    this.handCount++;
    const bomb = this.bombNext || (s.bombEvery > 0 && this.handCount % s.bombEvery === 0);
    this.bombNext = false;
    const deck = newDeck();
    this.hand = {
      id: this.handCount, deck, board: [], board2: null, rabbit: null, street: 'preflop', order, sbSeat: bomb ? -1 : sbSeat, bbSeat: bomb ? -1 : bbSeat,
      currentBet: 0, minRaise: s.bb, acted: new Set(), actingSeat: -1, turnDeadline: 0, bankPhase: false,
      result: null, runout: false, runTwice: false, runFrom: 0, dramatic: false, bomb, lastActorSeat: null
    };
    for(let r = 0; r < 2; r++) for(const x of order) this.seats[x].hole.push(deck.pop());
    this.addLog(`Hand #${this.hand.id}${bomb ? ' — bomb pot' : ''} — ${this.seats[this.dealerSeat].name} has the button.`, 'hand');

    const dealTime = 650 + 120 * order.length;
    if(bomb){
      for(const x of order) this.postDead(this.seats[x], s.bb * s.bombBB, 'Bomb pot');
      this.later(dealTime, () => {
        if(!this.hand || this.hand.id !== this.handCount) return;
        const h = this.hand;
        h.deck.pop(); h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
        h.street = 'flop';
        this.addLog(`Flop: ${h.board.map(cardText).join(' ')}`, 'board');
        this.later(950, () => {
          if(this.canAct().length <= 1) this.advance();
          else this.setTurn(this.nextSeat(this.dealerSeat, p => p.inHand && !p.folded && !p.allIn));
          this.changed();
        });
        this.changed();
      });
      return;
    }
    if(s.ante > 0) for(const x of order) this.postDead(this.seats[x], s.ante, 'Ante');
    this.post(this.seats[sbSeat], s.sb, 'SB');
    this.post(this.seats[bbSeat], s.bb, 'BB');
    this.hand.currentBet = s.bb;
    const first = headsUp ? sbSeat : this.nextSeat(bbSeat, p => p.inHand && !p.allIn);
    this.later(dealTime, () => {
      if(!this.hand || this.hand.id !== this.handCount) return;
      if(this.canAct().length <= 1 && this.canAct().every(p => p.bet >= this.hand.currentBet)) this.advance();
      else this.setTurn(first);
      this.changed();
    });
  }

  post(p, amount, label){
    const a = Math.min(amount, p.chips);
    p.chips -= a; p.bet += a; p.committed += a;
    if(p.chips === 0) p.allIn = true;
    p.lastAction = label;
  }
  // antes and bomb-pot money go straight into the pot without counting as a bet
  postDead(p, amount, label){
    const a = Math.min(amount, p.chips);
    p.chips -= a; p.committed += a;
    if(p.chips === 0) p.allIn = true;
    p.lastAction = label;
  }

  setTurn(seat){
    const h = this.hand;
    const p = this.seats[seat];
    if(!h || !p || !p.inHand || p.folded || p.allIn){ this.advance(); return; }
    h.actingSeat = seat; h.bankPhase = false;
    clearTimeout(this.turnTimer);
    const handId = h.id;
    if(this.settings.timerOn){
      h.turnDeadline = Date.now() + this.settings.turnSeconds * 1000;
      this.armTimer(p, handId, this.settings.turnSeconds * 1000);
    } else h.turnDeadline = 0;
    if(p.isBot || !p.connected){
      // bots think for a moment; a disconnected person gets some time to come back before auto check/fold
      const wait = p.isBot ? DELAY.botMin + Math.random() * (DELAY.botMax - DELAY.botMin)
                           : (this.settings.timerOn ? Math.min(10000, this.settings.turnSeconds * 1000) : 30000);
      this.later(wait, () => {
        if(!this.hand || this.hand.id !== handId || this.hand.actingSeat !== seat) return;
        if(!p.isBot && p.connected) return;
        const fallback = { type: (this.hand.currentBet - p.bet) > 0 ? 'fold' : 'check' };
        const d = p.isBot ? botDecide(this, p) : fallback;
        try { this.act(p.id, d, true); } catch(e){ this.act(p.id, fallback, true); }
        this.changed();
      });
    }
  }
  armTimer(p, handId, ms){
    const seat = p.seat;
    this.turnTimer = setTimeout(() => {
      const h = this.hand;
      if(!h || h.id !== handId || h.actingSeat !== seat) return;
      if(!h.bankPhase && p.bank >= 1){
        // the turn clock ran out: dip into this player's time bank
        h.bankPhase = true; h.bankStarted = Date.now();
        h.turnDeadline = Date.now() + p.bank * 1000;
        this.addLog(`${p.name} is using their time bank.`);
        this.armTimer(p, handId, p.bank * 1000);
        this.changed();
        return;
      }
      if(h.bankPhase) p.bank = 0;
      this.addLog(`${p.name} ran out of time.`);
      this.act(p.id, { type: h.currentBet - p.bet > 0 ? 'fold' : 'check' }, true);
      this.changed();
    }, (ms + 300) * SPEED);
  }
  skipTurn(){
    const h = this.hand;
    if(!h || h.actingSeat < 0) throw new Error('Nobody is deciding right now.');
    const p = this.seats[h.actingSeat];
    this.addLog(`The admin skipped ${p.name}'s turn.`);
    this.act(p.id, { type: h.currentBet - p.bet > 0 ? 'fold' : 'check' }, true);
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
      if(o.toCall === 0){ p.lastAction = 'Check'; this.addLog(`${p.name} checks.`); }
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
    if(h.bankPhase) p.bank = Math.max(0, p.bank - (Date.now() - h.bankStarted) / 1000);
    h.acted.add(p.seat);
    h.lastActorSeat = p.seat;
    clearTimeout(this.turnTimer);
    h.actingSeat = -1; h.bankPhase = false;
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
      const from = h.lastActorSeat != null ? h.lastActorSeat : (h.street === 'preflop' && h.bbSeat >= 0 ? h.bbSeat : this.dealerSeat);
      return this.setTurn(this.nextSeat(from, p => p.inHand && !p.folded && !p.allIn && needs(p)));
    }
    // betting round complete
    for(const p of this.inHand()){ p.bet = 0; if(!p.folded && !p.allIn && h.street !== 'river') p.lastAction = null; }
    h.currentBet = 0; h.minRaise = this.settings.bb; h.acted = new Set(); h.lastActorSeat = null;
    if(h.street === 'river'){
      if(h.runTwice && !h.board2) return this.dealSecondRun();
      return this.showdown();
    }
    const runout = canAct.length <= 1;
    if(runout && !h.runout){
      h.runout = true;
      for(const p of live) p.shown = true;     // everyone all-in: cards go face up
      if(this.settings.runItTwice && live.length >= 2){ h.runTwice = true; h.runFrom = h.board.length; this.addLog('All-in — running it twice.', 'bet'); }
      else this.addLog('All-in — the cards are turned face up.', 'bet');
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
      if(runout) this.later(nextStreet === 'flop' ? 1300 : 900, () => { this.advance(); this.changed(); });
      else {
        const first = this.nextSeat(this.dealerSeat, p => p.inHand && !p.folded && !p.allIn);
        this.later(nextStreet === 'flop' ? 950 : 700, () => { this.setTurn(first); this.changed(); });
      }
      this.changed();
    });
  }

  dealSecondRun(){
    const h = this.hand;
    this.later(DELAY.runoutStreet, () => {
      if(!this.hand || this.hand.id !== h.id || h.result) return;
      const b2 = h.board.slice(0, h.runFrom);
      while(b2.length < 5){ h.deck.pop(); b2.push(h.deck.pop()); }
      h.board2 = b2;
      this.addLog(`Second run: ${b2.map(cardText).join(' ')}`, 'board');
      this.later(550 * (5 - h.runFrom) + 900, () => { this.showdown(); this.changed(); });
      this.changed();
    });
  }

  finishUncontested(winner){
    const h = this.hand;
    clearTimeout(this.turnTimer);
    const pot = this.potTotal();
    const { payouts, won } = this.splitPots(['score']);
    for(const [id, amt] of payouts) this.players.get(id).chips += amt;
    const amount = won[0].get(winner.id) || 0;
    if(this.settings.rabbitHunt && h.board.length < 5){
      // show what would have come
      const r = [];
      let len = h.board.length;
      while(len < 5){ h.deck.pop(); const n = len === 0 ? 3 : 1; for(let i = 0; i < n; i++){ r.push(h.deck.pop()); len++; } }
      h.rabbit = r;
    }
    h.result = { uncontested: true, winners: [{ id: winner.id, seat: winner.seat, amount, hand: null }], pot };
    this.recordHand(pot);
    this.addLog(`${winner.name} wins ${amount.toLocaleString()} — everyone else folded.`, 'win');
    h.actingSeat = -1;
    this.endHand(DELAY.foldWin + (h.rabbit ? 2000 : 0));
  }

  showdown(){
    const h = this.hand;
    clearTimeout(this.turnTimer);
    const live = this.live();
    for(const p of live){
      p.score = E.eval7i(p.hole[0], p.hole[1], ...h.board); p.handName = E.handName(p.score);
      if(h.board2){ p.score2 = E.eval7i(p.hole[0], p.hole[1], ...h.board2); p.handName2 = E.handName(p.score2); }
    }
    const pot = this.potTotal();
    const keys = h.board2 ? ['score', 'score2'] : ['score'];
    const { payouts, won } = this.splitPots(keys);
    for(const [id, amt] of payouts) this.players.get(id).chips += amt;
    const winnersOf = (map, nameKey) => [...map.entries()].filter(([id, amt]) => this.players.get(id) && !this.players.get(id).folded && amt > 0)
      .map(([id, amount]) => { const p = this.players.get(id); return { id, seat: p.seat, amount, hand: p[nameKey] }; });
    const runs = keys.map((k, i) => ({ winners: winnersOf(won[i], i ? 'handName2' : 'handName') }));
    // totals across runs for the main banner
    const total = new Map();
    for(const r of runs) for(const w of r.winners) total.set(w.id, (total.get(w.id) || 0) + w.amount);
    const winners = [...total.entries()].map(([id, amount]) => { const p = this.players.get(id); return { id, seat: p.seat, amount, hand: p.handName }; });
    h.result = { uncontested: false, winners, runs: h.board2 ? runs : null, pot };
    this.recordHand(pot);
    const winSeats = new Set(winners.map(w => w.seat));
    for(const p of live) if(!this.settings.muckLosers || winSeats.has(p.seat) || p.shown) this.addLog(`${p.name} shows ${p.hole.map(cardText).join(' ')} — ${p.handName}${h.board2 ? ` / ${p.handName2}` : ''}.`);
    if(h.board2) runs.forEach((r, i) => r.winners.forEach(w => this.addLog(`Run ${i + 1}: ${this.players.get(w.id).name} wins ${w.amount.toLocaleString()} with ${w.hand}.`, 'win')));
    else for(const w of winners) this.addLog(`${this.players.get(w.id).name} wins ${w.amount.toLocaleString()} with ${w.hand}.`, 'win');
    h.actingSeat = -1;
    this.endHand(DELAY.showdown + (h.board2 ? 1500 : 0));
  }

  // One record per person in the hand, for their personal hand history.
  recordHand(pot){
    const h = this.hand, records = [];
    const ct = c => '23456789TJQKA'[c >> 2] + 'shdc'[c & 3];
    const players = this.inHand().length;
    for(const p of this.inHand()){
      const delta = p.chips - p.startStack;
      const won = delta > 0;
      if(won){ p.handsWon++; p.biggestPot = Math.max(p.biggestPot, pot); }
      if(p.isBot || !p.userId) continue;
      records.push({ userId: p.userId, gameKey: this.gameKey, handNo: h.id, hole: p.hole.map(ct).join(' '),
        board: h.board.map(ct).join(' '), board2: h.board2 ? h.board2.map(ct).join(' ') : null,
        handName: p.folded ? null : (p.handName || null), delta, pot, won, folded: p.folded, players });
    }
    if(this.onHand && records.length) try { this.onHand(this, records); } catch(e){ console.error(e); }
  }
  // Running totals for one member, as saved to their game history.
  summaryFor(p){
    const h = this.hand;
    const inPot = p.inHand && !(h && h.result) ? p.committed : 0;
    const final = p.wallet + (p.seat >= 0 ? p.chips + p.pendingChips + inPot : 0);
    const s = this.settings;
    return { userId: p.userId, gameKey: this.gameKey, code: this.code, admin: (this.players.get(this.adminId) || {}).name || null,
      startedAt: this.createdAt, given: p.buyInTotal, final, net: final - p.buyInTotal, hands: p.handsPlayed, handsWon: p.handsWon,
      biggestPot: p.biggestPot, blinds: `${s.sb}/${s.bb}` };
  }

  // Side-pot aware split. Each contribution level is a layer; only live players who paid into a
  // layer can win it; a layer nobody live paid into goes back to whoever paid it. With two runs,
  // every layer is split in half (odd chip to the first run) and each half goes to that run's best hand.
  splitPots(keys){
    const contributors = this.inHand().filter(p => p.committed > 0);
    const levels = [...new Set(contributors.map(p => p.committed))].sort((a, b) => a - b);
    const payouts = new Map();
    const won = keys.map(() => new Map());
    const pay = (id, a) => payouts.set(id, (payouts.get(id) || 0) + a);
    const credit = (i, id, a) => won[i].set(id, (won[i].get(id) || 0) + a);
    const fromButton = p => (p.seat - this.dealerSeat + MAX_SEATS) % MAX_SEATS;
    let prev = 0;
    for(const level of levels){
      const size = level - prev; prev = level;
      const payers = contributors.filter(p => p.committed >= level);
      const amount = size * payers.length;
      const eligible = payers.filter(p => !p.folded);
      if(eligible.length === 0){ for(const p of payers) pay(p.id, size); continue; }
      if(eligible.length === 1){ pay(eligible[0].id, amount); if(payers.length > 1) credit(0, eligible[0].id, amount); continue; }
      const parts = keys.length === 2 ? [Math.ceil(amount / 2), Math.floor(amount / 2)] : [amount];
      keys.forEach((k, i) => {
        const best = Math.max(...eligible.map(p => p[k]));
        const winners = eligible.filter(p => p[k] === best).sort((a, b) => fromButton(a) - fromButton(b));
        const share = Math.floor(parts[i] / winners.length);
        let rem = parts[i] - share * winners.length;   // odd chips go to the first winners left of the button
        for(const w of winners){ const a = share + (rem > 0 ? 1 : 0); rem--; pay(w.id, a); credit(i, w.id, a); }
      });
    }
    return { payouts, won };
  }

  endHand(wait){
    const h = this.hand;
    for(const p of this.seated()) if(p.chips === 0 && p.isBot && p.pendingChips === 0) p.leaving = true;
    this.later(wait, () => {
      if(!this.hand || this.hand.id !== h.id) return;
      for(const p of this.seated()){
        if(p.inHand) p.handsPlayed++;
        Object.assign(p, { inHand: false, hole: [], bet: 0, committed: 0, folded: false, allIn: false, shown: false, lastAction: null });
        if(p.pendingChips){ p.chips += p.pendingChips; p.pendingChips = 0; }
      }
      for(const p of this.seated()){
        if(p.leaving){ this.vacate(p); this.removePlayer(p.id, p.isBot ? 'left the table' : 'left'); }
        else if(p.standing) this.vacate(p);
      }
      this.hand = null;
      if(this.status === 'paused') this.addLog('The game is paused.');
      else if(!this.settings.autoDeal) this.addLog('Waiting for the admin to deal the next hand.');
      this.maybeStart();
      this.changed();
    });
  }

  // ---------- player utilities ----------
  setSittingOut(id, v){
    const p = this.players.get(id);
    if(!p) return;
    if(!v && p.chips === 0) throw new Error('Add chips to your stack first.');
    p.sittingOut = !!v;
    this.addLog(`${p.name} ${v ? 'is sitting out' : 'is back in'}.`);
    if(!v) this.maybeStart();
  }
  addBot(){
    if(this.seated().length >= this.settings.maxPlayers) throw new Error('The table is full.');
    const used = new Set(this.seated().filter(p => p.isBot).map(p => p.bot.id));
    const bot = BOTS.find(b => !used.has(b.id)) || BOTS[Math.floor(Math.random() * BOTS.length)];
    const p = this.addMember({ name: bot.name, isBot: true, bot });
    this.give(p.id, this.settings.defaultBuyIn);
    this.sit(p.id, null, this.settings.defaultBuyIn);
    return p;
  }

  // ---------- what each person sees ----------
  viewFor(viewerId){
    const h = this.hand;
    const me = this.players.get(viewerId);
    if(me && !me.approved) return { code: this.code, you: viewerId, pending: true, adminName: (this.players.get(this.adminId) || {}).name || null, members: [] };
    const isAdmin = viewerId === this.adminId;
    const showdown = h && h.result && !h.result.uncontested;
    const winSeats = new Set(h && h.result ? h.result.winners.map(w => w.seat) : []);
    const seats = this.seats.map((p, i) => {
      if(!p) return null;
      let cards = null;
      const reveal = p.shown || (showdown && !p.folded && (!this.settings.muckLosers || winSeats.has(i)));
      if(p.inHand && p.hole.length){
        if(p.id === viewerId || reveal) cards = p.hole;
        else if(!p.folded) cards = ['back', 'back'];
      }
      return {
        seat: i, id: p.id, name: p.name, chips: p.chips, pendingChips: p.pendingChips, bet: p.bet, inHand: p.inHand, folded: p.folded, allIn: p.allIn,
        isBot: p.isBot, connected: p.connected, sittingOut: p.sittingOut, lastAction: p.lastAction, cards,
        handName: reveal && !p.folded && p.handName ? p.handName + (p.handName2 && h && h.board2 ? ` / ${p.handName2}` : '') : null,
        bank: Math.round(p.bank), isAdmin: p.id === this.adminId, standing: p.standing
      };
    });
    const members = [...this.players.values()].filter(p => p.approved).sort((a, b) => a.joinedAt - b.joinedAt).map(p => ({
      id: p.id, name: p.name, isBot: p.isBot, isAdmin: p.id === this.adminId, connected: p.connected,
      seat: p.seat, wallet: p.wallet, stack: p.seat >= 0 ? p.chips + p.pendingChips + (p.inHand && !(h && h.result) ? p.committed : 0) : 0,
      given: p.buyInTotal, handsPlayed: p.handsPlayed,
      net: p.wallet + (p.seat >= 0 ? p.chips + p.pendingChips + (p.inHand && !(h && h.result) ? p.committed : 0) : 0) - p.buyInTotal,
      request: (this.requests.find(r => r.playerId === p.id) || {}).amount || 0
    }));
    const s = this.settings;
    return {
      code: this.code, you: viewerId, youSeat: me ? me.seat : -1, isAdmin, members, myWallet: me ? me.wallet : 0,
      adminName: (this.players.get(this.adminId) || {}).name || null, handCount: this.handCount,
      settings: s, pendingSettings: this.pending, status: this.status, seats, maxSeats: MAX_SEATS,
      level: this.level, nextLevelMs: s.blindUpMinutes > 0 && this.levelStartedAt ? Math.max(0, this.levelStartedAt + s.blindUpMinutes * 60000 - Date.now()) : null,
      bombNext: this.bombNext || (s.bombEvery > 0 && (this.handCount + 1) % s.bombEvery === 0),
      joinRequests: isAdmin ? [...this.players.values()].filter(p => !p.approved).map(p => ({ id: p.id, name: p.name })) : [],
      requests: isAdmin ? this.requests.map(r => ({ id: r.id, playerId: r.playerId, amount: r.amount, name: (this.players.get(r.playerId) || {}).name })) : [],
      myRequest: (this.requests.find(r => r.playerId === viewerId) || {}).amount || 0,
      hand: h ? {
        id: h.id, board: h.board, board2: h.board2, rabbit: h.rabbit, runFrom: h.runFrom, street: h.street, bomb: h.bomb,
        dealerSeat: this.dealerSeat, sbSeat: h.sbSeat, bbSeat: h.bbSeat,
        pot: this.potTotal(), potBehind: this.potTotal() - this.inHand().reduce((a, p) => a + p.bet, 0),
        currentBet: h.currentBet, actingSeat: h.actingSeat, bankPhase: h.bankPhase,
        turnMsLeft: h.actingSeat >= 0 && h.turnDeadline ? Math.max(0, h.turnDeadline - Date.now()) : 0,
        turnMs: h.bankPhase ? Math.max(1000, (h.turnDeadline - h.bankStarted)) : s.turnSeconds * 1000,
        timerOn: !!h.turnDeadline,
        runout: h.runout, runTwice: h.runTwice, dramatic: h.dramatic, streetPending: h.streetPending || null, result: h.result,
        liveOpponents: me && me.inHand && !me.folded ? this.live().length - 1 : 0
      } : null,
      options: me && h ? this.options(me) : null,
      log: this.log.slice(0, 50), chat: this.chat.slice(-40),
      serverTime: Date.now()
    };
  }
}

function cardText(c){ return '23456789TJQKA'[c >> 2] + '♠♥♦♣'[c & 3]; }
function fmtNet(n){ return (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString(); }
function validateSettings(input){
  const s = { ...DEFAULT_SETTINGS, ...input };
  const int = (k, lo, hi, msg) => {
    const v = Math.floor(Number(s[k]));
    if(!Number.isFinite(v) || v < lo || v > hi) throw new Error(msg);
    s[k] = v;
  };
  int('maxPlayers', 2, MAX_SEATS, 'Players must be between 2 and 10.');
  int('sb', 1, 1e8, 'The small blind must be at least 1.');
  int('bb', 1, 1e8, 'The big blind must be at least 1.');
  int('ante', 0, 1e8, 'The ante can’t be negative.');
  int('blindUpMinutes', 0, 240, 'Blind increases must be between 0 and 240 minutes.');
  int('turnSeconds', 5, 300, 'Turn time must be between 5 and 300 seconds.');
  int('timeBank', 0, 600, 'The time bank must be between 0 and 600 seconds.');
  int('defaultBuyIn', 1, 1e9, 'The default buy-in must be at least 1.');
  int('bombEvery', 0, 1000, 'Bomb pots: choose 0 (off) or how many hands between them.');
  int('bombBB', 1, 100, 'The bomb pot must be 1 to 100 big blinds.');
  if(s.sb > s.bb) throw new Error('The small blind can’t be bigger than the big blind.');
  if(s.bombEvery === 1) throw new Error('A bomb pot every hand isn’t allowed — use 2 or more.');
  for(const k of ['timerOn', 'runItTwice', 'rabbitHunt', 'muckLosers', 'autoDeal']) s[k] = s[k] === true || s[k] === 'true' || s[k] === 'on';
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, s[k]]));
}

module.exports = { Table, validateSettings, DEFAULT_SETTINGS, MAX_SEATS };
