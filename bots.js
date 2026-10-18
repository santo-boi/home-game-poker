// Computer players. Each compares its pot equity with the pot odds, then its personality
// shifts how readily it folds, raises and bluffs.
const E = require('./engine.js');

const BOTS = [
  { id: 'ice',    name: 'Ethan W.',    style: 'Tight-aggressive', bluff: 55, aggr: 70, patience: 80, risk: 50 },
  { id: 'blaze',  name: 'Sofia R.',   style: 'Loose-aggressive', bluff: 80, aggr: 90, patience: 30, risk: 85 },
  { id: 'oracle', name: 'Priya S.', style: 'Tight-aggressive', bluff: 50, aggr: 60, patience: 80, risk: 50 },
  { id: 'kid',    name: 'Tyler B.',    style: 'Loose-aggressive', bluff: 70, aggr: 80, patience: 25, risk: 80 },
  { id: 'reaper', name: 'Hendrik V.', style: 'Loose-aggressive', bluff: 60, aggr: 82, patience: 50, risk: 70 },
  { id: 'rock',   name: 'Maggie C.',  style: 'Tight-passive',    bluff: 15, aggr: 30, patience: 95, risk: 25 },
  { id: 'fox',    name: 'Arjun M.',     style: 'Tricky',           bluff: 75, aggr: 55, patience: 60, risk: 60 },
  { id: 'duke',   name: 'Luca M.',   style: 'Loose-passive',    bluff: 30, aggr: 35, patience: 40, risk: 65 },
];

function botDecide(table, p){
  const h = table.hand;
  const o = table.options(p);
  const opponents = Math.max(1, table.live().length - 1);
  // simulation only on the server, so a bot never stalls other tables
  const eq = E.equity(p.hole, h.board, opponents, { allowExact: false, trials: 2500 });
  const winEq = eq ? eq.equity : 0.3;
  const b = p.bot;
  const aggr = b.aggr / 100, bluffT = b.bluff / 100, patience = b.patience / 100, risk = b.risk / 100;
  const potOdds = o.toCall > 0 ? o.toCall / (o.pot + o.toCall) : 0;
  const r = Math.random();
  const foldMargin = 0.03 + patience * 0.12 - risk * 0.06;
  const valueRaise = 0.62 - aggr * 0.12 - (opponents - 1) * 0.06;   // more opponents → lower bar (equity shrinks)
  const bluffChance = 0.04 + bluffT * 0.25;
  const sizing = 0.45 + aggr * 0.55;
  const raiseTo = frac => {
    const target = h.currentBet + Math.max(o.minRaiseTo - h.currentBet, Math.round((o.pot + o.toCall) * frac / table.settings.bb) * table.settings.bb);
    return Math.max(o.minRaiseTo, Math.min(target, o.maxRaiseTo));
  };
  if(o.toCall === 0){
    if(o.canRaise && winEq > valueRaise && r > 0.3 - aggr * 0.2) return { type: 'raise', amount: raiseTo(sizing) };
    if(o.canRaise && r < bluffChance * 0.5) return { type: 'raise', amount: raiseTo(0.4) };
    return { type: 'check' };
  }
  if(winEq < potOdds - foldMargin && r > 0.1 + risk * 0.15) return { type: 'fold' };
  if(o.canRaise && winEq > potOdds + 0.2 - aggr * 0.08 && r > 0.4 - aggr * 0.25) return { type: 'raise', amount: raiseTo(sizing) };
  if(o.canRaise && r < bluffChance * 0.25 && winEq < potOdds) return { type: 'raise', amount: raiseTo(sizing) };
  return { type: 'call' };
}

module.exports = { BOTS, botDecide };
