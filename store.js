// Accounts and play history.
// With DATABASE_URL set (a free Neon Postgres database), everything is kept permanently.
// Without it, data goes to data.json next to the server: fine on your own computer, but on
// Render's free plan that file is wiped whenever the site restarts.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- passwords: scrypt with a random salt (built into Node, no extra package) ----------
function hashPassword(pw){
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function checkPassword(pw, stored){
  const [kind, saltHex, hashHex] = String(stored || '').split('$');
  if(kind !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  const want = Buffer.from(hashHex, 'hex');
  return want.length === hash.length && crypto.timingSafeEqual(want, hash);
}
const newToken = () => crypto.randomBytes(32).toString('hex');

// ---------- Postgres ----------
function pgStore(url){
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1|\/var\/run/.test(url);
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
  const q = (text, params) => pool.query(text, params);
  return {
    kind: 'postgres',
    async init(){
      await q(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT now())`);
      await q(`CREATE TABLE IF NOT EXISTS game_results (
        user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, game_key TEXT NOT NULL, code TEXT, admin TEXT,
        started_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now(), given BIGINT DEFAULT 0, final BIGINT DEFAULT 0, net BIGINT DEFAULT 0,
        hands INT DEFAULT 0, hands_won INT DEFAULT 0, biggest_pot BIGINT DEFAULT 0, blinds TEXT, PRIMARY KEY (user_id, game_key))`);
      await q(`CREATE TABLE IF NOT EXISTS hand_history (
        id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE, game_key TEXT NOT NULL, hand_no INT,
        played_at TIMESTAMPTZ DEFAULT now(), hole TEXT, board TEXT, board2 TEXT, hand_name TEXT, delta BIGINT, pot BIGINT, won BOOLEAN, folded BOOLEAN, players INT)`);
      await q(`CREATE INDEX IF NOT EXISTS hand_history_user_game ON hand_history (user_id, game_key, hand_no)`);
    },
    async createUser(email, name, pass){
      const r = await q(`INSERT INTO users (email, name, pass) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, name`, [email, name, pass]);
      return r.rows[0] || null;
    },
    async findUserByEmail(email){ const r = await q(`SELECT * FROM users WHERE email = $1`, [email]); return r.rows[0] || null; },
    async createSession(userId){ const t = newToken(); await q(`INSERT INTO sessions (token, user_id) VALUES ($1, $2)`, [t, userId]); return t; },
    async userForSession(token){
      if(!token) return null;
      const r = await q(`SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1`, [token]);
      return r.rows[0] || null;
    },
    async deleteSession(token){ await q(`DELETE FROM sessions WHERE token = $1`, [token]); },
    async saveGame(g){
      await q(`INSERT INTO game_results (user_id, game_key, code, admin, started_at, given, final, net, hands, hands_won, biggest_pot, blinds, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
        ON CONFLICT (user_id, game_key) DO UPDATE SET given = EXCLUDED.given, final = EXCLUDED.final, net = EXCLUDED.net, hands = EXCLUDED.hands,
          hands_won = EXCLUDED.hands_won, biggest_pot = EXCLUDED.biggest_pot, blinds = EXCLUDED.blinds, admin = EXCLUDED.admin, updated_at = now()`,
        [g.userId, g.gameKey, g.code, g.admin, new Date(g.startedAt), g.given, g.final, g.net, g.hands, g.handsWon, g.biggestPot, g.blinds]);
    },
    async addHand(h){
      await q(`INSERT INTO hand_history (user_id, game_key, hand_no, played_at, hole, board, board2, hand_name, delta, pot, won, folded, players)
        VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [h.userId, h.gameKey, h.handNo, h.hole, h.board, h.board2, h.handName, h.delta, h.pot, h.won, h.folded, h.players]);
    },
    async history(userId){
      const g = await q(`SELECT game_key, code, admin, started_at, updated_at, given, final, net, hands, hands_won, biggest_pot, blinds
        FROM game_results WHERE user_id = $1 ORDER BY started_at DESC LIMIT 200`, [userId]);
      return g.rows.map(r => ({ gameKey: r.game_key, code: r.code, admin: r.admin, startedAt: +new Date(r.started_at), updatedAt: +new Date(r.updated_at),
        given: +r.given, final: +r.final, net: +r.net, hands: r.hands, handsWon: r.hands_won, biggestPot: +r.biggest_pot, blinds: r.blinds }));
    },
    async gameHands(userId, gameKey){
      const r = await q(`SELECT hand_no, played_at, hole, board, board2, hand_name, delta, pot, won, folded, players FROM hand_history
        WHERE user_id = $1 AND game_key = $2 ORDER BY hand_no DESC LIMIT 500`, [userId, gameKey]);
      return r.rows.map(x => ({ handNo: x.hand_no, at: +new Date(x.played_at), hole: x.hole, board: x.board, board2: x.board2, handName: x.hand_name,
        delta: +x.delta, pot: +x.pot, won: x.won, folded: x.folded, players: x.players }));
    },
  };
}

// ---------- JSON file (local fallback) ----------
function fileStore(file){
  let db = { users: [], sessions: {}, games: [], hands: [], nextId: 1 };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch(e){}
  let timer = null;
  const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(file, JSON.stringify(db), () => {}), 300); };
  const pub = u => u && ({ id: u.id, email: u.email, name: u.name });
  return {
    kind: 'file',
    async init(){},
    async createUser(email, name, pass){
      if(db.users.some(u => u.email === email)) return null;
      const u = { id: db.nextId++, email, name, pass, createdAt: Date.now() };
      db.users.push(u); save(); return pub(u);
    },
    async findUserByEmail(email){ return db.users.find(u => u.email === email) || null; },
    async createSession(userId){ const t = newToken(); db.sessions[t] = userId; save(); return t; },
    async userForSession(token){ return token && db.sessions[token] ? pub(db.users.find(u => u.id === db.sessions[token])) : null; },
    async deleteSession(token){ delete db.sessions[token]; save(); },
    async saveGame(g){
      const i = db.games.findIndex(x => x.userId === g.userId && x.gameKey === g.gameKey);
      const rec = { ...g, updatedAt: Date.now() };
      if(i >= 0) db.games[i] = rec; else db.games.push(rec);
      save();
    },
    async addHand(h){ db.hands.push({ ...h, at: Date.now() }); if(db.hands.length > 50000) db.hands.splice(0, 10000); save(); },
    async history(userId){ return db.games.filter(g => g.userId === userId).sort((a, b) => b.startedAt - a.startedAt).slice(0, 200).map(({ userId, ...g }) => g); },
    async gameHands(userId, gameKey){ return db.hands.filter(h => h.userId === userId && h.gameKey === gameKey).sort((a, b) => b.handNo - a.handNo).slice(0, 500).map(({ userId, gameKey, ...h }) => h); },
  };
}

function createStore(){
  const url = process.env.DATABASE_URL;
  return url ? pgStore(url) : fileStore(process.env.DATA_FILE || path.join(__dirname, 'data.json'));
}

module.exports = { createStore, hashPassword, checkPassword };
