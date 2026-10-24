// 3D-Karte wie WinTAK/ATAK: MapLibre mit Gelände (Höhendaten), Himmel und aufrecht stehenden Symbolen.
// Die flache Leaflet-Karte bleibt das Werkzeug für alles Zeichnen/Messen (bei 0° Neigung); sobald gekippt
// wird, übernimmt diese Ansicht mit gleichem Ausschnitt, gleicher Drehung und allen Markern.
// MapLibre wird erst beim ersten Kippen geladen (ES-Modul, Worker liegt daneben).
'use strict';

(() => {
  const DEM = location.origin + TILE_BASE + 'dem/{z}/{x}/{y}.png'; // Klammern nicht kodieren (new URL würde das tun)
  const EMPTY = { type: 'FeatureCollection', features: [] };
  const supported = (() => {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
  })();

  let lib = null;         // maplibregl
  let ml = null;          // Karte
  let loading = null;
  let active = false;
  let syncing = false;    // Kamera wird gerade von der anderen Karte übernommen
  let timer = null;
  let clickedMarker = 0;
  let popup = null;
  const marks = new Map(); // uid -> { m, el, key }
  const ovMarks = [];
  let selfMark = null;
  let images = [];         // ids der Rasterbilder aus Overlays
  let demErrors = 0;       // fehlgeschlagene Höhenkacheln

  const absUrl = t => (/^https?:\/\//i.test(t) ? t : location.origin + t);
  const mlZoom = () => map.getZoom() - 1; // Leaflet rechnet mit 256-px-Kacheln, MapLibre mit 512
  const leafletBearing = () => (map.getBearing ? map.getBearing() : 0);

  function baseSource() {
    return {
      type: 'raster', tiles: [absUrl(sourceTemplate(profile.tiles))], tileSize: 256,
      maxzoom: sourceMaxZoom(profile.tiles), attribution: profile.tiles === 'custom' ? '' : SOURCES[profile.tiles].attribution,
    };
  }

  function style() {
    const isPoly = ['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false];
    const isLine = ['match', ['geometry-type'], ['LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'], true, false];
    const fill = src => ({ id: src + '-fill', type: 'fill', source: src, filter: isPoly, paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': ['get', 'fillOpacity'] } });
    const line = src => ({ id: src + '-line', type: 'line', source: src, filter: isLine,
      layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'stroke'], 'line-width': ['get', 'width'], 'line-opacity': ['get', 'opacity'] } });
    return {
      version: 8,
      sources: {
        base: baseSource(),
        dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: '© Mapzen terrain' },
        ovl: { type: 'geojson', data: EMPTY },
        shapes: { type: 'geojson', data: EMPTY },
      },
      layers: [
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 100 } },
        fill('ovl'), line('ovl'), fill('shapes'), line('shapes'),
      ],
      terrain: { source: 'dem', exaggeration: profile.exag || 1 },
      sky: {
        'sky-color': '#5f9bd6', 'horizon-color': '#cfe1f2', 'fog-color': '#d6e4f0',
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.75, 'atmosphere-blend': 0.6,
      },
    };
  }

  async function init() {
    if (ml) return;
    if (!loading) {
      loading = (async () => {
        const mod = await import('./vendor/maplibre-gl.mjs');
        lib = mod.default && mod.default.Map ? mod.default : mod;
        if (!document.querySelector('link[data-ml]')) {
          const css = document.createElement('link');
          css.rel = 'stylesheet';
          css.href = 'vendor/maplibre-gl.css';
          css.dataset.ml = '1';
          document.head.append(css);
        }
        const c = map.getCenter();
        ml = new lib.Map({
          container: 'map3d', style: style(), center: [c.lng, c.lat], zoom: mlZoom(), bearing: -leafletBearing(),
          pitch: 60, maxPitch: 88, attributionControl: { compact: true }, fadeDuration: 0, maxTileCacheSize: 600,
        });
        ml.on('move', () => { if (active) updateCompass(); });
        ml.on('moveend', toLeaflet);
        ml.on('pitch', () => { if (active && !syncing) pitchUi(ml.getPitch()); });
        ml.on('pitchend', () => {
          if (!active || syncing) return;
          const p = ml.getPitch();
          if (p < 2) { setPitch(0); return; } // ganz flach gedreht: zurück zur 2D-Karte
          pitch = Math.round(p);
          profile.pitch = pitch;
          saveProfile();
        });
        ml.on('dragstart', () => { follow = false; $('btnLocate').classList.remove('active'); });
        ml.on('click', e => {
          if (Date.now() - clickedMarker < 400) return;
          if (tool) placeMarker(L.latLng(e.lngLat.lat, e.lngLat.lng)); // Symbol gewählt: Antippen setzt den Marker
        });
        // Höhendaten nicht erreichbar (offline, gesperrt): 3D ohne Gelände statt Löchern in der Karte
        ml.on('error', e => {
          if (e && e.sourceId === 'dem' && ++demErrors === 4 && ml.getTerrain()) {
            ml.setTerrain(null);
            toast('No terrain data available – 3D view without elevation.');
          }
        });
        await new Promise(r => {
          if (ml.loaded()) return r();
          ml.once('load', r);
          setTimeout(() => (ml.isStyleLoaded() ? r() : ml.once('styledata', r)), 5000); // nicht ewig auf Kacheln warten
        });
        // Leaflet bewegt sich (Eigene Position folgen, Kontakt angetippt, Overlay gezeigt …): 3D folgt
        map.on('moveend', () => { if (active && !syncing) fromLeaflet(true); });
        map.on('rotate', () => { if (active && !syncing) ml.setBearing(-leafletBearing()); });
      })();
    }
    await loading;
  }

  // ---------------- Kamera zwischen beiden Karten abgleichen ----------------

  function fromLeaflet(animate) {
    const c = map.getCenter();
    const opts = { center: [c.lng, c.lat], zoom: mlZoom(), bearing: -leafletBearing() };
    syncing = true;
    if (animate) ml.easeTo({ ...opts, duration: 600 }); else ml.jumpTo(opts);
    syncing = false;
  }

  function toLeaflet() {
    if (!active || syncing) return;
    const c = ml.getCenter();
    syncing = true;
    try {
      map.setView([c.lat, c.lng], Math.round(ml.getZoom() + 1), { animate: false });
      if (map.setBearing) map.setBearing(-ml.getBearing());
    } finally { syncing = false; }
  }

  // ---------------- Inhalte: Marker, Zeichnungen, Overlays, eigene Position ----------------

  function circlePoly(lat, lon, r, n = 64) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      const dLat = (r * Math.cos(a)) / 111320;
      const dLon = (r * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180));
      pts.push([lon + dLon, lat + dLat]);
    }
    return { type: 'Polygon', coordinates: [pts] };
  }

  function styleProps(o) {
    return {
      stroke: o.color || '#ffd400', width: Math.min(Number(o.weight) || 3, 8), opacity: o.opacity == null ? 1 : o.opacity,
      fill: o.fillColor || o.color || '#ffd400', fillOpacity: o.fill === false ? 0 : (o.fillOpacity == null ? 0.2 : o.fillOpacity),
    };
  }

  function layerFeature(l) {
    if (l instanceof L.Circle) {
      const c = l.getLatLng();
      return { type: 'Feature', geometry: circlePoly(c.lat, c.lng, l.getRadius()), properties: styleProps(l.options) };
    }
    if (l instanceof L.Polyline) {
      const g = l.toGeoJSON().geometry;
      return { type: 'Feature', geometry: g, properties: styleProps(l.options) };
    }
    return null;
  }

  function pointElement(it) {
    const ic = iconFor(it.c, Date.now() > it.c.stale).options;
    const el = document.createElement('div');
    el.className = (ic.className || 'cot-icon') + ' m3d';
    el.style.width = ic.iconSize[0] + 'px';
    el.style.height = ic.iconSize[1] + 'px';
    el.innerHTML = ic.html;
    return { el, offset: [ic.iconSize[0] / 2 - ic.iconAnchor[0], ic.iconSize[1] / 2 - ic.iconAnchor[1]] };
  }

  function openPopup(it, lngLat) {
    if (popup) popup.remove();
    popup = new lib.Popup({ offset: 16, maxWidth: '260px', className: 'p3d', focusAfterOpen: false })
      .setLngLat(lngLat).setHTML(popupHtml(it)).addTo(ml);
    const p = popup;
    wirePopup(p.getElement(), () => p.remove());
  }

  function syncItems() {
    const seen = new Set();
    const shapes = [];
    for (const it of items.values()) {
      if (!it.c) continue;
      if (!isPoint(it.c)) {
        const f = it.layer && layerFeature(it.layer);
        if (f) shapes.push(f);
        continue;
      }
      if (!Number.isFinite(it.c.lat) || !Number.isFinite(it.c.lon) || (it.c.lat === 0 && it.c.lon === 0)) continue;
      seen.add(it.uid);
      const stale = Date.now() > it.c.stale;
      const key = it.xml + (stale ? 's' : '') + (it.c.team && it.c.speed > 0.5 ? Math.round(northAngle()) : '');
      let rec = marks.get(it.uid);
      if (rec && rec.key === key) continue;
      const { el, offset } = pointElement(it);
      if (rec) {
        const mel = rec.m.getElement();
        mel.innerHTML = el.innerHTML;
        mel.style.width = el.style.width;
        mel.style.height = el.style.height;
        mel.classList.toggle('stale', stale);
        rec.m.setLngLat([it.c.lon, it.c.lat]).setOffset(offset).setDraggable(!!it.own);
        rec.key = key;
        rec.it = it;
        continue;
      }
      // Symbole stehen aufrecht zur Kamera (wie in WinTAK), sitzen aber auf dem Gelände
      // Symbole stehen aufrecht und bleiben immer voll sichtbar (wie WinTAK). MapLibre würde Marker, deren
      // Bodenpunkt vom Gelände verdeckt ist, auf 20 % abdunkeln – bei starker Neigung fast alle.
      const m = new lib.Marker({ element: el, offset, draggable: !!it.own, pitchAlignment: 'viewport', rotationAlignment: 'viewport', opacity: '1', opacityWhenCovered: '1' })
        .setLngLat([it.c.lon, it.c.lat]).addTo(ml);
      rec = { m, key, it };
      el.addEventListener('click', e => {
        e.stopPropagation();
        clickedMarker = Date.now();
        openPopup(rec.it, m.getLngLat());
      });
      m.on('dragend', () => { const ll = m.getLngLat(); updateOwn(rec.it, { lat: ll.lat, lon: ll.lng }); });
      marks.set(it.uid, rec);
    }
    for (const [uid, rec] of marks) if (!seen.has(uid)) { rec.m.remove(); marks.delete(uid); }
    ml.getSource('shapes').setData({ type: 'FeatureCollection', features: shapes });
  }

  function syncSelf() {
    if (!me) { if (selfMark) { selfMark.remove(); selfMark = null; } return; }
    const col = TEAMS[profile.team] || '#00FFFF';
    if (!selfMark) {
      const el = document.createElement('div');
      el.className = 'm3d-self';
      el.innerHTML = `<svg width="34" height="34" viewBox="0 0 32 32"><path d="M16 2 L28 29 L16 22 L4 29 Z" fill="#007bff" stroke="${col}" stroke-width="2" stroke-linejoin="round"/></svg>`;
      // Eigener Pfeil liegt flach im Gelände und zeigt in die Bewegungs-/Blickrichtung
      selfMark = new lib.Marker({ element: el, pitchAlignment: 'map', rotationAlignment: 'map', opacityWhenCovered: '1' }).setLngLat([me.lon, me.lat]).addTo(ml);
    }
    const rot = Number.isFinite(me.course) && me.speed > 0.5 ? me.course : (compassMode === 'heading' && heading != null ? heading : 0);
    selfMark.setLngLat([me.lon, me.lat]).setRotation(rot);
  }

  function syncOverlays() {
    const api = window.eud.overlayApi;
    const data = api && api.for3d ? api.for3d() : { features: [], points: [], images: [] };
    ml.getSource('ovl').setData({ type: 'FeatureCollection', features: data.features });
    while (ovMarks.length) ovMarks.pop().remove();
    for (const p of data.points.slice(0, 500)) {
      const el = document.createElement('div');
      el.className = 'cot-icon m3d ov3d';
      el.innerHTML = (p.icon ? `<img src="${esc(p.icon)}" width="24" height="24" alt="">` : `<span class="dot" style="background:${esc(p.color || '#ffd400')}"></span>`)
        + (p.name ? `<span class="lbl" style="top:24px">${esc(p.name)}</span>` : '');
      ovMarks.push(new lib.Marker({ element: el, pitchAlignment: 'viewport', rotationAlignment: 'viewport', opacityWhenCovered: '1' }).setLngLat([p.lon, p.lat]).addTo(ml));
    }
    for (const id of images) { if (ml.getLayer(id)) ml.removeLayer(id); if (ml.getSource(id)) ml.removeSource(id); }
    images = [];
    data.images.slice(0, 60).forEach((g, i) => {
      const id = 'img' + i;
      const [[s, w], [n, e]] = g.bounds;
      ml.addSource(id, { type: 'image', url: g.url, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
      ml.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': 0.9, 'raster-fade-duration': 0 } }, 'ovl-fill');
      images.push(id);
    });
  }

  function syncAll(withOverlays) {
    if (!ml || !active) return;
    syncItems();
    syncSelf();
    if (withOverlays) syncOverlays();
  }

  // ---------------- Öffentliche Schnittstelle ----------------

  window.view3d = {
    supported,
    get active() { return active; },
    northAngle() { return active && ml ? (((-ml.getBearing()) % 360) + 360) % 360 : 0; },
    async show(p) {
      try {
        await init();
      } catch (e) {
        toast('3D map could not be loaded – using the flat map.');
        profile.map3d = false;
        saveProfile();
        setPitch(p);
        return;
      }
      if (!active) {
        active = true;
        fromLeaflet(false);
        $('map3d').classList.remove('hidden');
        $('map').classList.add('behind3d');
        map.closePopup();
        ml.resize();
        syncAll(true);
      }
      syncing = true;
      ml.easeTo({ pitch: p, duration: 250 });
      syncing = false;
      updateCompass();
    },
    hide() {
      if (!active) return;
      toLeaflet();
      active = false;
      if (popup) { popup.remove(); popup = null; }
      $('map3d').classList.add('hidden');
      $('map').classList.remove('behind3d');
      map.invalidateSize({ animate: false });
      updateCompass();
    },
    // Änderungen sammeln und gebündelt zeichnen
    dirty() {
      if (!active || timer) return;
      timer = setTimeout(() => { timer = null; syncAll(false); }, 150);
    },
    dirtyOverlays() { if (active && ml) setTimeout(syncOverlays, 50); },
    baseChanged() {
      if (!ml) return;
      demErrors = 0;
      ml.setStyle(style(), { diff: false });
      ml.once('styledata', () => { images = []; syncAll(true); });
    },
    focus(it, pos) {
      if (!ml) return;
      ml.easeTo({ center: [pos.lon, pos.lat], zoom: Math.max(ml.getZoom(), 14), duration: 600 });
      if (isPoint(it.c)) ml.once('moveend', () => openPopup(it, [pos.lon, pos.lat]));
    },
    map: () => ml,
  };
})();
