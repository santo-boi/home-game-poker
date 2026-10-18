// Plays many fast hands with random human actions + bots and checks the rules hold.
// Run: npm test   (uses POKER_SPEED to fast-forward all delays)
process.env.POKER_SPEED = process.env.POKER_SPEED || '0.001';
const { Table } = require('./table');

const HANDS = Number(process.argv[2] || 3000);
let totalIn = 0, totalOut = 0, problems = [], handsSeen = new Set(), showdowns = 0, splits = 0, sidePots = 0, runouts = 0;

const t = new Table('TEST1', { sb: 10, bb: 20, minBuyIn: 400, maxBuyIn: 4000, turnSeconds: 30, allowRebuy: true }, () => {});
const origRemove = t.removePlayer.bind(t);
t.removePlayer = (id, reason) => { const p = t.players.get(id); const before = t.players.size; origRemove(id, reason); if(p && t.players.size < before) totalOut += p.chips; };
const origAdd = t.addPlayer.bind(t);
t.addPlayer = o => { const p = origAdd(o); totalIn += o.buyIn; return p; };
const origRebuy = t.rebuy.bind(t);
t.rebuy = (id, a) => { origRebuy(id, a); totalIn += Math.floor(a); };

const humans = [];
for(const n of ['Santo', 'Arun', 'Divya', 'Kiran']) humans.push(t.addPlayer({ name: n, buyIn: 400 + Math.floor(Math.random() * 3600) }));
t.addBot(); t.addBot(); t.addBot();
t.start();

function check(where){
  // after the pot is paid (result shown) the committed amounts are already in winners' stacks
  const paid = t.hand && t.hand.result;
  const inPlay = t.seated().reduce((a, p) => a + p.chips + (p.inHand && !paid ? p.committed : 0), 0);
  if(inPlay !== totalIn - totalOut) problems.push(`${where}: chips ${inPlay} != ${totalIn - totalOut}`);
  for(const p of t.seated()) if(p.chips < 0) problems.push(`${where}: negative chips for ${p.name}`);
}

let lastProgress = Date.now(), lastSig = '';
const tick = setInterval(() => {
  const h = t.hand;
  check('tick');
  const sig = h ? `${h.id}-${h.street}-${h.actingSeat}-${h.board.length}-${!!h.result}` : 'none';
  if(sig !== lastSig){ lastSig = sig; lastProgress = Date.now(); }
  if(Date.now() - lastProgress > 3000){ problems.push(`stalled at ${sig}`); finish(); }
  if(h){
    handsSeen.add(h.id);
    if(h.result && !h.counted){
      h.counted = true;
      if(!h.result.uncontested){ showdowns++; if(h.board.length !== 5) problems.push(`showdown with ${h.board.length} board cards`); }
      if(h.result.winners.length > 1) splits++;
      if(new Set(t.inHand().filter(p => p.allIn).map(p => p.committed)).size > 1) sidePots++;
      if(h.runout) runouts++;
      const paid = h.result.winners.reduce((a, w) => a + w.amount, 0);
      if(!h.result.uncontested && paid > h.result.pot) problems.push(`paid ${paid} > pot ${h.result.pot}`);
    }
    if(h.actingSeat >= 0){
      const p = t.seats[h.actingSeat];
      if(p && !p.isBot && !p.acting){
        const o = t.options(p);
        const r = Math.random();
        let a;
        if(r < 0.15 && o.toCall > 0) a = { type: 'fold' };
        else if(r < 0.3 && o.canRaise) a = { type: 'raise', amount: o.maxRaiseTo };                 // shove
        else if(r < 0.5 && o.canRaise) a = { type: 'raise', amount: o.minRaiseTo + Math.floor(Math.random() * (o.maxRaiseTo - o.minRaiseTo + 1)) };
        else a = { type: o.toCall > 0 ? 'call' : 'check' };
        try { t.act(p.id, a); } catch(e){ problems.push(`act error: ${e.message} ${JSON.stringify(a)} ${JSON.stringify(o)}`); }
        // also exercise illegal moves: they must be refused without changing anything
        try { t.act(p.id, { type: 'check' }); problems.push('acted twice in a row'); } catch(e){}
      }
    }
  } else {
    // between hands: busted humans rebuy, and keep the table populated
    for(const p of humans) if(t.players.has(p.id) && p.chips === 0){ t.rebuy(p.id, 400 + Math.floor(Math.random() * 3000)); }
    if(t.seated().filter(p => p.isBot).length < 2) t.addBot();
  }
  if(handsSeen.size >= HANDS) finish();
}, 1);

function finish(){
  clearInterval(tick);
  check('end');
  console.log(`hands ${handsSeen.size}, showdowns ${showdowns}, split pots ${splits}, side pots ${sidePots}, all-in run-outs ${runouts}`);
  console.log(problems.length ? `PROBLEMS (${problems.length}):\n` + [...new Set(problems)].slice(0, 15).join('\n') : 'All checks passed: chips conserved, no stalls, no illegal states.');
  t.destroy();
  process.exit(problems.length ? 1 : 0);
}
