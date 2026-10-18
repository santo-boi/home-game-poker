// Sends emails through Brevo's web API (Render's free plan blocks normal email ports, so
// a web API is the way out). Set in Render → Environment:
//   BREVO_API_KEY   the API key from Brevo (SMTP & API → API keys)
//   MAIL_FROM       the sender address you verified in Brevo (e.g. your Gmail)
//   MAIL_FROM_NAME  optional, the name shown as sender (default "Home Game")
// Without BREVO_API_KEY no emails are sent and accounts work without email codes.
// MAIL_DEV=1 prints emails to the server log instead (for testing on your own computer).
const API = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';

const enabled = () => !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM) || process.env.MAIL_DEV === '1';

async function sendMail(to, subject, html, text){
  if(process.env.MAIL_DEV === '1' && !process.env.BREVO_API_KEY){
    console.log(`\n[email to ${to}] ${subject}\n${text}\n`);
    return;
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'Home Game' },
      to: [{ email: to }], subject, htmlContent: html, textContent: text,
    }),
  });
  if(!res.ok){
    const body = await res.text().catch(() => '');
    console.error('Brevo refused the email:', res.status, body.slice(0, 300));
    throw new Error("The email couldn't be sent. Try again in a minute.");
  }
}

// A short email with a big code in it.
function codeEmail(kind, name, code){
  const what = kind === 'verify' ? 'confirm your email' : 'reset your password';
  const subject = kind === 'verify' ? `${code} is your Home Game code` : `${code} is your password reset code`;
  const text = `Hi ${name || 'there'},\n\nUse this code to ${what}: ${code}\n\nIt works for 15 minutes. If you didn't ask for this, you can ignore this email.\n\nHome Game`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:440px;margin:0 auto;padding:24px;background:#0d1828;color:#e9edf3;border-radius:14px">
    <div style="font-family:Georgia,serif;font-size:26px;margin-bottom:12px">Home Game</div>
    <p style="margin:0 0 16px">Hi ${escapeHtml(name || 'there')}, use this code to ${what}:</p>
    <div style="font-size:34px;letter-spacing:8px;font-weight:bold;background:#13223b;border:1px solid #d4a246;border-radius:10px;padding:14px;text-align:center;color:#d4a246">${code}</div>
    <p style="margin:16px 0 0;color:#9aa8bb;font-size:13px">It works for 15 minutes. If you didn't ask for this, you can ignore this email.</p></div>`;
  return { subject, html, text };
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { enabled, sendMail, codeEmail };
