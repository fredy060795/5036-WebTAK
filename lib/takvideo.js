// Register camera streams in the TAK server (OpenTAKServer/MediaMTX) automatically.
// For each stream OTS creates a video path; MediaMTX pulls the video on demand (sourceOnDemand) from
// our HLS link and ATAK finds the feed under "Video" (rtsp://<OTS>:8554/<path>).
// The admin mainly maintains the path here; everything else runs by itself.

const PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._~-]{0,63}(\/[A-Za-z0-9._~-]{1,64}){0,3}$/;

function slug(text) {
  return String(text || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
}

class TakVideo {
  // base(): public address of this server (for the HLS link MediaMTX pulls)
  constructor({ store, hub, takUsers, base, log }) {
    this.store = store;
    this.hub = hub;
    this.takUsers = takUsers;
    this.base = base;
    this.log = log || (() => {});
    this.queue = Promise.resolve();
    this.lastSeen = new Map(); // stream id -> last time with a connected camera (mode "live")
  }

  get s() {
    const d = this.store.data;
    if (!d.takVideo) d.takVideo = {};
    const s = d.takVideo;
    if (s.auto === undefined) s.auto = true;        // register new streams automatically
    if (!['all', 'live'].includes(s.when)) s.when = 'all'; // all = while enabled, live = only while the camera is sending
    if (typeof s.prefix !== 'string') s.prefix = 'cam';
    if (!s.paths) s.paths = {};                     // Stream-ID -> { path, enabled, pushed, source, error, at }
    return s;
  }

  ready() { return this.takUsers.otsConfigured(); }

  static validPath(p) { return PATH_RE.test(p) && !p.includes('..'); }

  setSettings({ auto, when, prefix }) {
    const s = this.s;
    if (auto !== undefined) s.auto = !!auto;
    if (when !== undefined) s.when = when === 'live' ? 'live' : 'all';
    if (prefix !== undefined) {
      const p = String(prefix).trim().replace(/^\/+|\/+$/g, '');
      if (p && !TakVideo.validPath(p)) throw new Error('Prefix: only letters, digits, - _ . and /');
      s.prefix = p;
    }
    this.store.save();
  }

  // suggestion: <prefix>/<label>, unique
  autoPath(id) {
    const e = this.store.data.streams[id];
    const name = slug(e && (e.name || e.label || e.user)) || slug(id) || 'stream';
    const base = (this.s.prefix ? this.s.prefix + '/' : '') + name;
    let p = base;
    for (let i = 2; this.pathTaken(p, id); i++) p = `${base}-${i}`;
    return p;
  }

  pathTaken(p, exceptId) {
    return Object.entries(this.s.paths).some(([id, v]) => id !== exceptId && (v.path === p || v.pushed === p));
  }

  rec(id) {
    const s = this.s;
    if (!s.paths[id]) s.paths[id] = { path: '', enabled: s.auto, pushed: '', source: '', error: '', at: null };
    if (!s.paths[id].path) s.paths[id].path = this.autoPath(id);
    return s.paths[id];
  }

  sourceFor(id) {
    const e = this.store.data.streams[id];
    const b = this.base();
    if (!e || !b) return '';
    return `${b}/${e.user}/${e.streamId}/index.m3u8`;
  }

  // Should the stream be in the TAK server right now?
  wanted(id) {
    const e = this.store.data.streams[id];
    const r = this.s.paths[id];
    if (!e || !r || !r.enabled || e.enabled === false) return false;
    if (this.s.when === 'live') {
      const l = this.hub.lives.get(id);
      if (l && l.publisher) this.lastSeen.set(id, Date.now());
      return Date.now() - (this.lastSeen.get(id) || 0) < 120000; // do not remove on short dropouts
    }
    return true;
  }

  // process changes one after another (no concurrent OTS calls)
  enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // sync one stream (after create, live, stop, path change …)
  touch(id) {
    if (!this.ready()) return Promise.resolve();
    if (this.store.data.streams[id]) this.rec(id);
    return this.enqueue(() => this.syncOne(id));
  }

  async syncOne(id) {
    const r = this.s.paths[id];
    if (!r) return;
    const ots = this.takUsers.ots();
    const want = this.wanted(id);
    const source = this.sourceFor(id);
    try {
      // remove the old path (renamed or no longer wanted) first
      if (r.pushed && (!want || r.pushed !== r.path)) {
        await ots.deleteStream(r.pushed).catch(e => { if (e.status !== 404 && !/not found/i.test(e.message)) throw e; });
        this.log('TAK video removed:', r.pushed);
        r.pushed = '';
        r.source = '';
      }
      if (want) {
        if (!source) throw new Error('Public address missing (Settings → public address).');
        if (r.pushed !== r.path) {
          try {
            await ots.addStream(r.path, source);
          } catch (e) {
            // already exists (e.g. after a restart): update the source
            if (!/exist/i.test(e.message)) throw e;
            await ots.updateStream(r.path, source);
          }
          this.log('TAK video registered:', r.path, '←', source);
        } else if (r.source !== source) {
          await ots.updateStream(r.path, source);
        }
        r.pushed = r.path;
        r.source = source;
      }
      r.error = '';
    } catch (e) {
      r.error = e.message;
      this.log('TAK video error', id, e.message);
    }
    r.at = new Date().toISOString();
    if (!this.store.data.streams[id] && !r.pushed) delete this.s.paths[id];
    this.store.save();
  }

  // stream deleted: remove it, then drop the entry
  removed(id) {
    const r = this.s.paths[id];
    if (!r) return Promise.resolve();
    r.enabled = false;
    if (!r.pushed || !this.ready()) { delete this.s.paths[id]; this.store.save(); return Promise.resolve(); }
    return this.enqueue(() => this.syncOne(id));
  }

  // admin: change the path / switch on or off in the TAK server
  async set(id, { path, enabled }) {
    if (!this.store.data.streams[id]) throw new Error('Stream not found.');
    const r = this.rec(id);
    if (path !== undefined) {
      const p = String(path).trim().replace(/^\/+|\/+$/g, '');
      const next = p || this.autoPath(id);
      if (!TakVideo.validPath(next)) throw new Error('Path: only letters, digits, - _ . and / (not starting with /).');
      if (this.pathTaken(next, id)) throw new Error('Another stream already has this path.');
      r.path = next;
    }
    if (enabled !== undefined) r.enabled = !!enabled;
    this.store.save();
    await this.touch(id);
    return this.view(id);
  }

  // sync everything ("Sync" button, regularly and at startup)
  async syncAll() {
    if (!this.ready()) return { ok: false, error: 'OpenTAKServer is not connected.' };
    for (const id of Object.keys(this.store.data.streams)) this.rec(id);
    const ids = Object.keys(this.s.paths);
    await this.enqueue(async () => { for (const id of ids) await this.syncOne(id); });
    const errors = ids.map(id => this.s.paths[id]).filter(r => r && r.error).map(r => `${r.path}: ${r.error}`);
    return { ok: !errors.length, errors };
  }

  rtspUrl(path) {
    const host = this.takUsers.takHost();
    return host ? `rtsp://${host}:8554/${path}` : '';
  }

  view(id) {
    const r = this.s.paths[id] || { path: this.autoPath(id), enabled: this.s.auto };
    const e = this.store.data.streams[id] || {};
    return {
      id, label: e.label || e.user || id, path: r.path, enabled: !!r.enabled, pushed: r.pushed || '',
      inTak: !!r.pushed && r.pushed === r.path, error: r.error || '', at: r.at || null,
      rtsp: r.path ? this.rtspUrl(r.path) : '', source: this.sourceFor(id),
    };
  }

  state() {
    const s = this.s;
    return {
      auto: s.auto, when: s.when, prefix: s.prefix, ready: this.ready(), base: this.base() || '',
      streams: Object.keys(this.store.data.streams).sort().map(id => this.view(id)),
    };
  }
}

module.exports = { TakVideo, slug };
