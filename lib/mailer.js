// Sending e-mail via SMTP (password reset, registration, notifications).

const nodemailer = require('nodemailer');

function configured(smtp) {
  return !!(smtp && smtp.host && smtp.from);
}

async function sendMail(smtp, { to, subject, text }) {
  if (!configured(smtp)) throw new Error('SMTP is not set up.');
  const port = Number(smtp.port) || 587;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port,
    // Port 465 = SSL/TLS from the start, 587/25 = STARTTLS. A wrong checkbox caused
    // "ssl3_get_record: wrong version number" – so the standard ports are set automatically.
    secure: port === 465 ? true : [587, 25, 2525].includes(port) ? false : !!smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass || '' } : undefined,
    connectionTimeout: 15000,
  });
  try {
    await transport.sendMail({ from: smtp.from, to, subject, text });
  } catch (e) {
    if (/wrong version number/i.test(e.message)) throw new Error(`SSL/TLS does not match port ${port}: turn "SSL/TLS" on for 465, off for 587 (STARTTLS).`);
    throw e;
  }
}

module.exports = { sendMail, configured };
