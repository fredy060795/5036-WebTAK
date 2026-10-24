// Admin-Anmeldung: Sitzungen (Cookie), Sperre nach Fehlversuchen, Passwort-Reset per Link.
// Neben dem Haupt-Admin gibt es "Helfer": dürfen Anfragen freigeben und Nutzer anlegen, aber keine
// Systemeinstellungen ändern (welche Anfragen sie dürfen, entscheidet server.js anhand der Rolle).

const { verifyPassword, hashPassword, randomToken } = require('./passwords');

const SESSION_MS = 12 * 60 * 60 * 1000;
const RESET_MS = 60 * 60 * 1000;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MIN_PASSWORD = 8;

class Auth {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();    // sid -> { expires, role: 'admin' | 'helper', helperId }
    this.resetTokens = new Map(); // token -> expires
    this.fails = new Map();       // ip -> [zeitpunkte]
  }

  get admin() {
    return this.store.data.admin;
  }

  get helpers() {
    if (!this.store.data.helpers) this.store.data.helpers = {};
    return this.store.data.helpers;
  }

  blocked(ip) {
    const now = Date.now();
    const list = (this.fails.get(ip) || []).filter(t => now - t < FAIL_WINDOW_MS);
    this.fails.set(ip, list);
    return list.length >= MAX_FAILS;
  }

  login(ip, username, password) {
    if (this.blocked(ip)) throw new Error('Zu viele Fehlversuche. Bitte 15 Minuten warten.');
    const name = String(username || '').toLowerCase();
    let session = null;
    if (name === this.admin.username.toLowerCase() && verifyPassword(String(password || ''), this.admin.password)) {
      session = { role: 'admin' };
    } else {
      const h = Object.values(this.helpers).find(x => x.username.toLowerCase() === name);
      if (h && !h.disabled && verifyPassword(String(password || ''), h.password)) {
        session = { role: 'helper', helperId: h.id };
        h.lastLogin = new Date().toISOString();
        this.store.save();
      }
    }
    if (!session) {
      this.fails.get(ip).push(Date.now());
      throw new Error('Benutzername oder Passwort falsch.');
    }
    this.fails.delete(ip);
    const sid = randomToken(32);
    this.sessions.set(sid, { ...session, expires: Date.now() + SESSION_MS });
    return sid;
  }

  // Sitzung (mit Rolle) oder false
  check(sid) {
    const s = sid && this.sessions.get(sid);
    if (!s) return false;
    if (s.expires < Date.now() || (s.role === 'helper' && !this.helpers[s.helperId])) {
      this.sessions.delete(sid);
      return false;
    }
    return s;
  }

  // ---------------- Helfer ----------------
  listHelpers() {
    return Object.values(this.helpers).map(({ password, ...h }) => h).sort((a, b) => a.username.localeCompare(b.username));
  }

  checkNewPassword(password) {
    if (String(password || '').length < MIN_PASSWORD) throw new Error(`Passwort muss mindestens ${MIN_PASSWORD} Zeichen haben.`);
    if (password === 'admin123') throw new Error('Bitte ein anderes Passwort als das Standard-Passwort wählen.');
  }

  addHelper({ username, password, name, email }) {
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) throw new Error('Benutzername: 3–64 Zeichen (Buchstaben, Ziffern, _ . @ -).');
    const lower = username.toLowerCase();
    if (lower === this.admin.username.toLowerCase() || Object.values(this.helpers).some(h => h.username.toLowerCase() === lower)) {
      throw new Error('Diesen Benutzernamen gibt es schon.');
    }
    this.checkNewPassword(password);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) throw new Error('E-Mail-Adresse ist ungültig.');
    const id = randomToken(6);
    this.helpers[id] = {
      id, username, password: hashPassword(String(password)), name: String(name || '').trim().slice(0, 60),
      email: String(email || '').trim(), created: new Date().toISOString(), lastLogin: null,
    };
    this.store.save();
    return this.listHelpers().find(h => h.id === id);
  }

  removeHelper(id) {
    if (!this.helpers[id]) throw new Error('Helfer nicht gefunden.');
    delete this.helpers[id];
    for (const [sid, s] of this.sessions) if (s.helperId === id) this.sessions.delete(sid);
    this.store.save();
  }

  setHelperPassword(id, password) {
    const h = this.helpers[id];
    if (!h) throw new Error('Helfer nicht gefunden.');
    this.checkNewPassword(password);
    h.password = hashPassword(String(password));
    for (const [sid, s] of this.sessions) if (s.helperId === id) this.sessions.delete(sid);
    this.store.save();
  }

  // Helfer ändert sein eigenes Passwort
  changeHelperPassword(sid, current, password) {
    const s = this.check(sid);
    const h = s && s.role === 'helper' && this.helpers[s.helperId];
    if (!h) throw new Error('Nicht erlaubt.');
    if (!verifyPassword(String(current || ''), h.password)) throw new Error('Aktuelles Passwort ist falsch.');
    this.checkNewPassword(password);
    h.password = hashPassword(String(password));
    for (const [other, x] of this.sessions) if (x.helperId === h.id && other !== sid) this.sessions.delete(other);
    this.store.save();
  }

  logout(sid) {
    this.sessions.delete(sid);
  }

  // Ändert Zugangsdaten; danach sind alle anderen Sitzungen abgemeldet
  changeCredentials(currentSid, { current, username, password, email }) {
    const s = this.check(currentSid);
    if (!s || s.role !== 'admin') throw new Error('Nur der Haupt-Admin kann diese Zugangsdaten ändern.');
    if (!verifyPassword(String(current || ''), this.admin.password)) throw new Error('Aktuelles Passwort ist falsch.');
    this.applyCredentials({ username, password, email });
    for (const sid of this.sessions.keys()) if (sid !== currentSid) this.sessions.delete(sid);
  }

  applyCredentials({ username, password, email }) {
    if (username !== undefined) {
      username = String(username).trim();
      if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) throw new Error('Benutzername: 3–64 Zeichen (Buchstaben, Ziffern, _ . @ -).');
      if (Object.values(this.helpers).some(h => h.username.toLowerCase() === username.toLowerCase())) throw new Error('Diesen Benutzernamen hat schon ein Helfer.');
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
    for (const [sid, s] of this.sessions) if (s.role === 'admin') this.sessions.delete(sid); // Helfer bleiben angemeldet
  }
}

module.exports = { Auth };
