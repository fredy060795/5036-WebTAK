// E-Mail-Versand über SMTP (für "Passwort vergessen").

const nodemailer = require('nodemailer');

function configured(smtp) {
  return !!(smtp && smtp.host && smtp.from);
}

async function sendMail(smtp, { to, subject, text }) {
  if (!configured(smtp)) throw new Error('SMTP ist nicht eingerichtet.');
  const port = Number(smtp.port) || 587;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port,
    // Port 465 = SSL/TLS von Anfang an, 587/25 = STARTTLS. Ein falsches Häkchen führte zu
    // "ssl3_get_record: wrong version number" – daher bei den Standard-Ports automatisch richtig.
    secure: port === 465 ? true : [587, 25, 2525].includes(port) ? false : !!smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass || '' } : undefined,
    connectionTimeout: 15000,
  });
  try {
    await transport.sendMail({ from: smtp.from, to, subject, text });
  } catch (e) {
    if (/wrong version number/i.test(e.message)) throw new Error(`SSL/TLS passt nicht zum Port ${port}: bei 465 „SSL/TLS“ an, bei 587 aus (STARTTLS).`);
    throw e;
  }
}

module.exports = { sendMail, configured };
