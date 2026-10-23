// E-Mail-Versand über SMTP (für "Passwort vergessen").

const nodemailer = require('nodemailer');

function configured(smtp) {
  return !!(smtp && smtp.host && smtp.from);
}

async function sendMail(smtp, { to, subject, text }) {
  if (!configured(smtp)) throw new Error('SMTP ist nicht eingerichtet.');
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port) || 587,
    secure: !!smtp.secure, // true = SSL/TLS (meist Port 465), false = STARTTLS (meist 587)
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass || '' } : undefined,
  });
  await transport.sendMail({ from: smtp.from, to, subject, text });
}

module.exports = { sendMail, configured };
