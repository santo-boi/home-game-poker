// Reset a player's password (the site can't send emails, so the site owner does this).
// Usage, from this folder on your own computer:
//   DATABASE_URL="postgres://...your Neon link..." node reset-password.js friend@email.com newpassword
// On Windows PowerShell:
//   $env:DATABASE_URL="postgres://..."; node reset-password.js friend@email.com newpassword
const { hashPassword } = require('./store');
const [email, password] = process.argv.slice(2);
if(!email || !password || password.length < 6){ console.log('Usage: node reset-password.js <email> <new password, 6+ characters>'); process.exit(1); }
if(!process.env.DATABASE_URL){ console.log('Set DATABASE_URL to your Neon connection string first.'); process.exit(1); }
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } });
pool.query('UPDATE users SET pass = $1 WHERE email = $2', [hashPassword(password), email.trim().toLowerCase()])
  .then(async r => {
    if(!r.rowCount){ console.log(`No account uses ${email}.`); }
    else { await pool.query('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)', [email.trim().toLowerCase()]); console.log(`Password reset for ${email}. They can log in with the new password now.`); }
    await pool.end();
  })
  .catch(e => { console.error(e.message); process.exit(1); });
