/* Home Game client: landing screens, the live table, animations and controls.
   The server is the only source of truth; this file draws what it sends and animates the changes. */
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('en-IN');
const RANKS = '23456789TJQKA', SUITS = '♠♥♦♣';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const AV_COLORS = ['#d4a246', '#8fb8de', '#e8a598', '#9dd3b4', '#c7a8e0', '#f0c987', '#a7c4a0', '#e6b8d0', '#b8c4e8', '#e0b48a'];

// The private key arrives in the link (?key=...), is remembered on this device, and is
// removed from the address bar so it isn't shown on screen.
const KEY = (() => {
  const q = new URLSearchParams(location.search);
  let k = q.get('key');
  try { if(k) localStorage.setItem('hgKey', k); else k = localStorage.getItem('hgKey'); } catch(e){}
  if(q.has('key')){ q.delete('key'); history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '')); }
  return k || '';
})();
const socket = io({ transports: ['websocket', 'polling'], auth: { key: KEY } });
const app = $('#app');
let S = null;                 // latest state from the server
let P = null;                 // previous state
let receivedAt = 0;
let session = loadSession();
const ui = { tab: 'odds', panelOpen: false, autoFold: false, muted: false, raise: null, unread: 0, built: false,
             dealing: false, boardShown: 0, handShown: null, animQ: Promise.resolve(), resultShown: null, eqKey: null, eq: null };

function loadSession(){ try { return JSON.parse(localStorage.getItem('homegame') || 'null'); } catch(e){ return null; } }
function saveSession(s){ session = s; try { s ? localStorage.setItem('homegame', JSON.stringify(s)) : localStorage.removeItem('homegame'); } catch(e){} }
function emit(ev, data){ return new Promise(res => socket.emit(ev, data, r => res(r || { ok: false, error: 'No response from the server.' }))); }
function toast(msg, err = false){
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
}

/* ================= sound (tiny synth, no files) ================= */
let AC = null;
function ac(){ if(!AC){ try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){} } return AC; }
document.addEventListener('pointerdown', () => { const a = ac(); if(a && a.state === 'suspended') a.resume(); }, { once: false });
function tone(f, d = .08, type = 'sine', v = .06, when = 0){
  if(ui.muted) return; const a = ac(); if(!a) return;
  const o = a.createOscillator(), g = a.createGain(); const t = a.currentTime + when;
  o.type = type; o.frequency.value = f; g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0001, t + d);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + d + .02);
}
function noise(d = .05, v = .05, hp = 2000){
  if(ui.muted) return; const a = ac(); if(!a) return;
  const b = a.createBuffer(1, a.sampleRate * d, a.sampleRate), ch = b.getChannelData(0);
  for(let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
  const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
  f.type = 'highpass'; f.frequency.value = hp; g.gain.value = v; s.buffer = b; s.connect(f).connect(g).connect(a.destination); s.start();
}
const SFX = {
  deal: () => noise(.045, .06, 2600), flip: () => noise(.08, .05, 1200), chip: () => { tone(2400, .05, 'triangle', .04); tone(3100, .04, 'triangle', .03, .04); },
  turn: () => { tone(660, .15, 'sine', .06); tone(990, .2, 'sine', .05, .12); }, tick: () => tone(1400, .03, 'square', .02),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, .25, 'triangle', .05, i * .09)), thud: () => tone(90, .25, 'sine', .12),
};

/* ================= landing ================= */
/* ================= settings form (used when hosting and in the host's settings) ================= */
const DEFAULTS = { maxPlayers: 10, sb: 10, bb: 20, ante: 0, blindUpMinutes: 0, timerOn: true, turnSeconds: 30, timeBank: 30,
  defaultBuyIn: 2000, runItTwice: false, rabbitHunt: true, muckLosers: false, bombEvery: 0, bombBB: 2, autoDeal: true };
const loadPresets = () => { try { return JSON.parse(localStorage.getItem('hgPresets') || '{}'); } catch(e){ return {}; } };
const savePresets = p => { try { localStorage.setItem('hgPresets', JSON.stringify(p)); } catch(e){} };
const opt = (v, cur, label) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
function settingsFields(v){
  v = { ...DEFAULTS, ...v };
  const presets = loadPresets();
  const sw = (name, label, hint) => `<label class="switch-row"><span><span class="sw-label">${label}</span>${hint ? `<span class="sw-hint">${hint}</span>` : ''}</span><input type="checkbox" class="switch" name="${name}" ${v[name] ? 'checked' : ''}></label>`;
  return `
    <div class="preset-row">
      <select class="preset-pick" aria-label="Load a saved preset"><option value="">${Object.keys(presets).length ? 'Load a saved preset…' : 'No saved presets yet'}</option>${Object.keys(presets).map(n => `<option>${esc(n)}</option>`).join('')}</select>
      <button type="button" class="btn btn-sm preset-save">Save as preset</button>
    </div>
    <fieldset class="set-group"><legend>Players</legend>
      <div class="field"><label>Maximum players</label><select name="maxPlayers">${[2,3,4,5,6,7,8,9,10].map(n => opt(n, v.maxPlayers, n)).join('')}</select></div>
    </fieldset>
    <fieldset class="set-group"><legend>Blinds</legend>
      <div class="row3">
        <div class="field"><label>Small blind</label><input name="sb" type="number" min="1" value="${v.sb}"></div>
        <div class="field"><label>Big blind</label><input name="bb" type="number" min="1" value="${v.bb}"></div>
        <div class="field"><label>Ante</label><input name="ante" type="number" min="0" value="${v.ante}"></div>
      </div>
      <div class="field"><label>Blinds go up</label><select name="blindUpMinutes">${opt(0, v.blindUpMinutes, 'Never')}${[5,10,15,20,30,45,60].map(m => opt(m, v.blindUpMinutes, `Double every ${m} minutes`)).join('')}</select></div>
    </fieldset>
    <fieldset class="set-group"><legend>Turn timer</legend>
      ${sw('timerOn', 'Use a turn timer', 'Off means players can take as long as they like.')}
      <div class="row timer-fields">
        <div class="field"><label>Seconds per turn</label><input name="turnSeconds" type="number" min="5" max="300" value="${v.turnSeconds}"></div>
        <div class="field"><label>Time bank (seconds)</label><input name="timeBank" type="number" min="0" max="600" value="${v.timeBank}"><span class="hint">Extra time each player can use once their clock runs out, for the whole game.</span></div>
      </div>
    </fieldset>
    <fieldset class="set-group"><legend>Chips</legend>
      <div class="field"><label>Standard buy-in</label><input name="defaultBuyIn" type="number" min="1" value="${v.defaultBuyIn}"><span class="hint">Suggested amount when someone asks you for chips. You approve every buy-in.</span></div>
    </fieldset>
    <fieldset class="set-group"><legend>Game rules</legend>
      ${sw('runItTwice', 'Run it twice', 'When everyone is all-in, deal the rest of the board twice and split the pot.')}
      ${sw('rabbitHunt', 'Rabbit hunting', 'After everyone folds, show the cards that would have come.')}
      ${sw('muckLosers', 'Muck losing hands', 'At showdown only the winning hands are shown.')}
      <div class="row">
        <div class="field"><label>Bomb pots</label><select name="bombEvery">${opt(0, v.bombEvery, 'Off')}${[3,5,8,10,15,20].map(n => opt(n, v.bombEvery, `Every ${n} hands`)).join('')}</select></div>
        <div class="field"><label>Bomb pot size</label><select name="bombBB">${[1,2,3,5,10].map(n => opt(n, v.bombBB, `${n} big blind${n > 1 ? 's' : ''} each`)).join('')}</select></div>
      </div>
    </fieldset>
    <fieldset class="set-group"><legend>Dealing</legend>
      ${sw('autoDeal', 'Deal the next hand automatically', 'Off means you press Deal next hand each time.')}
    </fieldset>`;
}
function readSettings(form){
  const f = new FormData(form), o = {};
  for(const k of Object.keys(DEFAULTS)){
    if(typeof DEFAULTS[k] === 'boolean') o[k] = f.has(k);
    else if(f.has(k)) o[k] = Number(f.get(k));
  }
  return o;
}
function wireSettings(form){
  const timer = form.querySelector('[name=timerOn]'), tf = form.querySelector('.timer-fields');
  const syncTimer = () => tf.classList.toggle('disabled', !timer.checked);
  timer.onchange = syncTimer; syncTimer();
  form.querySelector('.preset-save').onclick = () => {
    const name = (prompt('Name this preset (for example "Friday night")') || '').trim().slice(0, 30);
    if(!name) return;
    const p = loadPresets(); p[name] = readSettings(form); savePresets(p);
    const sel = form.querySelector('.preset-pick');
    if(![...sel.options].some(o => o.value === name)){ const o = document.createElement('option'); o.textContent = name; sel.appendChild(o); }
    sel.options[0].textContent = 'Load a saved preset…';
    toast(`Saved "${name}"`);
  };
  form.querySelector('.preset-pick').onchange = e => {
    const p = loadPresets()[e.target.value];
    if(!p) return;
    for(const [k, v] of Object.entries(p)){
      const el = form.querySelector(`[name=${k}]`);
      if(!el) continue;
      if(el.type === 'checkbox') el.checked = !!v; else el.value = v;
    }
    syncTimer(); toast(`Loaded "${e.target.value}"`);
  };
}

/* ================= landing ================= */
function landing(mode = 'join', code = ''){
  ui.built = false; ui.view = 'landing';
  app.innerHTML = `
  <main class="landing">
    <section class="landing-hero">
      <div>
        <h1>Home<br>Game</h1>
        <p>Open a private Hold'em table, send the link to your friends, and play. The host hands out the chips — settle up however your group likes.</p>
      </div>
      <div class="hero-fan" aria-hidden="true"></div>
    </section>
    <section class="landing-forms">
      <div class="panel-card">
        <div class="tabs" role="tablist">
          <button role="tab" data-mode="join" aria-selected="${mode === 'join'}">Join a table</button>
          <button role="tab" data-mode="create" aria-selected="${mode === 'create'}">Host a table</button>
        </div>
        <form id="joinForm" class="stack ${mode === 'join' ? '' : 'hidden'}" autocomplete="off">
          <div class="field"><label for="jCode">Table code</label><input id="jCode" class="code-input" maxlength="5" placeholder="·····" value="${esc(code)}" inputmode="text" autocapitalize="characters"></div>
          <div id="preview" class="room-preview hidden"></div>
          <div class="field"><label for="jName">Your name</label><input id="jName" maxlength="20" value="${esc(localStorage.getItem('hgName') || '')}"></div>
          <p class="hint-line">The host gives you your chips once you're seated.</p>
          <div class="error" id="jErr"></div>
          <button class="btn btn-primary" type="submit">Take a seat</button>
        </form>
        <form id="createForm" class="stack ${mode === 'create' ? '' : 'hidden'}" autocomplete="off">
          <div class="row">
            <div class="field"><label for="cName">Your name</label><input id="cName" maxlength="20" value="${esc(localStorage.getItem('hgName') || '')}"></div>
            <div class="field"><label for="cChips">Your starting chips</label><input id="cChips" type="number" min="0" value="2000"></div>
          </div>
          <div class="field"><label for="cBots">Computer players</label><select id="cBots">${[0,1,2,3,4,5,6,7,8,9].map(n => `<option value="${n}">${n === 0 ? 'None — just friends' : n}</option>`).join('')}</select></div>
          <details class="more"><summary>Table settings</summary><div class="stack" id="createSettings">${settingsFields({})}</div></details>
          <div class="error" id="cErr"></div>
          <button class="btn btn-primary" type="submit">Open the table</button>
        </form>
      </div>
    </section>
  </main>`;
  // a fan of cards, the one decorative moment on this page
  const fan = $('.hero-fan');
  [[48, -24], [44, -12], [40, 0], [36, 12], [32, 24]].forEach(([c, deg], i) => {
    const el = cardEl(c + 1); el.classList.add('up'); el.style.transform = `translateX(-50%) rotate(${deg}deg)`;
    el.style.opacity = 0; fan.appendChild(el);
    el.animate([{ opacity: 0, transform: `translateX(-50%) translateY(40px) rotate(0deg)` }, { opacity: 1, transform: `translateX(-50%) rotate(${deg}deg)` }],
      { duration: reduced ? 1 : 700, delay: reduced ? 0 : 200 + i * 90, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
  });
  $$('.tabs button').forEach(b => b.onclick = () => landing(b.dataset.mode, $('#jCode') ? $('#jCode').value : ''));
  wireSettings($('#createForm'));

  const codeIn = $('#jCode');
  const peek = async () => {
    const c = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    codeIn.value = c;
    const pv = $('#preview');
    if(c.length < 5){ pv.classList.add('hidden'); return; }
    const r = await emit('peekRoom', { code: c });
    if(!r.ok){ pv.classList.remove('hidden'); pv.innerHTML = esc(r.error); return; }
    const s = r.settings;
    pv.classList.remove('hidden');
    pv.innerHTML = `<strong>${esc(r.host || 'A table')}'s table</strong> · blinds ${fmt(s.sb)}/${fmt(s.bb)} · ${r.seatsTaken} of ${s.maxPlayers} seats taken`;
  };
  codeIn && (codeIn.oninput = peek);
  if(code) peek();
  if(mode === 'join') (code ? $('#jName') : codeIn).focus(); else $('#cName').focus();

  $('#joinForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('#jName').value.trim();
    localStorage.setItem('hgName', name);
    const r = await emit('joinRoom', { code: codeIn.value, name });
    if(!r.ok) return $('#jErr').textContent = r.error;
    saveSession({ code: r.code, token: r.token }); history.replaceState(null, '', `/?room=${r.code}`);
  };
  $('#createForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('#cName').value.trim();
    localStorage.setItem('hgName', name);
    const r = await emit('createRoom', { name, settings: readSettings($('#createForm')), startChips: $('#cChips').value, bots: $('#cBots').value });
    if(!r.ok) return $('#cErr').textContent = r.error;
    saveSession({ code: r.code, token: r.token }); history.replaceState(null, '', `/?room=${r.code}`);
  };
}

/* ================= cards ================= */
function cardEl(c){
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = '<div class="inner"><div class="back"></div><div class="face"></div></div>';
  if(typeof c === 'number') setFace(el, c);
  return el;
}
function setFace(el, c){
  const f = el.querySelector('.face'), r = RANKS[c >> 2], s = c & 3;
  f.className = 'face' + (s === 1 || s === 2 ? ' red' : '');
  f.innerHTML = `<span class="rk">${r === 'T' ? '10' : r}</span><span class="st">${SUITS[s]}</span><span class="big">${SUITS[s]}</span>`;
  el.dataset.c = c;
}
function flipUp(el, delay = 0){ return new Promise(res => setTimeout(() => { el.classList.add('up'); SFX.flip(); setTimeout(res, 520); }, reduced ? 0 : delay)); }
// A card flies from the deck to where `target` sits, then `target` appears in its place.
function fly(target, delay = 0, spin = -18){
  return new Promise(res => {
    setTimeout(() => {
      const deck = $('.deck').getBoundingClientRect(), to = target.getBoundingClientRect();
      if(reduced || !to.width){ target.style.visibility = ''; return res(); }
      const f = cardEl(); f.classList.add('flying'); f.style.setProperty('--cw', to.width + 'px'); f.style.left = '0px'; f.style.top = '0px';
      document.body.appendChild(f);
      SFX.deal();
      const a = f.animate([
        { transform: `translate(${deck.left - to.width / 2}px, ${deck.top}px) rotate(${spin}deg) scale(.55)`, opacity: .2 },
        { transform: `translate(${to.left}px, ${to.top}px) rotate(0deg) scale(1)`, opacity: 1 }
      ], { duration: 380, easing: 'cubic-bezier(.2,.75,.25,1)' });
      a.onfinish = () => { f.remove(); target.style.visibility = ''; res(); };
    }, reduced ? 0 : delay);
  });
}
function flyChip(fromEl, toEl, delay = 0){
  if(reduced || !fromEl || !toEl) return;
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  if(!a.width && !a.height) return;
  setTimeout(() => {
    const c = document.createElement('div'); c.className = 'flying-chip'; document.body.appendChild(c);
    const x0 = a.left + a.width / 2 - 8, y0 = a.top + a.height / 2 - 8, x1 = b.left + b.width / 2 - 8, y1 = b.top + b.height / 2 - 8;
    c.animate([{ transform: `translate(${x0}px,${y0}px)` }, { transform: `translate(${(x0 + x1) / 2}px,${Math.min(y0, y1) - 40}px)`, offset: .5 }, { transform: `translate(${x1}px,${y1}px)` }],
      { duration: 650, easing: 'cubic-bezier(.3,.6,.3,1)' }).onfinish = () => { c.remove(); SFX.chip(); };
  }, delay);
}

/* ================= table: static frame ================= */
const ICON = {
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>',
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>',
  mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
  panel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
};
function buildTable(){
  ui.built = true; ui.view = 'table'; ui.boardShown = 0; ui.handShown = null; ui.resultShown = null;
  app.innerHTML = `
  <div class="game">
    <header class="topbar">
      <div class="brand">Home Game</div>
      <div class="room-chip" title="Table code"><span class="code" id="roomCode"></span><button class="btn btn-sm" id="copyLink">${ICON.link}<span style="margin-left:6px">Invite</span></button></div>
      <div class="status-line" id="statusLine"></div>
      <div class="spacer"></div>
      <button class="btn btn-sm hidden" id="reqBtn">Chip requests <span class="badge" id="reqCount">0</span></button>
      <button class="btn btn-sm hidden" id="setBtn">${ICON.gear}<span>Settings</span></button>
      <button class="icon-btn" id="soundBtn" aria-label="Sound on or off">${ICON.sound}</button>
      <button class="icon-btn panel-toggle" id="panelBtn" aria-label="Show odds, log and chat">${ICON.panel}</button>
      <button class="btn btn-sm btn-ghost" id="leaveBtn">Leave</button>
    </header>
    <section class="stage">
      <div class="table" id="table">
        <div class="felt"></div>
        <div class="felt-mark"><div class="code" id="feltCode"></div><div class="blinds" id="feltBlinds"></div></div>
        <div class="deck"></div>
        <div class="pot empty" id="pot"><div class="amount" id="potAmt">0</div><div class="label">pot</div></div>
        <div class="board" id="board">${'<div class="slot"></div>'.repeat(5)}</div>
        <div class="board board2 hidden" id="board2">${'<div class="slot"></div>'.repeat(5)}</div>
        <div class="waiting-note hidden" id="waitNote"></div>
        <div class="banner" id="banner"><div class="who"></div><div class="what"></div></div>
        <div class="dealer-btn hidden" id="dealerBtn">D</div>
        ${Array.from({ length: 10 }, (_, i) => `<div class="bet zero" id="bet${i}"><span class="chipstack"></span><span class="v"></span></div>`).join('')}
        ${Array.from({ length: 10 }, (_, i) => `<div class="seat empty" id="seat${i}"></div>`).join('')}
      </div>
    </section>
    <section class="actions" id="actions"></section>
    <aside class="side" id="side">
      <div class="tabs" role="tablist" id="sideTabs"></div>
      <div class="side-body" id="sideBody"></div>
    </aside>
  </div>`;
  $('#copyLink').onclick = async () => {
    const url = `${location.origin}/?room=${S.code}${KEY ? '&key=' + encodeURIComponent(KEY) : ''}`;
    if(navigator.share && matchMedia('(pointer: coarse)').matches){ try { await navigator.share({ title: 'Join my poker table', text: `Table code ${S.code}`, url }); return; } catch(e){} }
    try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch(e){ prompt('Copy this link', url); }
  };
  $('#soundBtn').onclick = () => { ui.muted = !ui.muted; $('#soundBtn').innerHTML = ui.muted ? ICON.mute : ICON.sound; };
  $('#panelBtn').onclick = () => { ui.panelOpen = !ui.panelOpen; $('#side').classList.toggle('open', ui.panelOpen); };
  $('#leaveBtn').onclick = confirmLeave;
  $('#setBtn').onclick = settingsDialog;
  $('#reqBtn').onclick = () => { ui.tab = 'table'; $('#sideBody').dataset.key = ''; ui.panelOpen = true; $('#side').classList.add('open'); renderSide(); };
  window.onresize = () => S && layout();
  document.onkeydown = hotkeys;
}

// Seat positions: you are always at the bottom; the rest go clockwise.
// Wide screens use an ellipse; phones use a hand-placed map that keeps the board clear.
const PHONE_SEATS = [[50, 91], [14, 79], [12, 63], [12, 29], [27, 10], [50, 4], [73, 10], [88, 29], [88, 63], [86, 79]];
const portrait = () => innerWidth <= 760;
function seatXY(v){
  if(portrait()) return PHONE_SEATS[v];
  const ang = (90 + v * 36) * Math.PI / 180;
  return [50 + 47 * Math.cos(ang), 50 + 45 * Math.sin(ang)];
}
const toward = ([x, y], k) => [50 + (x - 50) * k, 50 + (y - 50) * k];
const vis = seat => (seat - Math.max(0, S.youSeat) + 10) % 10;
function layout(){
  for(let i = 0; i < 10; i++){
    const v = vis(i), [x, y] = seatXY(v), [bx, by] = toward([x, y], portrait() ? (v === 0 ? .5 : .55) : .58);
    const seat = $('#seat' + i), bet = $('#bet' + i);
    seat.style.left = x + '%'; seat.style.top = y + '%';
    bet.style.left = bx + '%'; bet.style.top = (by + (v === 0 && !portrait() ? -6 : 0)) + '%';
  }
  if(S.hand){
    const [x, y] = seatXY(vis(S.hand.dealerSeat)), [dx, dy] = toward([x, y], .72);
    const d = $('#dealerBtn'); d.classList.remove('hidden');
    d.style.left = (dx + (x <= 50 ? 6 : -6)) + '%'; d.style.top = dy + '%';
  }
}

/* ================= table: each update ================= */
function update(){
  if(!ui.built) buildTable();
  const h = S.hand, ph = P && P.hand;
  $('#roomCode').textContent = S.code; $('#feltCode').textContent = S.code;
  $('#feltBlinds').textContent = `Blinds ${fmt(S.settings.sb)} / ${fmt(S.settings.bb)}`;
  $('.felt-mark').classList.toggle('quiet', !!h);
  renderStatus();
  $('#setBtn').classList.toggle('hidden', !S.isAdmin);
  $('#reqBtn').classList.toggle('hidden', !S.isAdmin || !S.requests.length);
  $('#reqCount').textContent = S.requests.length;
  if(S.isAdmin && P && S.requests.length > P.requests.length){ const r = S.requests.at(-1); toast(`${r.name} is asking for ${fmt(r.amount)} chips`); SFX.turn(); }
  layout();
  const newHand = h && h.id !== ui.handShown;
  if(!h && ui.handShown != null){ clearTableForNextHand(); }
  renderSeats(newHand);
  renderBets(ph);
  renderPot();
  if(newHand) startDealAnimation();
  else if(h && !ui.dealing){ syncBoard(); syncBoard2(); syncRabbit(); }
  renderResult();
  renderWaiting();
  renderActions();
  renderSide();
  if(h && h.actingSeat === S.youSeat && !(ph && ph.actingSeat === S.youSeat && ph.id === h.id)){ SFX.turn(); maybeAutoAct(); }
}

function clearTableForNextHand(){
  ui.handShown = null; ui.boardShown = 0; ui.resultShown = null;
  $$('#board .slot, #board2 .slot').forEach(s => s.innerHTML = '');
  $('#board2').classList.add('hidden'); $('#table').classList.remove('two-runs');
  ui.board2Shown = false; ui.rabbitShown = false;
  $('#banner').classList.remove('show');
  $('#dealerBtn').classList.toggle('hidden', true);
}

function renderSeats(newHand){
  const h = S.hand;
  S.seats.forEach((p, i) => {
    const el = $('#seat' + i);
    if(!p){
      if(!el.classList.contains('empty') || !el.innerHTML){ el.className = 'seat empty'; el.innerHTML = `<div class="empty-chair">Open</div>`; }
      return;
    }
    if(el.dataset.pid !== p.id){
      el.dataset.pid = p.id;
      const color = AV_COLORS[i % AV_COLORS.length];
      el.innerHTML = `
        <div class="cards"></div>
        <div class="plate">
          <svg class="ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" stroke-dasharray="113.1" stroke-dashoffset="113.1"/></svg>
          <div class="avatar" style="background:${color}">${esc(initials(p.name))}</div>
          <div class="name"></div><div class="chips"></div>
          <div class="tag"></div>
        </div>
        <div class="hand-name"></div>`;
      el.querySelector('.cards').dataset.key = '';
    }
    const acting = h && h.actingSeat === i;
    const winner = h && h.result && h.result.winners.some(w => w.seat === i);
    el.className = 'seat' + (i === S.youSeat ? ' me' : '') + (acting ? ' acting' : '') + (p.folded ? ' folded' : '') +
      (p.sittingOut || (!p.inHand && h) || (p.chips === 0 && !p.inHand) ? ' out' : '') + (!p.connected && !p.isBot ? ' offline' : '') + (winner ? ' winner' : '');
    el.querySelector('.name').innerHTML = esc(p.name) + (p.isAdmin ? '<span class="host-mark" title="Host">★</span>' : '') + (p.isBot ? '<span class="host-mark botmark" title="Computer player">· bot</span>' : '');
    el.querySelector('.chips').textContent = (p.chips === 0 && !p.inHand ? (p.request ? `Asking for ${fmt(p.request)}` : 'No chips yet') : p.sittingOut ? `${fmt(p.chips)} · sitting out` : fmt(p.chips))
      + (p.pendingChips ? ` · +${fmt(p.pendingChips)} next hand` : '');
    const tag = el.querySelector('.tag');
    const label = p.allIn ? 'All-in' : p.lastAction;
    tag.textContent = label || ''; tag.className = 'tag' + (label ? ' show' : '') + (p.folded ? ' fold' : '') + (p.allIn ? ' allin' : '');
    el.querySelector('.hand-name').textContent = p.handName || '';
    if(!newHand && !ui.dealing) syncSeatCards(i, p);
  });
}

function syncSeatCards(i, p){
  const box = $('#seat' + i + ' .cards');
  if(!box) return;
  const cards = p.cards;
  const key = cards ? cards.join(',') : '';
  if(box.dataset.key === key) return;
  const old = box.dataset.key;
  box.dataset.key = key;
  if(!cards){ box.innerHTML = ''; return; }
  const els = $$('.card', box);
  if(els.length === 2 && old && old.startsWith('back') && typeof cards[0] === 'number'){
    // reveal: turn the opponent's cards over
    const d = 120 * ((vis(i) + 9) % 10);
    els.forEach((el, k) => { setFace(el, cards[k]); flipUp(el, d + k * 140); });
    return;
  }
  box.innerHTML = '';
  cards.forEach(c => { const el = cardEl(c === 'back' ? undefined : c); if(typeof c === 'number') el.classList.add('up'); box.appendChild(el); });
}

async function startDealAnimation(){
  const h = S.hand;
  ui.handShown = h.id; ui.boardShown = 0; ui.resultShown = null; ui.dealing = true; ui.eqKey = null;
  $$('#board .slot, #board2 .slot').forEach(s => s.innerHTML = '');
  $('#board2').classList.add('hidden'); $('#table').classList.remove('two-runs');
  ui.board2Shown = false; ui.rabbitShown = false;
  $('#banner').classList.remove('show');
  // empty every seat's cards, then deal two rounds clockwise from the small blind
  const order = [];
  for(let k = 1; k <= 10; k++){ const s = (h.dealerSeat + k) % 10; const p = S.seats[s]; if(p && p.inHand) order.push(s); }
  if(order.length === 2) order.reverse(); // heads-up: the button gets the first card
  const slots = {};
  S.seats.forEach((p, i) => { const box = $('#seat' + i + ' .cards'); if(box){ box.innerHTML = ''; box.dataset.key = ''; } });
  for(const s of order){
    const box = $('#seat' + s + ' .cards');
    slots[s] = [cardEl(), cardEl()];
    slots[s].forEach(c => { c.style.visibility = 'hidden'; box.appendChild(c); });
  }
  const flights = [];
  let t = 0;
  for(let r = 0; r < 2; r++) for(const s of order){ flights.push(fly(slots[s][r], t, r ? 14 : -18)); t += 110; }
  await Promise.all(flights);
  // my cards turn over
  const me = S.seats[S.youSeat];
  if(me && me.inHand && Array.isArray(me.cards) && typeof me.cards[0] === 'number' && slots[S.youSeat]){
    slots[S.youSeat].forEach((el, k) => setFace(el, me.cards[k]));
    await Promise.all(slots[S.youSeat].map((el, k) => flipUp(el, 120 + k * 160)));
  }
  ui.dealing = false;
  for(const s of order){ const box = $('#seat' + s + ' .cards'); const p = S.seats[s]; if(box && p) box.dataset.key = slots[s].map((el, k) => typeof (p.cards || [])[k] === 'number' && el.classList.contains('up') ? p.cards[k] : 'back').join(','); }
  if(S.hand) { S.seats.forEach((p, i) => p && syncSeatCards(i, p)); syncBoard(); syncBoard2(); syncRabbit(); renderSide(); }
}

function syncBoard(){
  const h = S.hand; if(!h) return;
  if(h.board.length <= ui.boardShown) return;
  const from = ui.boardShown, to = h.board.length;
  ui.boardShown = to;
  const cards = h.board.slice(from, to);
  ui.animQ = ui.animQ.then(async () => {
    const slots = $$('#board .slot');
    const els = cards.map((c, k) => { const el = cardEl(c); el.style.visibility = 'hidden'; slots[from + k].innerHTML = ''; slots[from + k].appendChild(el); return el; });
    await Promise.all(els.map((el, k) => fly(el, k * 120, -10)));
    if(to === 3){ for(let k = 0; k < 3; k++) await flipUp(els[k], k ? 60 : 200); }
    else await flipUp(els[0], 250);
    renderSide();
  });
}

function renderBets(ph){
  S.seats.forEach((p, i) => {
    const el = $('#bet' + i), v = p && p.inHand ? p.bet : 0;
    const prevBet = ph && P.seats[i] && P.hand && S.hand && P.hand.id === S.hand.id ? P.seats[i].bet : 0;
    if(v > 0){ el.classList.remove('zero'); el.querySelector('.v').textContent = fmt(v); if(v > prevBet && prevBet >= 0 && P) SFX.chip(); }
    else {
      if(prevBet > 0 && S.hand && P.hand && S.hand.id === P.hand.id) flyChip(el, $('#pot'));   // bets swept into the pot
      el.classList.add('zero');
    }
  });
}
function renderPot(){
  const h = S.hand, pot = $('#pot');
  if(!h || (h.potBehind || 0) === 0){ pot.classList.add('empty'); return; }
  pot.classList.remove('empty');
  $('#potAmt').textContent = fmt(h.result ? h.result.pot : h.potBehind);
}
function renderResult(){
  const h = S.hand;
  if(!h || !h.result || ui.resultShown === h.id) return;
  ui.resultShown = h.id;
  const delay = h.result.uncontested ? 300 : 700 + (h.board2 ? 600 : 0);
  ui.animQ = ui.animQ.then(async () => {
    await sleep(delay);
    if(!S.hand || S.hand.id !== h.id) return;
    const ws = h.result.winners;
    const nm = w => S.seats[w.seat] ? S.seats[w.seat].name : 'Player';
    const b = $('#banner');
    if(h.result.runs){
      const [r1, r2] = h.result.runs.map(r => r.winners.map(nm).join(' & ') || '—');
      b.querySelector('.who').textContent = r1 === r2 ? `${r1} wins both runs` : `${r1} · ${r2}`;
      b.querySelector('.what').textContent = h.result.runs.map((r, i) => `Run ${i + 1}: ${r.winners.map(w => `${nm(w)} (${w.hand})`).join(', ')}`).join('   ');
    } else {
      b.querySelector('.who').textContent = ws.length > 1 ? `Split pot · ${ws.map(nm).join(' & ')}` : `${nm(ws[0])} wins ${fmt(ws[0].amount)}`;
      b.querySelector('.what').textContent = h.result.uncontested ? 'Everyone else folded' : (ws[0].hand || '');
    }
    b.classList.add('show');
    ws.forEach((w, k) => {
      const seat = $('#seat' + w.seat);
      for(let n = 0; n < 6; n++) flyChip($('#pot'), seat && seat.querySelector('.plate'), k * 200 + n * 70);
      if(!h.result.uncontested) $$('.card', seat).forEach(c => c.classList.add('win'));
    });
    if(ws.some(w => w.seat === S.youSeat)) SFX.win();
    $('#pot').classList.add('empty');
  });
}
// Run it twice: the second board appears under the first; shared cards show at once, the rest are dealt and turned.
function syncBoard2(){
  const h = S.hand;
  if(!h || !h.board2 || ui.board2Shown) return;
  ui.board2Shown = true;
  const b2 = h.board2, from = h.runFrom;
  ui.animQ = ui.animQ.then(async () => {
    $('#table').classList.add('two-runs'); $('#board2').classList.remove('hidden');
    const slots = $$('#board2 .slot');
    for(let k = 0; k < from; k++){ const el = cardEl(b2[k]); el.classList.add('up', 'shared'); slots[k].innerHTML = ''; slots[k].appendChild(el); }
    const els = [];
    for(let k = from; k < 5; k++){ const el = cardEl(b2[k]); el.style.visibility = 'hidden'; slots[k].innerHTML = ''; slots[k].appendChild(el); els.push(el); }
    await sleep(400);
    await Promise.all(els.map((el, k) => fly(el, k * 140, -10)));
    for(const el of els) await flipUp(el, 200);
  });
}
// Rabbit hunting: after everyone folds, the cards that would have come appear dimmed.
function syncRabbit(){
  const h = S.hand;
  if(!h || !h.rabbit || ui.rabbitShown) return;
  ui.rabbitShown = true;
  ui.animQ = ui.animQ.then(async () => {
    await sleep(700);
    const slots = $$('#board .slot');
    const els = h.rabbit.map((c, k) => { const el = cardEl(c); el.classList.add('rabbit'); el.style.visibility = 'hidden'; const sl = slots[h.board.length + k]; sl.innerHTML = ''; sl.appendChild(el); return el; });
    await Promise.all(els.map((el, k) => fly(el, k * 120, -10)));
    await Promise.all(els.map((el, k) => flipUp(el, 100 + k * 110)));
  });
}
function renderStatus(){
  const s = S.settings, h = S.hand;
  const parts = [];
  if(S.status === 'playing') parts.push(h ? `Hand #${h.id}${h.bomb ? ' · bomb pot' : ''}` : (s.autoDeal ? 'Next hand starting…' : 'Waiting for the host to deal'));
  else parts.push(S.status === 'paused' ? 'Paused by the host' : 'Waiting to start');
  parts.push(`Blinds ${fmt(s.sb)}/${fmt(s.bb)}${s.ante ? ` · ante ${fmt(s.ante)}` : ''}`);
  if(S.nextLevelMs != null && S.status === 'playing'){
    const ms = Math.max(0, S.nextLevelMs - (performance.now() - receivedAt)), m = Math.floor(ms / 60000), sec = Math.floor(ms / 1000) % 60;
    parts.push(`up in ${m}:${String(sec).padStart(2, '0')}`);
  }
  if(S.bombNext && !(h && h.bomb)) parts.push('bomb pot next');
  const t = parts.join(' · ');
  if($('#statusLine').textContent !== t) $('#statusLine').textContent = t;
}
setInterval(() => { if(S && ui.built) renderStatus(); }, 1000);
function renderWaiting(){
  const n = $('#waitNote');
  if(S.hand){ n.classList.add('hidden'); return; }
  const seated = S.seats.filter(Boolean);
  const ready = seated.filter(p => p.chips > 0 && !p.sittingOut).length;
  const me = S.seats[S.youSeat];
  let big, small;
  if(me && me.chips === 0 && !S.isAdmin){ big = 'Waiting for chips'; small = S.myRequest ? `You asked the host for ${fmt(S.myRequest)} chips.` : 'Ask the host for chips to play.'; }
  else if(S.status === 'playing'){ big = ready >= 2 ? (S.settings.autoDeal ? 'Shuffling…' : 'Ready for the next hand') : 'Waiting for players'; small = ready >= 2 ? (S.settings.autoDeal ? '' : S.isAdmin ? 'Deal when everyone is ready.' : 'The host will deal the next hand.') : 'At least two players with chips are needed.'; }
  else if(S.status === 'paused'){ big = 'Paused'; small = S.isAdmin ? 'Resume when everyone is ready.' : 'The host will resume the game.'; }
  else {
    big = seated.length < 2 ? 'Invite your friends' : `${seated.length} players seated`;
    small = S.isAdmin ? (S.requests.length ? `${S.requests.length} waiting for chips — approve them in Chip requests.` : `Share code ${S.code}, give everyone chips, then start.`) : 'Waiting for the host to start the game.';
  }
  n.classList.remove('hidden');
  n.innerHTML = `<div class="big">${esc(big)}</div><div>${esc(small)}</div>`;
}

/* ================= actions ================= */
function renderActions(){
  const box = $('#actions'), o = S.options, me = S.seats[S.youSeat];
  if(o){
    const key = `${S.hand.id}-${S.hand.street}-${o.currentBet}-${o.myBet}`;
    if(box.dataset.key === key) return;
    box.dataset.key = key;
    const callLabel = o.toCall === 0 ? 'Check' : (o.toCall >= me.chips ? `All-in ${fmt(o.toCall)}` : `Call ${fmt(o.toCall)}`);
    const verb = o.currentBet === 0 ? 'Bet' : 'Raise to';
    ui.raise = o.minRaiseTo;
    box.innerHTML = `
      ${o.toCall > 0 ? '<button class="btn btn-danger" id="aFold" title="F">Fold</button>' : ''}
      <button class="btn" id="aCall" title="C">${callLabel}</button>
      ${o.canRaise ? `
        <div class="raise-box">
          <div class="presets">
            <button data-p="min">Min</button><button data-p=".5">½ pot</button><button data-p=".75">¾ pot</button><button data-p="1">Pot</button><button data-p="max">All-in</button>
          </div>
          <input type="range" id="rRange" min="${o.minRaiseTo}" max="${o.maxRaiseTo}" step="${S.settings.sb}" value="${o.minRaiseTo}" aria-label="Raise amount">
          <input type="number" id="rNum" min="${o.minRaiseTo}" max="${o.maxRaiseTo}" value="${o.minRaiseTo}" aria-label="Raise to">
        </div>
        <button class="btn btn-primary" id="aRaise">${verb} ${fmt(o.minRaiseTo)}</button>` : ''}`;
    const setRaise = v => {
      v = Math.max(o.minRaiseTo, Math.min(o.maxRaiseTo, Math.round(Number(v) || 0)));
      ui.raise = v; $('#rRange').value = v; $('#rNum').value = v;
      $('#aRaise').textContent = v === o.maxRaiseTo ? `All-in ${fmt(v)}` : `${verb} ${fmt(v)}`;
    };
    if(o.canRaise){
      $('#rRange').oninput = e => setRaise(e.target.value);
      $('#rNum').oninput = e => { ui.raise = Number(e.target.value); };
      $('#rNum').onchange = e => setRaise(e.target.value);
      $$('.presets button', box).forEach(b => b.onclick = () => {
        const p = b.dataset.p;
        if(p === 'min') return setRaise(o.minRaiseTo);
        if(p === 'max') return setRaise(o.maxRaiseTo);
        // pot-sized raise: call first, then raise by a fraction of the pot after calling
        setRaise(o.currentBet + Number(p) * (o.pot + o.toCall));
      });
      $('#aRaise').onclick = () => act('raise', ui.raise);
    }
    $('#aCall').onclick = () => act(o.toCall === 0 ? 'check' : 'call');
    if($('#aFold')) $('#aFold').onclick = () => act('fold');
    return;
  }
  const acting = S.hand && S.hand.actingSeat >= 0 ? S.seats[S.hand.actingSeat] : null;
  const key = `idle-${S.status}-${me && me.sittingOut}-${me && me.chips}-${me && me.pendingChips}-${S.myRequest}-${S.hand && S.hand.id}-${S.hand && S.hand.actingSeat}-${S.hand && !!S.hand.result}-${ui.autoFold}-${S.isAdmin}-${S.seats.filter(p => p && p.chips > 0).length}-${S.settings.autoDeal}-${S.settings.timerOn}`;
  if(box.dataset.key === key) return;
  box.dataset.key = key;
  const handOn = S.hand && !S.hand.result;
  let html = '';
  const askBtn = S.myRequest
    ? `<span class="idle-note">Waiting for the host to approve ${fmt(S.myRequest)} chips.</span><button class="btn btn-ghost" id="cancelReq">Cancel request</button>`
    : `<button class="btn btn-primary" id="askChips">Ask the host for chips</button>`;
  if(S.isAdmin && S.status !== 'playing'){
    const n = S.seats.filter(p => p && p.chips > 0).length;
    html += `<button class="btn btn-primary" id="hStart" ${n < 2 ? 'disabled' : ''}>${S.status === 'paused' ? 'Resume the game' : 'Start the game'}</button>`;
    if(me && me.chips === 0) html += `<button class="btn" id="giveSelf">Give myself chips</button>`;
    if(n < 2) html += `<button class="btn" id="hBot">Add a computer player</button>`;
  } else if(S.isAdmin && !S.hand && !S.settings.autoDeal){
    html += `<button class="btn btn-primary" id="hDeal">Deal next hand</button><button class="btn btn-ghost" id="hBomb">Make it a bomb pot</button>`;
  } else if(me && me.chips === 0 && !(S.hand && me.inHand && handOn)){
    html += S.isAdmin ? `<span class="idle-note">You're out of chips.</span><button class="btn btn-primary" id="giveSelf">Give myself chips</button>` : `<span class="idle-note">You're out of chips.</span>${askBtn}`;
  } else if(me && me.sittingOut){
    html += `<span class="idle-note">You're sitting out.</span><button class="btn btn-primary" id="sitIn">Sit back in</button>`;
  } else if(S.hand && me && me.inHand && !me.folded && handOn){
    html += `<span class="idle-note">${acting ? `${esc(acting.name)} is deciding…` : '&nbsp;'}<label class="check"><input type="checkbox" id="autoFold" ${ui.autoFold ? 'checked' : ''}> Check or fold when it's my turn</label></span>`;
  } else if(S.hand){
    html += `<span class="idle-note">${me && me.folded ? 'You folded. ' : me && !me.inHand ? 'You\'re in from the next hand. ' : ''}${acting ? `${esc(acting.name)} is deciding…` : ''}</span>`;
  } else html += `<span class="idle-note">&nbsp;</span>`;
  // the host can move a slow player along when there's no timer
  if(S.isAdmin && acting && acting.id !== S.you && !acting.isBot && !S.settings.timerOn) html += `<button class="btn btn-sm btn-ghost" id="hSkip">Skip ${esc(acting.name)}'s turn</button>`;
  box.innerHTML = html;
  const on = (id, fn) => { if($('#' + id)) $('#' + id).onclick = fn; };
  on('hStart', () => host('start'));
  on('hBot', () => host('addBot'));
  on('hDeal', () => host('deal'));
  on('hBomb', async () => { const r = await host('bomb'); if(r.ok) host('deal'); });
  on('hSkip', () => host('skip'));
  on('giveSelf', () => chipsDialog('give', S.you));
  on('askChips', () => chipsDialog('ask'));
  on('cancelReq', () => emit('cancelRequest'));
  on('sitIn', async () => { const r = await emit('sitOut', { value: false }); if(!r.ok) toast(r.error, true); });
  if($('#autoFold')) $('#autoFold').onchange = e => { ui.autoFold = e.target.checked; };
}
async function act(type, amount){
  const r = await emit('action', { type, amount });
  if(!r.ok) toast(r.error, true);
}
function maybeAutoAct(){
  if(!ui.autoFold || !S.options) return;
  ui.autoFold = false;
  act(S.options.toCall === 0 ? 'check' : 'fold');
}
function hotkeys(e){
  if(!S || !S.options || /input|textarea|select/i.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if(k === 'f' && $('#aFold')) $('#aFold').click();
  else if(k === 'c') $('#aCall').click();
  else if(k === 'r' && $('#aRaise')) $('#aRaise').click();
}
async function host(cmd, extra = {}){
  const r = await emit('host', { cmd, ...extra });
  if(!r.ok) toast(r.error, true);
  return r;
}

/* ================= timer ring ================= */
function tickTimers(){
  requestAnimationFrame(tickTimers);
  if(!S || !S.hand || !ui.built) return;
  const h = S.hand;
  $$('.seat .ring circle').forEach(c => c.style.strokeDashoffset = 113.1);
  if(h.actingSeat < 0 || !h.timerOn) return;
  const c = $(`#seat${h.actingSeat} .ring circle`);
  if(!c) return;
  const left = Math.max(0, h.turnMsLeft - (performance.now() - receivedAt));
  c.style.strokeDashoffset = 113.1 * (1 - left / h.turnMs);
  c.style.stroke = h.bankPhase ? 'var(--good)' : left < 5000 ? 'var(--danger)' : 'var(--brass)';
  if(h.actingSeat === S.youSeat && left < 5000){
    const sec = Math.ceil(left / 1000);
    if(sec !== ui.lastTick){ ui.lastTick = sec; if(sec > 0) SFX.tick(); }
  }
}
requestAnimationFrame(tickTimers);

/* ================= side panel ================= */
function renderSide(){
  const tabs = [['odds', 'Odds'], ['log', 'Log'], ['chat', 'Chat' + (ui.unread ? ` · ${ui.unread}` : '')], ['table', 'Table']];
  const tb = $('#sideTabs');
  const tkey = tabs.map(t => t[1]).join('|') + ui.tab;
  if(tb.dataset.key !== tkey){
    tb.dataset.key = tkey;
    tb.innerHTML = tabs.map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="${ui.tab === k}">${l}</button>`).join('');
    $$('button', tb).forEach(b => b.onclick = () => { ui.tab = b.dataset.t; if(ui.tab === 'chat') ui.unread = 0; $('#sideBody').dataset.key = ''; renderSide(); });
  }
  const body = $('#sideBody');
  if(ui.tab === 'odds') renderOdds(body);
  else if(ui.tab === 'log') renderLog(body);
  else if(ui.tab === 'chat') renderChat(body);
  else renderLedger(body);
}

function renderOdds(body){
  const h = S.hand, me = S.seats[S.youSeat];
  const shownBoard = h ? h.board.slice(0, ui.boardShown) : [];
  const live = h && !h.result && me && me.inHand && !me.folded && Array.isArray(me.cards) && typeof me.cards[0] === 'number' && !ui.dealing;
  const k = h ? h.liveOpponents : 0;
  const key = live ? `${me.cards.join(',')}|${shownBoard.join(',')}|${k}|${S.options ? S.options.toCall + '/' + S.options.pot : ''}` : `none-${h ? h.id : 'x'}-${me && me.folded}-${h && !!h.result}`;
  if(body.dataset.key === key) return;
  body.dataset.key = key;
  if(!live || k < 1){
    body.innerHTML = `<div class="odds"><h3>Your odds</h3><p class="method">${h && h.result ? 'Hand over — the next one is coming.' : me && me.folded ? 'You folded this hand.' : h ? 'Shown once you have cards and an opponent.' : 'Shown when the next hand is dealt.'}</p>
      <p style="color:var(--text-dim);font-size:14px">Probabilities assume every unknown card is random. Heads-up they are exact on every street; three-handed they are exact from the flop; bigger pots are simulated with a 95% confidence interval.</p></div>`;
    return;
  }
  const ekey = `${me.cards.join(',')}|${shownBoard.join(',')}|${k}`;
  if(ui.eqKey !== ekey){ ui.eqKey = ekey; ui.eq = PokerEngine.equity(me.cards, shownBoard, k); }
  const e = ui.eq;
  const pct = x => (Math.round(x * 1000) / 10).toFixed(1) + '%';
  const method = e.method === 'precomputed' ? `Exact · all ${fmt(e.trials)} deals (precomputed)` : e.exact ? `Exact · ${fmt(e.trials)} showdowns counted` : `Simulated · ${fmt(e.trials)} deals · ±${(e.ci95 * 100).toFixed(1)}%`;
  const best = shownBoard.length >= 3 ? PokerEngine.bestHandName([...me.cards, ...shownBoard]) : null;
  const o = S.options;
  const need = o && o.toCall > 0 ? o.toCall / (o.pot + o.toCall) : null;
  body.innerHTML = `<div class="odds">
    <h3>Your odds</h3>
    <div class="method ${e.exact ? 'exact' : ''}">${method}</div>
    <div class="meter"><span>Win</span><div class="bar"><span style="width:${e.win * 100}%;background:var(--good)"></span></div><span class="num">${pct(e.win)}</span></div>
    <div class="meter"><span>Tie</span><div class="bar"><span style="width:${e.tie * 100}%;background:var(--brass)"></span></div><span class="num">${pct(e.tie)}</span></div>
    <div class="meter"><span>Lose</span><div class="bar"><span style="width:${e.lose * 100}%;background:var(--danger)"></span></div><span class="num">${pct(e.lose)}</span></div>
    <div class="equity-big"><div class="v">${pct(e.equity)}${e.exact ? '' : ` <span class="ci">±${(e.ci95 * 100).toFixed(1)}</span>`}</div><div class="l">Pot equity against ${k} random hand${k > 1 ? 's' : ''}</div></div>
    ${best ? `<div class="best-hand">You have <b>${esc(best.toLowerCase())}</b></div>` : ''}
    ${need != null ? `<div class="pot-odds">Calling ${fmt(o.toCall)} to win ${fmt(o.pot + o.toCall)} needs ${pct(need)} equity — ${e.equity >= need ? 'you have more than that.' : 'you have less than that.'}</div>` : ''}
  </div>`;
}
function renderLog(body){
  const key = 'log' + (S.log[0] ? S.log[0].t + S.log.length : '');
  if(body.dataset.key === key) return; body.dataset.key = key;
  body.innerHTML = S.log.map(l => `<div class="log-item ${l.kind}">${esc(l.text)}</div>`).join('') || '<p class="log-item">Nothing yet.</p>';
}
function renderChat(body){
  const key = 'chat' + S.chat.length + (S.chat.at(-1) ? S.chat.at(-1).t : '');
  if(body.dataset.key === key) return; body.dataset.key = key;
  const draft = $('#chatIn') ? $('#chatIn').value : '';
  body.innerHTML = `<div class="chat-list">${S.chat.map(m => `<div class="chat-msg"><b style="color:${AV_COLORS[m.seat % AV_COLORS.length]}">${esc(m.name)}</b>${esc(m.text)}</div>`).join('') || '<p class="log-item">Say hello to the table.</p>'}</div>
    <form class="chat-form" id="chatForm"><input id="chatIn" maxlength="200" placeholder="Message the table" autocomplete="off"><button class="btn btn-sm">Send</button></form>`;
  $('#chatIn').value = draft;
  body.scrollTop = body.scrollHeight;
  $('#chatForm').onsubmit = async e => { e.preventDefault(); const t = $('#chatIn').value.trim(); if(!t) return; $('#chatIn').value = ''; await emit('chat', { text: t }); };
}
function renderLedger(body){
  const s = S.settings, me = S.seats[S.youSeat];
  const key = JSON.stringify([S.seats.map(p => p && [p.id, p.chips, p.pendingChips, p.net, p.sittingOut, p.isAdmin, p.connected, p.inHand]), s, S.pendingSettings, S.status, S.isAdmin, S.requests, S.myRequest, S.hand && S.hand.id, S.hand && !!S.hand.result]);
  if(body.dataset.key === key) return; body.dataset.key = key;
  const rows = S.seats.filter(Boolean).sort((a, b) => b.net - a.net);
  const sgn = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
  let html = '';
  if(S.isAdmin && S.requests.length){
    html += `<div class="section requests"><div class="section-title">Waiting for chips</div>
      ${S.requests.map(r => `<div class="req-row" data-req="${r.id}"><span>${esc(r.name)}</span>
        <input type="number" min="1" value="${r.amount}" aria-label="Chips for ${esc(r.name)}">
        <button class="btn btn-sm btn-primary" data-approve>Give</button><button class="btn btn-sm btn-ghost" data-deny>Decline</button></div>`).join('')}
    </div>`;
  }
  html += `<h3>Table</h3>
    <table class="ledger"><thead><tr><th>Player</th><th>Given</th><th>Stack</th><th>Net</th>${S.isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map(p => `<tr><td>${esc(p.name)}${p.isBot ? ' <span class="dim">(bot)</span>' : ''}</td><td>${fmt(p.buyInTotal)}</td>
      <td>${fmt(p.chips)}${p.pendingChips ? `<div class="dim">+${fmt(p.pendingChips)} next hand</div>` : ''}</td>
      <td class="${p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''}">${sgn(p.net)}</td>
      ${S.isAdmin ? `<td class="chip-btns"><button class="mini" data-give="${p.id}" title="Give chips">+</button><button class="mini" data-take="${p.id}" title="Take chips back">−</button></td>` : ''}</tr>`).join('')}
    </tbody></table>
    <p class="dim small">Blinds ${fmt(s.sb)}/${fmt(s.bb)}${s.ante ? ` · ante ${fmt(s.ante)}` : ''} · ${s.timerOn ? `${s.turnSeconds}s turns, ${s.timeBank}s bank` : 'no turn timer'} · up to ${s.maxPlayers} players${S.pendingSettings ? ' · new settings apply next hand' : ''}</p>
    <div class="section"><div class="section-title">You</div><div class="btn-row">
      ${S.isAdmin ? '<button class="btn btn-sm" id="selfGive">Give myself chips</button>' : S.myRequest ? `<span class="dim small">Asked for ${fmt(S.myRequest)} chips</span><button class="btn btn-sm btn-ghost" id="cancelReq2">Cancel</button>` : '<button class="btn btn-sm" id="askMore">Ask the host for chips</button>'}
      ${me && me.chips > 0 ? `<button class="btn btn-sm" id="sitToggle">${me.sittingOut ? 'Sit back in' : 'Sit out next hand'}</button>` : ''}
    </div></div>`;
  if(S.isAdmin){
    html += `<div class="section"><div class="section-title">Host controls</div>
      <div class="btn-row">
        <button class="btn btn-sm btn-primary" id="openSettings">${ICON.gear}<span>Table settings</span></button>
        ${S.status === 'playing' ? '<button class="btn btn-sm" id="hPause">Pause after this hand</button>' : '<button class="btn btn-sm" id="hStart2">Start the game</button>'}
        ${S.status === 'playing' && !S.hand && !s.autoDeal ? '<button class="btn btn-sm" id="hDeal2">Deal next hand</button>' : ''}
        <button class="btn btn-sm" id="hBomb2" ${S.bombNext ? 'disabled' : ''}>${S.bombNext ? 'Bomb pot is next' : 'Bomb pot next hand'}</button>
        <button class="btn btn-sm" id="hBot2">Add a computer player</button>
      </div>
      <div class="host-list">${S.seats.filter(p => p && p.id !== S.you).map(p => `<div class="host-row"><span>${esc(p.name)}</span>
        ${p.isBot ? '' : `<button class="btn btn-sm btn-ghost" data-host="${p.id}">Make host</button>`}
        <button class="btn btn-sm btn-danger" data-kick="${p.id}">Remove</button></div>`).join('')}</div>
    </div>`;
  }
  body.innerHTML = html;
  const on = (id, fn) => { if($('#' + id)) $('#' + id).onclick = fn; };
  on('selfGive', () => chipsDialog('give', S.you));
  on('askMore', () => chipsDialog('ask'));
  on('cancelReq2', () => emit('cancelRequest'));
  on('sitToggle', async () => { const r = await emit('sitOut', { value: !me.sittingOut }); if(!r.ok) toast(r.error, true); });
  if(S.isAdmin){
    on('openSettings', settingsDialog);
    on('hPause', () => host('pause'));
    on('hStart2', () => host('start'));
    on('hDeal2', () => host('deal'));
    on('hBomb2', () => host('bomb'));
    on('hBot2', () => host('addBot'));
    $$('[data-req]', body).forEach(row => {
      row.querySelector('[data-approve]').onclick = () => host('approve', { requestId: row.dataset.req, amount: Number(row.querySelector('input').value) });
      row.querySelector('[data-deny]').onclick = () => host('deny', { requestId: row.dataset.req });
    });
    $$('[data-give]', body).forEach(b => b.onclick = () => chipsDialog('give', b.dataset.give));
    $$('[data-take]', body).forEach(b => b.onclick = () => chipsDialog('take', b.dataset.take));
    $$('[data-kick]', body).forEach(b => b.onclick = () => confirmDialog('Remove this player?', 'They fold any live hand and leave the table.', 'Remove', () => host('kick', { playerId: b.dataset.kick })));
    $$('[data-host]', body).forEach(b => b.onclick = () => host('makeHost', { playerId: b.dataset.host }));
  }
}

/* ================= dialogs ================= */
function confirmDialog(title, text, ok, fn, danger = true){
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><p>${esc(text)}</p><div class="btns"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button></div></div>`;
  document.body.appendChild(m);
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.onclick = e => { if(e.target === m) m.remove(); };
  m.querySelector('[data-ok]').onclick = () => { m.remove(); fn(); };
  m.querySelector('[data-ok]').focus();
}
function confirmLeave(){
  const me = S.seats[S.youSeat];
  const net = me ? me.net : 0;
  confirmDialog('Leave the table?', `You'll leave with ${fmt(me ? me.chips : 0)} chips (${net >= 0 ? 'up' : 'down'} ${fmt(Math.abs(net))}). Any live hand is folded.`, 'Leave', async () => {
    await emit('leave'); saveSession(null); S = null; history.replaceState(null, '', '/'); landing('join');
  });
}
// mode: 'ask' (a player asks the host), 'give' or 'take' (the host)
function chipsDialog(mode, playerId){
  const p = playerId ? S.seats.find(x => x && x.id === playerId) : S.seats[S.youSeat];
  if(!p) return;
  const self = p.id === S.you;
  const title = mode === 'ask' ? 'Ask for chips' : mode === 'give' ? (self ? 'Give yourself chips' : `Give ${p.name} chips`) : `Take chips from ${p.name}`;
  const text = mode === 'ask' ? 'The host will see your request and decide how many to give you.'
    : mode === 'give' ? (p.inHand && S.hand && !S.hand.result ? 'They are in a hand, so the chips arrive when it ends.' : 'The chips go straight onto their stack and count as a buy-in.')
    : `They have ${fmt(p.chips)}. Taking chips back counts as cashing out.`;
  const def = mode === 'take' ? p.chips : S.settings.defaultBuyIn;
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<form class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p>
    <div class="field"><label for="chAmt">Chips</label><input id="chAmt" type="number" min="1" ${mode === 'take' ? `max="${p.chips}"` : ''} value="${def}"></div>
    <div class="quick">${(mode === 'take' ? [0.25, 0.5, 1].map(f => Math.floor(p.chips * f)) : [0.5, 1, 2].map(f => Math.round(S.settings.defaultBuyIn * f))).filter(v => v > 0).map(v => `<button type="button" class="btn btn-sm" data-v="${v}">${fmt(v)}</button>`).join('')}</div>
    <div class="error" id="chErr"></div>
    <div class="btns"><button type="button" class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary">${mode === 'ask' ? 'Send request' : mode === 'give' ? 'Give chips' : 'Take chips'}</button></div></form>`;
  document.body.appendChild(m);
  $$('[data-v]', m).forEach(b => b.onclick = () => $('#chAmt').value = b.dataset.v);
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const amount = Number($('#chAmt').value);
    const r = mode === 'ask' ? await emit('requestChips', { amount }) : await emit('host', { cmd: mode, playerId: p.id, amount });
    if(!r.ok) return $('#chErr').textContent = r.error;
    m.remove(); toast(mode === 'ask' ? 'Request sent to the host' : mode === 'give' ? 'Chips given' : 'Chips taken back');
  };
  $('#chAmt').select();
}
function settingsDialog(){
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<form class="modal wide" id="setDlg"><div class="modal-head"><h3>Table settings</h3><button type="button" class="icon-btn" data-x aria-label="Close">✕</button></div>
    <div class="modal-scroll">${settingsFields(S.pendingSettings || S.settings)}</div>
    <p class="dim small">${S.hand ? 'A hand is in progress, so changes apply from the next hand.' : 'Changes apply straight away.'}</p>
    <div class="error" id="setErr"></div>
    <div class="btns"><button type="button" class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary">Save settings</button></div></form>`;
  document.body.appendChild(m);
  const form = $('#setDlg');
  wireSettings(form);
  $$('[data-x]', m).forEach(b => b.onclick = () => m.remove());
  form.onsubmit = async e => {
    e.preventDefault();
    const r = await emit('host', { cmd: 'settings', settings: readSettings(form) });
    if(!r.ok) return $('#setErr').textContent = r.error;
    m.remove(); toast('Settings saved');
  };
}
const initials = n => n.replace(/["'].*?["']/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

/* ================= connection ================= */
socket.on('state', st => {
  if(!session) return;
  if(st.youSeat < 0){   // removed by the host
    saveSession(null); S = null; history.replaceState(null, '', '/');
    landing('join'); toast('The host removed you from the table.', true); return;
  }
  const chatGrew = S && st.chat.length > S.chat.length && ui.tab !== 'chat';
  P = S; S = st; receivedAt = performance.now();
  if(chatGrew) ui.unread += st.chat.length - P.chat.length;
  update();
});
socket.on('connect', async () => {
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();
  if(session && (!urlRoom || urlRoom === session.code)){
    const r = await emit('resume', session);
    if(r.ok) return;
    saveSession(null);
    if(S){ S = null; toast('Your seat was closed. Join again with the code.', true); }
  }
  if(!S && ui.view !== 'landing') landing('join', urlRoom);
});
socket.on('connect_error', err => {
  if(err && err.message === 'private'){
    socket.disconnect();
    try { localStorage.removeItem('hgKey'); } catch(e){}
    ui.view = 'locked';
    app.innerHTML = `<main class="landing locked"><section class="landing-hero"><div>
      <h1>Home<br>Game</h1>
      <p>This is a private table. Ask the host for the invite link, then open it on this device.</p>
    </div></section></main>`;
  }
});
socket.on('disconnect', () => { if(S) toast('Connection lost — reconnecting…', true); });
if(!session && !KEY) {} else if(!session) landing('join', (new URLSearchParams(location.search).get('room') || '').toUpperCase());
})();
