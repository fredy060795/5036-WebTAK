// Admin login: sessions (cookie), lockout after failed attempts, password reset via link.
// Besides the main admin there are "helpers": they may approve requests and create users, but not
// change system settings (server.js decides which requests they may make based on the role).

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
    this.fails = new Map();       // ip -> [timestamps]
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
    if (this.blocked(ip)) throw new Error('Too many failed attempts. Please wait 15 minutes.');
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
      throw new Error('Wrong username or password.');
    }
    this.fails.delete(ip);
    const sid = randomToken(32);
    this.sessions.set(sid, { ...session, expires: Date.now() + SESSION_MS });
    return sid;
  }

  // session (with role) or false
  check(sid) {
    const s = sid && this.sessions.get(sid);
    if (!s) return false;
    if (s.expires < Date.now() || (s.role === 'helper' && !this.helpers[s.helperId])) {
      this.sessions.delete(sid);
      return false;
    }
    return s;
  }

  // ---------------- Helpers ----------------
  listHelpers() {
    return Object.values(this.helpers).map(({ password, ...h }) => h).sort((a, b) => a.username.localeCompare(b.username));
  }

  checkNewPassword(password) {
    if (String(password || '').length < MIN_PASSWORD) throw new Error(`Password must have at least ${MIN_PASSWORD} characters.`);
    if (password === 'admin123') throw new Error('Please choose a password other than the default password.');
  }

  addHelper({ username, password, name, email }) {
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) throw new Error('Username: 3–64 characters (letters, digits, _ . @ -).');
    const lower = username.toLowerCase();
    if (lower === this.admin.username.toLowerCase() || Object.values(this.helpers).some(h => h.username.toLowerCase() === lower)) {
      throw new Error('This username already exists.');
    }
    this.checkNewPassword(password);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) throw new Error('E-mail address is invalid.');
    const id = randomToken(6);
    this.helpers[id] = {
      id, username, password: hashPassword(String(password)), name: String(name || '').trim().slice(0, 60),
      email: String(email || '').trim(), created: new Date().toISOString(), lastLogin: null,
    };
    this.store.save();
    return this.listHelpers().find(h => h.id === id);
  }

  removeHelper(id) {
    if (!this.helpers[id]) throw new Error('Helper not found.');
    delete this.helpers[id];
    for (const [sid, s] of this.sessions) if (s.helperId === id) this.sessions.delete(sid);
    this.store.save();
  }

  setHelperPassword(id, password) {
    const h = this.helpers[id];
    if (!h) throw new Error('Helper not found.');
    this.checkNewPassword(password);
    h.password = hashPassword(String(password));
    for (const [sid, s] of this.sessions) if (s.helperId === id) this.sessions.delete(sid);
    this.store.save();
  }

  // a helper changes their own password
  changeHelperPassword(sid, current, password) {
    const s = this.check(sid);
    const h = s && s.role === 'helper' && this.helpers[s.helperId];
    if (!h) throw new Error('Not allowed.');
    if (!verifyPassword(String(current || ''), h.password)) throw new Error('Current password is wrong.');
    this.checkNewPassword(password);
    h.password = hashPassword(String(password));
    for (const [other, x] of this.sessions) if (x.helperId === h.id && other !== sid) this.sessions.delete(other);
    this.store.save();
  }

  logout(sid) {
    this.sessions.delete(sid);
  }

  // Changes the login data; all other sessions are logged out afterwards
  changeCredentials(currentSid, { current, username, password, email }) {
    const s = this.check(currentSid);
    if (!s || s.role !== 'admin') throw new Error('Only the main admin can change these login details.');
    if (!verifyPassword(String(current || ''), this.admin.password)) throw new Error('Current password is wrong.');
    this.applyCredentials({ username, password, email });
    for (const sid of this.sessions.keys()) if (sid !== currentSid) this.sessions.delete(sid);
  }

  applyCredentials({ username, password, email }) {
    if (username !== undefined) {
      username = String(username).trim();
      if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) throw new Error('Username: 3–64 characters (letters, digits, _ . @ -).');
      if (Object.values(this.helpers).some(h => h.username.toLowerCase() === username.toLowerCase())) throw new Error('A helper already has this username.');
    }
    if (password !== undefined && password !== '') {
      if (String(password).length < MIN_PASSWORD) throw new Error(`Password must have at least ${MIN_PASSWORD} characters.`);
      if (password === 'admin123') throw new Error('Please choose a password other than the default password.');
    }
    if (email !== undefined && email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      throw new Error('E-mail address is invalid.');
    }
    if (this.admin.mustChange && !password) throw new Error('Please set a new password.');
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
    if (!expires || expires < Date.now()) throw new Error('Link has expired or is invalid. Please request a new one.');
    if (!password) throw new Error('Please enter a new password.');
    this.applyCredentials({ password });
    this.resetTokens.clear();
    for (const [sid, s] of this.sessions) if (s.role === 'admin') this.sessions.delete(sid); // helpers stay logged in
  }
}

module.exports = { Auth };
