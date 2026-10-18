// Plays many fast hands with random human actions + bots and checks the rules hold,
// cycling through different table settings (antes, bomb pots, run it twice, no timer...).
// Run: npm test   (uses POKER_SPEED to fast-forward all delays)
process.env.POKER_SPEED = process.env.POKER_SPEED || '0.001';
const { Table, validateSettings } = require('./table');

const HANDS = Number(process.argv[2] || 3000);
const PHASES = [
  { name: 'standard', s: {} },
  { name: 'antes + run it twice', s: { ante: 5, runItTwice: true } },
  { name: 'bomb pots + muck losers + no timer', s: { bombEvery: 3, bombBB: 3, muckLosers: true, timerOn: false } },
  { name: '10 players, rising blinds', s: { blindUpMinutes: 1, ante: 2, runItTwice: true, bombEvery: 5 } },
];
let totalIn = 0, totalOut = 0, problems = [], counted = 0, stats = { showdowns: 0, splits: 0, twice: 0, bombs: 0, rabbits: 0, runouts: 0 };

const t = new Table('TEST1', validateSettings({ sb: 10, bb: 20, defaultBuyIn: 2000 }), () => {});
const origGive = t.give.bind(t), origTake = t.take.bind(t), origRemove = t.removePlayer.bind(t);
t.give = (id, a, via) => { origGive(id, a, via); totalIn += Math.floor(a); };
t.take = (id, a) => { origTake(id, a); totalOut += Math.floor(a); };
t.removePlayer = (id, reason) => { const p = t.players.get(id); const before = t.players.size; origRemove(id, reason); if(p && t.players.size < before) totalOut += p.chips + p.pendingChips; };

const humans = [];
for(const n of ['Santo', 'Arun', 'Divya', 'Kiran']){
  const p = t.addPlayer({ name: n });
  t.requestChips(p.id, 1500);
  t.approve(t.requests.find(r => r.playerId === p.id).id, 400 + Math.floor(Math.random() * 3600));
  humans.push(p);
}
t.addBot(); t.addBot(); t.addBot();
t.start();

function check(where){
  const paid = t.hand && t.hand.result;
  const inPlay = t.seated().reduce((a, p) => a + p.chips + p.pendingChips + (p.inHand && !paid ? p.committed : 0), 0);
  if(inPlay !== totalIn - totalOut) problems.push(`${where}: chips ${inPlay} != ${totalIn - totalOut}`);
  for(const p of t.seated()) if(p.chips < 0) problems.push(`${where}: negative chips for ${p.name}`);
  if(t.seated().length > t.settings.maxPlayers && t.settings.maxPlayers >= t.seated().length) problems.push('too many players');
}

let phase = -1, lastProgress = Date.now(), lastSig = '';
function nextPhase(){
  phase++;
  const ph = PHASES[phase % PHASES.length];
  t.updateSettings({ sb: 10, bb: 20, ante: 0, bombEvery: 0, runItTwice: false, muckLosers: false, timerOn: true, blindUpMinutes: 0, ...ph.s });
  if(ph.name.startsWith('10 players')) while(t.seated().length < 10) t.addBot();
}
nextPhase();

const tick = setInterval(() => {
  const h = t.hand;
  check('tick');
  const sig = h ? `${h.id}-${h.street}-${h.actingSeat}-${h.board.length}-${!!h.result}-${!!h.board2}` : 'none' + t.seated().length;
  if(sig !== lastSig){ lastSig = sig; lastProgress = Date.now(); }
  if(Date.now() - lastProgress > 3000){ problems.push(`stalled at ${sig} (phase ${PHASES[phase % PHASES.length].name})`); finish(); }
  if(h){
    if(h.result && !h.counted){
      h.counted = true; counted++;
      if(!h.result.uncontested){ stats.showdowns++; if(h.board.length !== 5) problems.push(`showdown with ${h.board.length} board cards`); }
      if(h.result.winners.length > 1) stats.splits++;
      if(h.board2){ stats.twice++; if(h.board2.length !== 5 || h.board2.slice(0, h.runFrom).join() !== h.board.slice(0, h.runFrom).join()) problems.push('bad second board');
        const all = [...h.board, ...h.board2.slice(h.runFrom), ...t.inHand().flatMap(p => p.hole)];
        if(new Set(all).size !== all.length) problems.push('duplicate card across runs'); }
      if(h.bomb) stats.bombs++;
      if(h.rabbit) stats.rabbits++;
      if(h.runout) stats.runouts++;
      if(counted % 150 === 0) nextPhase();
    }
    if(h.actingSeat >= 0){
      const p = t.seats[h.actingSeat];
      if(p && !p.isBot){
        const o = t.options(p);
        const r = Math.random();
        let a;
        if(r < 0.15 && o.toCall > 0) a = { type: 'fold' };
        else if(r < 0.27 && o.canRaise) a = { type: 'raise', amount: o.maxRaiseTo };
        else if(r < 0.45 && o.canRaise) a = { type: 'raise', amount: o.minRaiseTo + Math.floor(Math.random() * (o.maxRaiseTo - o.minRaiseTo + 1)) };
        else a = { type: o.toCall > 0 ? 'call' : 'check' };
        try { t.act(p.id, a); } catch(e){ problems.push(`act error: ${e.message}`); }
        try { t.act(p.id, { type: 'check' }); problems.push('acted twice in a row'); } catch(e){}
      }
    }
    // the host hands out chips mid-hand sometimes: they must wait until the hand ends
    if(Math.random() < 0.002){ const p = humans.find(x => t.players.has(x.id)); if(p) t.give(p.id, 100); }
  } else {
    for(const p of humans) if(t.players.has(p.id) && p.chips === 0){ t.requestChips(p.id, 2000); t.approve(t.requests.find(r => r.playerId === p.id).id, 400 + Math.floor(Math.random() * 3000)); }
    const rich = humans.find(p => t.players.has(p.id) && p.chips > 5000);
    if(rich && Math.random() < 0.3) t.take(rich.id, 1000);
    if(t.seated().filter(p => p.isBot).length < 2) t.addBot();
  }
  if(counted >= HANDS) finish();
}, 1);

function finish(){
  clearInterval(tick);
  check('end');
  console.log(`hands ${counted}: showdowns ${stats.showdowns}, split pots ${stats.splits}, run twice ${stats.twice}, bomb pots ${stats.bombs}, rabbit hunts ${stats.rabbits}, all-in run-outs ${stats.runouts}`);
  console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + [...new Set(problems)].slice(0, 15).join('\n') : 'All checks passed: chips conserved, no stalls, no illegal states.');
  t.destroy();
  process.exit(problems.length ? 1 : 0);
}
