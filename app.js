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
// your name is remembered on this device so you don't have to type it every time
const loadName = () => { try { return localStorage.getItem('hgName') || ''; } catch(e){ return ''; } };
const saveName = n => { try { localStorage.setItem('hgName', n); } catch(e){} };
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
// iPhones only show the pressed-in look on buttons when the page listens for touches
document.addEventListener('touchstart', () => {}, { passive: true });
const SFX = {
  deal: () => noise(.045, .06, 2600), chat: () => { tone(880, .06, 'sine', .035); tone(1320, .08, 'sine', .03, .06); }, flip: () => noise(.08, .05, 1200), chip: () => { tone(2400, .05, 'triangle', .04); tone(3100, .04, 'triangle', .03, .04); },
  turn: () => { tone(660, .15, 'sine', .06); tone(990, .2, 'sine', .05, .12); }, tick: () => tone(1400, .03, 'square', .02),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, .25, 'triangle', .05, i * .09)), thud: () => tone(90, .25, 'sine', .12),
};

/* ================= landing ================= */
// a fan of cards, the one decorative moment on the home screens
function fanCards(){
  const fan = $('.hero-fan');
  if(!fan) return;
  [[48, -24], [44, -12], [40, 0], [36, 12], [32, 24]].forEach(([c, deg], i) => {
    const el = cardEl(c + 1); el.classList.add('up'); el.style.transform = `translateX(-50%) rotate(${deg}deg)`;
    el.style.opacity = 0; fan.appendChild(el);
    el.animate([{ opacity: 0, transform: `translateX(-50%) translateY(40px) rotate(0deg)` }, { opacity: 1, transform: `translateX(-50%) rotate(${deg}deg)` }],
      { duration: reduced ? 1 : 700, delay: reduced ? 0 : 200 + i * 90, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
  });
}
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
        ${session && S ? `<div class="rejoin"><div><div class="dim small">You're in a game</div><div class="rj-code">${esc(S.code)}</div></div>
          <button type="button" class="btn btn-primary" id="rjGo">Return to game</button><button type="button" class="btn btn-ghost btn-sm" id="rjLeave">Leave it</button></div>` : ''}
        <div class="tabs" role="tablist">
          <button role="tab" data-mode="join" aria-selected="${mode === 'join'}">Join a table</button>
          <button role="tab" data-mode="create" aria-selected="${mode === 'create'}">Host a table</button>
        </div>
        <form id="joinForm" class="stack ${mode === 'join' ? '' : 'hidden'}" autocomplete="off">
          <div class="field"><label for="jName">Your name</label><input id="jName" maxlength="20" placeholder="How the table sees you" value="${esc(loadName())}" autocomplete="nickname"></div>
          <div class="field"><label for="jCode">Table code</label><input id="jCode" class="code-input" maxlength="5" placeholder="·····" value="${esc(code)}" inputmode="text" autocapitalize="characters"></div>
          <div id="preview" class="room-preview hidden"></div>
          <p class="hint-line">The admin gives you chips, then you buy in when you sit down at the table.</p>
          <div class="error" id="jErr"></div>
          <button class="btn btn-primary" type="submit">Take a seat</button>
        </form>
        <form id="createForm" class="stack ${mode === 'create' ? '' : 'hidden'}" autocomplete="off">
          <div class="field"><label for="cName">Your name</label><input id="cName" maxlength="20" placeholder="How the table sees you" value="${esc(loadName())}" autocomplete="nickname"></div>
          <div class="field"><label for="cChips">Chips for your own wallet</label><input id="cChips" type="number" min="0" value="2000"></div>
          <div class="field"><label for="cBots">Computer players</label><select id="cBots">${[0,1,2,3,4,5,6,7,8,9].map(n => `<option value="${n}">${n === 0 ? 'None — just friends' : n}</option>`).join('')}</select></div>
          <details class="more"><summary>Table settings</summary><div class="stack" id="createSettings">${settingsFields({})}</div></details>
          <div class="error" id="cErr"></div>
          <button class="btn btn-primary" type="submit">Open the table</button>
        </form>
      </div>
    </section>
  </main>`;
  fanCards();
  $$('.tabs button').forEach(b => b.onclick = () => landing(b.dataset.mode, $('#jCode') ? $('#jCode').value : ''));
  if($('#rjGo')) $('#rjGo').onclick = () => { history.replaceState(null, '', `/?room=${S.code}`); goLobby(); };
  if($('#rjLeave')) $('#rjLeave').onclick = confirmLeave;
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
  const first = mode === 'join' ? (!$('#jName').value ? $('#jName') : codeIn) : (!$('#cName').value ? $('#cName') : $('#cChips'));
  first.focus();

  $('#joinForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('#jName').value.trim();
    if(!name){ $('#jErr').textContent = 'Enter your name.'; return $('#jName').focus(); }
    const r = await emit('joinRoom', { code: codeIn.value, name });
    if(!r.ok) return $('#jErr').textContent = r.error;
    saveName(name);
    saveSession({ code: r.code, token: r.token }); history.replaceState(null, '', `/?room=${r.code}`);
    try { sessionStorage.setItem('hgView', 'lobby'); } catch(e){}
    ui.view = r.pending ? 'waiting' : 'lobby'; ui.lobbyKey = '';
  };
  $('#createForm').onsubmit = async e => {
    e.preventDefault();
    const name = $('#cName').value.trim();
    if(!name){ $('#cErr').textContent = 'Enter your name.'; return $('#cName').focus(); }
    const r = await emit('createRoom', { name, settings: readSettings($('#createForm')), startChips: $('#cChips').value, bots: $('#cBots').value });
    if(!r.ok) return $('#cErr').textContent = r.error;
    saveName(name);
    saveSession({ code: r.code, token: r.token }); history.replaceState(null, '', `/?room=${r.code}`);
    ui.view = 'lobby'; ui.lobbyKey = ''; try { sessionStorage.setItem('hgView', 'lobby'); } catch(e){}
  };
}

// Animations run one after another; one that fails (or finds the page changed) never blocks the rest.
function queueAnim(fn){
  ui.animQ = ui.animQ.then(() => (ui.view === 'table' && S ? fn() : null)).catch(e => console.error(e));
}

// Only touch the page when something really changed: every write costs the browser a restyle.
const setText = (el, v) => { if(el && el.textContent !== v) el.textContent = v; };
const setHTML = (el, v) => { if(el && el._h !== v){ el._h = v; el.innerHTML = v; } };
const setClass = (el, v) => { if(el && el.className !== v) el.className = v; };

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
function flipUp(el, delay = 0){ return new Promise(res => setTimeout(() => { el.classList.add('up'); SFX.flip(); setTimeout(res, reduced ? 0 : 400); }, reduced ? 0 : delay)); }
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
      ], { duration: 300, easing: 'cubic-bezier(.2,.75,.25,1)' });
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
      { duration: 450, easing: 'cubic-bezier(.3,.6,.3,1)' }).onfinish = () => { c.remove(); SFX.chip(); };
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
const ICON2 = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  vdots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 5v6c0 5 3.4 9.6 8 11 4.6-1.4 8-6 8-11V5z"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M16 13h2M3 10h18M6 6V4h11v2"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.5a5 5 0 0 1 5.5 5.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
};
async function invite(){
  const url = `${location.origin}/?room=${S.code}${KEY ? '&key=' + encodeURIComponent(KEY) : ''}`;
  if(navigator.share && matchMedia('(pointer: coarse)').matches){ try { await navigator.share({ title: 'Join my poker game', text: `Game code ${S.code}`, url }); return; } catch(e){} }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch(e){ prompt('Copy this link', url); }
}
function buildTable(){
  ui.built = true; ui.view = 'table'; ui.fitKey = ui.layoutKey = ''; ui.ringEl = null; ui.boardShown = 0; ui.handShown = null; ui.resultShown = null; ui.instant = true;
  try { sessionStorage.setItem('hgView', 'table'); } catch(e){}
  app.innerHTML = `
  <div class="game ${ui.panelOpen ? 'panel-open' : ''}" id="game">
    <header class="tbar">
      <button class="round-btn" id="backBtn" aria-label="Back to the lobby">${ICON2.back}</button>
      <div class="tbar-title"><span class="code" id="roomCode"></span><span class="status-line" id="statusLine"></span></div>
      <div class="spacer"></div>
      <button class="btn btn-sm hidden" id="reqBtn">Requests <span class="badge" id="reqCount">0</span></button>
      <button class="round-btn" id="menuBtn" aria-label="Table menu">${ICON2.dots}</button>
    </header>
    <section class="stage" id="stage">
      <div class="table" id="table">
        <div class="felt"></div>
        <div class="felt-mark"><div class="game-name">Texas Hold'em</div><div class="blinds" id="feltBlinds"></div></div>
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
    <footer class="bbar">
      <button class="round-btn help-btn" id="helpBtn" aria-label="Hand rankings">?</button>
      <div class="actions" id="actions"></div>
      <div class="bbar-tools">
        <button class="tool-btn ${ui.bbMode ? 'on' : ''}" id="bbBtn" aria-pressed="${!!ui.bbMode}"><span class="tool-ic">BB</span><span>x BB</span></button>
        <button class="tool-btn" id="oddsBtn"><span class="tool-ic">${ICON2.chart}</span><span>odds</span></button>
        <button class="tool-btn" id="reactBtn" aria-label="Send a reaction"><span class="tool-ic emo-ic">😊</span><span>react</span></button>
        <button class="tool-btn" id="chatBtn"><span class="tool-ic">${ICON2.chat}</span><span>chat/log</span><span class="badge hidden" id="chatBadge"></span></button>
      </div>
    </footer>
    <aside class="side ${ui.panelOpen ? 'open' : ''}" id="side">
      <div class="side-head"><div class="tabs" role="tablist" id="sideTabs"></div><button class="round-btn sm" id="sideClose" aria-label="Close panel">✕</button></div>
      <div class="side-body" id="sideBody"></div>
    </aside>
  </div>`;
  $('#backBtn').onclick = () => goLobby();
  $('#menuBtn').onclick = e => tableMenu(e.currentTarget);
  $('#helpBtn').onclick = rankingsDialog;
  $('#bbBtn').onclick = () => { ui.bbMode = !ui.bbMode; $('#bbBtn').classList.toggle('on', ui.bbMode); $('#bbBtn').setAttribute('aria-pressed', ui.bbMode); update(); };
  $('#chatBtn').onclick = () => togglePanel(ui.tab === 'odds' ? 'chat' : ui.tab);
  $('#oddsBtn').onclick = () => togglePanel('odds');
  $('#reactBtn').onclick = e => reactMenu(e.currentTarget);
  $('#sideClose').onclick = () => togglePanel(null);
  $('#reqBtn').onclick = () => goLobby();
  window.onresize = () => S && ui.view === 'table' && layout();
  document.onkeydown = hotkeys;
  if(window.ResizeObserver){ ui.ro && ui.ro.disconnect(); ui.ro = new ResizeObserver(() => S && ui.view === 'table' && layout()); ui.ro.observe($('#stage')); }
}
function togglePanel(tab){
  const open = tab && !(ui.panelOpen && ui.tab === tab);
  ui.panelOpen = !!open;
  if(open){ ui.tab = tab; if(tab === 'chat' || tab === 'log') ui.unread = 0; }
  $('#side').classList.toggle('open', ui.panelOpen);
  $('#game').classList.toggle('panel-open', ui.panelOpen);
  $('#sideBody').dataset.key = ''; $('#sideTabs').dataset.key = '';
  ui.fitKey = ''; renderSide(); layout();
}
// chip amounts, optionally shown in big blinds
const fmtC = n => ui.bbMode && S ? `${(Math.round(n / S.settings.bb * 10) / 10).toLocaleString('en-IN')} BB` : fmt(n);

// Seat positions: the viewer is always at the bottom; the rest go clockwise.
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
// Fit the whole table (seats included) inside the space between the top and bottom bars.
function fitTable(){
  const st = $('#stage'), t = $('#table');
  if(!st || !t) return;
  const W = st.clientWidth, H = st.clientHeight, pt = portrait();
  const ar = pt ? 0.64 : 2.05;
  const w = Math.max(220, Math.min(W * (pt ? 0.9 : 0.84), H * (pt ? 0.86 : 0.78) * ar));
  const fk = `${W}x${H}${pt}`;
  if(ui.fitKey === fk) return;
  ui.fitKey = fk;
  t.style.width = w + 'px'; t.style.height = (w / ar) + 'px';
  const k = pt ? Math.min(1.15, Math.max(0.72, w / 330)) : Math.min(1.2, Math.max(0.55, w / 900));
  const r = document.documentElement.style;
  r.setProperty('--k', k);
  r.setProperty('--cw', (pt ? 40 : 60) * k + 'px');
  r.setProperty('--cw-seat', (pt ? 22 : 38) * k + 'px');
  r.setProperty('--cw-hero', (pt ? 48 : 70) * k + 'px');
}
function layout(){
  fitTable();
  const lk = `${ui.fitKey}|${S.youSeat}|${S.hand ? S.hand.dealerSeat : -1}`;
  if(ui.layoutKey === lk) return;
  ui.layoutKey = lk;
  for(let i = 0; i < 10; i++){
    const v = vis(i), [x, y] = seatXY(v), [bx, by] = toward([x, y], portrait() ? (v === 0 ? .5 : .55) : .58);
    const seat = $('#seat' + i), bet = $('#bet' + i);
    seat.style.left = x + '%'; seat.style.top = y + '%';
    bet.style.left = bx + '%'; bet.style.top = (by + (v === 0 && !portrait() ? -6 : 0)) + '%';
  }
  if(S.hand && S.hand.dealerSeat >= 0){
    const [x, y] = seatXY(vis(S.hand.dealerSeat)), [dx, dy] = toward([x, y], .72);
    const d = $('#dealerBtn'); d.classList.remove('hidden');
    d.style.left = (dx + (x <= 50 ? 6 : -6)) + '%'; d.style.top = dy + '%';
  }
}

/* ================= table: each update ================= */
function update(){
  if(ui.view !== 'table') return;
  if(!ui.built) buildTable();
  const h = S.hand, ph = P && P.hand;
  setText($('#roomCode'), S.code);
  setText($('#feltBlinds'), `Blinds ${fmtC(S.settings.sb)} / ${fmtC(S.settings.bb)}${S.settings.ante ? ` · ante ${fmtC(S.settings.ante)}` : ''}`);
  $('.felt-mark').classList.toggle('quiet', !!h);
  $('#table').classList.toggle('no-hand', !h);
  renderStatus();
  const nReq = S.requests.length + S.joinRequests.length;
  $('#reqBtn').classList.toggle('hidden', !S.isAdmin || !nReq);
  setText($('#reqCount'), String(nReq));
  $('#chatBadge').classList.toggle('hidden', !ui.unread); setText($('#chatBadge'), String(ui.unread));
  layout();
  const newHand = h && h.id !== ui.handShown;
  if(!h && ui.handShown != null){ clearTableForNextHand(); }
  if(newHand && ui.instant) instantHand();
  renderSeats(newHand && !ui.instant);
  renderBets(ph);
  renderPot();
  if(newHand && !ui.instant) startDealAnimation();
  else if(h && !ui.dealing){ syncBoard(); syncBoard2(); syncRabbit(); }
  ui.instant = false;
  renderResult();
  renderWaiting();
  renderActions();
  renderSide();
  if(h && h.actingSeat === S.youSeat && S.youSeat >= 0 && !(ph && ph.actingSeat === S.youSeat && ph.id === h.id)){ SFX.turn(); maybeAutoAct(); }
}
// Arriving at the table mid-hand: show everything as it is, without replaying the deal.
function instantHand(){
  const h = S.hand;
  ui.handShown = h.id; ui.resultShown = h.result ? h.id : null; ui.boardShown = h.board.length;
  const slots = $$('#board .slot');
  h.board.forEach((c, k) => { const el = cardEl(c); el.classList.add('up'); slots[k].innerHTML = ''; slots[k].appendChild(el); });
  if(h.board2){ ui.board2Shown = true; $('#table').classList.add('two-runs'); $('#board2').classList.remove('hidden');
    const s2 = $$('#board2 .slot'); h.board2.forEach((c, k) => { const el = cardEl(c); el.classList.add('up'); s2[k].innerHTML = ''; s2[k].appendChild(el); }); }
  if(h.rabbit){ ui.rabbitShown = true; h.rabbit.forEach((c, k) => { const el = cardEl(c); el.classList.add('up', 'rabbit'); slots[h.board.length + k].innerHTML = ''; slots[h.board.length + k].appendChild(el); }); }
}

function clearTableForNextHand(){
  ui.handShown = null; ui.boardShown = 0; ui.resultShown = null;
  $$('#board .slot, #board2 .slot').forEach(s => s.innerHTML = '');
  $('#board2').classList.add('hidden'); $('#table').classList.remove('two-runs');
  ui.board2Shown = false; ui.rabbitShown = false;
  $('#banner').classList.remove('show');
  $('#dealerBtn').classList.toggle('hidden', true);
  ui.layoutKey = '';
}

function renderSeats(newHand){
  const h = S.hand;
  S.seats.forEach((p, i) => {
    const el = $('#seat' + i);
    if(!p){
      const canSit = S.youSeat < 0 && S.seats.filter(Boolean).length < S.settings.maxPlayers;
      const k = canSit ? 'sit' : 'open';
      if(el.dataset.pid !== k){
        el.dataset.pid = k; el.className = 'seat empty' + (canSit ? ' can-sit' : '');
        el.innerHTML = canSit ? `<button class="empty-chair sit" data-seat="${i}">Sit</button>` : `<div class="empty-chair">Open</div>`;
        if(canSit) el.querySelector('button').onclick = () => joinDialog(i);
      }
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
    setClass(el, 'seat' + (i === S.youSeat ? ' me' : '') + (acting ? ' acting' : '') + (p.folded ? ' folded' : '') +
      (p.sittingOut || (!p.inHand && h) || (p.chips === 0 && !p.inHand) ? ' out' : '') + (!p.connected && !p.isBot ? ' offline' : '') + (winner ? ' winner' : ''));
    setHTML(el.querySelector('.name'), esc(p.name) + (p.isAdmin ? `<span class="host-mark" title="Admin">${ICON2.shield}</span>` : '') + (p.isBot ? '<span class="host-mark botmark" title="Computer player">· bot</span>' : ''));
    setText(el.querySelector('.chips'), (p.chips === 0 && !p.inHand ? 'No chips' : p.standing ? `${fmtC(p.chips)} · leaving` : p.sittingOut ? `${fmtC(p.chips)} · away` : fmtC(p.chips))
      + (p.pendingChips ? ` +${fmtC(p.pendingChips)}` : ''));
    const tag = el.querySelector('.tag');
    const label = p.allIn ? 'All-in' : p.lastAction;
    setText(tag, label || ''); setClass(tag, 'tag' + (label ? ' show' : '') + (p.folded ? ' fold' : '') + (p.allIn ? ' allin' : ''));
    setText(el.querySelector('.hand-name'), p.handName || '');
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
    const d = 70 * ((vis(i) + 9) % 10);
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
  for(let r = 0; r < 2; r++) for(const s of order){ flights.push(fly(slots[s][r], t, r ? 14 : -18)); t += 60; }
  await Promise.all(flights);
  // my cards turn over
  const me = S.seats[S.youSeat];
  if(me && me.inHand && Array.isArray(me.cards) && typeof me.cards[0] === 'number' && slots[S.youSeat]){
    slots[S.youSeat].forEach((el, k) => setFace(el, me.cards[k]));
    await Promise.all(slots[S.youSeat].map((el, k) => flipUp(el, 40 + k * 90)));
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
  queueAnim(async () => {
    if(ui.view !== 'table') return;
    const slots = $$('#board .slot');
    const els = cards.map((c, k) => { const el = cardEl(c); el.style.visibility = 'hidden'; slots[from + k].innerHTML = ''; slots[from + k].appendChild(el); return el; });
    await Promise.all(els.map((el, k) => fly(el, k * 70, -10)));
    await Promise.all(els.map((el, k) => flipUp(el, 60 + k * 90)));
    renderSide();
  });
}

function renderBets(ph){
  S.seats.forEach((p, i) => {
    const el = $('#bet' + i), v = p && p.inHand ? p.bet : 0;
    const prevBet = ph && P.seats[i] && P.hand && S.hand && P.hand.id === S.hand.id ? P.seats[i].bet : 0;
    if(v > 0){ el.classList.remove('zero'); setText(el.querySelector('.v'), fmtC(v)); if(v > prevBet && prevBet >= 0 && P && i !== S.youSeat) SFX.chip(); }
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
  setText($('#potAmt'), fmtC(h.result ? h.result.pot : h.potBehind));
}
function renderResult(){
  const h = S.hand;
  if(!h || !h.result || ui.resultShown === h.id) return;
  ui.resultShown = h.id;
  const delay = h.result.uncontested ? 150 : 350 + (h.board2 ? 300 : 0);
  queueAnim(async () => {
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
      b.querySelector('.who').textContent = ws.length > 1 ? `Split pot · ${ws.map(nm).join(' & ')}` : `${nm(ws[0])} wins ${fmtC(ws[0].amount)}`;
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
  queueAnim(async () => {
    $('#table').classList.add('two-runs'); $('#board2').classList.remove('hidden');
    const slots = $$('#board2 .slot');
    for(let k = 0; k < from; k++){ const el = cardEl(b2[k]); el.classList.add('up', 'shared'); slots[k].innerHTML = ''; slots[k].appendChild(el); }
    const els = [];
    for(let k = from; k < 5; k++){ const el = cardEl(b2[k]); el.style.visibility = 'hidden'; slots[k].innerHTML = ''; slots[k].appendChild(el); els.push(el); }
    await sleep(150);
    await Promise.all(els.map((el, k) => fly(el, k * 80, -10)));
    for(const el of els) await flipUp(el, 90);
  });
}
// Rabbit hunting: after everyone folds, the cards that would have come appear dimmed.
function syncRabbit(){
  const h = S.hand;
  if(!h || !h.rabbit || ui.rabbitShown) return;
  ui.rabbitShown = true;
  queueAnim(async () => {
    await sleep(300);
    const slots = $$('#board .slot');
    const els = h.rabbit.map((c, k) => { const el = cardEl(c); el.classList.add('rabbit'); el.style.visibility = 'hidden'; const sl = slots[h.board.length + k]; sl.innerHTML = ''; sl.appendChild(el); return el; });
    await Promise.all(els.map((el, k) => fly(el, k * 70, -10)));
    await Promise.all(els.map((el, k) => flipUp(el, 60 + k * 90)));
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
  const me = S.youSeat >= 0 ? S.seats[S.youSeat] : null;
  let big, small;
  if(!me){ big = seated.length ? `${seated.length} at the table` : 'The table is empty'; small = 'Press Join Table or tap an empty seat to sit down.'; }
  else if(S.status === 'playing'){ big = ready >= 2 ? (S.settings.autoDeal ? 'Shuffling…' : 'Ready for the next hand') : 'Waiting for players'; small = ready >= 2 ? (S.settings.autoDeal ? '' : S.isAdmin ? 'Deal when everyone is ready.' : 'The admin will deal the next hand.') : 'At least two players with chips are needed.'; }
  else if(S.status === 'paused'){ big = 'Paused'; small = S.isAdmin ? 'Resume when everyone is ready.' : 'The admin will resume the game.'; }
  else { big = `${seated.length} seated`; small = S.isAdmin ? (ready >= 2 ? 'Press Start game when everyone is in.' : 'At least two players need to sit down with chips.') : 'Waiting for the admin to start the game.'; }
  n.classList.remove('hidden');
  setHTML(n, `<div class="big">${esc(big)}</div><div>${esc(small)}</div>`);
}

/* ================= actions ================= */
function renderActions(){
  const box = $('#actions'), o = S.options, me = S.youSeat >= 0 ? S.seats[S.youSeat] : null;
  if(o){
    const key = `${S.hand.id}-${S.hand.street}-${o.currentBet}-${o.myBet}-${ui.bbMode}`;
    if(ui.sentKey === key) return;    // already acted: the server just hasn't answered yet
    if(box.dataset.key === key) return;
    box.dataset.key = key;
    ui.raiseOpen = false;
    const allInCall = o.toCall > 0 && o.toCall >= me.chips;
    const callLabel = o.toCall === 0 ? 'Check' : allInCall ? `All-in<small>${fmtC(o.toCall)}</small>` : `Call<small>${fmtC(o.toCall)}</small>`;
    const verb = o.currentBet === 0 ? 'Bet' : 'Raise';
    ui.raise = o.minRaiseTo;
    box.innerHTML = `
      <button class="btn act-btn fold" id="aFold" ${o.toCall === 0 ? 'disabled title="Nothing to fold to — you can check"' : ''}>Fold<kbd>F</kbd></button>
      <button class="btn act-btn call" id="aCall">${callLabel}<kbd>C</kbd></button>
      ${o.canRaise ? `<button class="btn act-btn raise" id="aRaise">${verb}<small id="aRaiseAmt">${fmtC(o.minRaiseTo)}</small><kbd>R</kbd></button>` : ''}`;
    if(o.canRaise){
      // raise sizes: multiples of the big blind preflop/unopened, multiples of the bet when facing one
      const bb = S.settings.bb, base = o.currentBet > bb ? o.currentBet : bb, baseLabel = base === bb ? 'bb' : '';
      const sizes = [4, 3, 2.5, 2].map(m => ({ m, v: Math.round(base * m) })).filter(x => x.v > o.minRaiseTo - 1 || x.m === 2)
        .map(x => ({ ...x, v: Math.max(o.minRaiseTo, Math.min(o.maxRaiseTo, x.v)) }));
      const pop = document.createElement('div');
      pop.className = 'raise-pop hidden'; pop.id = 'raisePop';
      pop.innerHTML = `
        <div class="rp-grid">
          <div class="rp-presets">${sizes.map(x => `<button class="chip-btn rp-pre" data-v="${x.v}">${x.m}x ${baseLabel}</button>`).join('')}
            <button class="chip-btn rp-pre allin" data-v="${o.maxRaiseTo}">All-in</button></div>
          <input type="range" class="rp-slider" id="rRange" min="${o.minRaiseTo}" max="${o.maxRaiseTo}" step="${S.settings.sb}" value="${o.minRaiseTo}" aria-label="Raise amount" orient="vertical">
        </div>
        <div class="rp-row"><button class="sq-btn" id="rMinus" aria-label="Less">−</button><button class="sq-btn blue" id="rPlus" aria-label="More">+</button>
          <input type="number" id="rNum" min="${o.minRaiseTo}" max="${o.maxRaiseTo}" value="${o.minRaiseTo}" aria-label="${verb} to"></div>
        <div class="rp-note" id="rNote"></div>`;
      box.appendChild(pop);
      const setRaise = v => {
        v = Math.max(o.minRaiseTo, Math.min(o.maxRaiseTo, Math.round(Number(v) || 0)));
        ui.raise = v; $('#rRange').value = v; $('#rNum').value = v;
        $('#aRaiseAmt').textContent = v === o.maxRaiseTo ? `All-in ${fmtC(v)}` : fmtC(v);
        $('#rNote').textContent = v === o.maxRaiseTo ? 'all-in' : `(${verb.toLowerCase()} to ${fmtC(v)})`;
      };
      setRaise(o.minRaiseTo);
      $('#rRange').oninput = e => setRaise(e.target.value);
      $('#rNum').oninput = e => { ui.raise = Number(e.target.value); };
      $('#rNum').onchange = e => setRaise(e.target.value);
      $('#rMinus').onclick = () => setRaise(ui.raise - bb);
      $('#rPlus').onclick = () => setRaise(ui.raise + bb);
      $$('.rp-pre', pop).forEach(b => b.onclick = () => setRaise(b.dataset.v));
      // first tap opens the sizes; tapping Raise again sends it
      $('#aRaise').onclick = () => {
        if(!ui.raiseOpen){ ui.raiseOpen = true; pop.classList.remove('hidden'); $('#aRaise').classList.add('armed'); return; }
        act('raise', ui.raise);
      };
    }
    $('#aCall').onclick = () => act(o.toCall === 0 ? 'check' : 'call');
    $('#aFold').onclick = () => act('fold');
    return;
  }
  const acting = S.hand && S.hand.actingSeat >= 0 ? S.seats[S.hand.actingSeat] : null;
  const handOn = S.hand && !S.hand.result;
  const ready = S.seats.filter(p => p && p.chips > 0).length;
  const key = `idle-${S.status}-${S.youSeat}-${me && me.sittingOut}-${me && me.chips}-${me && me.standing}-${me && me.allIn}-${S.myWallet}-${S.hand && S.hand.id}-${S.hand && S.hand.street}-${S.hand && S.hand.actingSeat}-${!!handOn}-${ui.pre}-${S.isAdmin}-${ready}-${S.settings.autoDeal}-${S.settings.timerOn}`;
  if(box.dataset.key === key) return;
  box.dataset.key = key;
  let html = '', note = '';
  const adminStart = S.isAdmin && S.status !== 'playing'
    ? `<button class="btn btn-primary" id="hStart" ${ready < 2 ? 'disabled' : ''}>${S.status === 'paused' ? 'Resume game' : 'Start game'}</button>` : '';
  const adminDeal = S.isAdmin && S.status === 'playing' && !S.hand && !S.settings.autoDeal
    ? `<button class="btn btn-primary" id="hDeal">Deal next hand</button><button class="btn" id="hBomb">Bomb pot</button>` : '';
  if(!me){
    html += `<button class="btn btn-go" id="joinBtn">Join Table</button>` + adminStart;
    note = S.isAdmin ? 'Spectating as admin' : 'Spectating';
  } else if(me.chips === 0 && !(me.inHand && handOn)){
    html += `<button class="btn btn-primary" id="topBtn">Add chips</button><button class="btn" id="standBtn">Stand up</button>` + adminStart;
    note = 'You are out of chips';
  } else if(me.sittingOut){
    html += `<button class="btn btn-primary" id="sitIn">I'm back</button>` + adminStart + adminDeal;
    note = 'You are away';
  } else if(S.hand && me.inHand && !me.folded && !me.allIn && handOn){
    const pk = `${S.hand.id}-${S.hand.street}`;
    if(ui.preKey !== pk){ ui.preKey = pk; ui.pre = null; }
    html += ['chkfold:Chk / Fold', 'check:Check', 'callany:Call Any'].map(x => { const [k, l] = x.split(':');
      return `<button class="btn act-btn pre ${ui.pre === k ? 'on' : ''}" data-pre="${k}" aria-pressed="${ui.pre === k}">${l}<span class="tick"></span></button>`; }).join('');
    note = acting ? `${esc(acting.name)} is deciding…` : '';
  } else {
    html += adminStart + adminDeal;
    note = S.hand ? (me.folded ? 'You folded' : me.inHand ? '' : 'You play from the next hand') + (acting ? `${me.folded || !me.inHand ? ' · ' : ''}${esc(acting.name)} is deciding…` : '')
      : S.status === 'playing' ? (ready >= 2 ? (S.settings.autoDeal ? 'Shuffling…' : S.isAdmin ? '' : 'Waiting for the admin to deal') : 'Waiting for players') : S.isAdmin ? '' : 'Waiting for the admin to start';
  }
  if(S.isAdmin && acting && acting.id !== S.you && !acting.isBot && !S.settings.timerOn) html += `<button class="btn btn-sm" id="hSkip">Skip ${esc(acting.name)}</button>`;
  box.innerHTML = html + (note ? `<span class="idle-note">${note}</span>` : '');
  const on = (id, fn) => { if($('#' + id)) $('#' + id).onclick = fn; };
  on('joinBtn', () => joinDialog(null));
  on('hStart', () => host('start'));
  on('hDeal', () => host('deal'));
  on('hBomb', async () => { const r = await host('bomb'); if(r.ok) host('deal'); });
  on('hSkip', () => host('skip'));
  on('topBtn', topUpDialog);
  on('standBtn', () => emit('stand'));
  on('sitIn', async () => { const r = await emit('sitOut', { value: false }); if(!r.ok) toast(r.error, true); });
  $$('[data-pre]', box).forEach(b => b.onclick = () => { ui.pre = ui.pre === b.dataset.pre ? null : b.dataset.pre; box.dataset.key = ''; renderActions(); });
}
// The buttons go away the moment you tap, without waiting for the server to answer.
async function act(type, amount){
  const box = $('#actions');
  if(ui.sentKey && ui.sentKey === (box && box.dataset.key)) return;   // no double taps
  ui.sentKey = box ? box.dataset.key : null;
  if(box){
    const word = { fold: 'You fold', check: 'You check', call: 'You call', raise: S.options && S.options.currentBet === 0 ? 'You bet' : 'You raise' }[type] || '';
    box.innerHTML = `<span class="idle-note">${word}${type === 'raise' && amount ? ' ' + fmtC(amount) : ''}</span>`;
    if(type === 'call' || type === 'raise') SFX.chip();
  }
  const r = await emit('action', { type, amount });
  if(!r.ok){ ui.sentKey = null; if(box) box.dataset.key = ''; toast(r.error, true); if(S) renderActions(); }
}
// A pre-selected move is played the moment it becomes your turn.
function maybeAutoAct(){
  const o = S.options, pre = ui.pre;
  if(!pre || !o) return;
  ui.pre = null;
  if(pre === 'chkfold') act(o.toCall === 0 ? 'check' : 'fold');
  else if(pre === 'check'){ if(o.toCall === 0) act('check'); }   // someone bet: let you decide
  else if(pre === 'callany') act(o.toCall === 0 ? 'check' : 'call');
}
function hotkeys(e){
  if(!S || !S.options || /input|textarea|select/i.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase();
  if(k === 'f' && $('#aFold') && !$('#aFold').disabled) $('#aFold').click();
  else if(k === 'c' && $('#aCall')) $('#aCall').click();
  else if((k === 'r' || k === 'b') && $('#aRaise')) $('#aRaise').click();
  else if(k === 'escape' && ui.raiseOpen){ ui.raiseOpen = false; $('#raisePop').classList.add('hidden'); $('#aRaise').classList.remove('armed'); }
}
async function host(cmd, extra = {}){
  const r = await emit('host', { cmd, ...extra });
  if(!r.ok) toast(r.error, true);
  return r;
}

/* ================= timer ring ================= */
function tickTimers(){
  requestAnimationFrame(tickTimers);
  const h = S && ui.built && ui.view === 'table' && !document.hidden ? S.hand : null;
  const seat = h && h.timerOn && h.actingSeat >= 0 ? h.actingSeat : -1;
  const c = seat >= 0 ? $(`#seat${seat} .ring circle`) : null;
  if(ui.ringEl && ui.ringEl !== c){ ui.ringEl.style.strokeDashoffset = 113.1; ui.ringEl = null; }
  if(!c) return;
  ui.ringEl = c;
  const left = Math.max(0, h.turnMsLeft - (performance.now() - receivedAt));
  const off = (113.1 * (1 - left / h.turnMs)).toFixed(1), col = h.bankPhase ? 'var(--good)' : left < 5000 ? 'var(--danger)' : 'var(--brass)';
  if(c._off !== off){ c._off = off; c.style.strokeDashoffset = off; }
  if(c._col !== col){ c._col = col; c.style.stroke = col; }
  if(h.actingSeat === S.youSeat && left < 5000){
    const sec = Math.ceil(left / 1000);
    if(sec !== ui.lastTick){ ui.lastTick = sec; if(sec > 0) SFX.tick(); }
  }
}
requestAnimationFrame(tickTimers);

/* ================= side panel ================= */
function renderSide(){
  if(ui.view !== 'table' || !$('#sideTabs')) return;
  const tabs = [['chat', 'Chat' + (ui.unread && ui.tab !== 'chat' ? ` · ${ui.unread}` : '')], ['log', 'Log'], ['odds', 'Odds']];
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
  else renderChat(body);
}

function renderOdds(body){
  const h = S.hand, me = S.youSeat >= 0 ? S.seats[S.youSeat] : null;
  const shownBoard = h ? h.board.slice(0, ui.boardShown) : [];
  const live = h && !h.result && me && me.inHand && !me.folded && Array.isArray(me.cards) && typeof me.cards[0] === 'number' && !ui.dealing;
  const k = h ? h.liveOpponents : 0;
  const key = live ? `${me.cards.join(',')}|${shownBoard.join(',')}|${k}|${S.options ? S.options.toCall + '/' + S.options.pot : ''}` : `none-${h ? h.id : 'x'}-${me && me.folded}-${h && !!h.result}`;
  // odds are only worked out while the panel is open, so they never slow the table down
  const shown = ui.panelOpen && ui.tab === 'odds';
  if(live && k >= 1 && !shown){ body.dataset.key = ''; return; }
  if(body.dataset.key === key) return;
  body.dataset.key = key;
  if(!live || k < 1){
    body.innerHTML = `<div class="odds"><h3>Your odds</h3><p class="method">${!me ? 'Take a seat to see your odds.' : h && h.result ? 'Hand over — the next one is coming.' : me && me.folded ? 'You folded this hand.' : h ? 'Shown once you have cards and an opponent.' : 'Shown when the next hand is dealt.'}</p>
      <p style="color:var(--text-dim);font-size:14px">Probabilities assume every unknown card is random. Heads-up they are exact on every street; three-handed they are exact from the flop; bigger pots are simulated with a 95% confidence interval.</p></div>`;
    return;
  }
  const ekey = `${me.cards.join(',')}|${shownBoard.join(',')}|${k}`;
  if(ui.eqKey !== ekey){ ui.eqKey = ekey; ui.eq = null; equityAsync(me.cards, shownBoard, k, ekey); }
  const e = ui.eq;
  if(!e){ body.dataset.key = ''; body.innerHTML = `<div class="odds"><h3>Your odds</h3><p class="method">Working out your odds…</p></div>`; return; }
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
// The odds maths runs in a background worker so cards and buttons never freeze while it counts.
let eqWorker = null, eqJob = null;
function equityAsync(cards, board, k, ekey){
  const done = (key, r) => { if(ui.eqKey !== key) return; ui.eq = r; if(ui.view === 'table' && $('#sideBody')){ $('#sideBody').dataset.key = ''; renderSide(); } };
  const onMain = () => setTimeout(() => done(ekey, PokerEngine.equity(cards, board, k)), 30);
  eqJob = { cards, board, k, key: ekey };
  if(eqWorker === 'off' || !window.Worker) return onMain();
  try {
    if(!eqWorker){
      const src = `importScripts(${JSON.stringify(location.origin + '/engine.js')});onmessage=e=>postMessage({key:e.data.key,r:PokerEngine.equity(e.data.cards,e.data.board,e.data.k)});`;
      eqWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      eqWorker.onmessage = e => done(e.data.key, e.data.r);
      // if the worker can't start, do the maths on the page instead
      eqWorker.onerror = () => { eqWorker = 'off'; const j = eqJob; if(j) setTimeout(() => done(j.key, PokerEngine.equity(j.cards, j.board, j.k)), 30); };
    }
    eqWorker.postMessage(eqJob);
  } catch(err){ eqWorker = 'off'; onMain(); }
}
function renderLog(body){
  const key = 'log' + (S.log[0] ? S.log[0].t + S.log.length : '');
  if(body.dataset.key === key) return; body.dataset.key = key;
  body.innerHTML = S.log.map(l => `<div class="log-item ${l.kind}">${esc(l.text)}</div>`).join('') || '<p class="log-item">Nothing yet.</p>';
}
const EMOJIS = ['😂','🤣','😭','😎','🤔','😮','😤','😡','🥲','😅','🙏','👍','👏','🔥','💀','🤡','🐟','🦈','🃏','♠️','💰','💸','🎉','🍀','🚀','🤯','😴','🙈','❤️','👀'];
const QUICK = ['👍','😂','🔥','😭','😮','🙏'];
const emojiOnly = t => /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(t) && [...t.replace(/\s|\uFE0F|\u200D/g, '')].length <= 3;
async function sendChat(text){
  text = String(text || '').trim(); if(!text) return false;
  const r = await emit('chat', { text });
  if(!r.ok){ toast(r.error, true); return false; }
  return true;
}
function renderChat(body){
  if(!$('#chatForm', body)){
    body.dataset.key = '';
    body.innerHTML = `<div class="chat-list" id="chatList"></div>
      <div class="chat-dock">
        <div class="quick-row">${QUICK.map(e => `<button type="button" class="quick-emo" data-emo="${e}" aria-label="Send ${e}">${e}</button>`).join('')}</div>
        <div class="emoji-grid ${ui.emojiOpen ? '' : 'hidden'}" id="emojiGrid">${EMOJIS.map(e => `<button type="button" data-ins="${e}">${e}</button>`).join('')}</div>
        <form class="chat-form" id="chatForm"><button type="button" class="emo-btn ${ui.emojiOpen ? 'on' : ''}" id="emoBtn" aria-label="Emojis">😊</button><input id="chatIn" maxlength="200" placeholder="Message the table" autocomplete="off"><button class="btn btn-sm">Send</button></form>
      </div>`;
    $('#chatIn').value = ui.chatDraft || '';
    $('#chatIn').oninput = e => { ui.chatDraft = e.target.value; };
    $('#emoBtn').onclick = () => { ui.emojiOpen = !ui.emojiOpen; $('#emojiGrid').classList.toggle('hidden', !ui.emojiOpen); $('#emoBtn').classList.toggle('on', ui.emojiOpen); };
    $$('[data-ins]', body).forEach(b => b.onclick = () => {
      const i = $('#chatIn'), at = i.selectionStart ?? i.value.length, end = i.selectionEnd ?? at;
      if(i.value.length + b.dataset.ins.length > 200) return;
      i.value = i.value.slice(0, at) + b.dataset.ins + i.value.slice(end); ui.chatDraft = i.value;
      const pos = at + b.dataset.ins.length; if(!matchMedia('(pointer: coarse)').matches){ i.focus(); i.setSelectionRange(pos, pos); }
    });
    $$('[data-emo]', body).forEach(b => b.onclick = () => sendChat(b.dataset.emo));
    $('#chatForm').onsubmit = async e => {
      e.preventDefault(); const t = $('#chatIn').value.trim(); if(!t) return;
      $('#chatIn').value = ''; ui.chatDraft = '';
      if(!(await sendChat(t))){ $('#chatIn').value = t; ui.chatDraft = t; }
    };
  }
  const key = 'chat' + (S.chat.at(-1) ? S.chat.at(-1).id + '-' + S.chat.length : '0');
  if(body.dataset.key === key) return; body.dataset.key = key;
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  $('#chatList').innerHTML = S.chat.map(m => `<div class="chat-msg ${emojiOnly(m.text) ? 'emo' : ''}"><b style="color:${AV_COLORS[Math.max(0, m.seat) % AV_COLORS.length]}">${esc(m.name)}</b><span>${esc(m.text)}</span></div>`).join('') || '<p class="log-item">Say hello to the table.</p>';
  if(nearBottom || !body._seen){ body.scrollTop = body.scrollHeight; body._seen = true; }
}
// A message pops up above the sender's seat on the table for a few seconds.
function chatBubble(m){
  if(ui.view !== 'table' || !S || !$('#table')) return;
  const seat = S.seats.findIndex(p => p && p.id === m.pid);
  if(seat < 0) return;                                   // spectators only show in the chat list
  const el = $('#seat' + seat); if(!el) return;
  const old = $(`.chat-bubble[data-seat="${seat}"]`); if(old) old.remove();
  const b = document.createElement('div');
  const below = el.offsetTop - el.offsetHeight / 2 < 70;  // seats at the very top get the bubble underneath
  b.className = 'chat-bubble' + (below ? ' below' : '') + (emojiOnly(m.text) ? ' emo' : '');
  b.dataset.seat = seat;
  b.textContent = m.text;
  b.style.top = (below ? el.offsetTop + el.offsetHeight / 2 + 4 : el.offsetTop - el.offsetHeight / 2 - 4) + 'px';
  $('#table').appendChild(b);
  // keep the whole bubble on screen; the little tail still points at the player
  const tr = $('#table').getBoundingClientRect(), w = b.offsetWidth, x = el.offsetLeft;
  const cx = Math.max(8 - tr.left + w / 2, Math.min(innerWidth - tr.left - 8 - w / 2, x));
  b.style.left = cx + 'px';
  b.style.setProperty('--tail', Math.max(-w / 2 + 14, Math.min(w / 2 - 14, x - cx)) + 'px');
  if(m.pid !== S.you) SFX.chat && SFX.chat();
  const ms = Math.min(7000, 3200 + m.text.length * 45);
  setTimeout(() => { b.classList.add('bye'); setTimeout(() => b.remove(), 300); }, ms);
}
// Quick reactions from the bottom bar, without opening the chat.
function reactMenu(anchor){
  const old = $('.react-pop'); if(old){ old.remove(); return; }
  const m = document.createElement('div'); m.className = 'react-pop';
  m.innerHTML = EMOJIS.slice(0, 18).map(e => `<button type="button" data-r="${e}">${e}</button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.left + r.width / 2 - m.offsetWidth / 2)) + 'px';
  m.style.top = (r.top - m.offsetHeight - 10) + 'px';
  $$('[data-r]', m).forEach(b => b.onclick = () => { sendChat(b.dataset.r); m.remove(); });
  setTimeout(() => document.addEventListener('pointerdown', function off(e){ if(!m.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)){ m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
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
  const me = S.members.find(m => m.id === S.you);
  const net = me ? me.net : 0;
  confirmDialog('Leave this game?', `You'll leave ${net >= 0 ? 'up' : 'down'} ${fmt(Math.abs(net))}. Any live hand is folded and your chips go back to the admin.`, 'Leave game', async () => {
    await emit('leave'); saveSession(null); S = null; history.replaceState(null, '', '/'); landing('join');
  });
}
// mode: 'ask' (a player asks the admin), 'give' or 'take' (the admin, on a wallet)
function chipsDialog(mode, playerId){
  const p = S.members.find(m => m.id === (playerId || S.you));
  if(!p) return;
  const self = p.id === S.you;
  const title = mode === 'ask' ? 'Ask for chips' : mode === 'give' ? (self ? 'Give yourself chips' : `Give ${p.name} chips`) : `Take chips from ${p.name}`;
  const text = mode === 'ask' ? `${S.adminName || 'The admin'} will see your request and decide how many to give you.`
    : mode === 'give' ? `The chips go into ${self ? 'your' : 'their'} wallet. ${self ? 'You' : 'They'} use them to buy in at the table.`
    : `${self ? 'Your' : 'Their'} wallet has ${fmt(p.wallet)}. Taking chips back counts as cashing out.`;
  const def = mode === 'take' ? p.wallet : S.settings.defaultBuyIn;
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<form class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p>
    <div class="field"><label for="chAmt">Chips</label><input id="chAmt" type="number" min="1" ${mode === 'take' ? `max="${p.wallet}"` : ''} value="${def}"></div>
    <div class="quick">${(mode === 'take' ? [0.25, 0.5, 1].map(f => Math.floor(p.wallet * f)) : [0.5, 1, 2].map(f => Math.round(S.settings.defaultBuyIn * f))).filter(v => v > 0).map(v => `<button type="button" class="btn btn-sm" data-v="${v}">${fmt(v)}</button>`).join('')}</div>
    <div class="error" id="chErr"></div>
    <div class="btns"><button type="button" class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary">${mode === 'ask' ? 'Send request' : mode === 'give' ? 'Give chips' : 'Take chips'}</button></div></form>`;
  document.body.appendChild(m);
  $$('[data-v]', m).forEach(b => b.onclick = () => $('#chAmt').value = b.dataset.v);
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.onclick = e => { if(e.target === m) m.remove(); };
  m.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const amount = Number($('#chAmt').value);
    const r = mode === 'ask' ? await emit('requestChips', { amount }) : await emit('host', { cmd: mode, playerId: p.id, amount });
    if(!r.ok) return $('#chErr').textContent = r.error;
    m.remove(); toast(mode === 'ask' ? 'Request sent' : mode === 'give' ? 'Chips given' : 'Chips taken back');
  };
  $('#chAmt').select();
}
function settingsDialog(){
  const ro = !S.isAdmin;
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<form class="modal wide ${ro ? 'readonly' : ''}" id="setDlg"><div class="modal-head"><h3>${ro ? 'Game settings' : 'Table settings'}</h3><button type="button" class="round-btn sm" data-x aria-label="Close">✕</button></div>
    <div class="modal-scroll"><fieldset class="plain" ${ro ? 'disabled' : ''}>${settingsFields(S.pendingSettings || S.settings)}</fieldset></div>
    <p class="dim small">${ro ? `Only ${esc(S.adminName || 'the admin')} can change these.` : S.hand ? 'A hand is in progress, so changes apply from the next hand.' : 'Changes apply straight away.'}</p>
    <div class="error" id="setErr"></div>
    <div class="btns">${ro ? '<button type="button" class="btn btn-primary" data-x>Close</button>' : '<button type="button" class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary">Save settings</button>'}</div></form>`;
  document.body.appendChild(m);
  const form = $('#setDlg');
  wireSettings(form);
  if(ro) $$('.preset-row', form).forEach(el => el.remove());
  $$('[data-x]', m).forEach(b => b.onclick = () => m.remove());
  form.onsubmit = async e => {
    e.preventDefault();
    if(ro) return m.remove();
    const r = await emit('host', { cmd: 'settings', settings: readSettings(form) });
    if(!r.ok) return $('#setErr').textContent = r.error;
    m.remove(); toast('Settings saved');
  };
}
// Sit down: choose a buy-in from the wallet.
function joinDialog(seat){
  const s = S.settings, wallet = S.myWallet;
  const seated = S.seats.filter(Boolean).length;
  if(seated >= s.maxPlayers) return toast('The table is full.', true);
  const def = wallet > 0 ? Math.min(wallet, s.defaultBuyIn) : s.defaultBuyIn;
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<form class="modal buyin"><h3>Enter a buy-in amount</h3>
    <input id="biAmt" class="big-input" type="number" min="1" value="${def}" aria-label="Buy-in amount">
    <div class="bi-meta"><span>${seated}/${s.maxPlayers} seated</span><span>Blinds ${fmt(s.sb)}/${fmt(s.bb)}</span></div>
    <div class="bi-wallet" id="biWallet"></div>
    <div class="error" id="biErr"></div>
    <div class="btns center"><button type="button" class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-go" id="biGo">Buy in</button></div>
  </form>`;
  document.body.appendChild(m);
  const amt = $('#biAmt');
  const sync = () => {
    const v = Math.floor(Number(amt.value) || 0), short = v > wallet;
    $('#biGo').disabled = short || v <= 0;
    $('#biWallet').innerHTML = `<div>Wallet: <b>${fmt(wallet)}</b></div>` + (short ? `<div class="warn">Not enough chips. ${S.isAdmin ? 'Give yourself chips first.' : `Ask ${esc(S.adminName || 'the admin')} for chips.`}</div>
      ${S.isAdmin ? `<button type="button" class="btn btn-sm" id="biSelf">Give myself ${fmt(v - wallet > 0 ? v - wallet : s.defaultBuyIn)}</button>`
        : S.myRequest ? `<div class="dim small">You asked for ${fmt(S.myRequest)} — waiting for the admin.</div>` : `<button type="button" class="btn btn-sm" id="biAsk">Ask for ${fmt(v - wallet)}</button>`}` : '');
    if($('#biAsk')) $('#biAsk').onclick = async () => { const r = await emit('requestChips', { amount: v - wallet }); if(!r.ok) return $('#biErr').textContent = r.error; toast('Request sent'); m.remove(); };
    if($('#biSelf')) $('#biSelf').onclick = async () => { const r = await host('give', { playerId: S.you, amount: v - wallet }); if(r.ok){ m.remove(); setTimeout(() => joinDialog(seat), 150); } };
  };
  amt.oninput = sync; sync();
  m.querySelector('[data-x]').onclick = () => m.remove();
  m.onclick = e => { if(e.target === m) m.remove(); };
  m.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const r = await emit('sit', { seat, amount: Number(amt.value) });
    if(!r.ok) return $('#biErr').textContent = r.error;
    m.remove();
  };
  amt.select();
}
function topUpDialog(){
  const wallet = S.myWallet;
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<form class="modal buyin"><h3>Add chips to your stack</h3>
    <input id="tuAmt" class="big-input" type="number" min="1" value="${Math.min(wallet, S.settings.defaultBuyIn) || S.settings.defaultBuyIn}">
    <div class="bi-wallet"><div>Wallet: <b>${fmt(wallet)}</b></div>${wallet ? '' : `<div class="warn">Your wallet is empty. ${S.isAdmin ? 'Give yourself chips in the lobby.' : `Ask ${esc(S.adminName || 'the admin')} for chips.`}</div>`}</div>
    <div class="error" id="tuErr"></div>
    <div class="btns center"><button type="button" class="btn btn-ghost" data-x>Cancel</button>${wallet ? '<button class="btn btn-go">Add chips</button>' : S.isAdmin ? '' : '<button type="button" class="btn btn-primary" id="tuAsk">Ask for chips</button>'}</div></form>`;
  document.body.appendChild(m);
  m.querySelector('[data-x]').onclick = () => m.remove();
  if($('#tuAsk')) $('#tuAsk').onclick = () => { m.remove(); chipsDialog('ask'); };
  m.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const r = await emit('topUp', { amount: Number($('#tuAmt').value) });
    if(!r.ok) return $('#tuErr').textContent = r.error;
    m.remove();
  };
}
// A small menu that opens next to the button that was pressed.
function popMenu(anchor, items){
  $$('.pop').forEach(x => x.remove());
  items = items.filter(Boolean);
  if(!items.length) return;
  const m = document.createElement('div'); m.className = 'pop'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : `<button role="menuitem" class="${it.danger ? 'danger' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  let x = r.right - w, y = r.bottom + 6;
  if(x < 8) x = Math.min(r.left, innerWidth - w - 8);
  if(y + h > innerHeight - 8) y = r.top - h - 6;
  m.style.left = Math.max(8, x) + 'px'; m.style.top = Math.max(8, y) + 'px';
  $$('button', m).forEach(b => b.onclick = () => { m.remove(); items[b.dataset.i].fn(); });
  setTimeout(() => document.addEventListener('pointerdown', function off(e){ if(!m.contains(e.target)){ m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
function memberItems(mb){
  const self = mb.id === S.you, admin = S.isAdmin;
  if(admin) return [
    { label: self ? 'Give myself chips' : 'Give chips', fn: () => chipsDialog('give', mb.id) },
    mb.wallet > 0 && { label: 'Take chips back', fn: () => chipsDialog('take', mb.id) },
    mb.seat >= 0 && !mb.isBot && { label: self ? 'Stand up' : 'Stand them up', fn: () => host('standUp', { playerId: mb.id }) },
    !self && !mb.isBot && { label: 'Make admin', fn: () => confirmDialog(`Make ${mb.name} the admin?`, 'They will control chips and settings, and you will become a regular player.', 'Make admin', () => host('makeHost', { playerId: mb.id }), false) },
    !self && { label: 'Remove from game', danger: true, fn: () => confirmDialog(`Remove ${mb.name}?`, 'They fold any live hand and leave the game.', 'Remove', () => host('kick', { playerId: mb.id })) },
    self && '-', self && { label: 'Leave game', danger: true, fn: confirmLeave },
  ];
  if(self) return [
    { label: 'Ask for chips', fn: () => chipsDialog('ask') },
    S.myRequest && { label: 'Cancel my chip request', fn: () => emit('cancelRequest') },
    mb.seat >= 0 && { label: 'Stand up', fn: () => emit('stand') },
    '-', { label: 'Leave game', danger: true, fn: confirmLeave },
  ];
  return [];
}
function tableMenu(anchor){
  const me = S.youSeat >= 0 ? S.seats[S.youSeat] : null, a = S.isAdmin;
  popMenu(anchor, [
    { label: 'Invite friends', fn: invite },
    { label: ui.muted ? 'Turn sound on' : 'Turn sound off', fn: () => { ui.muted = !ui.muted; } },
    { label: a ? 'Table settings' : 'Game settings', fn: settingsDialog },
    a && (S.status === 'playing' ? { label: 'Pause after this hand', fn: () => host('pause') } : { label: S.status === 'paused' ? 'Resume game' : 'Start game', fn: () => host('start') }),
    a && !S.bombNext && { label: 'Bomb pot next hand', fn: () => host('bomb') },
    a && { label: 'Add a computer player', fn: () => host('addBot') },
    me && '-',
    me && { label: 'Add chips to my stack', fn: topUpDialog },
    me && me.chips > 0 && { label: me.sittingOut ? "I'm back" : 'Sit out next hand', fn: () => emit('sitOut', { value: !me.sittingOut }) },
    me && { label: 'Stand up', fn: () => emit('stand') },
    '-',
    { label: 'Back to lobby', fn: goLobby },
  ]);
}
const CARD = (r, s) => `<span class="mc ${s === '♥' || s === '♦' ? 'red' : ''}">${r}<i>${s}</i></span>`;
function rankingsDialog(){
  const H = [
    ['Royal flush', 'A, K, Q, J and 10, all the same suit. The best hand in poker.', ['A♠','K♠','Q♠','J♠','10♠']],
    ['Straight flush', 'Five cards in a row, all the same suit.', ['9♥','8♥','7♥','6♥','5♥']],
    ['Four of a kind', 'Four cards of the same rank.', ['Q♣','Q♦','Q♥','Q♠','7♦']],
    ['Full house', 'Three of a kind plus a pair. Higher three of a kind wins.', ['K♠','K♥','K♦','4♣','4♠']],
    ['Flush', 'Any five cards of the same suit. Highest card wins between flushes.', ['A♦','J♦','8♦','6♦','2♦']],
    ['Straight', 'Five cards in a row of mixed suits. The ace can be high (10-J-Q-K-A) or low (A-2-3-4-5).', ['10♣','9♦','8♠','7♥','6♣']],
    ['Three of a kind', 'Three cards of the same rank.', ['7♠','7♥','7♦','K♣','2♠']],
    ['Two pair', 'Two different pairs. The higher pair decides, then the lower, then the fifth card.', ['J♥','J♣','4♦','4♠','A♥']],
    ['One pair', 'Two cards of the same rank.', ['10♠','10♥','K♦','6♣','3♠']],
    ['High card', 'None of the above. The highest card plays.', ['A♣','J♦','8♥','5♠','3♣']],
  ];
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<div class="modal wide rankings" role="dialog" aria-modal="true"><div class="modal-head"><h3>Hand rankings</h3><button class="round-btn sm" data-x aria-label="Close">✕</button></div>
    <div class="modal-scroll">
      <p class="dim">Best hand at the top. You make your best five-card hand from your two cards plus the five shared cards on the table.</p>
      <ol class="rank-list">${H.map(([n, d, c], i) => `<li><span class="rk-no">${i + 1}</span><div class="rk-body"><div class="rk-name">${n}</div><div class="rk-desc">${d}</div></div><div class="rk-cards">${c.map(x => CARD(x.slice(0, -1), x.slice(-1))).join('')}</div></li>`).join('')}</ol>
      <div class="howto">
        <div class="section-title">How a hand works</div>
        <ol>
          <li>Everyone gets two private cards. The two players left of the dealer put in the small and big blind.</li>
          <li>Betting goes round the table. On your turn you can <b>fold</b> (give up), <b>check</b> (pass, if nobody has bet), <b>call</b> (match the bet) or <b>raise</b> (bet more).</li>
          <li>Three shared cards come out (the flop), then one (the turn), then one more (the river), with a round of betting after each.</li>
          <li>Whoever is left shows their cards. The best five-card hand wins the pot; equal hands split it.</li>
        </ol>
        <p class="dim small">Suits never rank above each other, and cards that don't make your five don't count.</p>
      </div>
    </div></div>`;
  document.body.appendChild(m);
  $$('[data-x]', m).forEach(b => b.onclick = () => m.remove());
  m.onclick = e => { if(e.target === m) m.remove(); };
}
function chipsHelpDialog(){
  const m = document.createElement('div'); m.className = 'modal-back';
  m.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h3>How chips work</h3><button class="round-btn sm" data-x aria-label="Close">✕</button></div>
    <ol class="help-list">
      <li><b>The admin hands out chips.</b> ${esc(S.adminName || 'The admin')} puts chips into each player's wallet. Ask with the menu next to your name.</li>
      <li><b>Buy in at the table.</b> Press Table, then Join Table, and choose how many chips from your wallet to sit down with.</li>
      <li><b>Standing up</b> moves your stack back into your wallet.</li>
      <li><b>+/−</b> shows how far each player is up or down against the chips they were given, so settling up is easy.</li>
    </ol>
    <div class="btns"><button class="btn btn-primary" data-x>Got it</button></div></div>`;
  document.body.appendChild(m);
  $$('[data-x]', m).forEach(b => b.onclick = () => m.remove());
}

/* ================= waiting for the admin ================= */
function waitingPage(st){
  ui.view = 'waiting'; ui.built = false;
  app.innerHTML = `<main class="waiting-page"><div class="wait-card">
    <div class="wait-dots"><span></span><span></span><span></span></div>
    <h2>Waiting for ${esc(st.adminName || 'the admin')}</h2>
    <p>You've asked to join game <b>${esc(st.code)}</b>. You'll be let in as soon as the admin approves.</p>
    <button class="btn btn-ghost" id="wCancel">Cancel</button></div></main>`;
  $('#wCancel').onclick = async () => { await emit('leave'); saveSession(null); S = null; history.replaceState(null, '', '/'); landing('join'); };
}

/* ================= lobby ================= */
function goLobby(){
  ui.view = 'lobby'; ui.built = false; ui.lobbyKey = '';
  if(ui.ro){ ui.ro.disconnect(); ui.ro = null; }
  window.onresize = null; document.onkeydown = null;
  try { sessionStorage.setItem('hgView', 'lobby'); } catch(e){}
  if(S) renderLobby();
}
function goTable(){ ui.view = 'table'; ui.built = false; update(); }
function goHome(){
  ui.view = 'home';
  try { sessionStorage.setItem('hgView', 'home'); } catch(e){}
  history.replaceState(null, '', '/');
  landing('join');
}
function renderLobby(){
  if(ui.view !== 'lobby' || !S) return;
  const s = S.settings;
  const key = JSON.stringify([S.members, s, S.requests, S.joinRequests, S.myWallet, S.isAdmin, S.handCount, S.hand && S.hand.id, S.status, S.seats.filter(Boolean).length]);
  if(ui.lobbyKey === key) return;
  ui.lobbyKey = key;
  const seatedN = S.seats.filter(Boolean).length;
  const sgn = n => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
  app.innerHTML = `
  <main class="lobby">
    <header class="lbar">
      <button class="round-btn" id="lBack" aria-label="Back to the home screen">${ICON2.back}</button>
      <div class="lcode"><div class="lbl">Game code</div><div class="val">${esc(S.code)} <button class="ghost-ic" id="lShare" aria-label="Copy invite link">${ICON2.share}</button></div></div>
      <div class="spacer"></div>
      <div class="lwallet"><div class="lbl">${ICON2.wallet} Wallet</div><div class="val">${fmt(S.myWallet)}</div></div>
    </header>
    <div class="lobby-col">
      <section class="game-card">
        <div class="gc-top">
          <div>
            <div class="gc-name">Texas Hold'em</div>
            <div class="gc-line">Buy-in <b>${fmt(s.defaultBuyIn)}</b></div>
            <div class="gc-line">SB / BB <b>${fmt(s.sb)} / ${fmt(s.bb)}</b>${s.ante ? ` · ante <b>${fmt(s.ante)}</b>` : ''}</div>
          </div>
          <div class="gc-right">
            <div class="gc-hand">${S.status === 'playing' ? `Hand #${Math.max(1, S.handCount)}` : S.status === 'paused' ? 'Paused' : 'Not started'}</div>
            <div class="gc-seated" title="Players at the table">${ICON2.users}<span>${seatedN}/${s.maxPlayers}</span></div>
          </div>
        </div>
        <div class="gc-btns">
          <button class="btn btn-plum" id="lSettings">Settings ${ICON.gear}</button>
          <button class="btn btn-primary" id="lTable">Table ${ICON2.back.replace('m15 18-6-6 6-6', 'm9 18 6-6-6-6')}</button>
        </div>
      </section>
      ${S.isAdmin && (S.requests.length || S.joinRequests.length) ? `<section class="approvals">
        <div class="section-title">Requests for admin approval</div>
        ${S.joinRequests.map(j => `<div class="appr-row" data-join="${j.id}"><span><b>${esc(j.name)}</b> wants to join</span>
          <button class="sq-btn no" data-reject aria-label="Decline ${esc(j.name)}">✕</button><button class="sq-btn yes" data-admit aria-label="Let ${esc(j.name)} in">✓</button></div>`).join('')}
        ${S.requests.map(r => `<div class="appr-row" data-req="${r.id}"><span><b>${esc(r.name)}</b> wants chips</span>
          <input type="number" min="1" value="${r.amount}" aria-label="Chips for ${esc(r.name)}">
          <button class="sq-btn no" data-deny aria-label="Decline">✕</button><button class="sq-btn yes" data-approve aria-label="Give chips">✓</button></div>`).join('')}
      </section>` : ''}
      <section class="balances">
        <div class="bal-head"><span>Balances</span><span>Chips</span><span></span><span>+/−</span></div>
        ${S.members.map(mb => {
          const items = memberItems(mb).filter(x => x && x !== '-');
          const status = mb.seat >= 0 ? 'at the table' : 'watching';
          const dollar = S.isAdmin || mb.id === S.you;
          return `<div class="bal-row ${mb.id === S.you ? 'me' : ''}">
            ${items.length ? `<button class="sq-btn" data-menu="${mb.id}" aria-label="Options for ${esc(mb.name)}">${ICON2.vdots}</button>` : '<span class="sq-btn ghost"></span>'}
            <div class="bal-name"><div class="nm">${esc(mb.name)}${mb.isAdmin ? `<span class="adm" title="Admin">${ICON2.shield}</span>` : ''}${mb.isBot ? '<span class="pill">bot</span>' : ''}${!mb.connected && !mb.isBot ? '<span class="off"> · offline</span>' : ''}</div>
              <div class="sub">in ${mb.handsPlayed} hand${mb.handsPlayed === 1 ? '' : 's'}<span class="st"> · ${status}</span>${mb.request ? ` · <span class="ask">asking for ${fmt(mb.request)}</span>` : ''}</div></div>
            <div class="bal-chips"><div class="big">${fmt(mb.stack + mb.wallet)}</div><div class="sm">${mb.seat >= 0 ? `${fmt(mb.stack)} at table · ` : ''}${fmt(mb.wallet)} wallet</div></div>
            ${dollar ? `<button class="sq-btn plum" data-dollar="${mb.id}" aria-label="${S.isAdmin ? 'Give chips' : 'Ask for chips'}">$</button>` : '<span class="sq-btn ghost"></span>'}
            <div class="bal-net ${mb.net > 0 ? 'pos' : mb.net < 0 ? 'neg' : ''}">${sgn(mb.net)}</div>
          </div>`; }).join('')}
      </section>
      <div class="lobby-foot">
        <button class="btn btn-ghost btn-sm" id="lHelp">? Chips help</button>
        <button class="btn btn-ghost btn-sm" id="lRanks">Hand rankings</button>
        <button class="btn btn-ghost btn-sm" id="lInvite">Invite friends</button>
      </div>
    </div>
  </main>`;
  $('#lBack').onclick = goHome;
  $('#lShare').onclick = invite; $('#lInvite').onclick = invite;
  $('#lSettings').onclick = settingsDialog;
  $('#lTable').onclick = goTable;
  $('#lHelp').onclick = chipsHelpDialog;
  $('#lRanks').onclick = rankingsDialog;
  $$('[data-menu]').forEach(b => b.onclick = () => popMenu(b, memberItems(S.members.find(m => m.id === b.dataset.menu))));
  $$('[data-dollar]').forEach(b => b.onclick = () => S.isAdmin ? chipsDialog('give', b.dataset.dollar) : chipsDialog('ask'));
  $$('[data-join]').forEach(row => {
    row.querySelector('[data-admit]').onclick = () => host('admit', { playerId: row.dataset.join });
    row.querySelector('[data-reject]').onclick = () => host('reject', { playerId: row.dataset.join });
  });
  $$('[data-req]').forEach(row => {
    row.querySelector('[data-approve]').onclick = () => host('approve', { requestId: row.dataset.req, amount: Number(row.querySelector('input').value) });
    row.querySelector('[data-deny]').onclick = () => host('deny', { requestId: row.dataset.req });
  });
}
const initials = n => n.replace(/["'].*?["']/g, '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?';

/* ================= connection ================= */
socket.on('state', st => {
  if(!session) return;
  if(st.pending){ S = null; P = null; if(ui.view !== 'waiting' || !$('.waiting-page')) waitingPage(st); return; }
  if(!st.members.some(m => m.id === st.you)){   // declined or removed by the admin
    const wasWaiting = ui.view === 'waiting';
    saveSession(null); S = null; history.replaceState(null, '', '/');
    landing('join'); toast(wasWaiting ? "The admin didn't let you in." : 'The admin removed you from the game.', true); return;
  }
  if(ui.view === 'waiting'){ ui.view = 'lobby'; ui.lobbyKey = ''; toast("You're in!"); }
  const lastId = st.chat.length ? (st.chat.at(-1).id || 0) : 0;
  const fresh = ui.chatSeen == null || ui.chatRoom !== st.code ? [] : st.chat.filter(m => (m.id || 0) > ui.chatSeen);
  ui.chatSeen = Math.max(ui.chatRoom === st.code ? ui.chatSeen || 0 : 0, lastId); ui.chatRoom = st.code;
  const reading = ui.panelOpen && ui.tab === 'chat' && ui.view === 'table';
  P = S; S = st; receivedAt = performance.now();
  if(!reading) ui.unread += fresh.filter(m => m.pid !== S.you).length;
  if(fresh.length && ui.view === 'table') queueMicrotask(() => fresh.forEach(chatBubble));
  if(S.isAdmin && P && P.requests && S.requests.length > P.requests.length){ const r = S.requests.at(-1); toast(`${r.name} is asking for ${fmt(r.amount)} chips`); SFX.turn(); }
  if(S.isAdmin && P && P.joinRequests && S.joinRequests.length > P.joinRequests.length){ toast(`${S.joinRequests.at(-1).name} wants to join`); SFX.turn(); }
  if(ui.view === 'table') update();
  else if(ui.view === 'lobby') renderLobby();
});
function enterGame(){
  let v = 'lobby';
  try { v = sessionStorage.getItem('hgView') || 'lobby'; } catch(e){}
  ui.view = v === 'table' ? 'table' : v === 'home' ? 'home' : 'lobby';
  ui.built = false; ui.lobbyKey = '';
  if(ui.view === 'home') landing('join');
  try { sessionStorage.setItem('hgView', ui.view); } catch(e){}
}
socket.on('connect', async () => {
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();
  if(session && (!urlRoom || urlRoom === session.code)){
    const r = await emit('resume', session);
    if(r.ok){ if(ui.view === 'waiting') return; if(!S || ui.view === 'landing' || ui.view === 'home') enterGame(); return; }
    saveSession(null);
    if(S){ S = null; toast('That game has closed. Join again with the code.', true); }
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
// nothing to draw until the connection says who you are
})();
