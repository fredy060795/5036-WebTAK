// Kamera-Streams automatisch im TAK-Server (OpenTAKServer/MediaMTX) eintragen.
// Für jeden Stream legt OTS einen Videopfad an; MediaMTX holt das Bild bei Bedarf (sourceOnDemand) von
// unserem HLS-Link und ATAK findet den Feed unter "Video" (rtsp://<OTS>:8554/<pfad>).
// Der Admin pflegt hier hauptsächlich den Pfad; alles andere läuft von selbst.

const PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._~-]{0,63}(\/[A-Za-z0-9._~-]{1,64}){0,3}$/;

function slug(text) {
  return String(text || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
}

class TakVideo {
  // base(): öffentliche Adresse dieses Servers (für den HLS-Link, den MediaMTX abholt)
  constructor({ store, hub, takUsers, base, log }) {
    this.store = store;
    this.hub = hub;
    this.takUsers = takUsers;
    this.base = base;
    this.log = log || (() => {});
    this.queue = Promise.resolve();
    this.lastSeen = new Map(); // Stream-ID -> letzte Zeit mit verbundener Kamera (Modus "live")
  }

  get s() {
    const d = this.store.data;
    if (!d.takVideo) d.takVideo = {};
    const s = d.takVideo;
    if (s.auto === undefined) s.auto = true;        // neue Streams automatisch eintragen
    if (!['all', 'live'].includes(s.when)) s.when = 'all'; // all = solange freigegeben, live = nur solange die Kamera sendet
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
      if (p && !TakVideo.validPath(p)) throw new Error('Präfix: nur Buchstaben, Ziffern, - _ . und /');
      s.prefix = p;
    }
    this.store.save();
  }

  // Vorschlag: <präfix>/<bezeichnung>, eindeutig
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

  // Soll der Stream gerade im TAK-Server stehen?
  wanted(id) {
    const e = this.store.data.streams[id];
    const r = this.s.paths[id];
    if (!e || !r || !r.enabled || e.enabled === false) return false;
    if (this.s.when === 'live') {
      const l = this.hub.lives.get(id);
      if (l && l.publisher) this.lastSeen.set(id, Date.now());
      return Date.now() - (this.lastSeen.get(id) || 0) < 120000; // kurze Abbrüche nicht gleich austragen
    }
    return true;
  }

  // Änderungen der Reihe nach abarbeiten (keine gleichzeitigen OTS-Aufrufe)
  enqueue(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // Einen Stream abgleichen (nach Anlegen, Live, Stopp, Pfadänderung …)
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
      // alter Pfad (umbenannt oder nicht mehr gewünscht) zuerst austragen
      if (r.pushed && (!want || r.pushed !== r.path)) {
        await ots.deleteStream(r.pushed).catch(e => { if (e.status !== 404 && !/not found/i.test(e.message)) throw e; });
        this.log('TAK-Video ausgetragen:', r.pushed);
        r.pushed = '';
        r.source = '';
      }
      if (want) {
        if (!source) throw new Error('Öffentliche Adresse fehlt (Einstellungen → Öffentliche Adresse).');
        if (r.pushed !== r.path) {
          try {
            await ots.addStream(r.path, source);
          } catch (e) {
            // gibt es schon (z. B. nach Neustart): Quelle aktualisieren
            if (!/exist/i.test(e.message)) throw e;
            await ots.updateStream(r.path, source);
          }
          this.log('TAK-Video eingetragen:', r.path, '←', source);
        } else if (r.source !== source) {
          await ots.updateStream(r.path, source);
        }
        r.pushed = r.path;
        r.source = source;
      }
      r.error = '';
    } catch (e) {
      r.error = e.message;
      this.log('TAK-Video Fehler', id, e.message);
    }
    r.at = new Date().toISOString();
    if (!this.store.data.streams[id] && !r.pushed) delete this.s.paths[id];
    this.store.save();
  }

  // Stream gelöscht: austragen, Eintrag danach entfernen
  removed(id) {
    const r = this.s.paths[id];
    if (!r) return Promise.resolve();
    r.enabled = false;
    if (!r.pushed || !this.ready()) { delete this.s.paths[id]; this.store.save(); return Promise.resolve(); }
    return this.enqueue(() => this.syncOne(id));
  }

  // Admin: Pfad ändern / im TAK-Server an- oder abschalten
  async set(id, { path, enabled }) {
    if (!this.store.data.streams[id]) throw new Error('Stream nicht gefunden.');
    const r = this.rec(id);
    if (path !== undefined) {
      const p = String(path).trim().replace(/^\/+|\/+$/g, '');
      const next = p || this.autoPath(id);
      if (!TakVideo.validPath(next)) throw new Error('Pfad: nur Buchstaben, Ziffern, - _ . und / (nicht mit / beginnen).');
      if (this.pathTaken(next, id)) throw new Error('Diesen Pfad hat schon ein anderer Stream.');
      r.path = next;
    }
    if (enabled !== undefined) r.enabled = !!enabled;
    this.store.save();
    await this.touch(id);
    return this.view(id);
  }

  // Alles abgleichen (Knopf "Abgleichen", regelmäßig und beim Start)
  async syncAll() {
    if (!this.ready()) return { ok: false, error: 'OpenTAKServer ist nicht verbunden.' };
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
