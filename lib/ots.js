// Anbindung an OpenTAKServer (OTS) über dessen Web-API (/api/...), angemeldet als OTS-Administrator.
// Benutzer anlegen/sperren/löschen, Passwort setzen, ATAK-QR (Enrollment-Token), Gruppen (wer sieht wen),
// Geräte-Profile (Rufname/Team/Rolle, die ATAK beim Verbinden übernimmt) und den Truststore holen.

const http = require('http');
const https = require('https');

class OtsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class Ots {
  // url z. B. "https://ots.example.com" (Web-Oberfläche/API von OTS), insecure = selbstsigniertes Zertifikat erlauben,
  // publicHost = Adresse, die OTS in Video-Links für ATAK einsetzen soll (sonst nimmt OTS die Adresse dieser Anfrage)
  constructor({ url, username, password, insecure = false, timeout = 20000, publicHost = '' }) {
    this.publicHost = publicHost;
    this.base = String(url || '').replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.insecure = !!insecure;
    this.timeout = timeout;
    this.token = '';
    this.cookies = {};
  }

  raw(method, path, { body, headers = {}, binary = false } = {}) {
    if (!/^https?:\/\//i.test(this.base)) return Promise.reject(new OtsError('OTS address is not set.', 0));
    const u = new URL(this.base + path);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const h = {
      Accept: 'application/json',
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      ...(this.token ? { 'Authentication-Token': this.token } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(this.cookies['XSRF-TOKEN'] ? { 'X-XSRF-TOKEN': decodeURIComponent(this.cookies['XSRF-TOKEN']) } : {}),
      ...headers,
    };
    return new Promise((resolve, reject) => {
      const req = lib.request(u, { method, headers: h, rejectUnauthorized: !this.insecure, timeout: this.timeout }, res => {
        for (const c of res.headers['set-cookie'] || []) {
          const m = /^([^=]+)=([^;]*)/.exec(c);
          if (m) this.cookies[m[1]] = m[2];
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (binary) return resolve({ status: res.statusCode, body: buf, headers: res.headers });
          let json = null;
          try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* kein JSON */ }
          resolve({ status: res.statusCode, json, text: buf.toString('utf8'), headers: res.headers });
        });
      });
      req.on('timeout', () => req.destroy(new Error('Timeout')));
      req.on('error', e => reject(new OtsError(`OTS not reachable (${e.message})`, 0)));
      if (data) req.write(data);
      req.end();
    });
  }

  async login() {
    this.token = '';
    this.cookies = {};
    const r = await this.raw('POST', '/api/login?include_auth_token', { body: { username: this.username, password: this.password } });
    const resp = (r.json && r.json.response) || {};
    if (r.status !== 200) {
      const err = (resp.errors && (resp.errors[0] || Object.values(resp.errors)[0])) || resp.error || '';
      throw new OtsError(`OTS login failed (${r.status})${err ? ': ' + err : ''} – check OTS admin user/password.`, r.status);
    }
    if (resp.tf_required) throw new OtsError('OTS login needs two-factor authentication – use an OTS admin account without 2FA for this app.', 401);
    this.token = (resp.user && resp.user.authentication_token) || '';
    if (resp.csrf_token && !this.cookies['XSRF-TOKEN']) this.cookies['XSRF-TOKEN'] = encodeURIComponent(resp.csrf_token);
    return true;
  }

  // Anfrage mit Anmeldung; bei abgelaufener Sitzung einmal neu anmelden
  async call(method, path, body, opts = {}) {
    if (!this.token && !Object.keys(this.cookies).length) await this.login();
    let r = await this.raw(method, path, { body, ...opts });
    if (r.status === 401 || r.status === 403) {
      await this.login();
      r = await this.raw(method, path, { body, ...opts });
    }
    if (r.status >= 400 || (r.json && r.json.success === false)) {
      const msg = (r.json && (r.json.error || (r.json.errors && JSON.stringify(r.json.errors)))) || `HTTP ${r.status}`;
      throw new OtsError(`OTS: ${msg}`, r.status);
    }
    return opts.binary ? r.body : (r.json != null ? r.json : r.text);
  }

  // ---------- Benutzer ----------
  async test() {
    await this.login();
    const s = await this.raw('GET', '/api/status');
    return { ok: true, status: s.json || null };
  }

  addUser(username, password, roles = ['user']) {
    return this.call('POST', '/api/user/add', { username, password, confirm_password: password, roles });
  }
  deleteUser(username) { return this.call('POST', '/api/user/delete', { username }); }
  deactivateUser(username) { return this.call('POST', '/api/user/deactivate', { username }); }
  activateUser(username) { return this.call('POST', '/api/user/activate', { username }); }
  resetPassword(username, newPassword) { return this.call('POST', '/api/user/password/reset', { username, new_password: newPassword }); }

  async userExists(username) {
    const r = await this.call('GET', '/api/users?username=' + encodeURIComponent(username) + '&per_page=50');
    return (r.results || []).some(u => u.username === username);
  }

  // ATAK-Enrollment-QR: tak://com.atakmap.app/enroll?host=…&username=…&token=…
  async atakQr(username, { maxUses, expires } = {}) {
    const body = { username };
    if (maxUses) body.max = maxUses;
    if (expires) body.exp = Math.round(expires / 1000);
    const r = await this.call('POST', '/api/atak_qr_string', body);
    if (!r.qr_string) throw new OtsError('OTS returned no QR string.', 500);
    return r.qr_string;
  }

  truststore() { return this.call('GET', '/api/truststore', undefined, { binary: true }); }

  // ---------- Gruppen (OTS-Kanäle: IN = schreiben, OUT = lesen) ----------
  async groups() {
    const r = await this.call('GET', '/api/groups?per_page=500');
    return (r.results || []).map(g => g.name);
  }
  async ensureGroup(name, description = '') {
    try {
      await this.call('POST', '/api/groups', { name, description });
    } catch (e) {
      if (!/already exists/i.test(e.message)) throw e;
    }
  }
  async userGroups(username) {
    const r = await this.call('GET', '/api/users/groups?username=' + encodeURIComponent(username));
    return (r.results || []).map(m => ({ group: m.group_name, direction: m.direction }));
  }
  addToGroup(username, group, direction) { return this.call('PUT', '/api/groups', { users: [username], group_name: group, direction }); }
  removeFromGroup(username, group, direction) {
    return this.call('DELETE', `/api/groups/members?username=${encodeURIComponent(username)}&group_name=${encodeURIComponent(group)}&direction=${direction}`);
  }

  // Mitgliedschaften eines Benutzers auf den Soll-Stand bringen; nur Gruppen mit Präfix werden angefasst
  async syncGroups(username, wanted, prefix, extra = []) {
    const want = new Set(wanted.map(w => `${w.group}|${w.direction}`));
    const have = (await this.userGroups(username)).filter(m => m.group.startsWith(prefix) || extra.includes(m.group));
    const haveSet = new Set(have.map(m => `${m.group}|${m.direction}`));
    for (const m of have) if (!want.has(`${m.group}|${m.direction}`)) await this.removeFromGroup(username, m.group, m.direction);
    for (const w of wanted) {
      if (haveSet.has(`${w.group}|${w.direction}`)) continue;
      await this.ensureGroup(w.group);
      await this.addToGroup(username, w.group, w.direction);
    }
  }

  // ---------- Geräte und Profile ----------
  async euds(username) {
    const r = await this.call('GET', '/api/eud?username=' + encodeURIComponent(username) + '&per_page=100');
    return (r.results || []).filter(e => !username || e.username === username);
  }
  // Einstellung für ein Gerät, die ATAK beim (nächsten) Verbinden übernimmt
  setProfile(eudUid, key, value) {
    return this.call('POST', '/api/profiles', {
      preference_key: key, preference_value: String(value), value_class: 'String',
      enrollment: true, connection: true, active: true, tool: '', eud_uid: eudUid,
    });
  }
}

// ---------- Videostreams (MediaMTX in OTS) ----------
// MediaMTX holt das Bild bei Bedarf selbst (sourceOnDemand) von der angegebenen Quelle (hier: unser HLS-Link)
Ots.prototype.videoStreams = async function () {
  const r = await this.call('GET', '/api/video_streams?per_page=500');
  return (r.results || []).map(v => ({ path: v.path, source: (() => { try { return JSON.parse(v.mediamtx_settings || '{}').source || ''; } catch (e) { return ''; } })() }));
};
Ots.prototype.hostHeaders = function () {
  // OTS (ProxyFix) übernimmt X-Forwarded-Host als Adresse im Video-Link für ATAK; den Host-Header lassen wir in Ruhe
  return this.publicHost ? { headers: { 'X-Forwarded-Host': this.publicHost } } : {};
};
Ots.prototype.addStream = function (path, source) {
  return this.call('POST', '/api/mediamtx/stream/add', { path, source, sourceOnDemand: true, sourceOnDemandStartTimeout: '20s', sourceOnDemandCloseAfter: '20s' }, this.hostHeaders());
};
Ots.prototype.updateStream = function (path, source) {
  return this.call('PATCH', '/api/mediamtx/stream/update', { path, source }, this.hostHeaders());
};
Ots.prototype.deleteStream = function (path) {
  return this.call('DELETE', '/api/mediamtx/stream/delete?path=' + encodeURIComponent(path));
};

// ---------- Verwaltung wie in der OTS-Oberfläche: Benutzer, Rollen, Gruppen, Missionen, Feeds, Meshtastic ----------
const q = encodeURIComponent;
const results = r => (Array.isArray(r) ? r : (r && r.results) || []);
Object.assign(Ots.prototype, {
  allUsers() { return this.call('GET', '/api/users/all').then(results); },
  setRoles(username, roles) { return this.call('POST', '/api/user/role', { username, roles }); },
  allGroups() { return this.call('GET', '/api/groups?per_page=500').then(results); },
  createGroup(name, description = '') { return this.call('POST', '/api/groups', { name, description }); },
  deleteGroup(name) { return this.call('DELETE', '/api/groups?group_name=' + q(name)); },
  allEuds() { return this.call('GET', '/api/eud?per_page=500').then(results); },
  missions() { return this.call('GET', '/api/missions?per_page=500').then(results); },
  // OTS verlangt die UID eines bekannten Geräts als Ersteller; groups = OTS-Gruppen-IDs
  createMission({ name, description, password, creatorUid, groups, defaultRole }) {
    const body = { name, creator_uid: creatorUid, description: description || '', tool: 'public' };
    if (password) body.password = password;
    if (groups && groups.length) body.groups = groups;
    if (defaultRole) body.default_role = defaultRole;
    return this.call('POST', '/api/missions', body);
  },
  // Bestehende Mission: Gruppen neu setzen (OTS verlangt dabei name und creator_uid)
  setMissionGroups(name, creatorUid, groups) { return this.call('PUT', '/api/missions', { name, creator_uid: creatorUid, groups }); },
  deleteMission(name) { return this.call('DELETE', '/api/missions?name=' + q(name)); },
  meshChannels() { return this.call('GET', '/api/meshtastic/channel?per_page=200').then(results); },
  meshPsk() { return this.call('GET', '/api/meshtastic/generate_psk').then(r => r.psk); },
  createMeshChannel(body) { return this.call('POST', '/api/meshtastic/channel', body); },
  deleteMeshChannel(url) { return this.call('DELETE', '/api/meshtastic/channel?url=' + q(url)); },
});

module.exports = { Ots, OtsError };
