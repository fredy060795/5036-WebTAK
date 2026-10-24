// Daten vom TAK-Server: Datenpakete, Data Sync (Missionen), Video-Feeds und Karten-Overlays (KML/KMZ).
// Abruf über die Durchreiche (/api/eud/marti) mit dem Client-Zertifikat dieses Geräts.
'use strict';

(() => {
  const { $, store, profile, toast, setMsg, esc, map, handleCot, askTrust, postJson, getServers, saveServers } = window.eud;
  const msg = (text, ok) => setMsg($('dataMsg'), text, ok);

  // ---------------- Speicher für Overlays (IndexedDB, bleibt offline) ----------------

  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('eud', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('overlays', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('overlays', mode);
        const req = fn(t.objectStore('overlays'));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
      });
    };
    return { all: () => tx('readonly', s => s.getAll()), put: o => tx('readwrite', s => s.put(o)), del: id => tx('readwrite', s => s.delete(id)) };
  })();

  // ---------------- KML -> Leaflet ----------------

  map.createPane('kml').style.zIndex = 390; // unter Zeichnungen und Markern
  const layers = new Map(); // overlay id -> Leaflet-Layer
  let overlays = [];

  function kmlColor(c, fallback) {
    c = String(c || '').trim();
    if (!/^[0-9a-f]{8}$/i.test(c)) return fallback;
    return { color: '#' + c.slice(6, 8) + c.slice(4, 6) + c.slice(2, 4), opacity: parseInt(c.slice(0, 2), 16) / 255 };
  }
  const textOf = html => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.trim();

  function kmlLayer(ov) {
    const doc = new DOMParser().parseFromString(ov.kml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('KML lässt sich nicht lesen.');
    const kids = (el, name) => [...el.children].filter(c => c.localName === name);
    const kid = (el, name) => kids(el, name)[0];
    const txt = (el, name) => { const n = el && el.getElementsByTagName(name)[0]; return n ? n.textContent.trim() : ''; };
    const image = href => {
      if (!href) return '';
      const imgs = ov.images || {};
      if (imgs[href]) return imgs[href];
      const base = href.split('/').pop();
      const k = Object.keys(imgs).find(n => n.split('/').pop() === base);
      if (k) return imgs[k];
      return /^https?:\/\//i.test(href) ? href : '';
    };
    const readStyle = st => {
      const ls = kid(st, 'LineStyle'), ps = kid(st, 'PolyStyle'), is = kid(st, 'IconStyle');
      return {
        line: kmlColor(ls && txt(ls, 'color'), null), width: Number(ls && txt(ls, 'width')) || 2,
        poly: kmlColor(ps && txt(ps, 'color'), null), fill: !(ps && txt(ps, 'fill') === '0'),
        icon: is ? image(txt(is, 'href')) : '', iconColor: kmlColor(is && txt(is, 'color'), null),
      };
    };
    const styles = {};
    for (const st of doc.getElementsByTagName('Style')) if (st.getAttribute('id')) styles['#' + st.getAttribute('id')] = readStyle(st);
    for (const sm of doc.getElementsByTagName('StyleMap')) {
      const pair = [...sm.getElementsByTagName('Pair')].find(p => txt(p, 'key') === 'normal');
      if (pair && sm.getAttribute('id')) styles['#' + sm.getAttribute('id')] = styles[txt(pair, 'styleUrl')] || {};
    }
    const coords = el => (el ? el.textContent.trim().split(/\s+/).map(s => s.split(',').map(Number)).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])).map(p => [p[1], p[0]]) : []);
    const group = L.featureGroup();

    for (const pm of doc.getElementsByTagName('Placemark')) {
      const own = kid(pm, 'Style');
      const st = Object.assign({}, styles[txt(pm, 'styleUrl')] || {}, own ? readStyle(own) : {});
      const name = txt(pm, 'name');
      const desc = textOf(txt(pm, 'description'));
      const line = st.line || { color: '#ffd400', opacity: 1 };
      const poly = st.poly || { color: line.color, opacity: 0.25 };
      const popup = `<div class="t">${esc(name || ov.name)}</div>${desc ? `<div>${esc(desc)}</div>` : ''}<div class="k">${esc(ov.name)}</div>`;
      const add = layer => { layer.bindPopup(popup, { maxWidth: 260 }); group.addLayer(layer); };
      const walk = g => {
        for (const el of g.children) {
          if (el.localName === 'Point') {
            const p = coords(kid(el, 'coordinates'))[0];
            if (!p) continue;
            const m = st.icon
              ? L.marker(p, { pane: 'kml', icon: L.icon({ iconUrl: st.icon, iconSize: [24, 24], iconAnchor: [12, 12] }) })
              : L.circleMarker(p, { pane: 'kml', radius: 6, color: '#000', weight: 1.5, fillColor: (st.iconColor || line).color, fillOpacity: 1 });
            if (name) m.bindTooltip(name, { permanent: true, direction: 'right', className: 'ov-label', offset: [8, 0] });
            add(m);
          } else if (el.localName === 'LineString' || el.localName === 'LinearRing') {
            const pts = coords(kid(el, 'coordinates'));
            if (pts.length > 1) add(L.polyline(pts, { pane: 'kml', color: line.color, opacity: line.opacity, weight: st.width || 2 }));
          } else if (el.localName === 'Polygon') {
            const outer = kid(el, 'outerBoundaryIs'), inner = kids(el, 'innerBoundaryIs');
            const rings = [coords(outer && outer.getElementsByTagName('coordinates')[0]), ...inner.map(i => coords(i.getElementsByTagName('coordinates')[0]))].filter(r => r.length > 2);
            if (rings.length) add(L.polygon(rings, { pane: 'kml', color: line.color, opacity: line.opacity, weight: st.width || 2, fillColor: poly.color, fillOpacity: st.fill === false ? 0 : poly.opacity }));
          } else if (el.localName === 'MultiGeometry') {
            walk(el);
          }
        }
      };
      walk(pm);
    }
    for (const go of doc.getElementsByTagName('GroundOverlay')) {
      const box = go.getElementsByTagName('LatLonBox')[0];
      const href = image(txt(go.getElementsByTagName('Icon')[0], 'href'));
      if (!box || !href) continue;
      const b = [[Number(txt(box, 'south')), Number(txt(box, 'west'))], [Number(txt(box, 'north')), Number(txt(box, 'east'))]];
      if (b.flat().every(Number.isFinite)) group.addLayer(L.imageOverlay(href, b, { pane: 'kml', opacity: 0.85 }));
    }
    return group;
  }

  function showOverlay(ov) {
    if (layers.has(ov.id)) { layers.get(ov.id).remove(); layers.delete(ov.id); }
    if (!ov.visible) return;
    try {
      const l = kmlLayer(ov);
      l.addTo(map);
      layers.set(ov.id, l);
    } catch (e) { toast(`Overlay „${ov.name}“: ${e.message}`); }
  }

  async function saveOverlays(list, source) {
    for (const o of list) {
      const ov = { id: source + ':' + o.name, name: o.name, source, kml: o.kml, images: o.images || {}, visible: true, date: Date.now() };
      const old = overlays.find(x => x.id === ov.id);
      if (old) ov.visible = old.visible;
      overlays = overlays.filter(x => x.id !== ov.id).concat(ov);
      try { await idb.put(ov); } catch (e) { toast('Overlay konnte nicht gespeichert werden (Speicher voll?).'); }
      showOverlay(ov);
    }
    renderOverlays();
  }

  function renderOverlays() {
    const box = $('ovList');
    box.textContent = '';
    if (!overlays.length) box.innerHTML = '<div class="empty">Noch keine Overlays.</div>';
    for (const ov of overlays) {
      const row = document.createElement('div');
      row.className = 'item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = ov.visible;
      cb.onchange = () => { ov.visible = cb.checked; idb.put(ov).catch(() => {}); showOverlay(ov); };
      const t = document.createElement('span');
      t.textContent = ov.name;
      const s = document.createElement('small');
      s.textContent = ov.source.split(':')[0] === 'file' ? 'vom Gerät' : ov.source.replace(/^(pkg|mission):/, (m, k) => (k === 'pkg' ? 'Paket ' : 'Mission '));
      t.append(s);
      t.style.cursor = 'pointer';
      t.onclick = () => { const l = layers.get(ov.id); if (l && l.getBounds().isValid()) { window.eud.closePopup(); map.fitBounds(l.getBounds(), { maxZoom: 16 }); } };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'del';
      del.textContent = '×';
      del.onclick = async () => {
        if (!confirm(`Overlay „${ov.name}“ löschen?`)) return;
        overlays = overlays.filter(x => x !== ov);
        ov.visible = false;
        showOverlay(ov);
        await idb.del(ov.id).catch(() => {});
        renderOverlays();
      };
      row.append(cb, t, del);
      box.append(row);
    }
  }

  // ---------------- Server-Auswahl und Abruf ----------------

  const dataServers = () => getServers().filter(s => s.proto === 'ssl' && s.certPem && s.keyPem);
  function currentServer() {
    const list = dataServers();
    return list.find(s => s.id === $('dataSrv').value) || list[0] || null;
  }
  function fillServers() {
    const list = dataServers();
    const keep = $('dataSrv').value || store.get('eud.dataSrv', '');
    $('dataSrv').replaceChildren(...list.map(s => new Option(s.name || s.host, s.id)));
    if (list.some(s => s.id === keep)) $('dataSrv').value = keep;
    $('dataSrvRow').classList.toggle('hidden', list.length < 2);
  }
  $('dataSrv').addEventListener('change', () => store.set('eud.dataSrv', $('dataSrv').value));

  async function marti(action, args, srv = currentServer()) {
    if (!srv) throw new Error('Dafür wird ein TAK-Server mit SSL und Zertifikat gebraucht (Menü → Server).');
    for (let i = 0; i < 2; i++) {
      try {
        return await postJson('/api/eud/marti', {
          server: { host: srv.host, apiPort: srv.apiPort || 8443, caPems: srv.caPems, fingerprint: srv.apiFingerprint || srv.fingerprint, certPem: srv.certPem, keyPem: srv.keyPem },
          action, args,
        });
      } catch (e) {
        if (e.code !== 'UNTRUSTED' || i) throw e;
        const ok = await askTrust(`${srv.host}:${srv.apiPort || 8443}`, e.fingerprint, e.subject);
        if (!ok) throw new Error('Abgebrochen.');
        srv.apiFingerprint = e.fingerprint;
        saveServers();
      }
    }
    return null;
  }

  // Ergebnis einspielen: CoT auf die Karte, Overlays speichern
  async function apply(result, source) {
    for (const xml of result.cot || []) handleCot(xml);
    if ((result.overlays || []).length) await saveOverlays(result.overlays, source);
    return `${(result.cot || []).length} Objekt(e), ${(result.overlays || []).length} Overlay(s)`;
  }

  const busy = (btn, on) => { if (btn) btn.disabled = on; };

  // ---------------- Datenpakete ----------------

  $('pkgLoad').addEventListener('click', async () => {
    const btn = $('pkgLoad');
    busy(btn, true);
    msg('Lade Liste …', true);
    try {
      const { packages } = await marti('packages');
      const box = $('pkgList');
      box.textContent = '';
      if (!packages.length) box.innerHTML = '<div class="empty">Keine Datenpakete auf dem Server.</div>';
      for (const p of packages) {
        const row = document.createElement('div');
        row.className = 'item';
        const t = document.createElement('span');
        t.textContent = p.name;
        const s = document.createElement('small');
        s.textContent = [p.user, p.time ? new Date(p.time).toLocaleString() : '', p.size ? Math.max(1, Math.round(p.size / 1024)) + ' KB' : ''].filter(Boolean).join(' · ');
        t.append(s);
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'LADEN';
        b.onclick = async () => {
          b.disabled = true;
          msg('Lade ' + p.name + ' …', true);
          try {
            const summary = await apply(await marti('package', { hash: p.hash, name: p.name }), 'pkg:' + p.name);
            msg(`${p.name}: ${summary}.`, true);
            b.textContent = '✓';
            b.className = 'on';
          } catch (e) { msg(e.message); } finally { b.disabled = false; }
        };
        row.append(t, b);
        box.append(row);
      }
      msg('');
    } catch (e) { msg(e.message); } finally { busy(btn, false); }
  });

  // ---------------- Data Sync (Missionen) ----------------

  let subs = store.get('eud.missions', []); // [{ srv, name }]
  const isSub = (srv, name) => subs.some(s => s.srv === srv.id && s.name === name);

  async function syncMission(srv, name, quiet) {
    const summary = await apply(await marti('mission', { name, uid: profile.uid }, srv), 'mission:' + name);
    if (!quiet) msg(`${name}: ${summary}.`, true);
  }

  $('misLoad').addEventListener('click', async () => {
    const btn = $('misLoad');
    const srv = currentServer();
    busy(btn, true);
    msg('Lade Missionen …', true);
    try {
      const { missions } = await marti('missions', {}, srv);
      const box = $('misList');
      box.textContent = '';
      if (!missions.length) box.innerHTML = '<div class="empty">Keine Missionen auf dem Server.</div>';
      for (const m of missions) {
        const row = document.createElement('div');
        row.className = 'item';
        const t = document.createElement('span');
        t.textContent = m.name + (m.password ? ' 🔒' : '');
        const s = document.createElement('small');
        s.textContent = [m.description, `${m.items} Objekte`, `${m.files} Dateien`].filter(Boolean).join(' · ');
        t.append(s);
        const b = document.createElement('button');
        b.type = 'button';
        const label = () => { const on = isSub(srv, m.name); b.textContent = on ? '✓ ABO' : 'ABONNIEREN'; b.className = on ? 'on' : ''; };
        label();
        b.onclick = async () => {
          b.disabled = true;
          try {
            if (isSub(srv, m.name)) {
              await marti('unsubscribe', { name: m.name, uid: profile.uid }, srv).catch(() => {});
              subs = subs.filter(x => !(x.srv === srv.id && x.name === m.name));
              msg(`${m.name}: Abo beendet.`, true);
            } else {
              msg('Lade ' + m.name + ' …', true);
              await syncMission(srv, m.name);
              subs.push({ srv: srv.id, name: m.name });
            }
            store.set('eud.missions', subs);
            label();
          } catch (e) { msg(e.message); } finally { b.disabled = false; }
        };
        row.append(t, b);
        box.append(row);
      }
      if (missions.length) msg('');
    } catch (e) { msg(e.message); } finally { busy(btn, false); }
  });

  // Abonnierte Missionen aktuell halten: bei Änderungsmeldung vom Server und alle 5 Minuten
  let syncTimer = null;
  async function syncAll() {
    if (!navigator.onLine) return;
    for (const sub of subs) {
      const srv = getServers().find(s => s.id === sub.srv && s.auto);
      if (srv) await syncMission(srv, sub.name, true).catch(() => {});
    }
  }
  document.addEventListener('eud-mission-change', () => { clearTimeout(syncTimer); syncTimer = setTimeout(syncAll, 3000); });
  setInterval(syncAll, 5 * 60 * 1000);
  setTimeout(syncAll, 8000);

  // ---------------- Overlays vom Gerät ----------------

  $('ovFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    msg('Lade ' + f.name + ' …', true);
    try {
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
        r.onerror = () => reject(new Error('Datei lässt sich nicht lesen.'));
        r.readAsDataURL(f);
      });
      const summary = await apply(await postJson('/api/eud/extract', { name: f.name, data }), 'file:' + f.name);
      msg(`${f.name}: ${summary}.`, true);
    } catch (err) { msg(err.message); }
  });

  // ---------------- Video-Feeds vom TAK-Server ----------------

  $('feedLoad').addEventListener('click', async () => {
    const btn = $('feedLoad');
    const box = $('feedList');
    busy(btn, true);
    try {
      const { feeds } = await marti('videos');
      box.textContent = '';
      if (!feeds.length) box.innerHTML = '<div class="empty">Keine Video-Feeds auf dem Server.</div>';
      for (const f of feeds) {
        const row = document.createElement('div');
        row.className = 'item';
        const t = document.createElement('span');
        t.textContent = f.alias;
        const s = document.createElement('small');
        s.textContent = f.url;
        t.append(s);
        let b;
        if (/^https?:\/\//i.test(f.url)) {
          b = document.createElement('button');
          b.type = 'button';
          b.textContent = '▶';
          b.onclick = () => { window.eud.closePopup(); window.eudPlay(f.alias, f.url); };
        } else {
          b = document.createElement('button');
          b.type = 'button';
          b.textContent = 'KOPIEREN';
          b.onclick = () => navigator.clipboard.writeText(f.url).then(() => toast('Adresse kopiert – z. B. in VLC öffnen.'), () => toast(f.url, 8000));
        }
        row.append(t, b);
        box.append(row);
      }
      setMsg($('vidMsg'), '');
    } catch (e) { setMsg($('vidMsg'), e.message); } finally { busy(btn, false); }
  });

  // ---------------- Tabs, Start ----------------

  for (const b of document.querySelectorAll('#dataTabs button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('#dataTabs button')) x.classList.toggle('on', x === b);
      for (const p of document.querySelectorAll('[data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab);
      if (b.dataset.tab === 'overlays') renderOverlays();
    });
  }
  document.addEventListener('eud-popup', e => {
    if (e.detail === 'data') { fillServers(); renderOverlays(); msg(dataServers().length ? '' : 'Dafür wird ein TAK-Server mit SSL und Zertifikat gebraucht (Menü → Server).'); }
  });

  idb.all().then(list => {
    overlays = (list || []).sort((a, b) => a.date - b.date);
    for (const ov of overlays) showOverlay(ov);
  }).catch(() => {});
})();
