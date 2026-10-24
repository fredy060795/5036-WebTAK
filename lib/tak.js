// TAK-Anbindung für den EUD: Zertifikat anfordern (wie ATAK "enroll") und CoT-Verbindung
// zum TAK-Server (SSL mit Client-Zertifikat, TCP oder UDP). Der Browser kann das nicht selbst,
// deshalb reicht dieser Server die Daten nur durch – Zertifikate liegen nur im Arbeitsspeicher.

const tls = require('tls');
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const dns = require('dns');
const forge = require('node-forge');

const ENROLL_PORT = 8446;
const MAX_BUFFER = 1024 * 1024;

// ----------------------------------------------------------------------
// Zertifikate
// ----------------------------------------------------------------------

function fingerprintOf(pemOrDer) {
  let der = pemOrDer;
  if (typeof pemOrDer === 'string') {
    der = Buffer.from(pemOrDer.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  }
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

function pemBodyToPem(text) {
  text = String(text || '').trim();
  if (!text) return null;
  if (text.includes('BEGIN CERTIFICATE')) return text.endsWith('\n') ? text : text + '\n';
  const body = text.replace(/\s+/g, '');
  return '-----BEGIN CERTIFICATE-----\n' + body.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
}

function certInfo(pem) {
  const c = forge.pki.certificateFromPem(pem);
  const name = attrs => attrs.map(a => `${a.shortName || a.name}=${a.value}`).join(', ');
  return { subject: name(c.subject.attributes), issuer: name(c.issuer.attributes), validTo: c.validity.notAfter.toISOString() };
}

// .p12 (Client-Zertifikat oder Truststore) -> PEM
function readP12(base64, password) {
  let p12;
  try {
    const der = forge.util.decode64(base64);
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, password || '');
  } catch (e) {
    throw new Error('Datei lässt sich nicht öffnen – Passwort falsch oder keine .p12-Datei.');
  }
  const keys = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [])
    .filter(b => b.cert).map(b => b.cert);
  const keyPem = keys.length ? forge.pki.privateKeyToPem(keys[0].key) : null;
  let certPem = null;
  const caPems = [];
  for (const c of certs) {
    const pem = forge.pki.certificateToPem(c);
    // Zum Schlüssel passendes Zertifikat = Client-Zertifikat, Rest = CA
    if (keys.length && !certPem && c.publicKey.n && keys[0].key.n && c.publicKey.n.equals(keys[0].key.n)) certPem = pem;
    else caPems.push(pem);
  }
  if (keys.length && !certPem) throw new Error('In der .p12 fehlt das Zertifikat zum Schlüssel.');
  return { kind: keyPem ? 'client' : 'truststore', keyPem, certPem, caPems };
}

// TLS-Optionen: Kette gegen die CA(s) prüfen (ohne Namensprüfung, wie ATAK), sonst
// öffentliche CAs, sonst nur ein vom Nutzer bestätigter Fingerabdruck.
function trustOptions({ caPems, fingerprint }) {
  const opts = { rejectUnauthorized: false };
  const check = sock => {
    const peer = sock.getPeerCertificate(true);
    if (!peer || !peer.raw) return 'Server hat kein Zertifikat gesendet.';
    const fp = fingerprintOf(peer.raw);
    if (fingerprint && fp === fingerprint.toUpperCase()) return null;
    if (sock.authorized) return null;
    return { untrusted: true, fingerprint: fp, subject: peer.subject ? Object.entries(peer.subject).map(([k, v]) => `${k}=${v}`).join(', ') : '' };
  };
  if (caPems && caPems.length) opts.ca = caPems;
  opts.checkServerIdentity = () => undefined; // TAK-Server-Zertifikate passen oft nicht zum Hostnamen
  return { opts, check };
}

// ----------------------------------------------------------------------
// Zertifikat anfordern (TAK Server / OpenTAKServer, Port 8446)
// ----------------------------------------------------------------------

// TLS-Verbindung aufbauen und das Serverzertifikat prüfen, BEVOR irgendetwas (z. B. das
// Passwort) gesendet wird. Nicht vertrauenswürdig -> Fehler mit Fingerabdruck zum Bestätigen.
function secureSocket({ host, port, caPems, fingerprint, cert, key, timeout = 20000 }) {
  return new Promise((resolve, reject) => {
    const { opts, check } = trustOptions({ caPems, fingerprint });
    const sock = tls.connect({ host, port, ...opts, cert, key, servername: net.isIP(host) ? undefined : host });
    const timer = setTimeout(() => sock.destroy(new Error('Zeitüberschreitung')), timeout);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const problem = check(sock);
      if (!problem) return resolve(sock);
      sock.destroy();
      const err = new Error(problem.untrusted ? 'Serverzertifikat ist nicht vertrauenswürdig.' : problem);
      if (problem.untrusted) Object.assign(err, { code: 'UNTRUSTED', fingerprint: problem.fingerprint, subject: problem.subject });
      reject(err);
    });
    sock.once('error', e => {
      clearTimeout(timer);
      if (/certificate required|alert number 116|handshake failure|alert number 40/i.test(e.message)) {
        return reject(new Error(`Port ${port} verlangt schon ein Client-Zertifikat – für die Anforderung ist es meist Port ${ENROLL_PORT}.`));
      }
      reject(new Error(`${host}:${port} nicht erreichbar: ${e.message}`));
    });
  });
}

// HTTP über eine bereits geprüfte TLS-Verbindung
async function httpsRequest({ host, port, path, method = 'GET', headers = {}, body, caPems, fingerprint, cert, key, timeout = 20000, raw = false, maxBytes = 30 * 1024 * 1024 }) {
  const sock = await secureSocket({ host, port, caPems, fingerprint, cert, key, timeout });
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method, headers: { Host: host, ...headers }, createConnection: () => sock, timeout }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > maxBytes) { req.destroy(new Error('Antwort zu groß')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        sock.destroy();
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: raw ? buf : buf.toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', e => reject(new Error(`${host}:${port}: ${e.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

function parseEnrollResponse(text) {
  text = String(text || '').trim();
  let signed = null;
  const cas = [];
  if (text.startsWith('{')) {
    const data = JSON.parse(text);
    signed = data.signedCert;
    for (const k of Object.keys(data).sort()) if (/^ca/i.test(k) && data[k]) cas.push(data[k]);
  } else {
    const m = text.match(/<signedCert>([\s\S]*?)<\/signedCert>/);
    signed = m && m[1];
    for (const c of text.matchAll(/<(ca\d*)>([\s\S]*?)<\/\1>/g)) cas.push(c[2]);
  }
  if (!signed) throw new Error('Antwort des Servers enthält kein signiertes Zertifikat.');
  const seen = new Set();
  const caPems = [];
  for (const c of cas) {
    const pem = pemBodyToPem(c);
    const fp = fingerprintOf(pem);
    if (!seen.has(fp)) { seen.add(fp); caPems.push(pem); }
  }
  return { certPem: pemBodyToPem(signed), caPems };
}

async function enroll({ host, port = ENROLL_PORT, username, password, uid = 'EUD', caPems = [], fingerprint = '' }) {
  username = String(username || '').trim();
  if (!host || !username || !password) throw new Error('Server, Benutzername und Passwort angeben.');
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const call = async (path, extra = {}) => {
    const r = await httpsRequest({ host, port, path, caPems, fingerprint, ...extra, headers: { Authorization: auth, ...(extra.headers || {}) } });
    if (r.status === 401 || r.status === 403) throw new Error('Server lehnt Benutzername/Passwort ab.');
    return r;
  };

  // Zusätzliche Namensbestandteile (O, OU …) – optional
  const subject = [{ shortName: 'CN', value: username }];
  try {
    const cfg = await call('/Marti/api/tls/config');
    if (cfg.status === 200) {
      for (const m of cfg.body.matchAll(/nameEntry[^>]*name="([^"]+)"[^>]*value="([^"]+)"/g)) {
        if (['O', 'OU', 'C', 'ST', 'L'].includes(m[1].toUpperCase())) subject.push({ shortName: m[1].toUpperCase(), value: m[2] });
      }
    }
  } catch (e) {
    if (e.code === 'UNTRUSTED' || /ablehnt|nicht erreichbar|Client-Zertifikat/.test(e.message)) throw e;
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject(subject);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const b64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificationRequestToAsn1(csr)).getBytes());
  const body = b64.match(/.{1,64}/g).join('\n') + '\n';
  const query = new URLSearchParams({ clientUid: uid, version: 'HelmCamera-EUD' }).toString();
  const r = await call(`/Marti/api/tls/signClient/v2?${query}`, {
    method: 'POST', body, headers: { 'Content-Type': 'text/plain', Accept: 'application/json' },
  });
  if (r.status !== 200) throw new Error(`Server antwortet mit HTTP ${r.status} bei der Zertifikatsanforderung.`);
  const { certPem, caPems: newCas } = parseEnrollResponse(r.body);
  return {
    certPem,
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    caPems: newCas.length ? newCas : caPems,
    info: certInfo(certPem),
  };
}

// ----------------------------------------------------------------------
// CoT-Datenstrom
// ----------------------------------------------------------------------

// Zerlegt einen Datenstrom in vollständige <event>…</event>-Dokumente
function splitEvents(buffer) {
  const events = [];
  for (;;) {
    const start = buffer.indexOf('<event');
    if (start < 0) return { events, rest: buffer.slice(-16) };
    const end = buffer.indexOf('</event>', start);
    if (end < 0) return { events, rest: buffer.length > MAX_BUFFER ? '' : buffer.slice(start) };
    events.push(buffer.slice(start, end + 8));
    buffer = buffer.slice(end + 8);
  }
}

const cotTime = d => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');

function pingXml(uid) {
  const now = new Date();
  const stale = new Date(now.getTime() + 20000);
  return `<event version="2.0" uid="${uid}-ping" type="t-x-c-t" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(stale)}">`
    + '<point lat="0.0" lon="0.0" hae="0.0" ce="9999999.0" le="9999999.0"/><detail/></event>';
}

// Eine Verbindung pro EUD; meldet sich über onStatus/onCot. Verbindet bei Abbruch neu.
class TakLink {
  constructor({ host, port, proto, certPem, keyPem, caPems, fingerprint, uid, onStatus, onCot }) {
    Object.assign(this, { host, port: Number(port), proto: String(proto || 'ssl').toLowerCase(), certPem, keyPem, caPems: caPems || [], fingerprint, uid });
    this.onStatus = onStatus || (() => {});
    this.onCot = onCot || (() => {});
    this.sock = null;
    this.udp = null;
    this.closed = false;
    this.retry = 0;
    this.outbox = [];
    this.connected = false;
  }

  start() {
    if (this.proto === 'udp') return this.startUdp();
    this.open();
  }

  startUdp() {
    this.udp = dgram.createSocket(this.host.includes(':') ? 'udp6' : 'udp4');
    this.udp.on('error', e => this.onStatus('error', 'UDP: ' + e.message));
    this.connected = true;
    this.onStatus('connected', `UDP an ${this.host}:${this.port} (nur senden – UDP liefert keine Daten zurück)`);
    this.flush();
  }

  open() {
    if (this.closed) return;
    this.onStatus('connecting', `Verbinde mit ${this.host}:${this.port} (${this.proto.toUpperCase()}) …`);
    let sock;
    if (this.proto === 'ssl') {
      if (!this.certPem || !this.keyPem) return this.onStatus('error', 'Für SSL wird ein Client-Zertifikat gebraucht (anfordern oder laden).');
      const { opts, check } = trustOptions({ caPems: this.caPems, fingerprint: this.fingerprint });
      sock = tls.connect({ host: this.host, port: this.port, cert: this.certPem, key: this.keyPem, ...opts, servername: net.isIP(this.host) ? undefined : this.host });
      sock.once('secureConnect', () => {
        const problem = check(sock);
        if (problem) {
          this.closed = true; // ohne Bestätigung nicht erneut versuchen
          sock.destroy();
          return this.onStatus('untrusted', 'Serverzertifikat ist nicht vertrauenswürdig.', problem);
        }
        this.ready(sock);
      });
    } else {
      sock = net.connect({ host: this.host, port: this.port }, () => this.ready(sock));
    }
    this.sock = sock;
    sock.setTimeout(90000);
    sock.on('timeout', () => sock.destroy(new Error('keine Daten vom Server')));
    sock.on('error', e => {
      const msg = /certificate (unknown|revoked|expired)|bad certificate|alert number 4[0-9]/i.test(e.message)
        ? 'Server lehnt das Client-Zertifikat ab (' + e.message + ').' : e.message;
      this.onStatus('error', msg);
    });
    sock.on('close', () => this.lost());
  }

  ready(sock) {
    this.connected = true;
    this.retry = 0;
    this.onStatus('connected', `Verbunden mit ${this.host}:${this.port} (${this.proto.toUpperCase()})`);
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      const r = splitEvents(buffer + chunk);
      buffer = r.rest;
      for (const ev of r.events) if (!/type="t-x-c-t/.test(ev)) this.onCot(ev);
    });
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.write(pingXml(this.uid)), 30000);
    this.flush();
  }

  lost() {
    this.connected = false;
    clearInterval(this.pingTimer);
    if (this.closed) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.onStatus('connecting', `Verbindung getrennt – neuer Versuch in ${Math.round(delay / 1000)} s`);
    this.timer = setTimeout(() => this.open(), delay);
  }

  write(xml) {
    if (this.proto === 'udp') {
      if (!this.udp) return false;
      this.udp.send(Buffer.from(xml), this.port, this.host);
      return true;
    }
    if (!this.connected || !this.sock) return false;
    this.sock.write(xml);
    return true;
  }

  // CoT senden; ohne Verbindung zwischenspeichern (max. 200)
  send(xml) {
    if (!this.write(xml)) {
      this.outbox.push(xml);
      if (this.outbox.length > 200) this.outbox.shift();
    }
  }

  flush() {
    while (this.outbox.length && this.write(this.outbox[0])) this.outbox.shift();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    if (this.sock) this.sock.destroy();
    if (this.udp) this.udp.close();
  }
}

// Erlaubte TAK-Server (Admin-Einstellung): leer = alle
// ---------------------------------------------------------------------
// ATAK-Datenpaket (.zip vom TAK-Server): .pref mit Serveradresse + .p12-Dateien
// ---------------------------------------------------------------------

function unzip(buf) {
  // Zentrales Verzeichnis suchen (Ende der Datei)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gültige .zip-Datei.');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count && n < 200; n++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || csize > 4 * 1024 * 1024) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + csize);
    if (method === 0) files[name] = data;
    else if (method === 8) files[name] = zlib.inflateRawSync(data);
  }
  return files;
}

function readPref(xml) {
  const out = {};
  const re = /<entry\s+key="([^"]+)"[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) out[m[1]] = m[2].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return out;
}

function readDataPackage(base64) {
  const files = unzip(Buffer.from(base64, 'base64'));
  const names = Object.keys(files);
  const base = n => n.split('/').pop();
  const prefName = names.find(n => /\.pref$/i.test(n));
  const pref = prefName ? readPref(files[prefName].toString('utf8')) : {};
  const result = { server: null, certPem: null, keyPem: null, caPems: [], enroll: false };
  const connect = pref.connectString0 || '';
  if (connect) {
    const [host, port, proto] = connect.split(':');
    result.server = { host, port: Number(port) || 8089, proto: (proto || 'ssl').toLowerCase(), description: pref.description0 || '' };
  }
  result.enroll = pref.enrollForCertificateWithTrust0 === 'true';
  const p12s = names.filter(n => /\.p12$/i.test(n));
  const find = loc => loc && p12s.find(n => base(n) === base(loc));
  const caFile = find(pref.caLocation0 || pref.caLocation);
  const clientFile = find(pref.certificateLocation0 || pref.certificateLocation);
  const tryRead = (file, passwords) => {
    for (const pw of passwords) {
      try { return readP12(files[file].toString('base64'), pw); } catch (e) { /* nächstes Passwort */ }
    }
    throw new Error(`${base(file)} lässt sich nicht öffnen (Passwort im Paket fehlt oder falsch).`);
  };
  const caPw = [pref.caPassword0, pref.caPassword, 'atakatak'].filter(x => x != null);
  const clPw = [pref.clientPassword0, pref.clientPassword, 'atakatak'].filter(x => x != null);
  for (const f of p12s) {
    const r = tryRead(f, f === caFile ? caPw : f === clientFile ? clPw : [...clPw, ...caPw]);
    if (r.kind === 'client' && !result.certPem) { result.certPem = r.certPem; result.keyPem = r.keyPem; }
    result.caPems.push(...r.caPems);
  }
  for (const n of names.filter(x => /\.(pem|crt)$/i.test(x))) {
    result.caPems.push(...(files[n].toString('utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).map(x => x + '\n'));
  }
  if (!result.server && !result.certPem && !result.caPems.length) throw new Error('Im Datenpaket wurden weder Serverdaten noch Zertifikate gefunden.');
  return result;
}

function hostAllowed(allowList, host) {
  const list = String(allowList || '').split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return !list.length || list.includes(String(host || '').toLowerCase());
}

// Ziel prüfen: steht eine Liste, gilt nur sie. Ohne Liste sind alle Server erlaubt außer
// dem eigenen Rechner und Link-Local (z. B. Cloud-Metadaten 169.254.169.254) – auch nach DNS-Auflösung.
function blockedAddress(ip) {
  if (net.isIPv4(ip)) return /^(127\.|0\.|169\.254\.)/.test(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return blockedAddress(v.slice(7));
  return v === '::1' || v === '::' || /^fe[89ab]/.test(v);
}

async function targetAllowed(allowList, host) {
  if (!host || !/^[a-z0-9.:_-]+$/i.test(host)) return false;
  if (String(allowList || '').trim()) return hostAllowed(allowList, host);
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true }); } catch (e) { return true; } // Fehler meldet dann die Verbindung
  return !addrs.some(a => blockedAddress(a.address));
}

// ---------------------------------------------------------------------
// TAK-Server-API (Port 8443, Client-Zertifikat): Datenpakete, Missionen (Data Sync), Videos
// ---------------------------------------------------------------------

const API_PORT = 8443;
const isZip = buf => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
const IMG_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// Inhalt einer Datei auswerten: CoT-Meldungen und Karten-Overlays (KML/KMZ, auch in .zip-Paketen)
function extractContent(name, buf, out = { cot: [], overlays: [], files: [] }, depth = 0) {
  const lower = String(name || '').toLowerCase();
  if (isZip(buf) && depth < 2) {
    const files = unzip(buf);
    if (lower.endsWith('.kmz') || (!lower.endsWith('.zip') && Object.keys(files).some(n => /\.kml$/i.test(n)) && !Object.keys(files).some(n => /manifest\.xml$/i.test(n)))) {
      const kmlName = Object.keys(files).find(n => /\.kml$/i.test(n));
      if (kmlName) {
        const images = {};
        for (const [n, data] of Object.entries(files)) {
          const ext = n.split('.').pop().toLowerCase();
          if (IMG_TYPES[ext] && data.length < 4 * 1024 * 1024) images[n] = `data:${IMG_TYPES[ext]};base64,${data.toString('base64')}`;
        }
        out.overlays.push({ name: String(name).split('/').pop().replace(/\.kmz$/i, ''), kml: files[kmlName].toString('utf8'), images });
      }
      return out;
    }
    for (const [n, data] of Object.entries(files)) {
      if (/(^|\/)manifest\.xml$|\.pref$|\.p12$/i.test(n)) continue;
      out.files.push(n.split('/').pop());
      extractContent(n, data, out, depth + 1);
    }
    return out;
  }
  if (lower.endsWith('.kml')) {
    out.overlays.push({ name: String(name).split('/').pop().replace(/\.kml$/i, ''), kml: buf.toString('utf8'), images: {} });
  } else if (/\.(cot|xml)$/i.test(lower) || buf.slice(0, 200).toString('utf8').includes('<event')) {
    const text = buf.toString('utf8');
    if (text.includes('<event')) out.cot.push(...splitEvents(text).events);
  }
  return out;
}

function parseVideoFeeds(text) {
  const feeds = [];
  const tag = (block, t) => { const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(block); return m ? m[1].trim() : ''; };
  const re = /<feed>([\s\S]*?)<\/feed>/g;
  let m;
  while ((m = re.exec(text))) {
    const b = m[1];
    let url = tag(b, 'url');
    if (!url) {
      const proto = tag(b, 'protocol') || 'rtsp';
      const addr = tag(b, 'address');
      const port = tag(b, 'port');
      const p = tag(b, 'path');
      if (addr) url = `${proto}://${addr}${port && port !== '-1' ? ':' + port : ''}${p && !p.startsWith('/') ? '/' : ''}${p}`;
    }
    if (url) feeds.push({ alias: tag(b, 'alias') || url, url });
  }
  // Neuere Server: JSON
  if (!feeds.length && text.trim().startsWith('{')) {
    try {
      const j = JSON.parse(text);
      for (const c of j.videoConnections || []) for (const f of c.feeds || [c]) if (f.url) feeds.push({ alias: f.alias || c.alias || f.url, url: f.url });
    } catch (e) { /* kein JSON */ }
  }
  return feeds;
}

// Eine Anfrage an die TAK-Server-API im Namen des EUD
async function marti(conn, action, args = {}) {
  const base = { host: conn.host, port: Number(conn.apiPort) || API_PORT, caPems: conn.caPems || [], fingerprint: conn.fingerprint || '', cert: conn.certPem, key: conn.keyPem };
  if (!base.cert || !base.key) throw new Error('Für die TAK-Server-Daten wird ein Client-Zertifikat gebraucht.');
  const get = async (path, raw) => {
    const r = await httpsRequest({ ...base, path, raw, headers: { Accept: '*/*' }, timeout: 30000 });
    if (r.status === 401 || r.status === 403) throw new Error('TAK-Server verweigert den Zugriff (Zertifikat/Rechte).');
    if (r.status === 404) throw new Error('Gibt es auf diesem TAK-Server nicht (' + path.split('?')[0] + ').');
    if (r.status >= 400) throw new Error('TAK-Server antwortet mit Fehler ' + r.status + '.');
    return r.body;
  };
  const json = async path => { const t = await get(path); try { return JSON.parse(t); } catch (e) { throw new Error('Unerwartete Antwort vom TAK-Server.'); } };
  const hashOk = h => /^[a-f0-9]{16,128}$/i.test(String(h || ''));
  const mname = n => encodeURIComponent(String(n || '').slice(0, 200));

  if (action === 'packages') {
    const r = await json('/Marti/sync/search?keywords=missionpackage');
    const list = (r.results || r.data || []).map(x => ({
      hash: x.Hash || x.hash, name: x.Name || x.name || x.filename, size: x.Size || x.size || 0,
      user: x.SubmissionUser || x.submissionUser || x.CreatorUid || '', time: x.SubmissionDateTime || x.submissionDateTime || '',
    })).filter(x => hashOk(x.hash));
    return { packages: list.sort((a, b) => String(b.time).localeCompare(String(a.time))) };
  }
  if (action === 'package' || action === 'file') {
    if (!hashOk(args.hash)) throw new Error('Ungültige Kennung.');
    const buf = await get('/Marti/sync/content?hash=' + encodeURIComponent(args.hash), true);
    return extractContent(String(args.name || 'paket.zip'), buf);
  }
  if (action === 'videos') {
    return { feeds: parseVideoFeeds(await get('/Marti/api/video')) };
  }
  if (action === 'missions') {
    const r = await json('/Marti/api/missions');
    return {
      missions: (r.data || []).map(m => ({
        name: m.name, description: m.description || '', creator: m.creatorUid || '', tool: m.tool || '',
        files: (m.contents || []).length, items: (m.uids || []).length, password: !!m.passwordProtected,
      })).filter(m => m.name && m.tool !== 'vbm'),
    };
  }
  if (action === 'mission') {
    const name = mname(args.name);
    const uid = encodeURIComponent(String(args.uid || 'EUD').slice(0, 64));
    // Abonnieren: der TAK-Server schickt Änderungen dann über die laufende Verbindung
    try { await httpsRequest({ ...base, method: 'PUT', path: `/Marti/api/missions/${name}/subscription?uid=${uid}`, headers: { 'Content-Length': 0 } }); } catch (e) { /* lesen geht trotzdem */ }
    const out = { cot: [], overlays: [], files: [] };
    try { out.cot = splitEvents(await get(`/Marti/api/missions/${name}/cot`)).events; } catch (e) { /* keine CoT */ }
    const m = await json(`/Marti/api/missions/${name}`);
    const contents = ((m.data || [])[0] || {}).contents || [];
    for (const c of contents.slice(0, 20)) {
      const d = c.data || c;
      const fname = d.name || d.filename || '';
      out.files.push(fname);
      if (!hashOk(d.hash) || !/\.(kml|kmz|zip|cot|xml)$/i.test(fname) || (d.size && d.size > 20 * 1024 * 1024)) continue;
      try { extractContent(fname, await get('/Marti/sync/content?hash=' + encodeURIComponent(d.hash), true), out); } catch (e) { /* Datei überspringen */ }
    }
    return out;
  }
  if (action === 'unsubscribe') {
    const r = await httpsRequest({ ...base, method: 'DELETE', path: `/Marti/api/missions/${mname(args.name)}/subscription?uid=${encodeURIComponent(String(args.uid || ''))}` });
    return { ok: r.status < 400 };
  }
  throw new Error('Unbekannte Aktion.');
}

module.exports = { marti, extractContent, parseVideoFeeds, unzip, API_PORT, targetAllowed, enroll, readP12, readDataPackage, TakLink, splitEvents, fingerprintOf, certInfo, parseEnrollResponse, hostAllowed, ENROLL_PORT };
