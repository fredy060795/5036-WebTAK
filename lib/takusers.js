// TAK-Zugänge: Registrierung -> (E-Mail bestätigen) -> Freigabe durch den Admin -> echtes OTS-Konto.
// Der Admin legt Rufname, Team (Farbe) und Rolle fest; OTS bekommt dafür Geräte-Profile (ATAK übernimmt
// sie beim Verbinden). Wer wen sieht, regeln Teams: jedes Team ist eine OTS-Gruppe, gesperrte Paare
// lesen die Gruppe des anderen nicht.

const crypto = require('crypto');
const { Ots } = require('./ots');

const TEAM_COLORS = ['White', 'Yellow', 'Orange', 'Magenta', 'Red', 'Maroon', 'Purple', 'Dark Blue', 'Blue', 'Cyan', 'Teal', 'Green', 'Dark Green', 'Brown'];
const ROLES = ['Team Member', 'Team Lead', 'HQ', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9'];
const GROUP_PREFIX = 'TEAM_';
const ANON = '__ANON__'; // Standardgruppe von OTS für Geräte ohne Gruppe
const STATUSES = ['unconfirmed', 'pending', 'active', 'blocked', 'rejected'];

const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const clean = (v, max = 60) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

// Passwort ohne verwechselbare Zeichen; OTS verbietet @ und :
function makePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(14);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

class TakUsers {
  constructor(store, { log = () => {}, mail = null } = {}) {
    this.store = store;
    this.log = log;
    this.mail = mail; // async ({ to, subject, text }) => …
    const d = store.data;
    d.tak = d.tak || {};
    const t = d.tak;
    t.ots = t.ots || { url: '', username: '', password: '', insecure: false, host: '', streamPort: 8089, enrollPort: 8446, apiPort: 8443 };
    // Passwort für neue TAK-Konten (leer = zufällig) und Austausch mit nicht verwalteten Geräten (__ANON__)
    if (t.ots.userPassword === undefined) t.ots.userPassword = 'atakatak';
    if (t.ots.anon === undefined) t.ots.anon = true;
    if (t.ots.truststorePassword === undefined) t.ots.truststorePassword = 'atakatak';
    t.registration = t.registration || { open: true, codeword: '', emailConfirm: true };
    t.teams = t.teams || [{ id: 'default', name: 'Default', color: 'Cyan' }];
    t.blocks = t.blocks || []; // [teamId, teamId]: erstes Team darf das zweite nicht sehen
    t.users = t.users || {};
    this._ots = null;
    this._otsKey = '';
  }

  get t() { return this.store.data.tak; }
  save() { this.store.save(); }

  // ---------------- OTS ----------------
  ots() {
    const o = this.t.ots;
    const key = JSON.stringify([o.url, o.username, o.password, o.insecure, o.host]);
    if (!this._ots || this._otsKey !== key) {
      this._ots = new Ots({ url: o.url, username: o.username, password: o.password, insecure: o.insecure, publicHost: o.host });
      this._otsKey = key;
    }
    return this._ots;
  }
  otsConfigured() { const o = this.t.ots; return !!(o.url && o.username && o.password); }
  takHost() {
    const o = this.t.ots;
    if (o.host) return o.host;
    try { return new URL(o.url).hostname; } catch (e) { return ''; }
  }

  // OTS setzt die Adresse ein, unter der wir OTS ansprechen (evtl. intern) – fürs Handy die öffentliche nehmen
  fixQr(qr) {
    const o = this.t.ots;
    if (!qr || !o.host) return qr;
    return qr.replace(/([?&]host=)[^&]*/, `$1${encodeURIComponent(o.host).replace(/%3A/gi, ':')}:${o.streamPort || 8089}`);
  }

  setOts(input) {
    const o = this.t.ots;
    o.url = clean(input.url, 300).replace(/\/+$/, '');
    o.username = clean(input.username, 100);
    if (input.password) o.password = String(input.password).slice(0, 200);
    o.insecure = !!input.insecure;
    o.host = clean(input.host, 200).replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');
    o.streamPort = Number(input.streamPort) || 8089;
    o.enrollPort = Number(input.enrollPort) || 8446;
    o.apiPort = Number(input.apiPort) || 8443;
    if (input.userPassword !== undefined) {
      const pw = String(input.userPassword).trim();
      if (pw && (pw.length < 8 || pw.length > 64 || /[<>&"'\s]/.test(pw))) {
        throw new Error('Passwort für neue Konten: 8–64 Zeichen, ohne Leerzeichen und ohne < > & " \' (OTS verändert diese Zeichen).');
      }
      o.userPassword = pw;
    }
    if (input.anon !== undefined) o.anon = !!input.anon;
    if (input.truststorePassword !== undefined) o.truststorePassword = String(input.truststorePassword).trim().slice(0, 64) || 'atakatak';
    this.save();
  }

  // Fest eingestelltes Passwort (z. B. "atakatak") oder zufällig
  newUserPassword() { return this.t.ots.userPassword || makePassword(); }

  setRegistration(input) {
    const r = this.t.registration;
    r.open = !!input.open;
    r.codeword = clean(input.codeword, 60);
    r.emailConfirm = !!input.emailConfirm;
    this.save();
  }

  // ---------------- Teams und Sichtbarkeit ----------------
  team(id) { return this.t.teams.find(x => x.id === id) || this.t.teams[0]; }
  groupName(team) { return GROUP_PREFIX + team.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40); }
  canSee(a, b) { return a === b || !this.t.blocks.some(([x, y]) => x === a && y === b); }

  // Soll-Gruppen eines Teams: in die eigene schreiben, alle nicht gesperrten lesen
  wantedGroups(teamId) {
    const own = this.team(teamId);
    // OTS: wer in keiner Gruppe ist, sendet/empfängt in __ANON__ – wie alle von Hand angelegten Benutzer und
    // Geräte ohne Gruppe. Solange niemand gesperrt ist, bekommt der Nutzer daher KEINE Gruppe (alle sehen alle).
    if (!this.t.blocks.length) return [];
    // Mit Sperren: eigene Team-Gruppe (senden) und die sichtbaren Teams (empfangen)
    const wanted = [{ group: this.groupName(own), direction: 'IN' }];
    for (const other of this.t.teams) if (this.canSee(own.id, other.id)) wanted.push({ group: this.groupName(other), direction: 'OUT' });
    // Austausch mit nicht verwalteten Geräten (__ANON__): empfangen immer, senden nur, wenn kein Team dieses Team
    // ausblenden soll (sonst würde es über __ANON__ doch gesehen)
    if (this.t.ots.anon !== false) {
      wanted.push({ group: ANON, direction: 'OUT' });
      if (!this.t.blocks.some(([, hidden]) => hidden === own.id)) wanted.push({ group: ANON, direction: 'IN' });
    }
    return wanted;
  }

  async setTeams(teams, blocks) {
    const list = [];
    const idMap = {}; // Entwurfs-Kennung neuer Teams -> echte Kennung
    for (const t of teams || []) {
      const name = clean(t.name, 40);
      if (!name) continue;
      const id = t.id && this.t.teams.some(x => x.id === t.id) ? t.id : rid(4);
      if (t.id) idMap[t.id] = id;
      if (list.some(x => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`Team „${name}“ gibt es doppelt.`);
      list.push({ id, name, color: TEAM_COLORS.includes(t.color) ? t.color : 'Cyan' });
    }
    if (!list.length) throw new Error('Mindestens ein Team wird gebraucht.');
    const ids = new Set(list.map(x => x.id));
    this.t.teams = list;
    this.t.blocks = (blocks || []).map(([a, b]) => [idMap[a] || a, idMap[b] || b]).filter(([a, b]) => ids.has(a) && ids.has(b) && a !== b);
    for (const u of Object.values(this.t.users)) if (!ids.has(u.team)) u.team = list[0].id;
    this.save();
    return this.syncAllGroups();
  }

  async syncAllGroups() {
    const errors = [];
    if (!this.otsConfigured()) return errors;
    for (const u of Object.values(this.t.users)) {
      if (u.status !== 'active' || !u.username) continue;
      try { await this.ots().syncGroups(u.username, this.wantedGroups(u.team), GROUP_PREFIX, [ANON]); } catch (e) { errors.push(`${u.callsign}: ${e.message}`); }
    }
    return errors;
  }

  // ---------------- Registrierung ----------------
  register(input, { smtpReady }) {
    const r = this.t.registration;
    if (!r.open) throw Object.assign(new Error('Registration is currently closed.'), { status: 403 });
    if (r.codeword && clean(input.codeword).toLowerCase() !== r.codeword.toLowerCase()) throw Object.assign(new Error('Wrong code word.'), { status: 403 });
    const name = clean(input.name, 60);
    const unit = clean(input.unit, 60);
    const email = clean(input.email, 120).toLowerCase();
    const callsign = clean(input.callsign, 30);
    if (!name) throw new Error('Please enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid e-mail address.');
    if (Object.values(this.t.users).some(u => u.email === email && !['rejected'].includes(u.status))) {
      throw Object.assign(new Error('This e-mail address is already registered. Use “Check my status” below – we send you your status link.'), { status: 409 });
    }
    const confirm = r.emailConfirm && smtpReady;
    const u = {
      id: rid(6), token: rid(24), emailToken: confirm ? rid(16) : '', status: confirm ? 'unconfirmed' : 'pending',
      name, unit, email, phone: clean(input.phone, 30), requestedCallsign: callsign, callsign: callsign || name,
      team: this.t.teams[0].id, role: 'Team Member', username: '', password: '', atakQr: '',
      created: new Date().toISOString(), confirmedAt: confirm ? '' : new Date().toISOString(), approvedAt: '', notes: '', profiles: {},
    };
    this.t.users[u.id] = u;
    this.save();
    this.log('TAK-Registrierung', u.name, u.email, u.status);
    return u;
  }

  confirmEmail(emailToken) {
    const u = Object.values(this.t.users).find(x => x.emailToken && x.emailToken === emailToken);
    if (!u) return null;
    if (u.status === 'unconfirmed') {
      u.status = 'pending';
      u.confirmedAt = new Date().toISOString();
    }
    u.emailToken = '';
    this.save();
    return u;
  }

  byEmail(email) {
    const e = clean(email, 120).toLowerCase();
    return e ? this.list().find(u => u.email === e && u.status !== 'rejected') || null : null;
  }

  byToken(token) { return token && token.length >= 32 ? Object.values(this.t.users).find(u => u.token === token) || null : null; }
  get(id) { const u = this.t.users[id]; if (!u) throw Object.assign(new Error('Benutzer nicht gefunden.'), { status: 404 }); return u; }
  list() { return Object.values(this.t.users).sort((a, b) => b.created.localeCompare(a.created)); }

  // OTS-Benutzername aus Rufname/Name: nur Buchstaben, Zahlen, _ und .
  makeUsername(u) {
    const base = (u.callsign || u.name || 'user').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9_.]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 24) || 'user';
    let name = base;
    let n = 1;
    const used = new Set(Object.values(this.t.users).filter(x => x !== u).map(x => x.username));
    while (used.has(name)) name = `${base}${++n}`;
    return name;
  }

  applyEdits(u, input) {
    if (input.callsign !== undefined) { const c = clean(input.callsign, 30); if (c) u.callsign = c; }
    if (input.team !== undefined && this.t.teams.some(x => x.id === input.team)) u.team = input.team;
    if (input.role !== undefined && ROLES.includes(input.role)) u.role = input.role;
    if (input.name !== undefined) { const v = clean(input.name, 60); if (v) u.name = v; }
    if (input.unit !== undefined) u.unit = clean(input.unit, 60);
    if (input.notes !== undefined) u.notes = clean(input.notes, 500);
  }

  // Mit den neuen Zugangsdaten anmelden: prüft, dass OTS das Passwort wirklich gesetzt hat
  async checkLogin(username, password) {
    const o = this.t.ots;
    try {
      await new Ots({ url: o.url, username, password, insecure: o.insecure }).login();
    } catch (e) {
      if (/two-factor/i.test(e.message)) return;
      throw new Error(`OTS hat das Konto „${username}“ angelegt, aber die Anmeldung mit dem Passwort klappt nicht (${e.message}).`);
    }
  }

  async approve(id, input = {}) {
    const u = this.get(id);
    if (!['pending', 'unconfirmed', 'rejected'].includes(u.status)) throw new Error('Nur offene Anfragen können freigegeben werden.');
    if (!this.otsConfigured()) throw new Error('Zuerst OpenTAKServer unter „Einstellungen → OpenTAKServer & Registrierung“ verbinden.');
    this.applyEdits(u, input);
    const ots = this.ots();
    const username = u.username || this.makeUsername(u);
    const password = this.newUserPassword();
    if (await ots.userExists(username)) await ots.resetPassword(username, password);
    else await ots.addUser(username, password, ['user']);
    await ots.activateUser(username).catch(() => {}); // falls vorher gesperrt
    await this.checkLogin(username, password);
    await ots.syncGroups(username, this.wantedGroups(u.team), GROUP_PREFIX, [ANON]);
    u.username = username;
    u.password = password;
    u.atakQr = this.fixQr(await ots.atakQr(username).catch(() => ''));
    u.status = 'active';
    u.approvedAt = new Date().toISOString();
    u.profiles = {};
    this.save();
    this.log('TAK-Zugang freigegeben', u.callsign, username);
    this.syncProfiles().catch(() => {});
    return u;
  }

  async update(id, input) {
    const u = this.get(id);
    const before = JSON.stringify([u.callsign, u.team, u.role]);
    this.applyEdits(u, input);
    this.save();
    const changed = before !== JSON.stringify([u.callsign, u.team, u.role]);
    if (u.status === 'active' && changed && this.otsConfigured()) {
      await this.ots().syncGroups(u.username, this.wantedGroups(u.team), GROUP_PREFIX, [ANON]);
      await this.syncProfiles();
    }
    return u;
  }

  async reject(id) {
    const u = this.get(id);
    if (u.status === 'active') throw new Error('Aktive Zugänge bitte sperren oder löschen.');
    u.status = 'rejected';
    this.save();
    return u;
  }

  async block(id) {
    const u = this.get(id);
    if (u.username && this.otsConfigured()) await this.ots().deactivateUser(u.username).catch(e => { if (!/already/i.test(e.message)) throw e; });
    u.status = 'blocked';
    this.save();
    this.log('TAK-Zugang gesperrt', u.callsign, u.username);
    return u;
  }

  async unblock(id) {
    const u = this.get(id);
    if (u.status !== 'blocked') throw new Error('Zugang ist nicht gesperrt.');
    if (u.username && this.otsConfigured()) await this.ots().activateUser(u.username).catch(e => { if (!/already/i.test(e.message)) throw e; });
    u.status = u.username ? 'active' : 'pending';
    this.save();
    return u;
  }

  async newPassword(id) {
    const u = this.get(id);
    if (!u.username) throw new Error('Noch kein TAK-Konto.');
    const password = this.newUserPassword();
    await this.ots().resetPassword(u.username, password);
    await this.checkLogin(u.username, password);
    u.password = password;
    u.atakQr = this.fixQr(await this.ots().atakQr(u.username).catch(() => u.atakQr));
    this.save();
    return u;
  }

  async newQr(id) {
    const u = this.get(id);
    if (!u.username) throw new Error('Noch kein TAK-Konto.');
    u.atakQr = this.fixQr(await this.ots().atakQr(u.username));
    this.save();
    return u;
  }

  async remove(id) {
    const u = this.get(id);
    if (u.username && this.otsConfigured()) await this.ots().deleteUser(u.username).catch(e => { if (!/not|exist/i.test(e.message)) throw e; });
    delete this.t.users[id];
    this.save();
    this.log('TAK-Zugang gelöscht', u.callsign, u.username);
  }

  // ---------------- Direkt anlegen / aus OTS übernehmen ----------------
  byUsername(username) { return Object.values(this.t.users).find(u => u.username === username) || null; }

  checkPassword(pw) {
    if (pw.length < 8 || pw.length > 64 || /[<>&"'\s@:]/.test(pw)) {
      throw new Error('Passwort: 8–64 Zeichen, ohne Leerzeichen und ohne < > & " \' @ :');
    }
  }

  // Admin legt einen Nutzer ohne Registrierung an: OTS-Konto, Gruppen, ATAK-QR, Zugangsseite
  async createDirect(input = {}) {
    if (!this.otsConfigured()) throw new Error('Zuerst OpenTAKServer im Bereich „Einstellungen → OpenTAKServer & Registrierung“ verbinden.');
    const callsign = clean(input.callsign, 30);
    if (!callsign) throw new Error('Bitte einen Rufnamen eingeben.');
    const email = clean(input.email, 120).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-Mail-Adresse ist ungültig.');
    const u = {
      id: rid(6), token: rid(24), emailToken: '', status: 'active', name: clean(input.name, 60) || callsign, unit: clean(input.unit, 60),
      email, phone: '', requestedCallsign: callsign, callsign, team: this.team(input.team).id, role: ROLES.includes(input.role) ? input.role : 'Team Member',
      username: '', password: '', atakQr: '', created: new Date().toISOString(), confirmedAt: new Date().toISOString(), approvedAt: '', notes: 'vom Admin angelegt', profiles: {},
    };
    const wanted = clean(input.username, 40).toLowerCase();
    if (wanted && !/^[a-z0-9_.]{2,40}$/.test(wanted)) throw new Error('Benutzername: 2–40 Zeichen, nur a–z, 0–9, _ und .');
    u.username = wanted || this.makeUsername(u);
    if (this.byUsername(u.username)) throw new Error(`Benutzer „${u.username}“ wird hier schon verwaltet.`);
    const ots = this.ots();
    if (await ots.userExists(u.username)) throw new Error(`Benutzer „${u.username}“ gibt es in OTS schon – bitte unter „OTS-Benutzer“ übernehmen.`);
    const password = String(input.password || '').trim() || this.newUserPassword();
    this.checkPassword(password);
    await ots.addUser(u.username, password, input.admin ? ['administrator'] : ['user']);
    await this.checkLogin(u.username, password);
    await ots.syncGroups(u.username, this.wantedGroups(u.team), GROUP_PREFIX, [ANON]);
    u.password = password;
    u.atakQr = this.fixQr(await ots.atakQr(u.username).catch(() => ''));
    u.approvedAt = new Date().toISOString();
    this.t.users[u.id] = u;
    this.save();
    this.log('TAK-Zugang direkt angelegt', u.callsign, u.username);
    this.syncProfiles().catch(() => {});
    return u;
  }

  // Vorhandenen OTS-Benutzer (z. B. von Hand in OTS angelegt) in WebTAK verwalten. Das Passwort kennt WebTAK
  // nicht – optional gleich ein neues setzen, damit die Zugangsseite vollständig ist.
  async importOts(username, input = {}) {
    if (!this.otsConfigured()) throw new Error('OpenTAKServer ist nicht verbunden.');
    username = clean(username, 100);
    if (this.byUsername(username)) throw new Error(`„${username}“ wird schon verwaltet.`);
    const ots = this.ots();
    if (!(await ots.userExists(username))) throw new Error(`„${username}“ gibt es in OTS nicht.`);
    const callsign = clean(input.callsign, 30) || username;
    const u = {
      id: rid(6), token: rid(24), emailToken: '', status: 'active', name: clean(input.name, 60) || callsign, unit: '', email: clean(input.email, 120).toLowerCase(),
      phone: '', requestedCallsign: callsign, callsign, team: this.team(input.team).id, role: ROLES.includes(input.role) ? input.role : 'Team Member',
      username, password: '', atakQr: '', created: new Date().toISOString(), confirmedAt: new Date().toISOString(), approvedAt: new Date().toISOString(),
      notes: 'aus OTS übernommen', profiles: {},
    };
    if (input.newPassword) {
      const pw = String(input.password || '').trim() || this.newUserPassword();
      this.checkPassword(pw);
      await ots.resetPassword(username, pw);
      await this.checkLogin(username, pw);
      u.password = pw;
    }
    u.atakQr = this.fixQr(await ots.atakQr(username).catch(() => ''));
    this.t.users[u.id] = u;
    this.save();
    if (input.syncGroups) await ots.syncGroups(username, this.wantedGroups(u.team), GROUP_PREFIX, [ANON]);
    this.log('OTS-Benutzer übernommen', username);
    return u;
  }

  // ---------------- Rufname/Team/Rolle in ATAK (Geräte-Profile) ----------------
  async syncProfiles() {
    if (!this.otsConfigured()) return { updated: 0, errors: [] };
    const ots = this.ots();
    let updated = 0;
    const errors = [];
    for (const u of Object.values(this.t.users)) {
      if (u.status !== 'active' || !u.username) continue;
      const color = this.team(u.team).color;
      const sig = `${u.callsign}|${color}|${u.role}`;
      let euds;
      try { euds = await ots.euds(u.username); } catch (e) { errors.push(`${u.callsign}: ${e.message}`); continue; }
      u.devices = euds.map(e => ({ uid: e.uid, callsign: e.callsign, device: e.device, platform: e.platform, last: e.last_event_time }));
      u.profiles = u.profiles || {};
      for (const e of euds) {
        if (!e.uid || u.profiles[e.uid] === sig) continue;
        try {
          await ots.setProfile(e.uid, 'locationCallsign', u.callsign);
          await ots.setProfile(e.uid, 'locationTeam', color);
          await ots.setProfile(e.uid, 'atakRoleType', u.role);
          u.profiles[e.uid] = sig;
          updated++;
        } catch (err) { errors.push(`${u.callsign}/${e.uid}: ${err.message}`); }
      }
    }
    this.save();
    return { updated, errors };
  }

  // Für die EUD-Durchreiche: Zuweisung zum OTS-Benutzernamen (CN des Client-Zertifikats)
  assignmentFor(username) {
    if (!username) return null;
    const u = Object.values(this.t.users).find(x => x.username === username && x.status === 'active');
    if (!u) return null;
    return { callsign: u.callsign, team: this.team(u.team).color, role: u.role };
  }

  // Was der Nutzer auf seiner Zugangsseite sieht (nur eigene Daten)
  publicView(u) {
    const o = this.t.ots;
    const base = {
      status: u.status, name: u.name, callsign: u.callsign, unit: u.unit, email: maskEmail(u.email),
      created: u.created, confirmedAt: u.confirmedAt || '', approvedAt: u.approvedAt || '',
    };
    if (u.status !== 'active') return base;
    return {
      ...base,
      team: this.team(u.team).name, teamColor: this.team(u.team).color, role: u.role,
      username: u.username, password: u.password, host: this.takHost(),
      streamPort: o.streamPort, enrollPort: o.enrollPort, apiPort: o.apiPort, hasAtakQr: !!u.atakQr,
      truststorePassword: o.truststorePassword || 'atakatak',
    };
  }

  adminView(u) {
    const { token, emailToken, ...rest } = u;
    return { ...rest, teamName: this.team(u.team).name, teamColor: this.team(u.team).color, hasAccessLink: !!token };
  }
}

// "horst.huber@example.com" -> "ho***@example.com" (auf der Statusseite, falls der Link weitergegeben wird)
function maskEmail(email) {
  const [a, d] = String(email || '').split('@');
  return d ? `${a.slice(0, 2)}***@${d}` : '';
}

module.exports = { ANON, maskEmail, TakUsers, TEAM_COLORS, ROLES, STATUSES, GROUP_PREFIX, makePassword };
