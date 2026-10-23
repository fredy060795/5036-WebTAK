// Admin-Anmeldung: Sitzungen (Cookie), Sperre nach Fehlversuchen, Passwort-Reset per Link.

const { verifyPassword, hashPassword, randomToken } = require('./passwords');

const SESSION_MS = 12 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 8;

class Auth {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();    // sid -> { expires }
    this.resetTokens = new Map(); // token -> expires
    this.fails = new Map();       // ip -> [zeitpunkte]
  }

  get admin() {
    return this.store.data.admin;
  }

  blocked(ip) {
    const now = Date.now();
    const list = (this.fails.get(ip) || []).filter(t => now - t < FAIL_WINDOW_MS);
    this.fails.set(ip, list);
    return list.length >= MAX_FAILS;
  }

  login(ip, username, password) {
    if (this.blocked(ip)) throw new Error('Zu viele Fehlversuche. Bitte 15 Minuten warten.');
    const ok = String(username || '').toLowerCase() === this.admin.username.toLowerCase()
      && verifyPassword(String(password || ''), this.admin.password);
    if (!ok) {
      this.fails.get(ip).push(Date.now());
      throw new Error('Benutzername oder Passwort falsch.');
    }
    this.fails.delete(ip);
    const sid = randomToken(32);
    this.sessions.set(sid, { expires: Date.now() + SESSION_MS });
    return sid;
  }

  check(sid) {
    const s = sid && this.sessions.get(sid);
    if (!s) return false;
    if (s.expires < Date.now()) {
      this.sessions.delete(sid);
      return false;
    }
    return true;
  }

  logout(sid) {
    this.sessions.delete(sid);
  }

  // Ändert Zugangsdaten; danach sind alle anderen Sitzungen abgemeldet
  changeCredentials(currentSid, { current, username, password, email }) {
    if (!verifyPassword(String(current || ''), this.admin.password)) throw new Error('Aktuelles Passwort ist falsch.');
    this.applyCredentials({ username, password, email });
    for (const sid of this.sessions.keys()) if (sid !== currentSid) this.sessions.delete(sid);
  }

  applyCredentials({ username, password, email }) {
    if (username !== undefined) {
      username = String(username).trim();
      if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) throw new Error('Benutzername: 3–64 Zeichen (Buchstaben, Ziffern, _ . @ -).');
    }
    if (password !== undefined && password !== '') {
      if (String(password).length < MIN_PASSWORD) throw new Error(`Passwort muss mindestens ${MIN_PASSWORD} Zeichen haben.`);
      if (password === 'admin123') throw new Error('Bitte ein anderes Passwort als das Standard-Passwort wählen.');
    }
    if (email !== undefined && email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      throw new Error('E-Mail-Adresse ist ungültig.');
    }
    if (this.admin.mustChange && !password) throw new Error('Bitte ein neues Passwort festlegen.');
    if (username !== undefined) this.admin.username = username;
    if (password) {
      this.admin.password = hashPassword(String(password));
      this.admin.mustChange = false;
    }
    if (email !== undefined) this.admin.email = String(email).trim();
    this.store.save();
  }

  createResetToken() {
    const token = randomToken(32);
    this.resetTokens.set(token, Date.now() + RESET_MS);
    return token;
  }

  resetPassword(token, password) {
    const expires = this.resetTokens.get(token);
    if (!expires || expires < Date.now()) throw new Error('Link ist abgelaufen oder ungültig. Bitte neu anfordern.');
    if (!password) throw new Error('Bitte ein neues Passwort eingeben.');
    this.applyCredentials({ password });
    this.resetTokens.clear();
    this.sessions.clear();
  }
}

module.exports = { Auth };
