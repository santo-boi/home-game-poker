/* Shared poker engine: used by the server (bots, showdowns) and the browser (odds board).
   See the study guide for how every part works. */
(function(root){
'use strict';
/* Fast direct 7-card evaluator.
   Cards are ints 0..51: rank = (c>>2)+2 (2..14), suit = c&3.
   Returns exactly the same score encoding as the original best7():
   category*15^5 + tiebreak digits in base 15. */
const _RC = new Int8Array(16), _SC = new Int8Array(4), _SM = new Int32Array(4);

function _straightHigh(m){
  if(m & (1<<14)) m |= 2;            // ace also plays low
  for(let h=14; h>=5; h--){
    const mask = 0x1F << (h-4);
    if((m & mask) === mask) return h;
  }
  return 0;
}
function _sc(cat,a,b,c,d,e){ return ((((cat*15+a)*15+b)*15+c)*15+d)*15+e; }

function eval7i(c0,c1,c2,c3,c4,c5,c6){
  _RC.fill(0); _SC[0]=_SC[1]=_SC[2]=_SC[3]=0; _SM[0]=_SM[1]=_SM[2]=_SM[3]=0;
  let rm = 0, r, s;
  r=(c0>>2)+2; s=c0&3; _RC[r]++; _SC[s]++; _SM[s]|=1<<r; rm|=1<<r;
  r=(c1>>2)+2; s=c1&3; _RC[r]++; _SC[s]++; _SM[s]|=1<<r; rm|=1<<r;
  r=(c2>>2)+2; s=c2&3; _RC[r]++; _SC[s]++; _SM[s]|=1<<r; rm|=1<<r;
  r=(c3>>2)+2; s=c3&3; _RC[r]++; _SC[s]++; _SM[s]|=1<<r; rm|=1<<r;
  r=(c4>>2)+2; s=c4&3; _RC[r]++; _SC[s]++; _SM[s]|=1<<r; rm|=1<<r;
  r=(c5>>2)+2; s=c5&3; _RC[r]++; _SC[s]++; _SM[s]|=1<<r; rm|=1<<r;
  r=(c6>>2)+2; s=c6&3; _RC[r]++; _SC[s]++; _SM[s]|=1<<r; rm|=1<<r;
  // A flush can't coexist with quads or a full house in 7 cards, so checking it first is safe.
  for(let fs=0;fs<4;fs++){
    if(_SC[fs] >= 5){
      const m = _SM[fs];
      const sh = _straightHigh(m);
      if(sh) return _sc(8,sh,0,0,0,0);
      let v = 5, n = 0;
      for(let rr=14; rr>=2 && n<5; rr--) if(m & (1<<rr)){ v = v*15 + rr; n++; }
      return v;
    }
  }
  let q=0,t1=0,t2=0,p1=0,p2=0;
  for(let r=14;r>=2;r--){
    const k=_RC[r];
    if(k===4) q=r;
    else if(k===3){ if(!t1) t1=r; else if(!t2) t2=r; }
    else if(k===2){ if(!p1) p1=r; else if(!p2) p2=r; }
  }
  if(q){
    let k=0; for(let r=14;r>=2;r--) if(r!==q && _RC[r]){ k=r; break; }
    return _sc(7,q,k,0,0,0);
  }
  if(t1 && (t2 || p1)) return _sc(6,t1,Math.max(t2,p1),0,0,0);
  const sh = _straightHigh(rm);
  if(sh) return _sc(4,sh,0,0,0,0);
  // v = category followed by tiebreak digits; d counts digits written so far (5 in total).
  let v, d, need, ex1=0, ex2=0;
  if(t1){ v = 3*15 + t1; d = 1; need = 2; ex1 = t1; }
  else if(p1 && p2){ v = (2*15 + p1)*15 + p2; d = 2; need = 1; ex1 = p1; ex2 = p2; }
  else if(p1){ v = 1*15 + p1; d = 1; need = 3; ex1 = p1; }
  else { v = 0; d = 0; need = 5; }
  for(let rr=14; rr>=2 && need>0; rr--){
    if(rr!==ex1 && rr!==ex2 && _RC[rr]){ v = v*15 + rr; need--; d++; }
  }
  while(d < 5){ v = v*15; d++; }
  return v;
}

/* Exact heads-up preflop table: [win, tie] for each of the 169 starting hands vs one random hand,
   from a full enumeration of all 2,097,572,400 deals per hand. */
const PREFLOP_HU = {"22":[0.49385176,0.01897686],"32s":[0.33091972,0.05784918],"32o":[0.29239450,0.06127557],"42s":[0.33917944,0.05822141],"42o":[0.30117407,0.06164687],"52s":[0.34929535,0.05839585],"52o":[0.31193807,0.06181676],"62s":[0.34837548,0.05662833],"62o":[0.31078656,0.05992965],"72s":[0.35439838,0.05432111],"72o":[0.31710280,0.05746735],"82s":[0.37679222,0.05184825],"82o":[0.34086830,0.05481689],"92s":[0.39972955,0.04884435],"92o":[0.36517013,0.05161846],"T2s":[0.42540161,0.04598644],"T2o":[0.39239115,0.04858472],"J2s":[0.45202441,0.04351423],"J2o":[0.42049266,0.04598404],"Q2s":[0.48101816,0.04134439],"Q2o":[0.45109930,0.04371013],"K2s":[0.51239952,0.03943552],"K2o":[0.48422782,0.04171883],"A2s":[0.55506261,0.03745275],"A2o":[0.52947305,0.03962506],"33":[0.52839237,0.01707680],"43s":[0.35727358,0.05829181],"43o":[0.32066305,0.06159177],"53s":[0.36758677,0.05868571],"53o":[0.33164981,0.06199580],"63s":[0.36685430,0.05696260],"63o":[0.33069789,0.06015683],"73s":[0.37303556,0.05464759],"73o":[0.33717911,0.05768693],"83s":[0.38282562,0.05181883],"83o":[0.34749849,0.05467927],"93s":[0.40806789,0.04914937],"93o":[0.37427914,0.05183201],"T3s":[0.43378483,0.04628057],"T3o":[0.40155186,0.04878730],"J3s":[0.46041750,0.04379748],"J3o":[0.42966762,0.04617565],"Q3s":[0.48938409,0.04161674],"Q3o":[0.46024897,0.04389078],"K3s":[0.52070127,0.03969699],"K3o":[0.49331264,0.04188851],"A3s":[0.56335054,0.03770534],"A3o":[0.53855312,0.03978581],"44":[0.56256514,0.01532614],"54s":[0.38532532,0.05841778],"54o":[0.35074820,0.06160934],"64s":[0.38480977,0.05704683],"64o":[0.35002989,0.06014999],"74s":[0.39108909,0.05480807],"74o":[0.35661729,0.05776198],"84s":[0.40102778,0.05197698],"84o":[0.36709172,0.05475239],"94s":[0.41407123,0.04909696],"94o":[0.38085796,0.05170516],"T4s":[0.44204069,0.04652848],"T4o":[0.41055389,0.04897439],"J4s":[0.46868668,0.04403571],"J4o":[0.43868735,0.04635299],"Q4s":[0.49763037,0.04184530],"Q4o":[0.46924765,0.04405837],"K4s":[0.52888844,0.03991586],"K4o":[0.50225154,0.04204635],"A4s":[0.57137799,0.03791673],"A4o":[0.54732870,0.03993614],"55":[0.59640035,0.01369770],"65s":[0.40348188,0.05570397],"65o":[0.37012755,0.05863094],"75s":[0.40979005,0.05393063],"75o":[0.37674684,0.05674569],"85s":[0.41990460,0.05109066],"85o":[0.38741271,0.05372510],"95s":[0.43312707,0.04818334],"95o":[0.40136720,0.05064845],"T5s":[0.44939025,0.04554467],"T5o":[0.41857476,0.04786948],"J5s":[0.47820945,0.04331810],"J5o":[0.44904648,0.04552481],"Q5s":[0.50713450,0.04111921],"Q5o":[0.47959000,0.04322166],"K5s":[0.53833852,0.03918131],"K5o":[0.51253917,0.04120111],"A5s":[0.58064119,0.03717612],"A5o":[0.55742294,0.03908481],"66":[0.62700024,0.01169449],"76s":[0.42829477,0.05084580],"76o":[0.39653812,0.05337870],"86s":[0.43818511,0.04849516],"86o":[0.40696584,0.05088635],"96s":[0.45151167,0.04554248],"96o":[0.42103393,0.04775904],"T6s":[0.46800198,0.04280956],"T6o":[0.43848125,0.04487757],"J6s":[0.48574245,0.04063325],"J6o":[0.45713539,0.04261468],"Q6s":[0.51679244,0.03866645],"Q6o":[0.48996501,0.04055103],"K6s":[0.54804671,0.03672128],"K6o":[0.52297120,0.03852317],"A6s":[0.58178898,0.03453860],"A6o":[0.55870306,0.03624293],"77":[0.65725354,0.01021338],"87s":[0.45684108,0.04504465],"87o":[0.42693294,0.04715036],"97s":[0.46990290,0.04254883],"97o":[0.44072060,0.04451493],"T7s":[0.48651234,0.03975608],"T7o":[0.45829764,0.04156744],"J7s":[0.50454458,0.03740646],"J7o":[0.47726131,0.03911606],"Q7s":[0.52523486,0.03557553],"Q7o":[0.49904365,0.03722603],"K7s":[0.55846321,0.03382833],"K7o":[0.53417328,0.03540044],"A7s":[0.59386672,0.03194572],"A7o":[0.57169515,0.03343360],"88":[0.68717382,0.00891306],"98s":[0.48856274,0.03888963],"98o":[0.46068332,0.04057401],"T8s":[0.50509148,0.03650446],"T8o":[0.47818105,0.03806337],"J8s":[0.52311653,0.03407982],"J8o":[0.49713657,0.03553011],"Q8s":[0.54417019,0.03201429],"Q8o":[0.51930522,0.03338540],"K8s":[0.56790410,0.03043880],"K8o":[0.54431634,0.03177078],"A8s":[0.60507809,0.02872003],"A8o":[0.58374156,0.02996899],"99":[0.71665652,0.00783200],"T9s":[0.52376873,0.03301310],"T9o":[0.49815696,0.03431954],"J9s":[0.54111984,0.03100972],"J9o":[0.51639381,0.03223632],"Q9s":[0.56222796,0.02883051],"Q9o":[0.53862004,0.02996862],"K9s":[0.58638139,0.02700672],"K9o":[0.56407644,0.02808562],"A9s":[0.61509674,0.02543080],"A9o":[0.59449741,0.02646130],"TT":[0.74660265,0.00703030],"JTs":[0.56154781,0.02746152],"JTo":[0.53826005,0.02843396],"QTs":[0.58170640,0.02593839],"QTo":[0.55947390,0.02686786],"KTs":[0.60587065,0.02402986],"KTo":[0.58494284,0.02489262],"ATs":[0.63488915,0.02226943],"ATo":[0.61568084,0.02307141],"JJ":[0.77152980,0.00632987],"QJs":[0.59070876,0.02376658],"QJo":[0.56906232,0.02456916],"KJs":[0.61476557,0.02181567],"KJo":[0.59441233,0.02254904],"AJs":[0.64397621,0.01990117],"AJo":[0.62535175,0.02056166],"QQ":[0.79631990,0.00586348],"KQs":[0.62408420,0.01983967],"KQo":[0.60432253,0.02047095],"AQs":[0.65313699,0.01790327],"AQo":[0.63508787,0.01846104],"KK":[0.82117335,0.00556689],"AKs":[0.66219608,0.01650049],"AKo":[0.64469378,0.01701388],"AA":[0.84931915,0.00543596]};

/* =========================================================
   EQUITY ENGINE v2 — exact wherever it is computationally feasible
   ---------------------------------------------------------
   • Heads-up preflop: exact, from a precomputed table (all 169
     starting hands vs a random hand, every possible deal).
   • Heads-up and 3-handed on flop / turn / river: exact live
     enumeration of every run-out and every opponent holding.
     For 2 opponents, card-disjoint pairs of holdings are counted
     with an inclusion–exclusion formula instead of a nested loop.
   • Everything else (3+ opponents, or 2 opponents preflop):
     Monte Carlo simulation, reported with a 95% confidence interval.
   ========================================================= */
const _SUIT_IDX = { s:0, h:1, d:2, c:3 };
function cardToInt(c){ return (c.r-2)*4 + _SUIT_IDX[c.s]; }

const _RANK_CH = '23456789TJQKA';
function startingHandKey(h){
  const r1 = (h[0]>>2), r2 = (h[1]>>2);
  const hi = Math.max(r1,r2), lo = Math.min(r1,r2);
  if(hi === lo) return _RANK_CH[hi] + _RANK_CH[lo];
  return _RANK_CH[hi] + _RANK_CH[lo] + (((h[0]&3) === (h[1]&3)) ? 's' : 'o');
}

const _EQ_CACHE = new Map();
const PREFLOP_HU_DEALS = 2097572400; // C(50,2) opponent hands × C(48,5) boards

function computeEquity(heroHole, board, numOpponents, trialsOverride){
  if(numOpponents <= 0) return null;
  const hero = heroHole.map(cardToInt);
  const bd = board.map(cardToInt);
  const cacheKey = hero.join(',') + '|' + bd.join(',') + '|' + numOpponents + '|' + (trialsOverride||0);
  if(_EQ_CACHE.has(cacheKey)) return _EQ_CACHE.get(cacheKey);
  let res;
  if(numOpponents === 1 && bd.length === 0 && typeof PREFLOP_HU === 'object'){
    const row = PREFLOP_HU[startingHandKey(hero)];
    res = { win:row[0], tie:row[1], lose:1-row[0]-row[1], equity:row[0]+row[1]/2,
            exact:true, trials:PREFLOP_HU_DEALS, method:'precomputed' };
  } else if(numOpponents <= 2 && bd.length >= 3){
    res = exactEquity(hero, bd, numOpponents);
  } else {
    res = monteCarloEquity(hero, bd, numOpponents, trialsOverride || 40000);
  }
  if(_EQ_CACHE.size > 5000) _EQ_CACHE.clear();
  _EQ_CACHE.set(cacheKey, res);
  return res;
}

function _choose2(n){ return n*(n-1)/2; }

// Exact enumeration for 1 or 2 opponents once the flop is out.
function exactEquity(hero, bd, k){
  const used = new Uint8Array(52);
  for(const c of hero) used[c] = 1;
  for(const c of bd) used[c] = 1;
  const deck = [];
  for(let c=0;c<52;c++) if(!used[c]) deck.push(c);
  const u = 5 - bd.length;
  const full = bd.slice(); while(full.length < 5) full.push(-1);

  let winW=0, tieW=0, total=0, eqSum=0;
  const scores = new Int32Array(1081), ha = new Int8Array(1081), hb = new Int8Array(1081);
  const cntL = new Int32Array(52), cntE = new Int32Array(52);

  const runOne = (runout) => {
    for(let i=0;i<u;i++) full[bd.length+i] = runout[i];
    const hs = eval7i(hero[0],hero[1],full[0],full[1],full[2],full[3],full[4]);
    const rem = [];
    for(const c of deck) if(runout.indexOf(c) < 0) rem.push(c);
    const m = rem.length;
    let nh = 0, L = 0, E = 0;
    cntL.fill(0); cntE.fill(0);
    for(let i=0;i<m;i++) for(let j=i+1;j<m;j++){
      const a = rem[i], b = rem[j];
      const s = eval7i(a,b,full[0],full[1],full[2],full[3],full[4]);
      if(s < hs){ L++; cntL[a]++; cntL[b]++; }
      else if(s === hs){ E++; cntE[a]++; cntE[b]++; }
      nh++;
    }
    if(k === 1){
      winW += L; tieW += E; total += nh; eqSum += L + E/2;
    } else {
      // D(S) = number of unordered pairs of card-disjoint holdings inside S.
      // Two distinct holdings can share at most one card, so the overlapping
      // pairs are exactly sum over cards c of C(count_S(c), 2).
      let sL=0, sE=0, sLE=0;
      for(const c of rem){ sL += _choose2(cntL[c]); sE += _choose2(cntE[c]); sLE += _choose2(cntL[c]+cntE[c]); }
      const dL = _choose2(L) - sL, dE = _choose2(E) - sE, dLE = _choose2(L+E) - sLE;
      const dAll = _choose2(nh) - m*_choose2(m-1);
      const maxEq = dLE - dL;           // best opponent ties hero
      const oneEq = maxEq - dE;         // exactly one opponent ties → split 2 ways
      winW += dL; tieW += maxEq; total += dAll; eqSum += dL + oneEq/2 + dE/3;
    }
  };

  if(u === 0) runOne([]);
  else if(u === 1){ for(const a of deck) runOne([a]); }
  else { for(let i=0;i<deck.length;i++) for(let j=i+1;j<deck.length;j++) runOne([deck[i],deck[j]]); }

  return { win:winW/total, tie:tieW/total, lose:(total-winW-tieW)/total, equity:eqSum/total,
           exact:true, trials:total, method:'enumerated' };
}

// Monte Carlo with a 95% confidence interval on the equity estimate.
function monteCarloEquity(hero, bd, k, trials){
  const used = new Uint8Array(52);
  for(const c of hero) used[c] = 1;
  for(const c of bd) used[c] = 1;
  const deck = new Int8Array(52 - hero.length - bd.length);
  let n=0; for(let c=0;c<52;c++) if(!used[c]) deck[n++] = c;
  const u = 5 - bd.length;
  const full = new Int8Array(5); for(let i=0;i<bd.length;i++) full[i] = bd[i];
  const need = u + 2*k;
  let win=0, tie=0, lose=0, sum=0, sumSq=0;
  for(let t=0;t<trials;t++){
    // partial Fisher–Yates: only shuffle the cards we actually deal
    for(let i=0;i<need;i++){
      const j = i + Math.floor(Math.random()*(n-i));
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
    }
    for(let i=0;i<u;i++) full[bd.length+i] = deck[i];
    const hs = eval7i(hero[0],hero[1],full[0],full[1],full[2],full[3],full[4]);
    let best = -1, nBest = 0;
    for(let o=0;o<k;o++){
      const s = eval7i(deck[u+2*o],deck[u+2*o+1],full[0],full[1],full[2],full[3],full[4]);
      if(s > best){ best = s; nBest = 1; } else if(s === best) nBest++;
    }
    let share;
    if(hs > best){ win++; share = 1; }
    else if(hs === best){ tie++; share = 1/(nBest+1); }
    else { lose++; share = 0; }
    sum += share; sumSq += share*share;
  }
  const mean = sum/trials;
  const variance = Math.max(0, sumSq/trials - mean*mean);
  const ci95 = 1.96*Math.sqrt(variance/trials);
  return { win:win/trials, tie:tie/trials, lose:lose/trials, equity:mean, ci95,
           exact:false, trials, method:'simulated' };
}

const HAND_NAMES = ['High card','Pair','Two pair','Three of a kind','Straight','Flush','Full house','Four of a kind','Straight flush'];
function handName(score){ return HAND_NAMES[Math.floor(score / 759375)]; }
// Best hand name for 5, 6 or 7 cards (ints); used for the "current best hand" label.
function bestHandName(cards){
  if(cards.length === 7) return handName(eval7i(...cards));
  if(cards.length < 5) return null;
  let best = -1;
  const pick = (start, chosen) => {
    if(chosen.length === 5){ const s = score5(chosen); if(s > best) best = s; return; }
    for(let i=start;i<cards.length;i++) pick(i+1, chosen.concat(cards[i]));
  };
  pick(0, []);
  return handName(best);
}
// 5-card score with the same encoding as eval7i.
function score5(c){
  const r = c.map(x=>(x>>2)+2).sort((a,b)=>b-a), s = c.map(x=>x&3);
  const flush = s.every(v=>v===s[0]);
  const cnt = {}; r.forEach(v=>cnt[v]=(cnt[v]||0)+1);
  const g = Object.entries(cnt).map(([k,v])=>({r:+k,c:v})).sort((a,b)=>b.c-a.c||b.r-a.r);
  let m=0; r.forEach(v=>m|=1<<v); const sh=_straightHigh(m);
  const sc=(cat,t)=>{ t=t.slice(0,5); while(t.length<5)t.push(0); return t.reduce((a,v)=>a*15+v,cat); };
  if(sh&&flush) return sc(8,[sh]);
  if(g[0].c===4) return sc(7,[g[0].r,g[1].r]);
  if(g[0].c===3&&g[1].c===2) return sc(6,[g[0].r,g[1].r]);
  if(flush) return sc(5,r);
  if(sh) return sc(4,[sh]);
  if(g[0].c===3) return sc(3,[g[0].r,...r.filter(v=>v!==g[0].r)]);
  if(g[0].c===2&&g[1].c===2) return sc(2,[g[0].r,g[1].r,g[2].r]);
  if(g[0].c===2) return sc(1,[g[0].r,...r.filter(v=>v!==g[0].r)]);
  return sc(0,r);
}

/* Equity for integer cards. opts.maxExact=false forces simulation (used by bots on the server
   so one table's bot can never stall the others). */
function equity(hero, board, k, opts){
  opts = opts || {};
  if(k <= 0) return null;
  if(k === 1 && board.length === 0){
    const row = PREFLOP_HU[startingHandKey(hero)];
    return { win:row[0], tie:row[1], lose:1-row[0]-row[1], equity:row[0]+row[1]/2, exact:true, trials:PREFLOP_HU_DEALS, method:'precomputed' };
  }
  if(opts.allowExact !== false && k <= 2 && board.length >= 3) return exactEquity(hero, board, k);
  return monteCarloEquity(hero, board, k, opts.trials || 40000);
}

const api = { equity, eval7i, computeEquity, exactEquity, monteCarloEquity, startingHandKey, cardToInt, handName, bestHandName, PREFLOP_HU };
if(typeof module !== 'undefined' && module.exports) module.exports = api; else root.PokerEngine = api;
})(typeof self !== 'undefined' ? self : this);
