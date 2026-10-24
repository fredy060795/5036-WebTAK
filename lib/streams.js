// Verwaltung der Streams: gespeicherte Einträge (Benutzer, Stream-ID, Schlüssel)
// und der Live-Zustand (verbundenes Handy, letztes Bild, Zuschauer, Umwandlung).
//
// Jeder Stream ist eindeutig über "<benutzer>/<streamId>" – mehrere Streams
// laufen völlig getrennt voneinander.

const path = require('path');
const { randomId, randomToken } = require('./passwords');
const { Transcoder } = require('./transcoder');

const USER_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(['admin', 'app', 'api', 'ws', 'assets', 'static', 'favicon.ico', 'robots.txt', 'health']);
const BOUNDARY = 'helmcamframe';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MIN_FRAME_GAP_MS = 30; // max. ca. 30 Bilder/s pro Stream annehmen
const ROTATIONS = [0, 90, 180, 270];

// Liest Breite x Höhe aus dem JPEG-Kopf (SOF-Marker), ohne das Bild zu dekodieren
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker >= 0xd0 && marker <= 0xd9) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return buf.readUInt16BE(i + 7) + 'x' + buf.readUInt16BE(i + 5);
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function normRotate(v) {
  const r = Number(v);
  return ROTATIONS.includes(r) ? r : 0;
}

class Live {
  constructor() {
    this.publisher = null;     // WebSocket des Handys
    this.camera = '';          // Name der Kamera (vom Handy gemeldet)
    this.phone = '';           // Gerät/Browser des Handys
    this.frame = null;         // letztes JPEG
    this.frameAt = 0;
    this.frameTimes = [];      // für die Bildrate
    this.viewers = new Set();  // MJPEG-Zuschauer (HTTP-Antworten)
    this.transcoder = null;
    this.connectedAt = 0;
  }

  fps() {
    const now = Date.now();
    this.frameTimes = this.frameTimes.filter(t => now - t < 5000);
    return Math.round((this.frameTimes.length / 5) * 10) / 10;
  }
}

class StreamHub {
  constructor({ store, ffmpeg, workDir, log }) {
    this.store = store;
    this.ffmpeg = ffmpeg;
    this.workDir = workDir;
    this.log = log || (() => {});
    this.lives = new Map();
  }

  static id(user, streamId) {
    return user + '/' + streamId;
  }

  static validUser(user) {
    return USER_RE.test(user) && !RESERVED.has(user);
  }

  get(user, streamId) {
    return this.store.data.streams[StreamHub.id(user, streamId)] || null;
  }

  live(id) {
    let l = this.lives.get(id);
    if (!l) {
      l = new Live();
      this.lives.set(id, l);
    }
    return l;
  }

  // ------------------------------------------------------------------
  // Verwaltung (Admin)
  // ------------------------------------------------------------------

  create(user, label) {
    user = String(user || '').trim().toLowerCase();
    if (!StreamHub.validUser(user)) {
      throw new Error('Benutzername: 1–32 Zeichen, nur a–z, 0–9, - und _ (nicht admin, app, api …).');
    }
    let streamId;
    do streamId = randomId(10); while (this.get(user, streamId));
    const entry = {
      user,
      streamId,
      label: String(label || '').trim().slice(0, 60),
      key: randomToken(24),
      rotate: normRotate((this.store.data.defaults || {}).rotate),
      mirror: !!(this.store.data.defaults || {}).mirror,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.store.data.streams[StreamHub.id(user, streamId)] = entry;
    this.store.save();
    return entry;
  }

  // Drehung/Spiegeln/Bezeichnung ändern; das Handy bekommt die Einstellung sofort
  setOptions(id, { rotate, mirror, label }) {
    const entry = this.store.data.streams[id];
    if (!entry) return false;
    if (rotate !== undefined) entry.rotate = normRotate(rotate);
    if (mirror !== undefined) entry.mirror = !!mirror;
    if (label !== undefined) entry.label = String(label).trim().slice(0, 60);
    this.store.save();
    const l = this.lives.get(id);
    if (l && l.publisher) {
      try { l.publisher.send(JSON.stringify(StreamHub.config(entry))); } catch (e) { /* getrennt */ }
    }
    return true;
  }

  static config(entry) {
    return { type: 'config', rotate: entry.rotate || 0, mirror: !!entry.mirror, label: entry.label };
  }

  setEnabled(id, enabled) {
    const entry = this.store.data.streams[id];
    if (!entry) return false;
    entry.enabled = enabled;
    this.store.save();
    if (!enabled) this.kick(id, 'stopped', 'Stream wurde vom Admin gestoppt.');
    return true;
  }

  stopAll() {
    for (const id of Object.keys(this.store.data.streams)) this.setEnabled(id, false);
  }

  // Handy rauswerfen: neuer Schlüssel, der alte QR-Code gilt nicht mehr
  revoke(id) {
    const entry = this.store.data.streams[id];
    if (!entry) return false;
    entry.key = randomToken(24);
    this.store.save();
    this.kick(id, 'revoked', 'Zugang wurde vom Admin entzogen.');
    return true;
  }

  remove(id) {
    if (!this.store.data.streams[id]) return false;
    delete this.store.data.streams[id];
    this.store.save();
    this.kick(id, 'removed', 'Stream wurde vom Admin gelöscht.');
    const l = this.lives.get(id);
    if (l) {
      for (const res of l.viewers) res.end();
      if (l.transcoder) l.transcoder.stop();
      this.lives.delete(id);
    }
    return true;
  }

  kick(id, type, message) {
    const l = this.lives.get(id);
    if (!l || !l.publisher) return;
    const ws = l.publisher;
    l.publisher = null;
    try {
      ws.send(JSON.stringify({ type, message }));
      ws.close(4000, type);
    } catch (e) { /* bereits geschlossen */ }
  }

  status(id) {
    const entry = this.store.data.streams[id];
    const l = this.lives.get(id);
    const now = Date.now();
    const live = !!(l && l.publisher);
    return {
      user: entry.user,
      streamId: entry.streamId,
      label: entry.label,
      rotate: entry.rotate || 0,
      mirror: !!entry.mirror,
      enabled: entry.enabled,
      createdAt: entry.createdAt,
      phoneConnected: live,
      camera: (l && l.camera) || '',
      receiving: !!(live && l.frameAt && now - l.frameAt < 5000),
      fps: l ? l.fps() : 0,
      lastFrameAt: l && l.frameAt ? new Date(l.frameAt).toISOString() : null,
      resolution: (l && l.dims) || '',
      viewers: l ? l.viewers.size + (l.transcoder ? l.transcoder.tsClients.size : 0) : 0,
    };
  }

  list() {
    return Object.keys(this.store.data.streams)
      .sort((a, b) => a.localeCompare(b))
      .map(id => this.status(id));
  }

  // ------------------------------------------------------------------
  // Handy (Sender)
  // ------------------------------------------------------------------

  // Prüft Zugang; gibt { id, entry } oder einen Fehler zurück
  authorize(user, streamId, key) {
    const entry = this.get(user, streamId);
    if (!entry || !key || entry.key !== key) return { error: 'invalid', message: 'Link ungültig oder Zugang entzogen.' };
    if (!entry.enabled) return { error: 'stopped', message: 'Stream ist vom Admin gestoppt.' };
    return { id: StreamHub.id(user, streamId), entry };
  }

  attachPublisher(id, ws) {
    const l = this.live(id);
    if (l.publisher && l.publisher !== ws) {
      // Nur ein Handy pro Stream: das alte wird abgelöst
      this.kick(id, 'replaced', 'Ein anderes Gerät sendet jetzt auf diesem Stream.');
    }
    l.publisher = ws;
    l.connectedAt = Date.now();
  }

  detachPublisher(id, ws) {
    const l = this.lives.get(id);
    if (l && l.publisher === ws) l.publisher = null;
  }

  pushFrame(id, jpeg) {
    const l = this.live(id);
    if (jpeg.length < 4 || jpeg.length > MAX_FRAME_BYTES) return false;
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false; // kein JPEG
    const now = Date.now();
    if (now - l.frameAt < MIN_FRAME_GAP_MS) return false;
    l.frame = jpeg;
    l.frameAt = now;
    l.dims = jpegSize(jpeg) || l.dims;
    l.frameTimes.push(now);
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    for (const res of l.viewers) {
      if (res.writableLength > 1024 * 1024) continue; // langsamer Zuschauer: Bild auslassen
      res.write(head);
      res.write(jpeg);
      res.write('\r\n');
    }
    if (l.transcoder) l.transcoder.push(jpeg, l.dims);
    return true;
  }

  // ------------------------------------------------------------------
  // Zuschauer
  // ------------------------------------------------------------------

  addMjpegViewer(id, res) {
    const l = this.live(id);
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=' + BOUNDARY,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Connection': 'close',
      'X-Accel-Buffering': 'no', // nginx: nicht puffern
      'Access-Control-Allow-Origin': '*',
    });
    l.viewers.add(res);
    res.on('close', () => l.viewers.delete(res));
    if (l.frame) {
      res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${l.frame.length}\r\n\r\n`);
      res.write(l.frame);
      res.write('\r\n');
    }
  }

  transcoder(id) {
    if (!this.ffmpeg) return null;
    const l = this.live(id);
    if (!l.transcoder) {
      l.transcoder = new Transcoder({
        ffmpeg: this.ffmpeg,
        dir: path.join(this.workDir, id.replace('/', '__')),
        log: msg => this.log(`[${id}] ${msg}`),
      });
      if (l.frame) l.transcoder.push(l.frame, l.dims);
    }
    return l.transcoder;
  }

  shutdown() {
    for (const l of this.lives.values()) {
      if (l.transcoder) l.transcoder.stop();
      for (const res of l.viewers) res.end();
    }
  }
}

module.exports = { StreamHub, BOUNDARY, jpegSize, normRotate };
