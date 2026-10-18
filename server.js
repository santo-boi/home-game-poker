// Home-game poker server: rooms with join codes, a host, blinds and buy-ins.
// Run with `npm start`, then open http://localhost:3000
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table, validateSettings } = require('./table');
const { createStore, hashPassword, checkPassword } = require('./store');
const store = createStore();

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

// Only the website's own files are served; the server code stays private.
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/engine.js': 'engine.js' };
app.get(Object.keys(PUBLIC_FILES), (req, res) => res.sendFile(path.join(__dirname, PUBLIC_FILES[req.path])));
app.get('/health', (_, res) => res.json({ ok: true }));

const rooms = new Map(); // code -> Table

// Private site: when ACCESS_KEY is set (in Render's Environment settings), only browsers that
// arrived through a link containing ?key=<ACCESS_KEY> can connect. Leave it unset to run open.
const crypto = require('crypto');
const ACCESS_KEY = process.env.ACCESS_KEY || '';
function keyOk(k){
  if(!ACCESS_KEY) return true;
  const a = Buffer.from(String(k || '')), b = Buffer.from(ACCESS_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
io.use((socket, next) => keyOk(socket.handshake.auth && socket.handshake.auth.key) ? next() : next(new Error('private')));
// Signed-in accounts: the browser sends its login token when it connects.
io.use(async (socket, next) => {
  try { socket.data.user = await store.userForSession(socket.handshake.auth && socket.handshake.auth.token); } catch(e){ console.error('session lookup failed', e.message); }
  next();
});

// ---------- saving history ----------
const saveTimers = new Map();
function saveTotals(table, member){
  if(!member.userId || member.isBot || !member.approved) return;
  store.saveGame(table.summaryFor(member)).catch(e => console.error('saveGame', e.message));
}
// totals for everyone at a table, at most once every 2 seconds per table
function scheduleSave(table){
  if(saveTimers.has(table.code)) return;
  saveTimers.set(table.code, setTimeout(() => {
    saveTimers.delete(table.code);
    for(const p of table.players.values()) saveTotals(table, p);
  }, 2000));
}
function wireTable(table){
  table.onHand = (t, records) => { for(const r of records) store.addHand(r).catch(e => console.error('addHand', e.message)); scheduleSave(t); };
  table.onLeave = (t, p) => saveTotals(t, p);
  return table;
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

function newCode(){
  for(;;){
    let c = '';
    for(let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if(!rooms.has(c)) return c;
  }
}
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cleanCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

function broadcast(table){
  for(const s of io.sockets.adapter.rooms.get(table.code) || []){
    const sock = io.sockets.sockets.get(s);
    if(sock) sock.emit('state', table.viewFor(sock.data.playerId));
  }
}

function attach(socket, table, player){
  socket.data.code = table.code;
  socket.data.playerId = player.id;
  socket.join(table.code);
  player.connected = true;
}

// Wrap each handler: errors go back to the caller as a readable message.
function handle(socket, event, fn){
  socket.on(event, (payload, ack) => {
    if(typeof ack !== 'function') ack = () => {};
    try {
      const out = fn(payload || {});
      ack({ ok: true, ...(out || {}) });
    } catch(e){
      ack({ ok: false, error: e.message || 'Something went wrong.' });
    }
    const t = rooms.get(socket.data.code);
    if(t){ broadcast(t); scheduleSave(t); }
  });
}
// Same, for handlers that need to wait on the database.
function handleAsync(socket, event, fn){
  socket.on(event, async (payload, ack) => {
    if(typeof ack !== 'function') ack = () => {};
    try { ack({ ok: true, ...((await fn(payload || {})) || {}) }); }
    catch(e){ ack({ ok: false, error: e.message || 'Something went wrong.' }); }
  });
}
const cleanEmail = e => String(e || '').trim().toLowerCase().slice(0, 120);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
// a different display name if someone with the same name is already in the game
function uniqueName(table, name){
  const taken = new Set([...table.players.values()].map(p => p.name.toLowerCase()));
  if(!taken.has(name.toLowerCase())) return name;
  for(let i = 2; ; i++){ const n = `${name.slice(0, 17)} ${i}`; if(!taken.has(n.toLowerCase())) return n; }
}

io.on('connection', socket => {
  // ---------- accounts ----------
  let attempts = 0, windowStart = Date.now();
  const limit = () => {
    if(Date.now() - windowStart > 60000){ attempts = 0; windowStart = Date.now(); }
    if(++attempts > 10) throw new Error('Too many tries. Wait a minute and try again.');
  };
  const signedIn = () => { if(!socket.data.user) throw new Error('Log in first.'); return socket.data.user; };
  handleAsync(socket, 'me', async () => ({ user: socket.data.user || null, storage: store.kind }));
  handleAsync(socket, 'signup', async ({ email, name, password }) => {
    limit();
    email = cleanEmail(email); name = cleanName(name); password = String(password || '');
    if(!emailOk(email)) throw new Error('Enter a valid email address.');
    if(!name) throw new Error('Enter the name other players will see.');
    if(password.length < 6) throw new Error('Use a password of at least 6 characters.');
    const user = await store.createUser(email, name, hashPassword(password));
    if(!user) throw new Error('That email already has an account. Log in instead.');
    const token = await store.createSession(user.id);
    socket.data.user = user;
    return { user, token };
  });
  handleAsync(socket, 'login', async ({ email, password }) => {
    limit();
    const u = await store.findUserByEmail(cleanEmail(email));
    if(!u || !checkPassword(String(password || ''), u.pass)) throw new Error('Wrong email or password.');
    const user = { id: u.id, email: u.email, name: u.name };
    const token = await store.createSession(user.id);
    socket.data.user = user;
    return { user, token };
  });
  handleAsync(socket, 'logout', async ({ token }) => { if(token) await store.deleteSession(String(token)); socket.data.user = null; });
  handleAsync(socket, 'history', async () => ({ games: await store.history(signedIn().id) }));
  handleAsync(socket, 'gameHands', async ({ gameKey }) => ({ hands: await store.gameHands(signedIn().id, String(gameKey || '')) }));

  const current = () => {
    const t = rooms.get(socket.data.code);
    const p = t && t.players.get(socket.data.playerId);
    if(!t || !p) throw new Error('You are not at a table.');
    return { t, p };
  };
  const hostOnly = () => {
    const c = current();
    if(c.t.adminId !== c.p.id) throw new Error('Only the admin can do that.');
    return c;
  };

  handle(socket, 'createRoom', ({ settings, startChips, bots }) => {
    const user = signedIn();
    const name = user.name;
    const s = validateSettings(settings || {});
    const code = newCode();
    const table = wireTable(new Table(code, s, broadcast));
    rooms.set(code, table);
    const p = table.addMember({ name, userId: user.id });
    attach(socket, table, p);
    const chips = Math.floor(Number(startChips));
    if(chips > 0) table.give(p.id, chips);
    const n = Math.max(0, Math.min(s.maxPlayers - 1, Math.floor(Number(bots) || 0)));
    for(let i = 0; i < n; i++) table.addBot();
    console.log(`room ${code} created by ${name}`);
    return { code, token: p.token };
  });

  handle(socket, 'joinRoom', ({ code }) => {
    const user = signedIn();
    const table = rooms.get(cleanCode(code));
    if(!table) throw new Error('No game has that code. Check it with the admin.');
    // already in this game (another device, or came back): pick up the same seat
    const mine = [...table.players.values()].find(p => p.userId === user.id);
    if(mine){ attach(socket, table, mine); return { code: table.code, token: mine.token, pending: !mine.approved }; }
    const p = table.addMember({ name: uniqueName(table, user.name), approved: false, userId: user.id });   // waits for the admin
    attach(socket, table, p);
    return { code: table.code, token: p.token, pending: true };
  });

  handle(socket, 'peekRoom', ({ code }) => {
    const table = rooms.get(cleanCode(code));
    if(!table) throw new Error('No table has that code. Check it with the host.');
    const host = table.players.get(table.adminId);
    return { code: table.code, settings: table.settings, seatsTaken: table.seated().length, members: table.players.size, host: host ? host.name : null };
  });

  handle(socket, 'resume', ({ code, token }) => {
    const table = rooms.get(cleanCode(code));
    const p = table && [...table.players.values()].find(x => x.token === token);
    if(!p) throw new Error('That seat is no longer available.');
    if(p.userId && (!socket.data.user || socket.data.user.id !== p.userId)) throw new Error('Log in with the account that joined this game.');
    attach(socket, table, p);
    table.addLog(`${p.name} reconnected.`);
    return { code: table.code };
  });

  handle(socket, 'action', a => { const { t, p } = current(); t.act(p.id, { type: a.type, amount: a.amount }); });
  handle(socket, 'requestChips', ({ amount }) => { const { t, p } = current(); t.requestChips(p.id, amount); });
  handle(socket, 'sit', ({ seat, amount }) => { const { t, p } = current(); t.sit(p.id, seat, amount); });
  handle(socket, 'stand', () => { const { t, p } = current(); t.standUp(p.id); });
  handle(socket, 'topUp', ({ amount }) => { const { t, p } = current(); t.topUp(p.id, amount); });
  handle(socket, 'cancelRequest', () => { const { t, p } = current(); t.cancelRequest(p.id); });
  handle(socket, 'sitOut', ({ value }) => { const { t, p } = current(); t.setSittingOut(p.id, value); });
  handle(socket, 'chat', ({ text }) => {
    const { t, p } = current();
    if(!p.approved) throw new Error('The admin has not let you in yet.');
    text = String(text || '').trim().slice(0, 200);
    if(text) t.chat.push({ t: Date.now(), name: p.name, seat: p.seat, text });
    if(t.chat.length > 100) t.chat.shift();
  });
  handle(socket, 'leave', () => {
    const { t, p } = current();
    t.removePlayer(p.id, 'left');
    socket.leave(t.code);
    socket.data.code = null;
    broadcast(t);
  });

  handle(socket, 'host', ({ cmd, settings, playerId, requestId, amount }) => {
    const { t } = hostOnly();
    if(cmd === 'start') t.start();
    else if(cmd === 'pause') t.pause();
    else if(cmd === 'settings') t.updateSettings(settings || {});
    else if(cmd === 'addBot') t.addBot();
    else if(cmd === 'deal') t.dealNext();
    else if(cmd === 'admit') t.admit(playerId);
    else if(cmd === 'reject') t.reject(playerId);
    else if(cmd === 'skip') t.skipTurn();
    else if(cmd === 'bomb') t.queueBomb();
    else if(cmd === 'give') t.give(playerId, amount);
    else if(cmd === 'take') t.take(playerId, amount);
    else if(cmd === 'approve') t.approve(requestId, amount);
    else if(cmd === 'deny') t.deny(requestId);
    else if(cmd === 'kick'){
      const target = t.players.get(playerId);
      if(!target) throw new Error('That player has already left.');
      if(target.id === t.adminId) throw new Error("You can't remove yourself.");
      if(target.isBot && target.seat >= 0){ t.removePlayer(target.id, 'was removed'); return; }
      t.removePlayer(target.id, target.isBot ? 'was removed' : 'was removed by the host');
    } else if(cmd === 'standUp'){
      const target = t.players.get(playerId);
      if(!target) throw new Error('That player has already left.');
      t.standUp(target.id);
    } else if(cmd === 'makeHost'){
      const target = t.players.get(playerId);
      if(!target || target.isBot) throw new Error('Choose a person at the table.');
      t.adminId = target.id; t.addLog(`${target.name} is now the admin.`);
    } else throw new Error('Unknown host command.');
  });

  socket.on('disconnect', () => {
    const t = rooms.get(socket.data.code);
    const p = t && t.players.get(socket.data.playerId);
    if(!p) return;
    // only mark offline if no other tab is holding this seat
    const still = [...(io.sockets.adapter.rooms.get(t.code) || [])].some(id => io.sockets.sockets.get(id)?.data.playerId === p.id);
    if(!still){ p.connected = false; t.addLog(`${p.name} lost connection.`); broadcast(t); }
  });
});

// Close rooms nobody has been connected to for 30 minutes.
setInterval(() => {
  for(const [code, t] of rooms){
    const anyone = t.humans().some(p => p.connected);
    if(!anyone && Date.now() - t.lastActivity > 30 * 60 * 1000){
      for(const p of t.players.values()) saveTotals(t, p);   // final totals before the game closes
      t.destroy(); rooms.delete(code); console.log(`room ${code} closed`);
    }
  }
}, 60 * 1000).unref();

store.init()
  .then(() => {
    console.log(`Accounts stored in ${store.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : 'data.json — set DATABASE_URL to keep them permanently'}`);
    server.listen(PORT, () => console.log(`Poker server on http://localhost:${PORT}${ACCESS_KEY ? ' (private: open it with ?key=YOUR_KEY)' : ''}`));
  })
  .catch(e => { console.error('Could not open the database:', e.message); process.exit(1); });
module.exports = { server, rooms };
