// Home-game poker server: rooms with join codes, a host, blinds and buy-ins.
// Run with `npm start`, then open http://localhost:3000
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Table, validateSettings } = require('./table');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10000, pingTimeout: 8000, perMessageDeflate: { threshold: 1024 } });

// Only the website's own files are served; the server code stays private.
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/engine.js': 'engine.js' };
// Files are read once and kept gzipped in memory, so pages load fast even on a phone connection.
// The browser keeps a copy and only re-downloads a file after it changes (ETag).
const zlib = require('zlib');
const fs = require('fs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const fileCache = new Map();
function cached(name){
  if(!fileCache.has(name)){
    const raw = fs.readFileSync(path.join(__dirname, name));
    fileCache.set(name, { raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16) + '"', type: TYPES[path.extname(name)] });
  }
  return fileCache.get(name);
}
app.get(Object.keys(PUBLIC_FILES), (req, res) => {
  const f = cached(PUBLIC_FILES[req.path]);
  res.set({ 'Content-Type': f.type, ETag: f.etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' });
  if(req.headers['if-none-match'] === f.etag) return res.status(304).end();
  if(/\bgzip\b/.test(req.headers['accept-encoding'] || '')){ res.set('Content-Encoding', 'gzip'); return res.end(f.gz); }
  res.end(f.raw);
});
app.get('/health', (_, res) => res.json({ ok: true }));

const rooms = new Map(); // code -> Table

// Private site: when ACCESS_KEY is set (in Render's Environment settings), only browsers that
// arrived through a link containing ?key=<ACCESS_KEY> can connect. Leave it unset to run open.
const ACCESS_KEY = process.env.ACCESS_KEY || '';
function keyOk(k){
  if(!ACCESS_KEY) return true;
  const a = Buffer.from(String(k || '')), b = Buffer.from(ACCESS_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
io.use((socket, next) => keyOk(socket.handshake.auth && socket.handshake.auth.key) ? next() : next(new Error('private')));
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

// Several changes in the same moment (an action, then the turn moving on) go out as one update.
const pendingBroadcast = new Set();
function broadcast(table){
  if(pendingBroadcast.has(table)) return;
  pendingBroadcast.add(table);
  setImmediate(() => { pendingBroadcast.delete(table); sendState(table); });
}
function sendState(table){
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
    if(t) broadcast(t);
  });
}
// a different display name if someone with the same name is already in the game
function uniqueName(table, name){
  const taken = new Set([...table.players.values()].map(p => p.name.toLowerCase()));
  if(!taken.has(name.toLowerCase())) return name;
  for(let i = 2; ; i++){ const n = `${name.slice(0, 17)} ${i}`; if(!taken.has(n.toLowerCase())) return n; }
}

io.on('connection', socket => {
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

  handle(socket, 'createRoom', ({ name, settings, startChips, bots }) => {
    name = cleanName(name);
    if(!name) throw new Error('Enter your name.');
    const s = validateSettings(settings || {});
    const code = newCode();
    const table = new Table(code, s, broadcast);
    rooms.set(code, table);
    const p = table.addMember({ name });
    attach(socket, table, p);
    const chips = Math.floor(Number(startChips));
    if(chips > 0) table.give(p.id, chips);
    const n = Math.max(0, Math.min(s.maxPlayers - 1, Math.floor(Number(bots) || 0)));
    for(let i = 0; i < n; i++) table.addBot();
    console.log(`room ${code} created by ${name}`);
    return { code, token: p.token };
  });

  handle(socket, 'joinRoom', ({ code, name }) => {
    name = cleanName(name);
    if(!name) throw new Error('Enter your name.');
    const table = rooms.get(cleanCode(code));
    if(!table) throw new Error('No game has that code. Check it with the admin.');
    const p = table.addMember({ name: uniqueName(table, name), approved: false });   // waits for the admin
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
  // The player's own hand history for this game (asked for when the History tab is open).
  socket.on('history', (_, ack) => {
    if(typeof ack !== 'function') return;
    const t = rooms.get(socket.data.code), p = t && t.players.get(socket.data.playerId);
    ack({ ok: !!p, hands: p && p.history ? p.history : [] });
  });
  handle(socket, 'chat', ({ text }) => {
    const { t, p } = current();
    if(!p.approved) throw new Error('The admin has not let you in yet.');
    text = String(text || '').trim().slice(0, 200);
    if(!text) return;
    if(Date.now() - (p.lastChat || 0) < 250) throw new Error('Slow down a little.');
    p.lastChat = Date.now();
    t.chatSeq = (t.chatSeq || 0) + 1;
    t.chat.push({ id: t.chatSeq, t: Date.now(), pid: p.id, name: p.name, seat: p.seat, text });
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
      t.destroy(); rooms.delete(code); console.log(`room ${code} closed`);
    }
  }
}, 60 * 1000).unref();

server.listen(PORT, () => console.log(`Poker server on http://localhost:${PORT}${ACCESS_KEY ? ' (private: open it with ?key=YOUR_KEY)' : ''}`));
module.exports = { server, rooms };
