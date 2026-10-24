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
const { StreamHub, normRotate, normFit } = require('./lib/streams');
const { sendMail, configured: smtpConfigured } = require('./lib/mailer');

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
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
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

function publicBase(req) {
  const host = ((config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || '').split(',')[0].trim();
  return config.publicUrl || `${protoOf(req)}://${host}`;
}

// Adresse für Links in Reset-Mails: nur aus der Konfiguration, nie aus der Anfrage
// (sonst könnte jemand über einen gefälschten Host-Header den Link umleiten).
function resetBase() {
  if (config.adminUrl) return config.adminUrl;
  if (!config.publicUrl) return null;
  if (!config.adminHost) return config.publicUrl;
  const u = new URL(config.publicUrl);
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
  if (!registrationEnabled()) {
    return json(res, 403, { error: 'Die Anmeldung ist gerade gesperrt. Bitte beim Admin melden.' });
  }
  const ip = clientIp(req);
  const now = Date.now();
  const list = (registrations.get(ip) || []).filter(t => now - t < 3600 * 1000);
  if (list.length >= MAX_REG_PER_HOUR) return json(res, 429, { error: 'Zu viele Anmeldungen. Bitte später erneut versuchen.' });
  const body = await readJson(req);
  const entry = hub.register(body.name, body.unit);
  list.push(now);
  registrations.set(ip, list);
  log('Selbst-Anmeldung', entry.user + '/' + entry.streamId, JSON.stringify(entry.label), ip);
  return json(res, 200, { u: entry.user, s: entry.streamId, k: entry.key, label: entry.label });
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
          subject: 'Helm Camera Streams – Passwort zurücksetzen',
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

  // Erst nach dem ersten Passwortwechsel ist der Rest erlaubt
  if (auth.admin.mustChange) return json(res, 403, { error: 'Bitte zuerst das Passwort ändern.', mustChange: true });

  if (route === 'registration' && method === 'GET') {
    return json(res, 200, { enabled: registrationEnabled(), appUrl: publicBase(req) + '/app/' });
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
      subject: 'Helm Camera Streams – Test',
      text: 'SMTP funktioniert. Passwort-Reset-Mails kommen an diese Adresse.\n',
    });
    return json(res, 200, { ok: true });
  }

  if (route === 'defaults' && method === 'GET') {
    const d = store.data.defaults || {};
    return json(res, 200, { rotate: normRotate(d.rotate), mirror: !!d.mirror, fit: normFit(d.fit) });
  }
  if (route === 'defaults' && method === 'POST') {
    const body = await readJson(req);
    store.data.defaults = { rotate: normRotate(body.rotate), mirror: !!body.mirror, fit: normFit(body.fit) };
    if (body.applyAll) {
      for (const id of Object.keys(store.data.streams)) hub.setOptions(id, store.data.defaults);
    }
    store.save();
    return json(res, 200, { ok: true });
  }

  if (route === 'streams' && method === 'GET') {
    const list = hub.list().map(s => ({ ...s, links: links(req, store.data.streams[StreamHub.id(s.user, s.streamId)]) }));
    return json(res, 200, { streams: list, ffmpeg: ffmpegOk });
  }
  if (route === 'streams' && method === 'POST') {
    const body = await readJson(req);
    const entry = hub.create(body.user, body.label);
    log('Stream angelegt', entry.user + '/' + entry.streamId);
    return json(res, 200, { ok: true, stream: { ...hub.status(StreamHub.id(entry.user, entry.streamId)), links: links(req, entry) } });
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
      hub.setOptions(id, { rotate: body.rotate, mirror: body.mirror, fit: body.fit, label: body.label });
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && action === 'stop') { hub.setEnabled(id, false); log('Stream gestoppt', id); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'start') { hub.setEnabled(id, true); log('Stream freigegeben', id); return json(res, 200, { ok: true }); }
    if (method === 'POST' && action === 'revoke') { hub.revoke(id); log('Zugang entzogen', id); return json(res, 200, { ok: true, links: links(req, entry) }); }
    if (method === 'DELETE' && action === '') { hub.remove(id); log('Stream gelöscht', id); return json(res, 200, { ok: true }); }
  }
  return json(res, 404, { error: 'Unbekannte Anfrage.' });
}

// ======================================================================
// Stream-Ausgabe
// ======================================================================

async function handleStream(req, res, user, streamId, rest) {
  const entry = hub.get(user, streamId);
  if (!entry) return send(res, 404, 'Stream nicht gefunden');
  const id = StreamHub.id(user, streamId);
  const live = hub.live(id);

  if (rest === '' || rest === '/') {
    if (req.method === 'HEAD') return send(res, 200, '', 'multipart/x-mixed-replace');
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
      return send(res, 200, 'Helm Camera Streams');
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
    if (p === '/api/app/info' && req.method === 'GET') return json(res, 200, { registration: registrationEnabled() });
    if (p === '/app') return send(res, 302, '', 'text/plain', { Location: '/app/' });
    if (p.startsWith('/app/')) return serveStatic(res, 'app', decodeURIComponent(p.slice(5)));
    if (p.startsWith('/assets/')) return serveStatic(res, 'assets', decodeURIComponent(p.slice(8)));

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

function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://x');
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
  log(`Helm Camera Streams läuft auf ${config.tlsCert ? 'https' : 'http'}://${config.bind}:${server.address().port}`);
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
