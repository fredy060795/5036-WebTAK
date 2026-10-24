// Helm Camera Streams – Server
//
//   Handy-App:   https://<domain>/app/#u=<benutzer>&s=<streamId>&k=<schlüssel>   (per QR-Code)
//   Stream:      https://<domain>/<benutzer>/<streamId>                         (MJPEG, Link für ATAK/WinTAK)
//                https://<domain>/<benutzer>/<streamId>/index.m3u8              (HLS, braucht ffmpeg)
//                https://<domain>/<benutzer>/<streamId>/stream.ts               (MPEG-TS, braucht ffmpeg)
//                https://<domain>/<benutzer>/<streamId>/snapshot.jpg            (letztes Bild)
//   Admin:       https://<admin-domain>/admin/
//
// Einstellungen über Umgebungsvariablen, siehe README.md.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const { Store } = require('./lib/store');
const { Auth } = require('./lib/auth');
const { StreamHub, normRotate, normFit, normFramesize } = require('./lib/streams');
const { sendMail, configured: smtpConfigured } = require('./lib/mailer');
const tak = require('./lib/tak');
const { TileCache } = require('./lib/tiles');
const { TakUsers, TEAM_COLORS, ROLES, maskEmail } = require('./lib/takusers');
const { TakVideo } = require('./lib/takvideo');
const { atakPackage } = require('./lib/datapackage');

const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 5036,
  bind: process.env.BIND || '0.0.0.0',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  adminHost: (process.env.ADMIN_HOST || '').toLowerCase(),
  adminUrl: (process.env.ADMIN_URL || '').replace(/\/+$/, ''),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  // Nur zum Testen am PC (start.bat): eigene CA, die Handys unter /ca.crt herunterladen können
  testCa: process.env.TEST_CA_FILE || '',
  // X-Forwarded-* nur auswerten, wenn ein Reverse-Proxy davor sitzt. Mit eigenem
  // Zertifikat (TLS_CERT) läuft der Server direkt im Netz, dann standardmäßig aus.
  trustProxy: process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY !== '0' : !process.env.TLS_CERT,
};

const log = (...args) => console.log(new Date().toISOString(), ...args);

const store = new Store(config.dataDir);
const auth = new Auth(store);
const ffmpegOk = spawnSync(config.ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;
const hub = new StreamHub({
  store,
  ffmpeg: ffmpegOk ? config.ffmpeg : null,
  workDir: path.join(config.dataDir, 'hls'),
  log,
});

const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ======================================================================
// Hilfsfunktionen
// ======================================================================

function hostOf(req) {
  const h = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '';
  return h.split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
}

function protoOf(req) {
  if (config.trustProxy && req.headers['x-forwarded-proto']) return req.headers['x-forwarded-proto'].split(',')[0].trim();
  return req.socket.encrypted ? 'https' : 'http';
}

function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) return req.headers['x-forwarded-for'].split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// Öffentliche Adresse: im Admin eingestellt > PUBLIC_URL > aus der Anfrage
function configuredBase() {
  return ((store.data.settings || {}).publicUrl) || config.publicUrl;
}

function publicBase(req) {
  const host = ((config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
  return configuredBase() || `${protoOf(req)}://${host}`;
}

// "https://domain:5036/irgendwas" -> "https://domain:5036"; leer = automatisch
function normalizeBase(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let u;
  try { u = new URL(/^https?:\/\//i.test(text) ? text : 'https://' + text); } catch (e) { u = null; }
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) throw new Error('Bitte eine gültige Adresse eingeben, z. B. https://example.com:5036');
  return u.origin;
}

// Adresse für Links in Reset-Mails: nur aus der Konfiguration, nie aus der Anfrage
// (sonst könnte jemand über einen gefälschten Host-Header den Link umleiten).
function resetBase() {
  if (config.adminUrl) return config.adminUrl;
  const pub = configuredBase();
  if (!pub) return null;
  if (!config.adminHost) return pub;
  const u = new URL(pub);
  u.hostname = config.adminHost;
  return u.origin;
}

// Admin nur auf der Admin-Domain, wenn eine eingestellt ist
function isAdminHost(req) {
  return !config.adminHost || hostOf(req) === config.adminHost;
}

function links(req, entry) {
  const base = publicBase(req) + '/' + entry.user + '/' + entry.streamId;
  return {
    stream: base,
    hls: base + '/index.m3u8',
    ts: base + '/stream.ts',
    snapshot: base + '/snapshot.jpg',
    app: `${publicBase(req)}/app/#u=${encodeURIComponent(entry.user)}&s=${encodeURIComponent(entry.streamId)}&k=${encodeURIComponent(entry.key)}`,
  };
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function json(res, status, obj, extra) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Anfrage zu groß.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('Ungültiges JSON.')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, dir, rel) {
  const root = path.join(PUBLIC_DIR, dir);
  let file = path.normalize(path.join(root, rel || 'index.html'));
  if (!file.startsWith(root)) return send(res, 404, 'Nicht gefunden');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return send(res, 404, 'Nicht gefunden');
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  fs.createReadStream(file).pipe(res);
}

// ======================================================================
// Selbst-Anmeldung (allgemeiner QR-Code -> /app/ -> Name + Einheit)
// ======================================================================

const registrations = new Map(); // ip -> [zeitpunkte]
const MAX_REG_PER_HOUR = 20;

function registrationEnabled() {
  return (store.data.registration || {}).enabled !== false; // Standard: an
}

async function handleRegister(req, res) {
  const body = await readJson(req);
  const en = body.source === 'eud'; // TAK-EUD ist englisch
  if (!registrationEnabled()) {
    return json(res, 403, { error: en ? 'Streaming sign-up is currently disabled. Please contact the admin.' : 'Die Anmeldung ist gerade gesperrt. Bitte beim Admin melden.' });
  }
  const ip = clientIp(req);
  const now = Date.now();
  const list = (registrations.get(ip) || []).filter(t => now - t < 3600 * 1000);
  if (list.length >= MAX_REG_PER_HOUR) return json(res, 429, { error: en ? 'Too many sign-ups. Please try again later.' : 'Zu viele Anmeldungen. Bitte später erneut versuchen.' });
  const entry = hub.register(body.name, body.unit, body.source === 'eud');
  list.push(now);
  registrations.set(ip, list);
  log('Selbst-Anmeldung', entry.user + '/' + entry.streamId, JSON.stringify(entry.label), ip);
  hub.event(StreamHub.id(entry.user, entry.streamId), 'register', `${entry.label} hat sich angemeldet`);
  takVideo.touch(StreamHub.id(entry.user, entry.streamId));
  return json(res, 200, { u: entry.user, s: entry.streamId, k: entry.key, label: entry.label });
}

// ======================================================================
// EUD (TAK-Client im Browser): Zertifikat anfordern, .p12 lesen
// ======================================================================

const VENDOR = {
  'leaflet.js': 'leaflet/dist/leaflet.js',
  'leaflet.css': 'leaflet/dist/leaflet.css',
  'images/marker-icon.png': 'leaflet/dist/images/marker-icon.png',
  'images/marker-shadow.png': 'leaflet/dist/images/marker-shadow.png',
  'images/layers.png': 'leaflet/dist/images/layers.png',
  'images/layers-2x.png': 'leaflet/dist/images/layers-2x.png',
  'images/marker-icon-2x.png': 'leaflet/dist/images/marker-icon-2x.png',
  'leaflet-rotate.js': 'leaflet-rotate/dist/leaflet-rotate.js',
  'milsymbol.js': 'milsymbol/dist/milsymbol.js',
  'jsQR.js': 'jsqr/dist/jsQR.js',
  // 3D-Karte (ES-Module; der Worker wird relativ zum Modul geladen)
  'maplibre-gl.mjs': 'maplibre-gl/dist/maplibre-gl.mjs',
  'maplibre-gl-worker.mjs': 'maplibre-gl/dist/maplibre-gl-worker.mjs',
  'maplibre-gl.css': 'maplibre-gl/dist/maplibre-gl.css',
};

function serveVendor(res, name) {
  const rel = VENDOR[name];
  if (!rel) return send(res, 404, 'Nicht gefunden');
  const file = require.resolve(rel.split('/')[0] + '/package.json').replace(/package\.json$/, '') + rel.split('/').slice(1).join('/');
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
}

const tiles = new TileCache(path.join(config.dataDir, 'tiles'), 'WebTAK/1.0 (TAK-Client; Kachel-Zwischenspeicher)', process.env.TILE_URL_OVERRIDE);

async function serveTile(res, rel) {
  const t = TileCache.parse(rel);
  if (!t) return send(res, 404, 'Nicht gefunden');
  try {
    const { data, type } = await tiles.get(t);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'Content-Length': data.length });
    res.end(data);
  } catch (e) {
    send(res, 502, 'Kachel nicht verfügbar');
  }
}

// ======================================================================
// TAK-Zugänge (OpenTAKServer): Registrierung, Zugangsseite, Verwaltung
// ======================================================================

const takUsers = new TakUsers(store, { log });
// Rufname/Team/Rolle für neue Geräte regelmäßig als OTS-Profil setzen
// Gruppen beim Start einmal auf den Soll-Stand bringen (z. B. alte TEAM_-Gruppen entfernen, wenn niemand gesperrt ist)
setTimeout(() => takUsers.syncAllGroups().then(errs => { for (const e of errs) log('OTS-Gruppen:', e); })
  .catch(e => log('OTS-Gruppen:', e.message)), 10000).unref();
setInterval(() => takUsers.syncProfiles().then(r => { if (r.updated) log('OTS-Profile aktualisiert:', r.updated); })
  .catch(e => log('OTS-Profile:', e.message)), 2 * 60 * 1000).unref();

// Kamera-Streams automatisch als Video-Feed im TAK-Server eintragen.
// Adresse für den HLS-Link: eingestellte öffentliche Adresse, sonst die zuletzt im Admin benutzte.
const takVideo = new TakVideo({
  store, hub, takUsers, log,
  base: () => configuredBase() || ((store.data.takVideo || {}).lastBase) || '',
});
setTimeout(() => takVideo.syncAll().catch(e => log('TAK-Video:', e.message)), 5000).unref();
let takVideoTick = 0;
setInterval(() => {
  // Modus "nur live": alle 30 s prüfen, sonst alle 10 min zur Sicherheit alles abgleichen
  if (takVideo.s.when === 'live' || ++takVideoTick % 20 === 0) takVideo.syncAll().catch(e => log('TAK-Video:', e.message));
}, 30 * 1000).unref();

const accessLimits = new Map(); // ip -> [zeitpunkte] für Registrierungen
function mailReady() { return smtpConfigured(store.data.smtp); }
// Mail an einen Nutzer. Sicherheitsnetz: Links zum Admin-Bereich gehen nie an Nutzer.
function mailUser(to, subject, text) {
  if (!mailReady() || !to) return Promise.resolve(false);
  if (/\/admin\b/i.test(text)) {
    log('E-Mail an', to, 'NICHT gesendet: enthält einen Link zum Admin-Bereich');
    return Promise.resolve(false);
  }
  return sendMail(store.data.smtp, { to, subject, text }).then(() => true).catch(e => { log('E-Mail fehlgeschlagen:', e.message); return false; });
}
// Mail nur an die Admin-Adresse (Einstellungen → System), nie an die anfragende Person
function mailAdmin(subject, text, notTo) {
  const to = String(auth.admin.email || '').trim();
  if (!mailReady() || !to) return Promise.resolve(false);
  if (notTo && to.toLowerCase() === String(notTo).trim().toLowerCase()) {
    log('Admin-Hinweis nicht gesendet: Admin-E-Mail ist gleich der E-Mail der Anfrage');
    return Promise.resolve(false);
  }
  return sendMail(store.data.smtp, { to, subject, text }).then(() => true).catch(e => { log('E-Mail fehlgeschlagen:', e.message); return false; });
}
const accessLink = (req, u) => `${publicBase(req)}/access/#t=${u.token}`;
const lookupLimits = new Map(); // ip -> [zeitpunkte] für "Status per E-Mail"

function requestMail(u, link) {
  return `Hello ${u.name},\n\nthank you – your registration request for WebTAK has been received.\n\n`
    + `Name: ${u.name}\n${u.unit ? `Unit: ${u.unit}\n` : ''}${u.requestedCallsign ? `Requested callsign: ${u.requestedCallsign}\n` : ''}\n`
    + 'What happens next:\n1. An administrator reviews your request.\n2. As soon as it is approved you get another e-mail.\n'
    + '3. Your login details, QR codes and a step-by-step guide are then shown on your personal status page:\n\n'
    + `${link}\n\nKeep this link private – it is your personal access.\n`;
}

// Neue Anfrage: Hinweis im Admin-Fenster und Mail an die Admin-Adresse
function newRequest(u, suffix) {
  const text = `WebTAK-Zugang angefragt: ${u.name}${u.unit ? ' – ' + u.unit : ''}${suffix}`;
  hub.event('tak', 'takreg', text);
  // Ohne Link: die Adresse des Admin-Bereichs steht nie in einer Mail (und nie aus dem Host-Header der Anfrage)
  mailAdmin('WebTAK – neue Registrierungsanfrage',
    `${text}\nE-Mail: ${u.email}\n${u.requestedCallsign ? `Gewünschter Rufname: ${u.requestedCallsign}\n` : ''}\n`
    + 'Bitte im WebTAK-Admin unter „Benutzer & Anfragen“ prüfen und freigeben oder ablehnen.\n', u.email);
}

async function handleAccessApi(req, res, route) {
  const url = new URL(req.url, 'http://x');
  const token = req.headers['x-access-token'] || url.searchParams.get('t') || '';
  if (route === 'config' && req.method === 'GET') {
    const r = takUsers.t.registration;
    return json(res, 200, { open: r.open, codeword: !!r.codeword, emailConfirm: r.emailConfirm && mailReady() });
  }
  if (route === 'register' && req.method === 'POST') {
    const ip = clientIp(req);
    const now = Date.now();
    const list = (accessLimits.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (list.length >= 5) return json(res, 429, { error: 'Too many registrations. Please try again later.' });
    list.push(now);
    accessLimits.set(ip, list);
    const body = await readJson(req);
    let u;
    try { u = takUsers.register(body, { smtpReady: mailReady() }); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
    const link = accessLink(req, u);
    let mailed;
    if (u.status === 'unconfirmed') {
      mailed = await mailUser(u.email, 'WebTAK – please confirm your registration request',
        `Hello ${u.name},\n\nwe received your registration request for WebTAK.\nPlease confirm your e-mail address with this link:\n\n${link}&c=${u.emailToken}\n\n`
        + `After that an administrator will review your request. You will get another e-mail as soon as your access is approved.\n\n`
        + `If you did not request access, simply ignore this e-mail.\n`);
    } else {
      newRequest(u, '');
      mailed = await mailUser(u.email, 'WebTAK – registration request received', requestMail(u, link));
    }
    return json(res, 200, { status: u.status, token: u.token, mailed, email: maskEmail(u.email) });
  }
  if (route === 'confirm' && req.method === 'POST') {
    const body = await readJson(req);
    const u = takUsers.confirmEmail(String(body.code || ''));
    if (!u) return json(res, 400, { error: 'This confirmation link is invalid or was already used.' });
    newRequest(u, ' (E-Mail bestätigt)');
    return json(res, 200, { status: u.status });
  }
  // Status vergessen: Statuslink per E-Mail (immer gleiche Antwort, damit niemand Adressen ausprobieren kann)
  if (route === 'lookup' && req.method === 'POST') {
    const ip = clientIp(req);
    const now = Date.now();
    const list = (lookupLimits.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (list.length >= 5) return json(res, 429, { error: 'Too many requests. Please try again later.' });
    list.push(now);
    lookupLimits.set(ip, list);
    const body = await readJson(req);
    const u = takUsers.byEmail(body.email);
    if (u && mailReady()) {
      mailUser(u.email, 'WebTAK – your status link', `Hello ${u.name},\n\nhere is the link to the status of your WebTAK access:\n\n${accessLink(req, u)}\n\n`
        + 'If you did not ask for this e-mail, you can ignore it.\n');
    }
    return json(res, 200, { ok: true, mail: mailReady() });
  }
  const u = takUsers.byToken(String(token));
  if (!u) return json(res, 404, { error: 'Unknown access link.' });
  if (route === 'me' && req.method === 'GET') return json(res, 200, { ...takUsers.publicView(u), mail: mailReady() });
  if (u.status !== 'active') return json(res, 403, { error: 'Your access is not approved yet.' });
  const o = takUsers.t.ots;
  const host = takUsers.takHost();
  const qr = text => QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  // ATAK-QR: normaler https-Link (Handy-Kamera öffnet ihn im Browser) zur Seite mit dem Einrichtungspaket
  if (route === 'qr/atak.svg') return send(res, 200, await qr(`${publicBase(req)}/access/atak.html#t=${encodeURIComponent(String(token))}`), 'image/svg+xml');
  // tak://-Link von OTS (nur mit vertrauenswürdigem Server-Zertifikat, z. B. Let's Encrypt)
  if (route === 'qr/atak-direct.svg') {
    if (!u.atakQr) return send(res, 404, 'Kein QR-Code');
    return send(res, 200, await qr(u.atakQr), 'image/svg+xml');
  }
  if (route === 'atak-link') return json(res, 200, { link: u.atakQr || '' });
  // Einrichtungspaket: Truststore + Server + Benutzer + Passwort + Rufname/Team – ATAK richtet alles ein
  if (route === 'atak-package.zip') {
    let truststore;
    try { truststore = await takUsers.ots().truststore(); } catch (e) { return json(res, 502, { error: 'Truststore not available: ' + e.message }); }
    const team = takUsers.team(u.team);
    const pkg = atakPackage({
      host, port: o.streamPort, description: 'WebTAK ' + host, username: u.username, password: u.password,
      caPassword: o.truststorePassword || 'atakatak', callsign: u.callsign, team: team.color, role: u.role, truststore,
    });
    return send(res, 200, pkg.data, 'application/zip', { 'Content-Disposition': `attachment; filename="${pkg.filename}"`, 'Cache-Control': 'no-store' });
  }
  if (route === 'qr/itak.svg') return send(res, 200, await qr(`${host},${host},${o.streamPort},ssl`), 'image/svg+xml');
  if (route === 'qr/eud.svg') {
    const p = new URLSearchParams({ host, port: o.streamPort, proto: 'ssl', enroll: o.enrollPort, username: u.username, password: u.password, callsign: u.callsign });
    return send(res, 200, await qr(`${publicBase(req)}/eud/#${p}`), 'image/svg+xml');
  }
  if (route === 'truststore.p12') {
    try {
      const data = await takUsers.ots().truststore();
      return send(res, 200, data, 'application/x-pkcs12', { 'Content-Disposition': `attachment; filename="truststore-${host || 'tak'}.p12"` });
    } catch (e) { return json(res, 502, { error: 'Truststore not available: ' + e.message }); }
  }
  return json(res, 404, { error: 'Unknown request.' });
}

async function handleTakAdmin(req, res, route) {
  const method = req.method;
  if (route === 'state' && method === 'GET') {
    const { password, ...ots } = takUsers.t.ots;
    return json(res, 200, {
      ots: { ...ots, hasPassword: !!password }, otsReady: takUsers.otsConfigured(), registration: takUsers.t.registration,
      teams: takUsers.t.teams, blocks: takUsers.t.blocks, users: takUsers.list().map(u => takUsers.adminView(u)),
      colors: TEAM_COLORS, roles: ROLES, joinUrl: publicBase(req) + '/join/', mail: mailReady(),
    });
  }
  if (route === 'join-qr.svg' && method === 'GET') {
    return send(res, 200, await QRCode.toString(publicBase(req) + '/join/', { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }), 'image/svg+xml');
  }
  if (method === 'GET') {
    const m = /^user\/([a-f0-9]+)\/link$/.exec(route);
    if (m) return json(res, 200, { link: accessLink(req, takUsers.get(m[1])) });
    return json(res, 404, { error: 'Unbekannte Anfrage.' });
  }
  const body = method === 'DELETE' ? {} : await readJson(req);
  if (route === 'ots') { takUsers.setOts(body); return json(res, 200, { ok: true }); }
  if (route === 'ots/test') {
    const r = await takUsers.ots().test();
    let groups = [];
    try { groups = await takUsers.ots().groups(); } catch (e) { /* Gruppen evtl. per LDAP */ }
    return json(res, 200, { ok: r.ok, groups });
  }
  if (route === 'registration') { takUsers.setRegistration(body); return json(res, 200, { ok: true }); }
  if (route === 'teams') {
    const errors = await takUsers.setTeams(body.teams, body.blocks);
    return json(res, 200, { ok: true, errors });
  }
  if (route === 'sync') {
    const groupErrors = await takUsers.syncAllGroups();
    const r = await takUsers.syncProfiles();
    return json(res, 200, { ok: true, updated: r.updated, errors: [...groupErrors, ...r.errors] });
  }
  const m = /^user\/([a-f0-9]+)(?:\/([a-z]+))?$/.exec(route);
  if (!m) return json(res, 404, { error: 'Unbekannte Anfrage.' });
  const [, id, action] = m;
  if (method === 'DELETE' && !action) { await takUsers.remove(id); return json(res, 200, { ok: true }); }
  let u;
  if (action === 'approve') {
    u = await takUsers.approve(id, body);
    const sent = await mailUser(u.email, 'WebTAK – your access is ready',
      `Hello ${u.name},\n\nyour WebTAK access has been approved.\n\nCallsign: ${u.callsign}\n\nOpen this page for your login details, QR codes and the step-by-step guide.\nRecommended: start WebTAK right from that page – it runs in the browser on any phone, nothing to install:\n\n${accessLink(req, u)}\n\nKeep this link private.\n`);
    return json(res, 200, { ok: true, user: takUsers.adminView(u), mailed: sent, link: accessLink(req, u) });
  }
  if (action === 'update') u = await takUsers.update(id, body);
  else if (action === 'reject') {
    u = await takUsers.reject(id);
    mailUser(u.email, 'WebTAK – registration request declined',
      `Hello ${u.name},\n\nyour registration request for WebTAK was declined by an administrator.\nIf you think this is a mistake, please contact your administrator.\n`);
  }
  else if (action === 'block') u = await takUsers.block(id);
  else if (action === 'unblock') u = await takUsers.unblock(id);
  else if (action === 'password') u = await takUsers.newPassword(id);
  else if (action === 'qr') u = await takUsers.newQr(id);
  else return json(res, 404, { error: 'Unbekannte Anfrage.' });
  return json(res, 200, { ok: true, user: takUsers.adminView(u) });
}

function takSettings() {
  const s = store.data.settings || {};
  return { allowedHosts: s.takHosts || '', preset: s.eudPreset || null };
}

const eudLimits = new Map(); // ip -> [zeitpunkte] für Zertifikatsanforderungen
const martiLimits = new Map(); // ip -> [zeitpunkte] für Anfragen an die TAK-Server-API

async function handleEudApi(req, res, route) {
  if (route === 'config' && req.method === 'GET') {
    const t = takSettings();
    return json(res, 200, { preset: t.preset, restricted: !!t.allowedHosts.trim() });
  }
  if (req.method !== 'POST') return json(res, 404, { error: 'Unknown request.' });
  if (route === 'p12') {
    const body = await readJson(req, 512 * 1024);
    const r = tak.readP12(String(body.data || ''), String(body.password || ''));
    return json(res, 200, { ...r, info: r.certPem ? tak.certInfo(r.certPem) : null, caInfo: r.caPems.map(tak.certInfo) });
  }
  if (route === 'package') {
    const body = await readJson(req, 6 * 1024 * 1024);
    const r = tak.readDataPackage(String(body.data || ''));
    return json(res, 200, { ...r, info: r.certPem ? tak.certInfo(r.certPem) : null });
  }
  if (route === 'pem') {
    // Truststore als PEM-Datei (eine oder mehrere CAs)
    const body = await readJson(req, 512 * 1024);
    const pems = String(body.data || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    if (!pems.length) throw new Error('No certificates found in file.');
    return json(res, 200, { kind: 'truststore', caPems: pems.map(p => p + '\n'), caInfo: pems.map(p => tak.certInfo(p)) });
  }
  if (route === 'extract') {
    // Eigene Datei (KML/KMZ/Datenpaket) als Overlay laden
    const body = await readJson(req, 120 * 1024 * 1024);
    return json(res, 200, tak.extractContent(String(body.name || ''), Buffer.from(String(body.data || ''), 'base64')));
  }
  if (route === 'marti') {
    const ip = clientIp(req);
    const now = Date.now();
    const list = (martiLimits.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (list.length >= 600) return json(res, 429, { error: 'Too many requests. Please try again later.' });
    list.push(now);
    martiLimits.set(ip, list);
    const body = await readJson(req, 512 * 1024);
    const conn = body.server || {};
    const host = String(conn.host || '').trim();
    if (!(await tak.targetAllowed(takSettings().allowedHosts, host))) return json(res, 403, { error: `TAK server ${host} is not allowed on this server.` });
    try {
      return json(res, 200, await tak.marti({ ...conn, host }, String(body.action || ''), body.args || {}));
    } catch (e) {
      log('EUD TAK-API', host, String(body.action || ''), 'Fehler:', e.message);
      if (e.code === 'UNTRUSTED') return json(res, 409, { error: e.message, code: e.code, fingerprint: e.fingerprint, subject: e.subject });
      throw e;
    }
  }
  if (route === 'enroll') {
    const ip = clientIp(req);
    const now = Date.now();
    const list = (eudLimits.get(ip) || []).filter(t => now - t < 3600 * 1000);
    if (list.length >= 30) return json(res, 429, { error: 'Too many requests. Please try again later.' });
    list.push(now);
    eudLimits.set(ip, list);
    const body = await readJson(req, 512 * 1024);
    const host = String(body.host || '').trim();
    if (!(await tak.targetAllowed(takSettings().allowedHosts, host))) return json(res, 403, { error: `TAK server ${host} is not allowed on this server.` });
    try {
      const r = await tak.enroll({
        host, port: Number(body.port) || tak.ENROLL_PORT, username: body.username, password: body.password,
        uid: String(body.uid || 'EUD').slice(0, 64), caPems: Array.isArray(body.caPems) ? body.caPems : [],
        fingerprint: String(body.fingerprint || ''),
      });
      log('EUD: Zertifikat angefordert', host, r.info.subject);
      return json(res, 200, r);
    } catch (e) {
      if (e.code === 'UNTRUSTED') return json(res, 409, { error: e.message, code: e.code, fingerprint: e.fingerprint, subject: e.subject });
      throw e;
    }
  }
  return json(res, 404, { error: 'Unknown request.' });
}

// ======================================================================
// Admin-API
// ======================================================================

async function handleAdminApi(req, res, route) {
  const method = req.method;
  const sid = cookies(req).sid;
  const secure = protoOf(req) === 'https';
  const cookieAttrs = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

  // Schutz gegen fremde Seiten (CSRF): schreibende Anfragen brauchen diesen Header
  if (method !== 'GET' && req.headers['x-requested-with'] !== 'helm') {
    return json(res, 403, { error: 'Ungültige Anfrage.' });
  }

  // --- ohne Anmeldung ---
  if (route === 'login' && method === 'POST') {
    const body = await readJson(req);
    const newSid = auth.login(clientIp(req), body.username, body.password);
    log('Admin angemeldet von', clientIp(req));
    return json(res, 200, { ok: true, mustChange: !!auth.admin.mustChange }, { 'Set-Cookie': `sid=${newSid}; ${cookieAttrs}; Max-Age=43200` });
  }
  if (route === 'forgot' && method === 'POST') {
    const body = await readJson(req);
    const who = String(body.username || '').trim().toLowerCase();
    const admin = auth.admin;
    if (who && admin.email && (who === admin.username.toLowerCase() || who === admin.email.toLowerCase())) {
      if (!resetBase()) {
        log('Passwort-Reset angefordert, aber PUBLIC_URL/ADMIN_URL ist nicht gesetzt – keine Mail gesendet.');
      } else if (smtpConfigured(store.data.smtp)) {
        const token = auth.createResetToken();
        const link = `${resetBase()}/admin/#reset=${token}`;
        sendMail(store.data.smtp, {
          to: admin.email,
          subject: 'WebTAK – Passwort zurücksetzen',
          text: `Hallo,\n\nüber diesen Link kannst du ein neues Admin-Passwort festlegen (1 Stunde gültig):\n\n${link}\n\nWenn du das nicht angefordert hast, ignoriere diese E-Mail.\n`,
        }).then(() => log('Reset-Mail gesendet')).catch(e => log('Reset-Mail fehlgeschlagen:', e.message));
      } else {
        log('Passwort-Reset angefordert, aber SMTP ist nicht eingerichtet.');
      }
    }
    // Immer gleiche Antwort, damit niemand Benutzernamen ausprobieren kann
    return json(res, 200, { ok: true });
  }
  if (route === 'reset' && method === 'POST') {
    const body = await readJson(req);
    auth.resetPassword(String(body.token || ''), body.password ? String(body.password) : '');
    log('Admin-Passwort per Link zurückgesetzt');
    return json(res, 200, { ok: true });
  }

  // --- ab hier angemeldet ---
  if (!auth.check(sid)) return json(res, 401, { error: 'Bitte anmelden.' });

  if (route === 'logout' && method === 'POST') {
    auth.logout(sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=; ${cookieAttrs}; Max-Age=0` });
  }
  if (route === 'me' && method === 'GET') {
    return json(res, 200, {
      username: auth.admin.username,
      email: auth.admin.email,
      mustChange: !!auth.admin.mustChange,
      ffmpeg: ffmpegOk,
      publicBase: publicBase(req),
      testCa: !!config.testCa,
    });
  }
  if (route === 'credentials' && method === 'POST') {
    const body = await readJson(req);
    auth.changeCredentials(sid, {
      current: body.current,
      username: body.username,
      password: body.password,
      email: body.email,
    });
    log('Admin-Zugangsdaten geändert');
    return json(res, 200, { ok: true });
  }

  // Adresse, unter der der Admin uns erreicht, als Rückfall für den HLS-Link im TAK-Server merken
  if (!configuredBase()) {
    const b = publicBase(req);
    if (b && !/\/\/(localhost|127\.|\[::1\])/.test(b) && (store.data.takVideo || {}).lastBase !== b) {
      takVideo.s.lastBase = b;
      store.save();
    }
  }

  // Erst nach dem ersten Passwortwechsel ist der Rest erlaubt
  if (auth.admin.mustChange) return json(res, 403, { error: 'Bitte zuerst das Passwort ändern.', mustChange: true });

  if (route === 'registration' && method === 'GET') {
    const host = ((config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
    return json(res, 200, {
      enabled: registrationEnabled(),
      liveMode: hub.liveMode(),
      userCanStart: hub.userCanStart(),
      appUrl: publicBase(req) + '/app/',
      publicUrl: (store.data.settings || {}).publicUrl || '',           // im Admin eingestellt
      autoUrl: config.publicUrl || `${protoOf(req)}://${host}`,          // ohne Einstellung
    });
  }
  if (route.startsWith('takusers/')) return await handleTakAdmin(req, res, route.slice(9));
  if (route === 'takvideo' && method === 'GET') return json(res, 200, takVideo.state());
  if (route === 'takvideo/settings' && method === 'POST') { takVideo.setSettings(await readJson(req)); return json(res, 200, takVideo.state()); }
  if (route === 'takvideo/sync' && method === 'POST') { const r = await takVideo.syncAll(); return json(res, 200, { ...r, ...takVideo.state() }); }
  if (route === 'tak' && method === 'GET') {
    return json(res, 200, { allowedHosts: takSettings().allowedHosts, preset: takSettings().preset, eudUrl: publicBase(req) + '/eud/' });
  }
  if (route === 'tak' && method === 'POST') {
    const body = await readJson(req);
    const preset = body.preset && body.preset.host ? {
      host: String(body.preset.host).trim().slice(0, 200),
      port: Number(body.preset.port) || 8089,
      proto: ['ssl', 'tcp', 'udp'].includes(body.preset.proto) ? body.preset.proto : 'ssl',
      enrollPort: Number(body.preset.enrollPort) || tak.ENROLL_PORT,
    } : null;
    store.data.settings = { ...(store.data.settings || {}), takHosts: String(body.allowedHosts || '').slice(0, 2000), eudPreset: preset };
    store.save();
    return json(res, 200, { ok: true });
  }
  if (route === 'eud-qr.svg' && method === 'GET') {
    const p = takSettings().preset;
    let url = publicBase(req) + '/eud/';
    if (p) url += '#' + new URLSearchParams({ host: p.host, port: p.port, proto: p.proto, enroll: p.enrollPort }).toString();
    return send(res, 200, await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }), 'image/svg+xml');
  }
  if (route === 'eud-links' && method === 'GET') {
    return json(res, 200, { links: [...takLinks.values()].map(l => l.info()) });
  }

  if (route === 'public-url' && method === 'POST') {
    const body = await readJson(req);
    const url = normalizeBase(body.url);
    store.data.settings = { ...(store.data.settings || {}), publicUrl: url };
    store.save();
    log('Öffentliche Adresse', url || '(automatisch)');
    return json(res, 200, { ok: true, publicUrl: url });
  }
  if (route === 'registration' && method === 'POST') {
    const body = await readJson(req);
    store.data.registration = { enabled: !!body.enabled };
    store.save();
    log('Selbst-Anmeldung', body.enabled ? 'erlaubt' : 'gesperrt');
    return json(res, 200, { ok: true });
  }
  if (route === 'app-qr.svg' && method === 'GET') {
    const svg = await QRCode.toString(publicBase(req) + '/app/', { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    return send(res, 200, svg, 'image/svg+xml');
  }

  if (route === 'ca-qr.svg' && method === 'GET' && config.testCa) {
    const svg = await QRCode.toString(publicBase(req) + '/ca.crt', { type: 'svg', margin: 2 });
    return send(res, 200, svg, 'image/svg+xml');
  }

  if (route === 'smtp' && method === 'GET') {
    const s = store.data.smtp;
    return json(res, 200, { host: s.host || '', port: s.port || 587, secure: !!s.secure, user: s.user || '', from: s.from || '', hasPass: !!s.pass });
  }
  if (route === 'smtp' && method === 'POST') {
    const body = await readJson(req);
    const s = store.data.smtp;
    s.host = String(body.host || '').trim();
    s.port = Number(body.port) || 587;
    s.secure = !!body.secure;
    s.user = String(body.user || '').trim();
    s.from = String(body.from || '').trim();
    if (body.pass) s.pass = String(body.pass);
    if (body.clearPass) s.pass = '';
    store.save();
    return json(res, 200, { ok: true });
  }
  if (route === 'smtp/test' && method === 'POST') {
    if (!auth.admin.email) throw new Error('Bitte zuerst eine Admin-E-Mail-Adresse eintragen.');
    await sendMail(store.data.smtp, {
      to: auth.admin.email,
      subject: 'WebTAK – Test',
      text: 'SMTP funktioniert. Passwort-Reset-Mails kommen an diese Adresse.\n',
    });
    return json(res, 200, { ok: true });
  }

  if (route === 'defaults' && method === 'GET') {
    const d = store.data.defaults || {};
    return json(res, 200, { rotate: normRotate(d.rotate), mirror: !!d.mirror, fit: normFit(d.fit), framesize: normFramesize(d.framesize) });
  }
  if (route === 'defaults' && method === 'POST') {
    const body = await readJson(req);
    store.data.defaults = {
      rotate: normRotate(body.rotate), mirror: !!body.mirror, fit: normFit(body.fit), framesize: normFramesize(body.framesize),
    };
    if (body.applyAll) {
      for (const id of Object.keys(store.data.streams)) hub.setOptions(id, store.data.defaults);
    }
    store.save();
    return json(res, 200, { ok: true });
  }

  if (route === 'streams' && method === 'GET') {
    const list = hub.list().map(s => {
      const id = StreamHub.id(s.user, s.streamId);
      return { ...s, links: links(req, store.data.streams[id]), tak: takVideo.view(id) };
    });
    // Hinweise seit der letzten Abfrage; ohne "since" nur die aktuelle Nummer (alte nicht erneut zeigen)
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since'));
    const events = Number.isFinite(since) && since >= 0 ? hub.eventsSince(since) : [];
    return json(res, 200, { streams: list, ffmpeg: ffmpegOk, events, eventSeq: hub.eventSeq, takVideo: { ready: takVideo.ready(), auto: takVideo.s.auto, when: takVideo.s.when, prefix: takVideo.s.prefix } });
  }
  if (route === 'streams' && method === 'POST') {
    const body = await readJson(req);
    const entry = hub.create(body.user, body.label);
    log('Stream angelegt', entry.user + '/' + entry.streamId);
    takVideo.touch(StreamHub.id(entry.user, entry.streamId));
    return json(res, 200, { ok: true, stream: { ...hub.status(StreamHub.id(entry.user, entry.streamId)), links: links(req, entry) } });
  }
  if (route === 'live-mode' && method === 'POST') {
    const body = await readJson(req);
    store.data.settings = { ...(store.data.settings || {}) };
    if (body.mode !== undefined) store.data.settings.liveMode = body.mode === 'user' ? 'user' : 'admin';
    if (body.userCanStart !== undefined) store.data.settings.userCanStart = !!body.userCanStart;
    store.save();
    hub.broadcastLive();
    log('Live-Modus', hub.liveMode() === 'admin' ? 'Admin schaltet live' : 'Nutzer startet selbst');
    return json(res, 200, { ok: true, mode: hub.liveMode(), userCanStart: hub.userCanStart() });
  }
  if (route === 'streams/live-off-all' && method === 'POST') {
    for (const id of Object.keys(store.data.streams)) hub.setOnAir(id, false);
    log('Alle Streams auf Bereit');
    return json(res, 200, { ok: true });
  }

  if (route === 'streams/stop-all' && method === 'POST') {
    hub.stopAll();
    log('Alle Streams gestoppt');
    return json(res, 200, { ok: true });
  }

  const m = route.match(/^streams\/([^/]+)\/([^/]+)(?:\/([a-z.-]+))?$/);
  if (m) {
    const id = StreamHub.id(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    const entry = store.data.streams[id];
    if (!entry) return json(res, 404, { error: 'Stream nicht gefunden.' });
    const action = m[3] || '';
    if (action === 'qr.svg' && method === 'GET') {
      const svg = await QRCode.toString(links(req, entry).app, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      return send(res, 200, svg, 'image/svg+xml');
    }
    if (method === 'POST' && action === 'options') {
      const body = await readJson(req);
      hub.setOptions(id, { rotate: body.rotate, mirror: body.mirror, fit: body.fit, framesize: body.framesize, label: body.label });
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'live') {
      const body = await readJson(req);
      hub.setOnAir(id, !!body.on);
      takVideo.touch(id);
      log(body.on ? 'Live geschaltet' : 'Live beendet', id);
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'stop') { hub.setEnabled(id, false); takVideo.touch(id); log('Stream gestoppt', id); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'start') { hub.setEnabled(id, true); takVideo.touch(id); log('Stream freigegeben', id); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'revoke') { hub.revoke(id); log('Zugang entzogen', id); return json(res, 200, { ok: true, links: links(req, entry) }); }
    if (method === 'DELETE' && action === '') { hub.remove(id); takVideo.removed(id); log('Stream gelöscht', id); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'tak') {
      const body = await readJson(req);
      return json(res, 200, { ok: true, video: await takVideo.set(id, { path: body.path, enabled: body.enabled }) });
    }
  }
  return json(res, 404, { error: 'Unbekannte Anfrage.' });
}

// ======================================================================
// Stream-Ausgabe
// ======================================================================

const escapeHtml = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Vollbild-Ansicht für den Stream-Link im Browser (Tippen: ganzes Bild / füllen, Doppeltippen: Vollbild)
function viewerPage(entry) {
  const title = escapeHtml(entry.label || entry.user);
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}
img{display:block;width:100vw;height:100vh;object-fit:contain}body.fill img{object-fit:cover}
#hint{position:fixed;left:10px;bottom:8px;color:#ccc;font:13px system-ui,sans-serif;text-shadow:0 1px 2px #000}</style>
</head><body><img src="?raw=1" alt="${title}">
<div id="hint">${title} · Tippen: füllen / ganzes Bild · Doppeltippen: Vollbild</div>
<script>
document.body.onclick=function(){document.body.classList.toggle('fill')};
document.body.ondblclick=function(){var d=document.documentElement;if(document.fullscreenElement)document.exitFullscreen();else if(d.requestFullscreen)d.requestFullscreen()};
setTimeout(function(){var h=document.getElementById('hint');if(h)h.remove()},5000);
</script></body></html>`;
}

async function handleStream(req, res, user, streamId, rest) {
  const entry = hub.get(user, streamId);
  if (!entry) return send(res, 404, 'Stream nicht gefunden');
  const id = StreamHub.id(user, streamId);
  const live = hub.live(id);

  if (rest === '' || rest === '/') {
    if (req.method === 'HEAD') return send(res, 200, '', 'multipart/x-mixed-replace');
    // Browser bekommt eine Vollbild-Seite, Player (ATAK, VLC …) den MJPEG-Stream
    const wantsHtml = /text\/html/.test(req.headers.accept || '') && !/[?&]raw\b/.test(req.url);
    if (wantsHtml) return send(res, 200, viewerPage(entry), 'text/html; charset=utf-8');
    return hub.addMjpegViewer(id, res);
  }
  if (rest === '/snapshot.jpg') {
    if (!live.frame) return send(res, 404, 'Noch kein Bild');
    return send(res, 200, live.frame, 'image/jpeg', { 'Access-Control-Allow-Origin': '*' });
  }

  if (rest === '/index.m3u8' || rest === '/stream.ts' || /^\/seg\d+\.ts$/.test(rest)) {
    const tc = hub.transcoder(id);
    if (!tc) return send(res, 503, 'HLS/MPEG-TS nicht verfügbar: ffmpeg ist auf dem Server nicht installiert.');
    if (rest === '/stream.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      return tc.addTsClient(res);
    }
    tc.touch();
    if (rest === '/index.m3u8') {
      const file = await tc.waitForPlaylist();
      if (!file) return send(res, 503, 'Stream startet noch, bitte erneut versuchen');
      return send(res, 200, fs.readFileSync(file), 'application/vnd.apple.mpegurl', { 'Access-Control-Allow-Origin': '*' });
    }
    const seg = path.join(tc.dir, path.basename(rest));
    if (!fs.existsSync(seg)) return send(res, 404, 'Segment nicht gefunden');
    return send(res, 200, fs.readFileSync(seg), 'video/mp2t', { 'Access-Control-Allow-Origin': '*' });
  }
  return send(res, 404, 'Nicht gefunden');
}

// ======================================================================
// HTTP
// ======================================================================

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const admin = isAdminHost(req);

  try {
    if (p === '/health') return send(res, 200, 'ok');
    if (p === '/ca.crt' && config.testCa) {
      return send(res, 200, fs.readFileSync(config.testCa), 'application/x-x509-ca-cert',
        { 'Content-Disposition': 'attachment; filename="helm-camera-test-ca.crt"' });
    }
    if (p === '/') {
      if (admin) return send(res, 302, '', 'text/plain', { Location: '/admin/' });
      return send(res, 200, 'WebTAK');
    }
    if (p === '/admin') return send(res, 302, '', 'text/plain', { Location: '/admin/' });
    if (p.startsWith('/admin/')) {
      if (!admin) return send(res, 404, 'Nicht gefunden');
      return serveStatic(res, 'admin', decodeURIComponent(p.slice(7)));
    }
    if (p.startsWith('/api/admin/')) {
      if (!admin) return json(res, 404, { error: 'Nicht gefunden' });
      return await handleAdminApi(req, res, p.slice(11));
    }
    if (p === '/api/app/register' && req.method === 'POST') return await handleRegister(req, res);
    if (p.startsWith('/api/eud/')) return await handleEudApi(req, res, p.slice(9));
    if (p.startsWith('/api/access/')) return await handleAccessApi(req, res, p.slice(12));
    if (p === '/join' || p === '/access') return send(res, 302, '', 'text/plain', { Location: p + '/' });
    if (p.startsWith('/join/')) return serveStatic(res, 'join', decodeURIComponent(p.slice(6)));
    if (p.startsWith('/access/')) return serveStatic(res, 'access', decodeURIComponent(p.slice(8)));
    if (p === '/eud') return send(res, 302, '', 'text/plain', { Location: '/eud/' });
    if (p.startsWith('/eud/vendor/')) return serveVendor(res, p.slice(12));
    if (p === '/eud/tiles/sources.json') return json(res, 200, { sources: TileCache.list() });
    if (p.startsWith('/eud/tiles/')) return await serveTile(res, p.slice(11));
    if (p.startsWith('/eud/')) return serveStatic(res, 'eud', decodeURIComponent(p.slice(5)));
    if (p === '/api/app/info' && req.method === 'GET') return json(res, 200, { registration: registrationEnabled() });
    if (p === '/app') return send(res, 302, '', 'text/plain', { Location: '/app/' });
    if (p.startsWith('/app/')) return serveStatic(res, 'app', decodeURIComponent(p.slice(5)));
    if (p.startsWith('/assets/')) return serveStatic(res, 'assets', decodeURIComponent(p.slice(8)));
    if (p === '/favicon.ico') return serveStatic(res, 'assets', 'brand/favicon.ico');

    const m = p.match(/^\/([a-z0-9][a-z0-9_-]{0,31})\/([a-z0-9]{4,32})(\/.*)?$/);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) return await handleStream(req, res, m[1], m[2], m[3] || '');
    return send(res, 404, 'Nicht gefunden');
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
    else res.end();
  }
}

// ======================================================================
// WebSocket: Handy sendet Bilder
// ======================================================================

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const takWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const takLinks = new Map(); // ws -> Verbindungsinfo (für die Admin-Übersicht)
const MAX_TAK_PER_IP = 5;

// Eigene Position (SA) eines verwalteten Zugangs: Rufname, Team und Rolle wie vom Admin festgelegt
function enforceAssignment(xml, uid, a) {
  const m = /<event\b[^>]*\buid="([^"]*)"/.exec(xml);
  if (!m || m[1] !== uid || !/\btype="a-/.test(xml.slice(0, 400))) return xml;
  const attr = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return xml
    .replace(/(<contact\b[^>]*\bcallsign=")[^"]*(")/, `$1${attr(a.callsign)}$2`)
    .replace(/(<uid\b[^>]*\bDroid=")[^"]*(")/, `$1${attr(a.callsign)}$2`)
    .replace(/(<__group\b[^>]*\bname=")[^"]*(")/, `$1${attr(a.team)}$2`)
    .replace(/(<__group\b[^>]*\brole=")[^"]*(")/, `$1${attr(a.role)}$2`);
}

// EUD <-> TAK-Server: der Browser schickt Zugangsdaten und CoT, wir reichen nur durch
function handleTakSocket(ws, req) {
  const ip = clientIp(req);
  const perIp = [...takLinks.values()].filter(l => l.ip === ip).length;
  if (perIp >= MAX_TAK_PER_IP) {
    ws.send(JSON.stringify({ type: 'status', state: 'error', message: 'Too many connections from this device.' }));
    return ws.close(4002, 'limit');
  }
  let link = null;
  let assigned = null; // vom Admin festgelegter Rufname/Team/Rolle (verwalteter TAK-Zugang)
  let eudUid = '';
  const entry = { ip, since: Date.now(), host: '', callsign: '', state: 'idle', info() {
    return { ip: this.ip, host: this.host, callsign: this.callsign, state: this.state, since: new Date(this.since).toISOString() };
  } };
  takLinks.set(ws, entry);
  const say = (state, message, extra) => {
    entry.state = state;
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'status', state, message, ...(extra || {}) }));
  };
  const stop = () => { if (link) link.stop(); link = null; };

  ws.on('message', async data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (msg.type === 'connect') {
      stop();
      const host = String(msg.host || '').trim();
      if (!host) return say('error', 'No TAK server given.');
      if (!(await tak.targetAllowed(takSettings().allowedHosts, host))) return say('error', `TAK server ${host} is not allowed on this server.`);
      if (ws.readyState !== 1) return;
      stop();
      entry.host = `${host}:${msg.port}`;
      entry.callsign = String(msg.callsign || '').slice(0, 40);
      eudUid = String(msg.uid || '');
      // Verwalteter Zugang? Benutzername steht im Client-Zertifikat (CN)
      assigned = null;
      try {
        const cn = msg.certPem ? (/(?:^|, )CN=([^,]+)/.exec(tak.certInfo(msg.certPem).subject) || [])[1] : '';
        assigned = takUsers.assignmentFor(cn);
      } catch (e) { /* kein lesbares Zertifikat */ }
      if (assigned) {
        entry.callsign = assigned.callsign;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'assign', ...assigned }));
      }
      link = new tak.TakLink({
        host, port: Number(msg.port) || 8089, proto: msg.proto, uid: String(msg.uid || 'EUD').slice(0, 64),
        certPem: msg.certPem, keyPem: msg.keyPem, caPems: Array.isArray(msg.caPems) ? msg.caPems : [], fingerprint: msg.fingerprint,
        onStatus: (state, message, extra) => say(state, message, extra),
        onCot: xml => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'cot', xml })); },
      });
      link.start();
      log('EUD verbindet', entry.callsign, '->', entry.host, msg.proto);
    } else if (msg.type === 'cot' && link && typeof msg.xml === 'string' && msg.xml.length < 256 * 1024) {
      if (/^\s*<event[\s>]/.test(msg.xml)) link.send(assigned ? enforceAssignment(msg.xml, eudUid, assigned) : msg.xml);
    } else if (msg.type === 'disconnect') {
      stop();
      say('closed', 'Disconnected.');
    }
  });
  ws.on('close', () => { stop(); takLinks.delete(ws); });
  ws.on('error', () => {});
}

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws/tak') return takWss.handleUpgrade(req, socket, head, ws => handleTakSocket(ws, req));
  if (url.pathname !== '/ws/publish') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    const user = url.searchParams.get('u') || '';
    const streamId = url.searchParams.get('s') || '';
    const key = url.searchParams.get('k') || '';
    const result = hub.authorize(user, streamId, key);
    if (result.error) {
      ws.send(JSON.stringify({ type: result.error, message: result.message }));
      ws.close(4001, result.error);
      return;
    }
    const { id, entry } = result;
    hub.attachPublisher(id, ws);
    if (takVideo.s.when === 'live') takVideo.touch(id);
    const live = hub.live(id);
    log('Handy verbunden', id, clientIp(req));
    ws.send(JSON.stringify({
      type: 'welcome',
      user: entry.user,
      streamId: entry.streamId,
      label: entry.label,
      stream: links(req, entry).stream,
    }));
    ws.send(JSON.stringify(StreamHub.config(entry)));
    hub.sendLive(id);

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const timer = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
      const st = hub.status(id);
      ws.send(JSON.stringify({ type: 'stats', viewers: st.viewers, fps: st.fps }));
    }, 5000);

    ws.on('message', (data, isBinary) => {
      if (live.publisher !== ws) return;
      if (isBinary) {
        hub.pushFrame(id, Buffer.isBuffer(data) ? data : Buffer.concat(data));
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello' || msg.type === 'info') {
          if (msg.camera !== undefined) live.camera = String(msg.camera).slice(0, 40);
          if (msg.phone !== undefined) live.phone = String(msg.phone).slice(0, 120);
          if (msg.resolution !== undefined) live.resolution = String(msg.resolution).slice(0, 20);
        } else if (msg.type === 'state') {
          const was = live.ready;
          live.ready = !!msg.ready; // Kamera am Handy verbunden
          if (!was && live.ready) hub.event(id, 'camera', `${hub.labelOf(id)} hat die Kamera aktiviert`);
        } else if (msg.type === 'golive') {
          // Nutzer drückt "Stream starten"/"Stream stoppen"
          if (hub.liveMode() === 'admin') {
            if (hub.userCanStart() || entry.eud) {
              if (!!msg.on !== live.onAir) {
                hub.setOnAir(id, !!msg.on);
                hub.event(id, msg.on ? 'live' : 'stop', `${hub.labelOf(id)} hat den Stream ${msg.on ? 'gestartet' : 'beendet'}`);
                log(msg.on ? 'Nutzer startet' : 'Nutzer beendet', id);
              }
            } else {
              hub.sendLive(id); // nicht erlaubt: Handy bleibt beim aktuellen Zustand
            }
          } else {
            hub.event(id, msg.on ? 'live' : 'stop', `${hub.labelOf(id)} hat den Stream ${msg.on ? 'gestartet' : 'beendet'}`);
          }
        } else if (msg.type === 'options') {
          // Nutzer richtet am Handy selbst aus (Drehung/Spiegeln); Admin sieht und kann es ändern
          hub.setOptions(id, { rotate: msg.rotate, mirror: msg.mirror });
        }
      } catch (e) { /* ignorieren */ }
    });
    ws.on('close', () => {
      clearInterval(timer);
      hub.detachPublisher(id, ws);
      log('Handy getrennt', id);
    });
    ws.on('error', () => {});
  });
}

// ======================================================================

const server = config.tlsCert && config.tlsKey
  ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handle)
  : http.createServer(handle);
server.on('upgrade', handleUpgrade);

// Erneuertes Zertifikat (z. B. Let's Encrypt) ohne Neustart übernehmen
if (config.tlsCert && config.tlsKey) {
  let stamp = fs.statSync(config.tlsCert).mtimeMs;
  setInterval(() => {
    try {
      const now = fs.statSync(config.tlsCert).mtimeMs;
      if (now === stamp) return;
      server.setSecureContext({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) });
      stamp = now;
      log('Neues TLS-Zertifikat geladen');
    } catch (e) {
      log('Zertifikat konnte nicht neu geladen werden:', e.message);
    }
  }, 60 * 60 * 1000).unref();
}
server.keepAliveTimeout = 65000;

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nPort ${config.port} ist schon belegt – läuft der Server schon in einem anderen Fenster?`);
    console.error('Das andere Fenster schließen (oder im Task-Manager "Node.js" beenden) und neu starten.\n');
  } else {
    console.error('Server-Fehler:', e.message);
  }
  process.exit(1);
});

server.listen(config.port, config.bind, () => {
  log(`WebTAK läuft auf ${config.tlsCert ? 'https' : 'http'}://${config.bind}:${server.address().port}`);
  log(`Öffentliche Adresse: ${config.publicUrl || '(aus Anfrage)'}${config.adminHost ? ', Admin-Domain: ' + config.adminHost : ''}`);
  log(ffmpegOk ? 'ffmpeg gefunden: HLS und MPEG-TS verfügbar' : 'ffmpeg nicht gefunden: nur MJPEG verfügbar');
  if (store.data.admin.mustChange) log('Erster Start: Admin-Login admin / admin123 – Passwort wird beim ersten Login geändert.');
});

function shutdown() {
  log('Server wird beendet');
  hub.shutdown();
  for (const c of wss.clients) c.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server };
