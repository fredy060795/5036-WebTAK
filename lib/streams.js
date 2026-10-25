// Stream management: stored entries (user, stream id, key)
// and the live state (connected phone, last image, viewers, conversion).
//
// Every stream is unique by "<user>/<streamId>" – several streams
// run completely separately from each other.

const path = require('path');
const { randomId, randomToken } = require('./passwords');
const { Transcoder } = require('./transcoder');

const USER_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED = new Set(['admin', 'app', 'api', 'ws', 'assets', 'static', 'favicon.ico', 'robots.txt', 'health']);
const BOUNDARY = 'helmcamframe';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MIN_FRAME_GAP_MS = 30; // accept at most approx. 30 frames/s per stream
const FIT_MODES = ['fill', 'fit']; // fill = crop (no black corners), fit = whole image

// Reads width x height from the JPEG header (SOF marker) without decoding the image
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

// Any clockwise angle, 0 to below 360°, rounded to 0.5°
function normRotate(v) {
  const r = Number(v);
  if (!Number.isFinite(r)) return 0;
  const a = Math.round((((r % 360) + 360) % 360) * 2) / 2;
  return a >= 360 ? 0 : a;
}

// Image size (OV2640 frame size): 1 = 160x120, 5 = 320x240, 8 = 640x480, 11 = 1280x720
const FRAMESIZES = [1, 5, 8, 11];
const DEFAULT_FRAMESIZE = 1; // very fast
function normFramesize(v) {
  const n = Number(v);
  return FRAMESIZES.includes(n) ? n : DEFAULT_FRAMESIZE;
}

function normFit(v) {
  return FIT_MODES.includes(v) ? v : 'fill';
}

class Live {
  constructor() {
    this.publisher = null;     // the phone's WebSocket
    this.camera = '';          // camera name (reported by the phone)
    this.phone = '';           // the phone's device/browser
    this.frame = null;         // last JPEG
    this.frameAt = 0;
    this.frameTimes = [];      // for the frame rate
    this.viewers = new Set();  // MJPEG viewers (HTTP responses)
    this.transcoder = null;
    this.connectedAt = 0;
    this.ready = false;        // phone has a camera connected and is waiting
    this.onAir = false;        // admin has put the stream live
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
    this.events = [];   // notifications for the admin window (popups)
    this.eventSeq = 0;
  }

  // notification for the admin, e.g. "Jan – Platoon 1 activated the camera"
  event(id, kind, text) {
    this.events.push({ seq: ++this.eventSeq, at: new Date().toISOString(), id, kind, text });
    if (this.events.length > 200) this.events.shift();
  }

  // delete notifications from the list (all, or only the given numbers); the counter keeps running
  deleteEvents(seqs) {
    if (!seqs) this.events = [];
    else this.events = this.events.filter(e => !seqs.includes(e.seq));
  }

  eventsSince(since) {
    return this.events.filter(e => e.seq > since);
  }

  labelOf(id) {
    const e = this.store.data.streams[id];
    return e ? (e.label || e.user) : id;
  }

  // May the user start by themselves in mode "admin puts live"?
  userCanStart() {
    return (this.store.data.settings || {}).userCanStart === true;
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
  // management (admin)
  // ------------------------------------------------------------------

  create(user, label) {
    user = String(user || '').trim().toLowerCase();
    if (!StreamHub.validUser(user)) {
      throw new Error('Username: 1–32 characters, only a–z, 0–9, - and _ (not admin, app, api …).');
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
      fit: normFit((this.store.data.defaults || {}).fit),
      framesize: normFramesize((this.store.data.defaults || {}).framesize),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.store.data.streams[StreamHub.id(user, streamId)] = entry;
    this.store.save();
    return entry;
  }

  // path name from a freely entered name, e.g. "Jörg Müller" -> "joerg-mueller"
  static slug(name) {
    let s = String(name || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');
    if (!s || RESERVED.has(s)) s = ('user-' + s).replace(/-+$/, '').slice(0, 32);
    return s;
  }

  // self-registration via the general QR code: name + unit -> own stream
  register(name, unit, eud = false) {
    name = String(name || '').trim().slice(0, 40);
    unit = String(unit || '').trim().slice(0, 40);
    if (!name) throw new Error('Please enter a name.');
    const entry = this.create(StreamHub.slug(name), unit ? `${name} – ${unit}` : name);
    entry.self = true;
    entry.name = name;
    entry.unit = unit;
    if (eud) entry.eud = true; // from the TAK EUD: may go live by itself
    this.store.save();
    return entry;
  }

  // change rotation/mirroring/label; the phone gets the setting immediately
  setOptions(id, { rotate, mirror, fit, framesize, label }) {
    const entry = this.store.data.streams[id];
    if (!entry) return false;
    if (rotate !== undefined) entry.rotate = normRotate(rotate);
    if (mirror !== undefined) entry.mirror = !!mirror;
    if (fit !== undefined) entry.fit = normFit(fit);
    if (framesize !== undefined) entry.framesize = normFramesize(framesize);
    if (label !== undefined) entry.label = String(label).trim().slice(0, 60);
    this.store.save();
    const l = this.lives.get(id);
    if (l && l.publisher) {
      try { l.publisher.send(JSON.stringify(StreamHub.config(entry))); } catch (e) { /* disconnected */ }
    }
    return true;
  }

  static config(entry) {
    return {
      type: 'config', rotate: entry.rotate || 0, mirror: !!entry.mirror, fit: normFit(entry.fit),
      framesize: normFramesize(entry.framesize), label: entry.label,
    };
  }

  // "admin" = admin puts live (default), "user" = user starts by themselves
  liveMode() {
    return (this.store.data.settings || {}).liveMode === 'user' ? 'user' : 'admin';
  }

  // admin puts a stream live or back to "ready"
  setOnAir(id, on) {
    if (!this.store.data.streams[id]) return false;
    const l = this.live(id);
    l.onAir = !!on;
    this.sendLive(id);
    return true;
  }

  sendLive(id) {
    const l = this.lives.get(id);
    if (!l || !l.publisher) return;
    const msg = { type: 'live', on: l.onAir, mode: this.liveMode(), userCanStart: this.userCanStart() };
    try { l.publisher.send(JSON.stringify(msg)); } catch (e) { /* disconnected */ }
  }

  // mode changed: tell all phones
  broadcastLive() {
    for (const id of this.lives.keys()) this.sendLive(id);
  }

  setEnabled(id, enabled) {
    const entry = this.store.data.streams[id];
    if (!entry) return false;
    entry.enabled = enabled;
    this.store.save();
    if (!enabled && this.lives.get(id)) this.lives.get(id).onAir = false;
    if (!enabled) this.kick(id, 'stopped', 'Stream was stopped by the admin.');
    return true;
  }

  stopAll() {
    for (const id of Object.keys(this.store.data.streams)) this.setEnabled(id, false);
  }

  // kick the phone: new key, the old QR code is no longer valid
  revoke(id) {
    const entry = this.store.data.streams[id];
    if (!entry) return false;
    entry.key = randomToken(24);
    this.store.save();
    this.kick(id, 'revoked', 'Access was revoked by the admin.');
    return true;
  }

  remove(id) {
    if (!this.store.data.streams[id]) return false;
    delete this.store.data.streams[id];
    this.store.save();
    this.kick(id, 'removed', 'Stream was deleted by the admin.');
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
    } catch (e) { /* already closed */ }
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
      fit: normFit(entry.fit),
      framesize: normFramesize(entry.framesize),
      self: !!entry.self,
      enabled: entry.enabled,
      createdAt: entry.createdAt,
      phoneConnected: live,
      ready: !!(live && l.ready),
      onAir: !!(l && l.onAir),
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
  // phone (sender)
  // ------------------------------------------------------------------

  // checks access; returns { id, entry } or an error
  authorize(user, streamId, key) {
    const entry = this.get(user, streamId);
    if (!entry || !key || entry.key !== key) return { error: 'invalid', message: 'Link invalid or access revoked.' };
    if (!entry.enabled) return { error: 'stopped', message: 'Stream is stopped by the admin.' };
    return { id: StreamHub.id(user, streamId), entry };
  }

  attachPublisher(id, ws) {
    const l = this.live(id);
    if (l.publisher && l.publisher !== ws) {
      // only one phone per stream: the old one is replaced
      this.kick(id, 'replaced', 'Another device is now sending on this stream.');
    }
    l.publisher = ws;
    l.connectedAt = Date.now();
  }

  detachPublisher(id, ws) {
    const l = this.lives.get(id);
    if (l && l.publisher === ws) {
      l.publisher = null;
      l.ready = false;
    }
  }

  pushFrame(id, jpeg) {
    const l = this.live(id);
    if (this.liveMode() === 'admin' && !l.onAir) return false; // not live: discard
    if (jpeg.length < 4 || jpeg.length > MAX_FRAME_BYTES) return false;
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false; // not a JPEG
    const now = Date.now();
    if (now - l.frameAt < MIN_FRAME_GAP_MS) return false;
    l.frame = jpeg;
    l.frameAt = now;
    l.dims = jpegSize(jpeg) || l.dims;
    l.frameTimes.push(now);
    const head = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    for (const res of l.viewers) {
      if (res.writableLength > 1024 * 1024) continue; // slow viewer: skip the image
      res.write(head);
      res.write(jpeg);
      res.write('\r\n');
    }
    if (l.transcoder) l.transcoder.push(jpeg, l.dims);
    return true;
  }

  // ------------------------------------------------------------------
  // viewers
  // ------------------------------------------------------------------

  addMjpegViewer(id, res) {
    const l = this.live(id);
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=' + BOUNDARY,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Connection': 'close',
      'X-Accel-Buffering': 'no', // nginx: do not buffer
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders(); // send the header immediately even without an image yet (players would otherwise wait without a response)
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

module.exports = { StreamHub, BOUNDARY, jpegSize, normRotate, normFit, normFramesize };
