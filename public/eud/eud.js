// TAK-EUD im Browser: Karte + Lagebild von einem oder mehreren TAK-Servern (CoT), eigene Position,
// Marker, Chat. Der eigene Server reicht nur durch (WebSocket /ws/tak); Zertifikate bleiben auf diesem Gerät.
'use strict';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* Speicher voll / privat */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* egal */ } },
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xmlEsc = esc;
const cotTime = d => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
const rnd = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');

const TEAMS = {
  White: '#FFFFFF', Yellow: '#FFFF00', Orange: '#FF7700', Magenta: '#FF00FF', Red: '#FF0000', Maroon: '#7F0000',
  Purple: '#7F007F', 'Dark Blue': '#00007F', Blue: '#0000FF', Cyan: '#00FFFF', Teal: '#007F7F', Green: '#00FF00',
  'Dark Green': '#007F00', Brown: '#A0714F',
};
const ROLES = ['Team Member', 'Team Lead', 'HQ', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9'];
const DEFAULT_PORT = { ssl: 8089, tcp: 8087, udp: 8087 };

// ======================================================================
// Profil und Serverliste (nur auf diesem Gerät)
// ======================================================================

const profile = Object.assign({
  callsign: '', team: 'Cyan', role: 'Team Member', uid: '', tiles: 'OSM', wake: false,
}, store.get('eud.profile', {}));
if (!profile.uid) profile.uid = 'EUD-' + rnd(6).toUpperCase();

let servers = store.get('eud.servers', null);
if (!servers) {
  // Ältere Version: ein Server im Profil
  servers = [];
  if (profile.host) {
    servers.push({
      id: rnd(4), name: profile.host, host: profile.host, port: profile.port, proto: profile.proto, enrollPort: profile.enrollPort,
      username: profile.username, certPem: profile.certPem, keyPem: profile.keyPem, caPems: profile.caPems || [],
      fingerprint: profile.fingerprint, certInfo: profile.certInfo, auto: !!profile.auto,
    });
  }
  for (const k of ['host', 'port', 'proto', 'enrollPort', 'username', 'certPem', 'keyPem', 'caPems', 'fingerprint', 'certInfo', 'auto']) delete profile[k];
}
const saveProfile = () => store.set('eud.profile', profile);
const saveServers = () => store.set('eud.servers', servers);
saveProfile();
saveServers();

function newServer(fields) {
  return Object.assign({
    id: rnd(4), name: '', host: '', port: 8089, proto: 'ssl', enrollPort: 8446, apiPort: 8443, username: '',
    certPem: '', keyPem: '', caPems: [], fingerprint: '', certInfo: null, auto: false,
  }, fields || {});
}

// ======================================================================
// Karte
// ======================================================================

const view = store.get('eud.view', [51.1, 10.4, 6]);
// Drehbare Karte (leaflet-rotate): Kompass schaltet zwischen Nord oben und Blickrichtung oben
const map = L.map('map', {
  zoomControl: false, attributionControl: true, worldCopyJump: true,
  rotate: true, bearing: 0, touchRotate: false, shiftKeyRotate: false, rotateControl: false, compassBearing: false,
}).setView([view[0], view[1]], view[2]);
map.attributionControl.setPosition('bottomleft');
// Kartenquellen: über den eigenen Server (gleiche Herkunft, dort zwischengespeichert) oder eigene URL
const SOURCES = {
  osm: { name: 'OpenStreetMap', maxZoom: 19, attribution: '© OpenStreetMap' },
  topo: { name: 'OpenTopoMap', maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' },
  sat: { name: 'Esri Satellite', maxZoom: 19, attribution: '© Esri' },
  esritopo: { name: 'Esri Topo', maxZoom: 19, attribution: '© Esri' },
};
const TILE_BASE = new URL('tiles/', location.href).pathname; // /eud/tiles/
if (!SOURCES[profile.tiles] && profile.tiles !== 'custom') profile.tiles = 'osm';

function sourceTemplate(id) {
  if (id === 'custom') return profile.customUrl || '';
  return TILE_BASE + id + '/{z}/{x}/{y}.png';
}
function sourceMaxZoom(id) { return id === 'custom' ? 20 : SOURCES[id].maxZoom; }

let baseLayer = null;
function setTiles(id) {
  if (id === 'custom' && !profile.customUrl) return;
  if (baseLayer) baseLayer.remove();
  baseLayer = L.tileLayer(sourceTemplate(id), {
    maxZoom: sourceMaxZoom(id), maxNativeZoom: sourceMaxZoom(id),
    attribution: id === 'custom' ? '' : SOURCES[id].attribution, keepBuffer: 4,
  });
  // Kachel nicht geladen (z. B. kurz kein Netz): einmal nachladen statt halb leerer Karte
  baseLayer.on('tileerror', e => {
    const img = e.tile;
    if (img.dataset.retry) return;
    img.dataset.retry = '1';
    setTimeout(() => { img.src = img.src.replace(/([?&])r=\d+|$/, m => (m ? m[0] : (img.src.includes('?') ? '&' : '?')) + 'r=' + Date.now()); }, 1500);
  });
  baseLayer.addTo(map);
  profile.tiles = id;
  saveProfile();
}
setTiles(profile.tiles);
map.on('moveend', () => { const c = map.getCenter(); store.set('eud.view', [c.lat, c.lng, map.getZoom()]); });
const shapesLayer = L.layerGroup().addTo(map);
const pointsLayer = L.layerGroup().addTo(map);

// ======================================================================
// Hilfen
// ======================================================================

let toastTimer;
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function setMsg(el, text, ok) {
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}

function distance(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lon - a.lon) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const fmtDist = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return Math.max(s, 0) + ' s ago';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(ts).toLocaleString();
}
const hhmm = d => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// ARGB-Zahl aus ATAK (-1 = weiß) -> CSS-Farbe
function argb(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v) >>> 0;
  const a = ((n >>> 24) & 255) / 255;
  return `rgba(${(n >>> 16) & 255},${(n >>> 8) & 255},${n & 255},${a.toFixed(2)})`;
}

// CoT-Typ -> Symbolcode (MIL-STD-2525C) für milsymbol
function sidcFor(type) {
  const p = type.split('-');
  if (p[0] !== 'a' || p.length < 3) return null;
  const aff = ({ f: 'F', h: 'H', n: 'N', u: 'U', a: 'A', s: 'S', j: 'J', k: 'K', p: 'P' })[p[1]] || 'U';
  const dim = ({ P: 'P', A: 'A', G: 'G', S: 'S', U: 'U', F: 'F', X: 'X' })[p[2]] || 'G';
  const fn = p.slice(3).join('').slice(0, 6).padEnd(6, '-');
  return 'S' + aff + dim + 'P' + fn + '-----';
}
const AFF_NAMES = { f: 'Friendly', h: 'Hostile', n: 'Neutral', u: 'Unknown', a: 'Assumed friend', s: 'Suspect', p: 'Pending' };

const symCache = new Map();
function symbolSvg(sidc, size = 26) {
  const key = sidc + size;
  if (!symCache.has(key)) {
    let s = null;
    try { s = new ms.Symbol(sidc, { size }); if (!s.isValid()) s = null; } catch (e) { s = null; }
    if (!s) s = new ms.Symbol(sidc.slice(0, 4) + '-----------', { size });
    symCache.set(key, { svg: s.asSVG(), w: s.getSize().width, h: s.getSize().height, a: s.getAnchor() });
  }
  return symCache.get(key);
}

// ======================================================================
// Statusleiste: Uhr, Akku, Rufname
// ======================================================================

let battery = null;
// Akku nur für die eigene Position (ATAK zeigt ihn beim Kontakt)
if (navigator.getBattery) navigator.getBattery().then(b => {
  const upd = () => { battery = Math.round(b.level * 100); };
  upd();
  b.addEventListener('levelchange', upd);
}).catch(() => {});

function showMe() {
  document.title = profile.callsign ? `TAK EUD – ${profile.callsign}` : 'TAK EUD';
}

// ======================================================================
// Menü und Fenster
// ======================================================================

const TITLES = { server: 'Servers', edit: 'Server', me: 'Callsign', video: 'Video stream', contacts: 'Contacts', map: 'Map', data: 'TAK Data' };
let popupSec = null;
// Wie ATAK: immer nur ein Sheet unten offen
function closeSheets(except) {
  if (except !== 'sidebar') closeSidebar();
  if (except !== 'popup') closePopup();
  if (except !== 'chat' && typeof closeChat === 'function') closeChat();
  if (except !== 'markers' && profile.showTools && typeof showTools === 'function') showTools(false);
}

function openPopup(sec, title) {
  closeSheets('popup');
  popupSec = sec;
  for (const s of document.querySelectorAll('.mbody section')) s.classList.toggle('on', s.dataset.sec === sec);
  $('popupTitle').textContent = title || TITLES[sec] || '';
  $('popup').classList.remove('hidden');
  if (sec === 'server') renderServers();
  if (sec === 'contacts') renderList();
  if (sec === 'me') fillMe();
  if (sec === 'map') fillMap();
  document.dispatchEvent(new CustomEvent('eud-popup', { detail: sec }));
}
function closePopup() {
  $('popup').classList.add('hidden');
  popupSec = null;
}
for (const b of document.querySelectorAll('[data-pclose]')) b.addEventListener('click', closePopup);

function openSidebar() { closeSheets('sidebar'); $('sidebar').classList.remove('hidden'); }
function closeSidebar() { $('sidebar').classList.add('hidden'); }
for (const b of document.querySelectorAll('[data-sbclose]')) b.addEventListener('click', closeSidebar);
$('btnMenu').addEventListener('click', () => ($('sidebar').classList.contains('hidden') ? openSidebar() : closeSidebar()));
$('btnLayers').addEventListener('click', () => (popupSec === 'map' ? closePopup() : openPopup('map')));
for (const t of document.querySelectorAll('[data-open]')) {
  t.addEventListener('click', () => {
    const o = t.dataset.open;
    if (o === 'chat') return openChat();
    if (o === 'overlays' || o === 'sync' || o === 'data') {
      openPopup('data', { overlays: 'Overlay Manager', sync: 'Data Sync', data: 'Data Packages' }[o]);
      const tab = document.querySelector(`#dataTabs [data-tab="${o === 'data' ? 'packages' : o}"]`);
      if (tab) tab.click();
      return;
    }
    openPopup(o);
  });
}
$('connBtn').addEventListener('click', () => openPopup('server'));

// ======================================================================
// Lagebild: CoT empfangen und zeichnen
// ======================================================================

const items = new Map(); // uid -> { uid, c, xml, layer, own, stale }
let chat = store.get('eud.chat', []);
let unread = 0;
let me = null; // eigene Position

function parseCot(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const ev = doc.documentElement;
  if (!ev || ev.nodeName !== 'event' || doc.getElementsByTagName('parsererror').length) return null;
  const pt = ev.querySelector(':scope > point');
  const detail = ev.querySelector(':scope > detail');
  const q = sel => (detail ? detail.querySelector(sel) : null);
  const attr = (sel, a) => { const n = q(sel); return n ? n.getAttribute(a) : null; };
  const links = detail ? [...detail.querySelectorAll(':scope > link')] : [];
  return {
    uid: ev.getAttribute('uid') || '',
    type: ev.getAttribute('type') || '',
    time: Date.parse(ev.getAttribute('time')) || Date.now(),
    stale: Date.parse(ev.getAttribute('stale')) || Date.now() + 120000,
    lat: pt ? Number(pt.getAttribute('lat')) : NaN,
    lon: pt ? Number(pt.getAttribute('lon')) : NaN,
    hae: pt ? Number(pt.getAttribute('hae')) : NaN,
    callsign: attr('contact', 'callsign'),
    team: attr('__group', 'name'),
    role: attr('__group', 'role'),
    course: Number(attr('track', 'course')),
    speed: Number(attr('track', 'speed')),
    battery: attr('status', 'battery'),
    remarks: q('remarks') ? q('remarks').textContent : '',
    color: attr('color', 'argb') || attr('color', 'value'),
    stroke: attr('strokeColor', 'value'),
    fill: attr('fillColor', 'value'),
    weight: Number(attr('strokeWeight', 'value')) || 3,
    ellipse: q('shape > ellipse'),
    video: attr('__video', 'url'),
    videoEntry: q('__video ConnectionEntry'),
    linkPoints: links.map(l => l.getAttribute('point')).filter(Boolean).map(s => s.split(',').map(Number)).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1])),
    links: links.map(l => ({ uid: l.getAttribute('uid'), relation: l.getAttribute('relation'), type: l.getAttribute('type') })),
    chat: q('__chat'),
    detail,
  };
}

function videoUrl(c) {
  if (c.videoEntry) {
    const e = c.videoEntry;
    const proto = e.getAttribute('protocol') || 'rtsp';
    const addr = e.getAttribute('address') || '';
    const port = e.getAttribute('port');
    const p = e.getAttribute('path') || '';
    if (/^https?:\/\//i.test(addr)) return addr;
    if (addr) return `${proto}://${addr}${port && port !== '-1' ? ':' + port : ''}${p.startsWith('/') || !p ? p : '/' + p}`;
  }
  return c.video || '';
}

// Video-Link für den Browser: eigene Streams (…/stream.ts) als Vollbild-Seite öffnen
function browserVideoUrl(u) {
  try {
    const url = new URL(u);
    if (url.origin === location.origin) url.pathname = url.pathname.replace(/\/(stream\.ts|index\.m3u8|snapshot\.jpg)$/, '');
    return url.href;
  } catch (e) { return u; }
}

function iconFor(c, stale) {
  const label = `<span class="lbl" style="top:{T}px">${esc(c.callsign || '')}</span>`;
  const cls = 'cot-icon' + (stale ? ' stale' : '');
  if (c.type.startsWith('a-') && c.team) {
    // ATAK-Nutzer: Kreis in Teamfarbe mit Kurz-Rufname, Pfeil für die Richtung
    const col = TEAMS[c.team] || '#00FFFF';
    const light = ['White', 'Yellow', 'Cyan', 'Green', 'Orange', 'Magenta'].includes(c.team);
    const short = esc((c.callsign || '?').slice(0, 4));
    const arrow = Number.isFinite(c.course) && c.speed > 0.5
      ? `<path d="M16 0 L21 7 L11 7 Z" fill="${col}" stroke="#000" stroke-width="1" transform="rotate(${c.course + northAngle()} 16 16)"/>` : '';
    const html = `<svg width="32" height="32" viewBox="0 0 32 32">${arrow}<circle cx="16" cy="16" r="11" fill="${col}" stroke="#333" stroke-width="1.5"/>`
      + `<text x="16" y="16" font-size="8" font-family="Courier New, monospace" font-weight="bold" fill="${light ? '#1a1a1a' : '#fff'}" text-anchor="middle" dominant-baseline="central">${short}</text></svg>${label.replace('{T}', 32)}`;
    return L.divIcon({ className: cls, html, iconSize: [32, 32], iconAnchor: [16, 16], popupAnchor: [0, -14] });
  }
  const sidc = sidcFor(c.type);
  if (sidc) {
    const s = symbolSvg(sidc);
    return L.divIcon({ className: cls, html: s.svg + label.replace('{T}', Math.round(s.h)), iconSize: [s.w, s.h], iconAnchor: [s.a.x, s.a.y], popupAnchor: [0, -s.a.y] });
  }
  const col = argb(c.color, c.type.startsWith('b-m-p-s-p-i') ? '#ff3030' : '#ffd400');
  const html = `<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="${col}" stroke="#000" stroke-width="2"/></svg>${label.replace('{T}', 20)}`;
  return L.divIcon({ className: cls, html, iconSize: [20, 20], iconAnchor: [10, 10], popupAnchor: [0, -8] });
}

function popupHtml(it) {
  const c = it.c;
  const rows = [];
  const kind = c.type.startsWith('a-')
    ? (AFF_NAMES[c.type.split('-')[1]] || 'Object') + (c.team ? ` · ${esc(c.team)} · ${esc(c.role || '')}` : '')
    : c.type.startsWith('b-m-p') ? 'Point' : c.type.startsWith('u-d') ? 'Drawing' : c.type.startsWith('b-m-r') ? 'Route' : esc(c.type);
  rows.push(`<div class="t">${esc(c.callsign || c.uid)}</div><div class="k">${kind}</div>`);
  if (Number.isFinite(c.lat)) rows.push(`<div>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}${Number.isFinite(c.hae) && c.hae < 9e6 ? ` · ${Math.round(c.hae)} m` : ''}</div>`);
  if (me && Number.isFinite(c.lat)) rows.push(`<div class="k">${fmtDist(distance(me, c))} · ${Math.round(bearing(me, c))}°</div>`);
  if (c.speed > 0.5) rows.push(`<div class="k">${(c.speed * 3.6).toFixed(0)} km/h</div>`);
  if (c.battery) rows.push(`<div class="k">Battery ${esc(c.battery)} %</div>`);
  rows.push(`<div class="k">${ago(c.time)}${Date.now() > c.stale ? ' · stale' : ''}</div>`);
  if (c.remarks) rows.push(`<div>${esc(c.remarks)}</div>`);
  const v = videoUrl(c);
  if (v) rows.push(`<button type="button" class="play" data-play="${esc(v)}" data-name="${esc(c.callsign || c.uid)}">▶ VIDEO</button>`);
  if (it.own) rows.push(`<button type="button" class="play" data-ren="${esc(c.uid)}">RENAME</button> <button type="button" data-del="${esc(c.uid)}">DELETE</button>`);
  if (it.own && isPoint(c)) rows.push('<div class="k">Drag the marker to move it.</div>');
  return rows.join('');
}

const isPoint = c => !(c.linkPoints.length >= 2 && (c.type.startsWith('u-d') || c.type.startsWith('b-m-r'))) && c.type !== 'u-d-c-c';

// Eigenen Marker ändern (Position und/oder Name) und an alle Server senden
function updateOwn(it, { lat, lon, name }) {
  const doc = new DOMParser().parseFromString(it.xml, 'application/xml');
  const ev = doc.documentElement;
  const now = new Date();
  ev.setAttribute('time', cotTime(now));
  ev.setAttribute('start', cotTime(now));
  if (Date.parse(ev.getAttribute('stale')) < +now + 86400000) ev.setAttribute('stale', cotTime(new Date(+now + 30 * 86400000)));
  ev.setAttribute('how', 'h-g-i-g-o');
  if (lat != null) {
    const pt = ev.querySelector(':scope > point');
    pt.setAttribute('lat', lat.toFixed(7));
    pt.setAttribute('lon', lon.toFixed(7));
  }
  if (name != null) {
    let detail = ev.querySelector(':scope > detail');
    if (!detail) { detail = doc.createElement('detail'); ev.append(detail); }
    let contact = detail.querySelector(':scope > contact');
    if (!contact) { contact = doc.createElement('contact'); detail.prepend(contact); }
    contact.setAttribute('callsign', name);
  }
  const xml = new XMLSerializer().serializeToString(ev);
  handleCot(xml, { own: true, local: true });
  persistSoon();
  const sent = sendCot(xml, true);
  toast((name != null ? 'Renamed' : 'Moved') + (sent ? ' – sent.' : ' – will be sent once connected.'));
}

function removeItem(uid) {
  const it = items.get(uid);
  if (!it) return;
  if (it.layer) it.layer.remove();
  items.delete(uid);
  persistSoon();
}

function drawItem(it) {
  const c = it.c;
  const stale = Date.now() > c.stale;
  if (it.layer) it.layer.remove();
  it.layer = null;
  const stroke = argb(c.stroke, '#ffd400');
  const fill = argb(c.fill, 'rgba(0,0,0,0)');
  const style = { color: stroke, weight: Math.min(c.weight, 8), fillColor: fill, fillOpacity: c.fill ? 1 : 0, opacity: stale ? 0.45 : 1 };
  if (c.type === 'u-d-c-c' && c.ellipse && Number.isFinite(c.lat)) {
    const r = Number(c.ellipse.getAttribute('major')) || Number(c.ellipse.getAttribute('minor')) || 0;
    it.layer = L.circle([c.lat, c.lon], { radius: r, ...style }).addTo(shapesLayer);
  } else if (c.linkPoints.length >= 2 && (c.type.startsWith('u-d') || c.type.startsWith('b-m-r'))) {
    const pts = c.linkPoints.map(p => [p[0], p[1]]);
    const closed = c.type === 'u-d-r' || c.type === 'u-d-f-c' || (c.detail && c.detail.querySelector('closed[value="true"]'))
      || (pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]);
    it.layer = (closed ? L.polygon(pts, style) : L.polyline(pts, { ...style, fill: false })).addTo(shapesLayer);
  } else if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && !(c.lat === 0 && c.lon === 0)) {
    // Eigene Marker lassen sich verschieben (Drag & Drop), Änderung geht wie bei ATAK mit gleicher UID raus
    it.layer = L.marker([c.lat, c.lon], { icon: iconFor(c, stale), zIndexOffset: c.team ? 500 : 0, draggable: !!it.own, autoPan: true }).addTo(pointsLayer);
    if (it.own) it.layer.on('dragend', e => { const ll = e.target.getLatLng(); updateOwn(it, { lat: ll.lat, lon: ll.lng }); });
  }
  if (it.layer) it.layer.bindPopup(() => popupHtml(it), { maxWidth: 260 });
  it.stale = stale;
}

function handleCot(xml, { local = false, own = false, srv = null } = {}) {
  const c = parseCot(xml);
  if (!c || !c.uid) return;
  if (c.type.startsWith('t-x-c-t')) return; // Ping/Pong
  if (c.type === 't-x-d-d') {
    for (const l of c.links) if (l.uid) removeItem(l.uid);
    return;
  }
  if (c.type === 'b-t-f') return receiveChat(c, local);
  // Vom TAK-Server geschickt (wie bei ATAK automatisch übernehmen): Datei/Paket, Missions-Einladung, Missions-Änderung
  if (c.type === 'b-f-t-r') { if (!local) document.dispatchEvent(new CustomEvent('eud-file-push', { detail: { xml, srv } })); return; }
  if (c.type === 't-x-m-i') { if (!local) document.dispatchEvent(new CustomEvent('eud-mission-invite', { detail: { xml, srv } })); return; }
  if (c.type.startsWith('t-x-m-')) { document.dispatchEvent(new CustomEvent('eud-mission-change', { detail: { xml, srv } })); return; }
  if (c.uid === profile.uid) return; // eigenes Echo
  const prev = items.get(c.uid);
  if (prev && prev.c.time > c.time && !local) return; // älter als bekannt (z. B. über zweiten Server)
  const it = prev || { uid: c.uid };
  it.c = c;
  it.xml = xml;
  it.own = own || (prev && prev.own) || c.links.some(l => l.uid === profile.uid && l.relation === 'p-p');
  items.set(c.uid, it);
  drawItem(it);
  if (!local) persistSoon();
  if (popupSec === 'contacts') renderList();
}

// Lagebild auf dem Gerät halten (für Start ohne Netz)
let persistTimer;
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const keep = [...items.values()].sort((a, b) => b.c.time - a.c.time).slice(0, 800)
      .map(it => ({ xml: it.xml, own: !!it.own }));
    store.set('eud.picture', keep);
  }, 1500);
}

function loadPicture() {
  for (const e of store.get('eud.picture', [])) handleCot(e.xml, { local: true, own: e.own });
}

// Veraltete Kontakte blasser, sehr alte entfernen
setInterval(() => {
  const now = Date.now();
  for (const it of [...items.values()]) {
    const tooOld = it.c.team ? now - it.c.stale > 3600000 : now - it.c.stale > 24 * 3600000;
    if (tooOld) { removeItem(it.uid); continue; }
    if ((now > it.c.stale) !== it.stale) drawItem(it);
  }
}, 15000);

// ======================================================================
// Chat (GeoChat, „All Chat Rooms“)
// ======================================================================

function receiveChat(c, local) {
  const ch = c.chat;
  const room = ch ? ch.getAttribute('chatroom') || ch.getAttribute('id') || '' : '';
  const sender = ch ? ch.getAttribute('senderCallsign') || '' : c.callsign || '';
  if (chat.some(m => m.id === c.uid)) return;
  const toMe = ch && (ch.getAttribute('id') === profile.uid || room === profile.callsign);
  const fromMe = c.uid.startsWith('GeoChat.' + profile.uid + '.');
  chat.push({ id: c.uid, from: sender, room: toMe ? 'Direkt' : room, text: c.remarks, time: c.time, me: fromMe });
  chat = chat.slice(-200);
  store.set('eud.chat', chat);
  if (!local && !fromMe && $('chatWin').classList.contains('hidden')) {
    unread++;
    updateBadge();
    toast(`${sender}: ${c.remarks}`);
  }
  renderChat();
}

function updateBadge() {
  $('chatBadge').textContent = unread;
  $('chatBadge').classList.toggle('hidden', !unread);
}

function renderChat() {
  const log = $('chatLog');
  log.textContent = '';
  if (!chat.length) {
    const e = document.createElement('div');
    e.className = 'chat-empty';
    e.textContent = 'No messages';
    log.append(e);
  }
  for (const m of chat) {
    const d = document.createElement('div');
    d.className = 'cm ' + (m.me ? 'out' : 'in');
    const h = document.createElement('div');
    h.className = 'cm-h';
    const who = document.createElement('b');
    who.textContent = m.from + (m.room && m.room !== 'All Chat Rooms' ? ' → ' + m.room : '');
    const time = document.createElement('span');
    time.textContent = hhmm(new Date(m.time));
    h.append(who, time);
    const txt = document.createElement('div');
    txt.className = 'cm-t';
    txt.textContent = m.text;
    d.append(h, txt);
    log.append(d);
  }
  log.scrollTop = log.scrollHeight;
}

function chatXml(text) {
  const now = new Date();
  const id = rnd(8);
  const room = 'All Chat Rooms';
  const call = xmlEsc(profile.callsign || profile.uid);
  const p = me || { lat: 0, lon: 0 };
  return `<event version="2.0" uid="GeoChat.${xmlEsc(profile.uid)}.${room}.${id}" type="b-t-f" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 86400000))}">`
    + `<point lat="${p.lat}" lon="${p.lon}" hae="9999999" ce="9999999" le="9999999"/><detail>`
    + `<__chat parent="RootContactGroup" groupOwner="false" messageId="${id}" chatroom="${room}" id="${room}" senderCallsign="${call}">`
    + `<chatgrp uid0="${xmlEsc(profile.uid)}" uid1="${room}" id="${room}"/></__chat>`
    + `<link uid="${xmlEsc(profile.uid)}" type="a-f-G-U-C" relation="p-p"/>`
    + `<remarks source="BAO.F.ATAK.${xmlEsc(profile.uid)}" to="${room}" time="${cotTime(now)}">${xmlEsc(text)}</remarks>`
    + `<__serverdestination destinations="0.0.0.0:4242:tcp:${xmlEsc(profile.uid)}"/></detail></event>`;
}

function openChat() {
  closeSheets('chat');
  unread = 0;
  updateBadge();
  renderChat();
  $('chatWin').classList.remove('hidden', 'min');
  $('btnChat').classList.add('active');
}
function closeChat() {
  $('chatWin').classList.add('hidden');
  $('btnChat').classList.remove('active');
}
$('btnChat').addEventListener('click', () => ($('chatWin').classList.contains('hidden') ? openChat() : closeChat()));
$('chatClose').addEventListener('click', closeChat);
$('chatMin').addEventListener('click', e => { e.stopPropagation(); $('chatWin').classList.toggle('min'); });
document.querySelector('.chat-head').addEventListener('click', e => { if (e.target.closest('button')) return; $('chatWin').classList.remove('min'); });
$('chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('chatIn').value.trim();
  if (!text) return;
  const xml = chatXml(text);
  handleCot(xml, { local: true });
  sendCot(xml, true);
  $('chatIn').value = '';
});

// ======================================================================
// Verbindungen zu den TAK-Servern (je Server ein WebSocket zur Durchreiche)
// ======================================================================

const conns = new Map(); // server.id -> { ws, retry, timer, state, message }
let outbox = store.get('eud.outbox2', {}); // server.id -> [xml]

function connOf(srv) {
  if (!conns.has(srv.id)) conns.set(srv.id, { ws: null, retry: 0, timer: null, state: 'idle', message: '' });
  return conns.get(srv.id);
}
const isOpen = c => c && c.ws && c.ws.readyState === 1;

function updateStatus() {
  const active = servers.filter(s => s.auto);
  const ok = active.filter(s => connOf(s).state === 'connected').length;
  const anyErr = active.some(s => ['error', 'untrusted'].includes(connOf(s).state));
  // Kopfzeile: grün = alle verbunden, orange = nur ein Teil, rot = offline/getrennt/Fehler
  let kind = '', text = 'OFFLINE';
  if (!servers.length) text = 'SETUP';
  else if (!active.length) text = 'DISCONNECTED';
  else if (!navigator.onLine) text = 'OFFLINE';
  else if (ok === active.length) { kind = 'ok'; text = active.length > 1 ? `ONLINE ${ok}/${active.length}` : 'ONLINE'; }
  else if (ok) { kind = 'warn'; text = `ONLINE ${ok}/${active.length}`; }
  else if (anyErr) text = 'ERROR';
  else text = 'CONNECTING';
  $('dot').className = 'dot ' + kind;
  $('connBtn').className = kind;
  $('statusText').textContent = text;
  $('connBtn').title = 'Servers: ' + text;
  if (popupSec === 'server') renderServers();
}

// An alle verbundenen Server senden; wer gerade nicht verbunden ist, bekommt es später (queue)
function sendCot(xml, queue) {
  let sent = false;
  for (const srv of servers.filter(s => s.auto)) {
    const c = connOf(srv);
    if (isOpen(c)) {
      c.ws.send(JSON.stringify({ type: 'cot', xml }));
      sent = true;
    } else if (queue) {
      outbox[srv.id] = (outbox[srv.id] || []).concat(xml).slice(-100);
    }
  }
  if (queue) store.set('eud.outbox2', outbox);
  return sent;
}

function flushOutbox(srv) {
  const c = connOf(srv);
  const list = outbox[srv.id] || [];
  while (list.length && isOpen(c)) c.ws.send(JSON.stringify({ type: 'cot', xml: list.shift() }));
  outbox[srv.id] = list;
  store.set('eud.outbox2', outbox);
}

function openConn(srv) {
  const c = connOf(srv);
  clearTimeout(c.timer);
  if (!srv.auto || !srv.host) return updateStatus();
  if (c.ws && (c.ws.readyState === 0 || c.ws.readyState === 1)) return;
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/tak');
  c.ws = sock;
  c.state = 'connecting';
  c.message = '';
  updateStatus();
  sock.onopen = () => {
    c.retry = 0;
    sock.send(JSON.stringify({
      type: 'connect', host: srv.host, port: srv.port, proto: srv.proto, uid: profile.uid, callsign: profile.callsign,
      certPem: srv.proto === 'ssl' ? srv.certPem : '', keyPem: srv.proto === 'ssl' ? srv.keyPem : '',
      caPems: srv.caPems, fingerprint: srv.fingerprint,
    }));
    flushOutbox(srv); // die Durchreiche puffert, bis der TAK-Server verbunden ist
    sendSelfTo(srv);
  };
  sock.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'cot') return handleCot(msg.xml, { srv });
    if (msg.type !== 'status') return;
    const was = c.state;
    c.state = msg.state;
    c.message = msg.message || '';
    if (msg.state === 'connected' && was !== 'connected') { toast('Connected: ' + (srv.name || srv.host)); sendSelfTo(srv); }
    if (msg.state === 'untrusted') {
      askTrust(`${srv.host}:${srv.port}`, msg.fingerprint, msg.subject).then(ok => {
        if (!ok) return disconnectServer(srv);
        srv.fingerprint = msg.fingerprint;
        saveServers();
        reconnect(srv);
      });
    }
    updateStatus();
  };
  sock.onclose = () => {
    if (c.ws !== sock) return;
    c.ws = null;
    if (c.state !== 'error' && c.state !== 'untrusted') c.state = 'offline';
    updateStatus();
    if (srv.auto) c.timer = setTimeout(() => openConn(srv), Math.min(30000, 1000 * 2 ** c.retry++));
  };
  sock.onerror = () => {};
}

function closeSock(srv) {
  const c = connOf(srv);
  clearTimeout(c.timer);
  if (c.ws) {
    try { c.ws.send(JSON.stringify({ type: 'disconnect' })); } catch (e) { /* egal */ }
    const s = c.ws;
    c.ws = null;
    s.onclose = null;
    s.close();
  }
  c.state = 'idle';
  c.message = '';
}

function reconnect(srv) {
  closeSock(srv);
  connOf(srv).retry = 0;
  openConn(srv);
}

function connectServer(srv) {
  srv.auto = true;
  saveServers();
  reconnect(srv);
}

function disconnectServer(srv) {
  srv.auto = false;
  saveServers();
  closeSock(srv);
  updateStatus();
}

function removeServer(srv) {
  closeSock(srv);
  conns.delete(srv.id);
  delete outbox[srv.id];
  store.set('eud.outbox2', outbox);
  servers = servers.filter(s => s !== srv);
  saveServers();
  updateStatus();
}

function reconnectAll() {
  for (const srv of servers) { connOf(srv).retry = 0; openConn(srv); }
}
window.addEventListener('online', reconnectAll);
window.addEventListener('offline', updateStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { reconnectAll(); sendSelf(); if (profile.wake) wakeLock(); }
});

// ======================================================================
// Eigene Position (SA)
// ======================================================================

let meMarker = null, meCircle = null, follow = true, lastSent = 0, sentAt = null;

function selfXml() {
  const now = new Date();
  const p = me;
  const course = Number.isFinite(p.course) ? p.course : 0;
  const speed = Number.isFinite(p.speed) ? p.speed : 0;
  const video = window.eudVideoUrl ? `<__video url="${xmlEsc(window.eudVideoUrl)}"/>` : '';
  return `<event version="2.0" uid="${xmlEsc(profile.uid)}" type="a-f-G-U-C" how="m-g" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 120000))}">`
    + `<point lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}" hae="${Number.isFinite(p.alt) ? p.alt.toFixed(1) : '9999999'}" ce="${Math.round(p.acc || 9999999)}" le="9999999"/>`
    + `<detail><takv os="${xmlEsc(navigator.platform || 'Web')}" version="1.0" device="Browser" platform="TAK EUD (Web)"/>`
    + `<contact endpoint="*:-1:stcp" callsign="${xmlEsc(profile.callsign || profile.uid)}"/>`
    + `<uid Droid="${xmlEsc(profile.callsign || profile.uid)}"/>`
    + `<precisionlocation altsrc="GPS" geopointsrc="GPS"/>`
    + `<__group role="${xmlEsc(profile.role)}" name="${xmlEsc(profile.team)}"/>`
    + (battery != null ? `<status battery="${battery}"/>` : '')
    + video
    + `<track course="${course.toFixed(1)}" speed="${speed.toFixed(1)}"/></detail></event>`;
}

function sendSelf() {
  if (!me) return;
  if (sendCot(selfXml(), false)) { lastSent = Date.now(); sentAt = { lat: me.lat, lon: me.lon }; }
}
function sendSelfTo(srv) {
  const c = connOf(srv);
  if (me && isOpen(c)) c.ws.send(JSON.stringify({ type: 'cot', xml: selfXml() }));
}
window.eudSendSelf = sendSelf;

function drawMe() {
  updateSelfInfo();
  const ll = [me.lat, me.lon];
  const col = TEAMS[profile.team] || '#00FFFF';
  const rot = (Number.isFinite(me.course) && me.speed > 0.5 ? me.course : (compassMode === 'heading' && heading != null ? heading : 0)) + northAngle();
  const html = `<svg width="32" height="32" viewBox="0 0 32 32"><g transform="rotate(${rot} 16 16)">`
    + `<path d="M16 2 L28 29 L16 22 L4 29 Z" fill="#007bff" stroke="${col}" stroke-width="2" stroke-linejoin="round"/></g></svg>`;
  const icon = L.divIcon({ className: 'cot-icon', html, iconSize: [32, 32], iconAnchor: [16, 16] });
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: me.acc || 0, color: '#007bff', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon, zIndexOffset: 1000 }).addTo(map).bindPopup(() =>
      `<div class="t">${esc(profile.callsign || 'Me')}</div><div>${me.lat.toFixed(5)}, ${me.lon.toFixed(5)}</div><div class="k">± ${Math.round(me.acc)} m</div>`);
    map.setView(ll, Math.max(map.getZoom(), 15));
  } else {
    meMarker.setLatLng(ll).setIcon(icon);
    meCircle.setLatLng(ll).setRadius(me.acc || 0);
    if (follow) map.panTo(ll, { animate: true });
  }
}

if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(pos => {
    const c = pos.coords;
    me = { lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy, speed: c.speed, course: c.heading, t: pos.timestamp };
    drawMe();
    const moved = sentAt ? distance(sentAt, me) : Infinity;
    if (Date.now() - lastSent > 30000 || (moved > 10 && Date.now() - lastSent > 3000)) sendSelf();
  }, err => {
    if (err.code === 1) toast('Location not allowed – your position is not sent.', 6000);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
setInterval(() => { if (Date.now() - lastSent > 30000) sendSelf(); }, 10000);

map.on('dragstart', () => { follow = false; $('btnLocate').classList.remove('active'); });
$('btnLocate').addEventListener('click', () => {
  follow = true;
  $('btnLocate').classList.add('active');
  if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 16));
  else toast('No position yet.');
});
$('btnLocate').classList.add('active');

// ======================================================================
// Marker setzen: Symbol wählen -> Fadenkreuz -> PUNKT SETZEN
// ======================================================================

const TOOL_NAMES = { 'a-h-G': 'Hostile', 'a-f-G': 'Friendly', 'a-n-G': 'Neutral', 'a-u-G': 'Unknown', 'b-m-p-s-p-i': 'Point' };
let tool = null;
for (const b of document.querySelectorAll('[data-tool]')) {
  const sidc = sidcFor(b.dataset.tool);
  if (sidc) b.innerHTML = symbolSvg(sidc, 30).svg;
  b.addEventListener('click', () => setTool(tool === b.dataset.tool ? null : b.dataset.tool));
}
function setTool(t) {
  tool = t;
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t);
  $('placeHint').classList.toggle('hidden', !t);
  map.getContainer().classList.toggle('drawing', !!t || measuring || drawing); // Antippen trifft die Karte
  if (t) { follow = false; $('btnLocate').classList.remove('active'); setPitch(0); }
}

function placeMarker(latlng) {
  const now = new Date();
  const type = tool;
  const uid = profile.uid + '-' + rnd(4);
  // Name wie ATAK: Präfix + laufende Nummer (ohne Präfix: Art + Uhrzeit)
  const prefix = ($('mkPrefix').value || '').trim();
  let name = `${TOOL_NAMES[type]} ${hhmm(now)}`;
  if (prefix) {
    const idx = Math.max(1, Number($('mkIndex').value) || 1);
    name = `${prefix} ${idx}`;
    $('mkIndex').value = idx + 1;
  }
  profile.markerPrefix = prefix;
  profile.markerIndex = Number($('mkIndex').value) || 1;
  saveProfile();
  const xml = `<event version="2.0" uid="${uid}" type="${type}" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 30 * 86400000))}">`
    + `<point lat="${latlng.lat.toFixed(7)}" lon="${latlng.lng.toFixed(7)}" hae="9999999" ce="9999999" le="9999999"/>`
    + `<detail><contact callsign="${xmlEsc(name)}"/>`
    + `<link uid="${xmlEsc(profile.uid)}" production_time="${cotTime(now)}" type="a-f-G-U-C" parent_callsign="${xmlEsc(profile.callsign || profile.uid)}" relation="p-p"/>`
    + `<archive/>${type.startsWith('b-m-p') ? '<color argb="-65536"/>' : ''}<remarks/></detail></event>`;
  handleCot(xml, { own: true });
  const sent = sendCot(xml, true);
  setTool(null);
  toast(sent ? `${name} sent.` : `${name} saved – will be sent once connected.`);
}


map.on('popupopen', e => {
  const play = e.popup.getElement().querySelector('[data-play]');
  if (play) play.addEventListener('click', () => { map.closePopup(); window.eudPlay(play.dataset.name, play.dataset.play); });
  const ren = e.popup.getElement().querySelector('[data-ren]');
  if (ren) ren.addEventListener('click', () => {
    const it = items.get(ren.getAttribute('data-ren'));
    if (!it) return;
    const name = prompt('New name:', it.c.callsign || '');
    if (name == null || !name.trim()) return;
    map.closePopup();
    updateOwn(it, { name: name.trim().slice(0, 40) });
  });
  const btn = e.popup.getElement().querySelector('[data-del]');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const uid = btn.getAttribute('data-del');
    const now = new Date();
    const xml = `<event version="2.0" uid="${xmlEsc(rnd(8))}" type="t-x-d-d" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 20000))}">`
      + `<point lat="0" lon="0" hae="9999999" ce="9999999" le="9999999"/><detail><link uid="${xmlEsc(uid)}" relation="none" type="none"/><__forcedelete/></detail></event>`;
    removeItem(uid);
    sendCot(xml, true);
    map.closePopup();
  });
});

// ======================================================================
// Kontakte
// ======================================================================

function renderList() {
  const box = $('listBody');
  box.textContent = '';
  const list = [...items.values()].filter(it => it.c.type.startsWith('a-') && Number.isFinite(it.c.lat));
  list.sort((a, b) => (b.c.team ? 1 : 0) - (a.c.team ? 1 : 0) || String(a.c.callsign || a.uid).localeCompare(String(b.c.callsign || b.uid)));
  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No contacts yet.';
    box.append(e);
  }
  for (const it of list) {
    const row = document.createElement('div');
    row.className = 'contact' + (Date.now() > it.c.stale ? ' stale' : '');
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = it.c.team ? (TEAMS[it.c.team] || '#0ff') : ({ f: '#80e0ff', h: '#ff8080', n: '#aaffaa', u: '#ffff80' })[it.c.type.split('-')[1]] || '#ccc';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.c.callsign || it.uid;
    const dist = document.createElement('span');
    dist.className = 'dist';
    dist.textContent = me ? fmtDist(distance(me, it.c)) : ago(it.c.time);
    row.append(sw, name, dist);
    row.addEventListener('click', () => {
      closePopup();
      follow = false;
      $('btnLocate').classList.remove('active');
      map.setView([it.c.lat, it.c.lon], Math.max(map.getZoom(), 15));
      if (it.layer) it.layer.openPopup();
    });
    box.append(row);
  }
}

// ======================================================================
// Rufname
// ======================================================================

for (const t of Object.keys(TEAMS)) $('fTeam').append(new Option(t, t));
for (const r of ROLES) $('fRole').append(new Option(r, r));
function fillMe() {
  $('fCallsign').value = profile.callsign;
  $('fTeam').value = profile.team;
  $('fRole').value = profile.role;
  $('uidText').textContent = profile.uid;
}
$('meSave').addEventListener('click', () => {
  const call = $('fCallsign').value.trim();
  if (!call) { $('fCallsign').focus(); return; }
  profile.callsign = call;
  profile.team = $('fTeam').value;
  profile.role = $('fRole').value;
  saveProfile();
  showMe();
  sendSelf();
  closePopup();
  if (!servers.length) openEdit(null);
});

// ======================================================================
// Server: Liste, Bearbeiten, Zertifikat, Dateien, QR
// ======================================================================

const STATE_TEXT = { connected: 'connected', connecting: 'connecting …', offline: 'relay not reachable', idle: 'disconnected' };

function renderServers() {
  const box = $('srvList');
  box.textContent = '';
  if (!servers.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No server set up yet.';
    box.append(e);
  }
  for (const srv of servers) {
    const c = connOf(srv);
    const el = document.createElement('div');
    el.className = 'srv';
    const dotKind = !srv.auto ? '' : c.state === 'connected' ? 'ok' : ['error', 'untrusted'].includes(c.state) ? 'err' : 'warn';
    el.innerHTML = `<div class="srv-h"><span class="dot ${dotKind}"></span><span class="srv-name"></span><span class="srv-proto"></span><button type="button" class="srv-del" aria-label="Remove">×</button></div>`
      + `<div class="srv-url"></div><div class="srv-info"></div><div class="srv-acts"><button type="button" class="act"></button><button type="button" class="edit">EDIT</button></div>`;
    el.querySelector('.srv-name').textContent = srv.name || srv.host;
    el.querySelector('.srv-proto').textContent = srv.proto.toUpperCase();
    el.querySelector('.srv-url').textContent = `${srv.host}:${srv.port}` + (srv.proto === 'ssl' ? (srv.certPem ? ' · certificate ✓' : ' · no certificate') : '');
    const info = el.querySelector('.srv-info');
    info.textContent = !srv.auto ? 'disconnected' : (c.state === 'error' || c.state === 'untrusted' ? c.message : STATE_TEXT[c.state] || c.state);
    info.classList.toggle('err', srv.auto && ['error', 'untrusted'].includes(c.state));
    const act = el.querySelector('.act');
    act.textContent = srv.auto ? 'DISCONNECT' : 'CONNECT';
    act.className = srv.auto ? 'dis' : 'con';
    act.onclick = () => (srv.auto ? disconnectServer(srv) : (profile.callsign ? connectServer(srv) : askCallsign()));
    el.querySelector('.edit').onclick = () => openEdit(srv);
    el.querySelector('.srv-del').onclick = () => { if (confirm(`Remove server "${srv.name || srv.host}"?`)) removeServer(srv); };
    box.append(el);
  }
}

function askCallsign() {
  openPopup('me');
  toast('Please enter a callsign first.');
  $('fCallsign').focus();
}

// Bearbeiten arbeitet auf einer Kopie; „Speichern & Verbinden“ übernimmt sie
let draft = null;
let draftOrig = null;

function openEdit(srv) {
  draftOrig = srv;
  draft = srv ? JSON.parse(JSON.stringify(srv)) : newServer();
  openPopup('edit', srv ? 'Edit server' : 'Add server');
  fillEdit();
  setMsg($('setupMsg'), '');
  $('fPass').value = '';
}
$('addSrvBtn').addEventListener('click', () => openEdit(null));
$('editCancel').addEventListener('click', () => openPopup('server'));

function fillEdit() {
  $('fName').value = draft.name || '';
  $('fHost').value = draft.host;
  $('fPort').value = draft.port || '';
  $('fProto').value = draft.proto;
  $('fEnroll').value = draft.enrollPort || '';
  $('fApi').value = draft.apiPort || '';
  $('fUser').value = draft.username || '';
  updateCertState();
}

function readEdit() {
  const host = $('fHost').value.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');
  if (host !== draft.host) draft.fingerprint = '';
  draft.host = host;
  draft.name = $('fName').value.trim();
  draft.port = Number($('fPort').value) || DEFAULT_PORT[$('fProto').value];
  draft.proto = $('fProto').value;
  draft.enrollPort = Number($('fEnroll').value) || 8446;
  draft.apiPort = Number($('fApi').value) || 8443;
  draft.username = $('fUser').value.trim();
}

function updateCertState() {
  $('sslBox').classList.toggle('hidden', $('fProto').value !== 'ssl');
  const st = $('certState');
  const i = draft.certInfo;
  if (draft.certPem) {
    st.textContent = '✓ ' + (i ? `${i.subject}${i.validTo ? ' · until ' + new Date(i.validTo).toLocaleDateString('en-GB') : ''}` : 'Certificate present')
      + (draft.caPems.length ? ` · ${draft.caPems.length} CA` : '');
    st.className = 'state ok';
  } else {
    st.textContent = draft.caPems.length ? `Truststore loaded (${draft.caPems.length} CA) – no client certificate yet` : 'No certificate – request one or import .p12 / data package';
    st.className = 'state';
  }
}
$('fProto').addEventListener('change', () => {
  if (!$('fPort').value || Object.values(DEFAULT_PORT).includes(Number($('fPort').value))) $('fPort').value = DEFAULT_PORT[$('fProto').value];
  updateCertState();
});

// 127.0.0.1 / localhost = dieses Handy (z. B. TAK-Server in der Meshtastic-App). Eine Web-App kann
// keine TCP/TLS-Verbindungen öffnen, und die Durchreiche erreicht das Handy nicht.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/i;
const LOCAL_MSG = 'This address is the phone itself (e.g. Meshtastic app): a web app cannot reach it – this needs the EUD as an installed app.';

$('editSave').addEventListener('click', () => {
  readEdit();
  const msg = $('setupMsg');
  if (!draft.host) return setMsg(msg, 'Please enter an address.');
  if (LOCAL_HOST.test(draft.host)) return setMsg(msg, LOCAL_MSG);
  saveDraft();
  if (!profile.callsign) return askCallsign();
  openPopup('server');
});

function saveDraft() {
  if (!draft.name) draft.name = draft.host;
  if (draftOrig) {
    const keepAuto = draftOrig.auto;
    Object.assign(draftOrig, draft, { auto: keepAuto });
    draft = draftOrig;
  } else {
    servers.push(draft);
    draftOrig = draft;
  }
  saveServers();
  if (profile.callsign) connectServer(draftOrig);
  else updateStatus();
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Server not reachable – this needs a connection.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* leer */ }
  if (!res.ok) { const err = new Error(data.error || 'Error ' + res.status); Object.assign(err, data, { status: res.status }); throw err; }
  return data;
}

function addCas(srv, pems) {
  for (const p of pems || []) if (!srv.caPems.includes(p)) srv.caPems.push(p);
}

async function requestCert(password) {
  readEdit();
  const msg = $('setupMsg');
  if (!draft.host) return setMsg(msg, 'Please enter an address.');
  if (!draft.username || !password) return setMsg(msg, 'Please enter user and password.');
  setMsg(msg, 'Requesting certificate …', true);
  $('enrollBtn').disabled = true;
  try {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await postJson('/api/eud/enroll', {
          host: draft.host, port: draft.enrollPort, username: draft.username, password,
          uid: profile.uid, caPems: draft.caPems, fingerprint: draft.fingerprint,
        });
        draft.certPem = r.certPem;
        draft.keyPem = r.keyPem;
        draft.certInfo = r.info;
        addCas(draft, r.caPems);
        $('fPass').value = '';
        setMsg(msg, 'Certificate received.', true);
        updateCertState();
        return true;
      } catch (e) {
        if (e.code !== 'UNTRUSTED' || i) throw e;
        const ok = await askTrust(`${draft.host}:${draft.enrollPort}`, e.fingerprint, e.subject);
        if (!ok) { setMsg(msg, 'Cancelled.'); return false; }
        draft.fingerprint = e.fingerprint;
      }
    }
  } catch (e) {
    setMsg(msg, e.message);
  } finally {
    $('enrollBtn').disabled = false;
  }
  return false;
}
$('enrollBtn').addEventListener('click', () => requestCert($('fPass').value));

// Vertrauensfrage für ein unbekanntes Server-Zertifikat
function askTrust(host, fingerprint, subject) {
  return new Promise(resolve => {
    $('trustHost').textContent = host;
    $('trustSubject').textContent = subject || '';
    $('trustFp').textContent = fingerprint;
    $('trust').classList.remove('hidden');
    const done = ok => {
      $('trust').classList.add('hidden');
      $('trustYes').onclick = $('trustNo').onclick = null;
      resolve(ok);
    };
    $('trustYes').onclick = () => done(true);
    $('trustNo').onclick = () => done(false);
  });
}

// ---------------- Dateien: Datenpaket, .p12, Truststore ----------------

function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('Cannot read file.'));
    r.readAsDataURL(file);
  });
}

async function loadFile(file) {
  const msg = $('setupMsg');
  readEdit();
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.zip')) {
      const r = await postJson('/api/eud/package', { data: await fileBase64(file) });
      if (r.server) {
        if (r.server.host !== draft.host) draft.fingerprint = '';
        Object.assign(draft, { host: r.server.host, port: r.server.port, proto: r.server.proto });
        if (!draft.name && r.server.description) draft.name = r.server.description;
      }
      if (r.certPem) Object.assign(draft, { certPem: r.certPem, keyPem: r.keyPem, certInfo: r.info });
      addCas(draft, r.caPems);
      fillEdit();
      if (LOCAL_HOST.test(draft.host)) return setMsg(msg, LOCAL_MSG);
      setMsg(msg, 'Data package loaded' + (r.server ? ': ' + r.server.host : '') + (r.enroll && !r.certPem ? ' – enter user/password and request a certificate.' : '.'), true);
    } else if (/\.(p12|pfx)$/.test(name)) {
      const data = await fileBase64(file);
      let r = null;
      for (const pw of ['atakatak', null]) {
        const password = pw != null ? pw : prompt('Password for ' + file.name + ':');
        if (password == null) return;
        try { r = await postJson('/api/eud/p12', { data, password }); break; } catch (e) { if (pw == null) throw e; }
      }
      if (r.kind === 'client') Object.assign(draft, { certPem: r.certPem, keyPem: r.keyPem, certInfo: r.info });
      addCas(draft, r.caPems);
      updateCertState();
      setMsg(msg, r.kind === 'client' ? 'Certificate loaded.' : `Truststore loaded (${r.caPems.length} CA).`, true);
    } else {
      const r = await postJson('/api/eud/pem', { data: await file.text() });
      addCas(draft, r.caPems);
      updateCertState();
      setMsg(msg, `Truststore loaded (${r.caPems.length} CA).`, true);
    }
  } catch (e) {
    setMsg(msg, e.message);
  }
}
$('fileIn').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });

// ---------------- QR-Codes ----------------

// Unterstützt: ATAK-Enrollment (tak://com.atakmap.app/enroll?...), iTAK (Name,Host,Port,Proto),
// eigener Link (…/eud/#host=…), JSON {host,port,proto,username,password} und "host:port:ssl"
function parseQr(text) {
  text = String(text || '').trim();
  const out = {};
  const fromParams = sp => {
    for (const [k, v] of sp) {
      const key = k.toLowerCase();
      if (key === 'host' || key === 'server') out.host = v;
      else if (key === 'port') out.port = Number(v);
      else if (key === 'proto' || key === 'protocol') out.proto = v.toLowerCase();
      else if (key === 'enroll' || key === 'enrollport') out.enrollPort = Number(v);
      else if (key === 'username' || key === 'user') out.username = v;
      else if (key === 'token' || key === 'password') out.password = v;
      else if (key === 'callsign') out.callsign = v;
      else if (key === 'name') out.name = v;
    }
  };
  if (/^tak:\/\//i.test(text)) {
    const u = new URL(text.replace(/^tak:/i, 'https:'));
    if (!/enroll/i.test(u.pathname)) throw new Error('This TAK code is not supported (enrollment only).');
    fromParams(u.searchParams);
    if (out.host && out.host.includes(':')) { const [h, p] = out.host.split(':'); out.host = h; out.enrollPort = Number(p) || out.enrollPort; }
    out.proto = 'ssl';
  } else if (/^https?:\/\//i.test(text)) {
    const u = new URL(text);
    fromParams(new URLSearchParams(u.hash.slice(1)));
    if (!out.host) fromParams(u.searchParams);
    if (!out.host) out.host = u.hostname;
  } else if (text.startsWith('{')) {
    fromParams(Object.entries(JSON.parse(text)).map(([k, v]) => [k, String(v)]));
  } else if (text.split(',').length === 4) {
    const [name, host, port, proto] = text.split(',').map(s => s.trim());
    Object.assign(out, { name, host, port: Number(port), proto: proto.toLowerCase() === 'quic' ? 'ssl' : proto.toLowerCase() });
  } else if (/^[\w.-]+:\d+(:\w+)?$/.test(text)) {
    const [host, port, proto] = text.split(':');
    Object.assign(out, { host, port: Number(port), proto: (proto || 'ssl').toLowerCase() });
  } else {
    throw new Error('Unknown QR code.');
  }
  if (out.proto && !['ssl', 'tcp', 'udp'].includes(out.proto)) out.proto = 'ssl';
  if (!out.host) throw new Error('The QR code contains no server.');
  return out;
}

// Serverdaten übernehmen: in den offenen Entwurf, sonst in den passenden oder einen neuen Server
async function applyConfig(cfg, auto) {
  if (!draft || popupSec !== 'edit') {
    const existing = servers.find(s => s.host === cfg.host && (!cfg.port || s.port === cfg.port));
    openEdit(existing || null);
  }
  if (cfg.host !== draft.host) {
    draft.fingerprint = '';
    if (draft.host) Object.assign(draft, { certPem: '', keyPem: '', certInfo: null, caPems: [] }); // anderer Server: altes Zertifikat passt nicht
  }
  draft.host = cfg.host;
  if (cfg.name && !draft.name) draft.name = cfg.name;
  if (cfg.port) draft.port = cfg.port;
  if (cfg.proto) draft.proto = cfg.proto;
  if (cfg.enrollPort) draft.enrollPort = cfg.enrollPort;
  if (cfg.username) draft.username = cfg.username;
  if (cfg.callsign && !profile.callsign) { profile.callsign = cfg.callsign; saveProfile(); showMe(); }
  fillEdit();
  if (cfg.password) $('fPass').value = cfg.password;
  if (LOCAL_HOST.test(cfg.host)) return setMsg($('setupMsg'), LOCAL_MSG);
  setMsg($('setupMsg'), 'Server settings applied.', true);
  if (auto && cfg.username && cfg.password && draft.proto === 'ssl') {
    const ok = await requestCert(cfg.password);
    if (ok) {
      saveDraft();
      if (!profile.callsign) askCallsign();
      else openPopup('server');
    }
  }
}

let scanStream = null, scanRaf = 0;
function decodeImage(source, w, h) {
  const cv = document.createElement('canvas');
  const scale = Math.min(1, 1000 / Math.max(w, h));
  cv.width = Math.round(w * scale);
  cv.height = Math.round(h * scale);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, cv.width, cv.height);
  const img = ctx.getImageData(0, 0, cv.width, cv.height);
  const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  return code ? code.data : null;
}
function onQr(text) {
  stopScan();
  try {
    applyConfig(parseQr(text), true);
  } catch (e) {
    setMsg($('setupMsg'), e.message);
  }
}
async function startScan() {
  $('scanner').classList.remove('hidden');
  $('scanMsg').textContent = 'Hold the QR code inside the frame';
  const video = $('scanVideo');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = scanStream;
    await video.play();
    const step = () => {
      if (!scanStream) return;
      if (video.readyState >= 2) {
        const text = decodeImage(video, video.videoWidth, video.videoHeight);
        if (text) return onQr(text);
      }
      scanRaf = requestAnimationFrame(step);
    };
    step();
  } catch (e) {
    $('scanMsg').textContent = 'Camera not available – use "Pick photo".';
  }
}
function stopScan() {
  cancelAnimationFrame(scanRaf);
  if (scanStream) for (const t of scanStream.getTracks()) t.stop();
  scanStream = null;
  $('scanVideo').srcObject = null;
  $('scanner').classList.add('hidden');
}
$('scanBtn').addEventListener('click', startScan);
$('scanClose').addEventListener('click', stopScan);
$('scanFile').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const img = new Image();
  img.onload = () => {
    const text = decodeImage(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(img.src);
    if (text) onQr(text);
    else $('scanMsg').textContent = 'No QR code found in the photo.';
  };
  img.src = URL.createObjectURL(f);
});

// ======================================================================
// Karte: Kartenart, offline speichern, Bildschirm, Löschen
// ======================================================================

$('fTiles').addEventListener('change', () => setTiles($('fTiles').value));

let wakeSentinel = null;
async function wakeLock() {
  try { if ('wakeLock' in navigator && !wakeSentinel) { wakeSentinel = await navigator.wakeLock.request('screen'); wakeSentinel.onrelease = () => { wakeSentinel = null; }; } } catch (e) { /* nicht erlaubt */ }
}
$('fWake').addEventListener('change', () => {
  profile.wake = $('fWake').checked;
  saveProfile();
  if (profile.wake) wakeLock();
  else if (wakeSentinel) wakeSentinel.release();
});

$('clearPicBtn').addEventListener('click', () => {
  for (const uid of [...items.keys()]) removeItem(uid);
  chat = [];
  store.set('eud.chat', chat);
  renderChat();
  toast('Map data cleared.');
});
$('resetBtn').addEventListener('click', () => {
  if (!confirm('Delete all data on this device (servers, certificates, map data)?')) return;
  for (const srv of servers) closeSock(srv);
  for (const k of ['eud.profile', 'eud.servers', 'eud.picture', 'eud.chat', 'eud.outbox', 'eud.outbox2', 'eud.view', 'eud.video', 'eud.areas']) store.del(k);
  location.reload();
});

// ---------------- Kartenquelle ----------------

for (const [id, src] of Object.entries(SOURCES)) $('fTiles').append(new Option(src.name, id));
$('fTiles').append(new Option('Custom source (URL) …', 'custom'));
function fillMap() {
  $('fTiles').value = profile.tiles;
  $('fCustom').value = profile.customUrl || '';
  $('customBox').classList.toggle('hidden', profile.tiles !== 'custom');
  $('fWake').checked = !!profile.wake;
  fillZoom();
  renderAreas();
  updateEstimate();
}
$('fTiles').addEventListener('change', () => {
  const id = $('fTiles').value;
  $('customBox').classList.toggle('hidden', id !== 'custom');
  if (id !== 'custom') setTiles(id);
  else if (profile.customUrl) setTiles('custom');
  fillZoom();
  updateEstimate();
});
$('customSave').addEventListener('click', () => {
  const u = $('fCustom').value.trim();
  if (!/^https?:\/\/.+\{z\}.+\{x\}.+\{y\}|^https?:\/\/.+\{z\}.+\{y\}.+\{x\}/i.test(u)) return toast('The URL needs {z}, {x} and {y}.');
  profile.customUrl = u;
  saveProfile();
  setTiles('custom');
  toast('Map source applied.');
});

// ---------------- Offline speichern: Ausschnitt oder Korridor ----------------

let areaMode = 'view';
let corridor = []; // [[lat, lon], …]
let corridorLine = null;
let drawing = false;
let areas = store.get('eud.areas', []);

function fillZoom() {
  const max = sourceMaxZoom(profile.tiles);
  const z = map.getZoom();
  for (const [id, def] of [['fZmin', Math.max(1, z - 2)], ['fZmax', Math.min(max, z + 3)]]) {
    const sel = $(id);
    const keep = sel.value;
    sel.replaceChildren(...Array.from({ length: max }, (_, i) => new Option(String(i + 1), String(i + 1))));
    sel.value = keep && Number(keep) <= max ? keep : String(def);
  }
}

for (const b of document.querySelectorAll('#areaMode button')) {
  b.addEventListener('click', () => {
    areaMode = b.dataset.mode;
    for (const x of document.querySelectorAll('#areaMode button')) x.classList.toggle('on', x === b);
    $('corridorBox').classList.toggle('hidden', areaMode !== 'corridor');
    updateEstimate();
  });
}
for (const id of ['fZmin', 'fZmax', 'fWidth']) $(id).addEventListener('change', updateEstimate);
$('fWidth').addEventListener('input', updateEstimate);

const tileX = (lon, n) => Math.floor((lon + 180) / 360 * n);
const tileY = (lat, n) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };

// Kacheln eines Bereichs: { kind: 'rect', s, w, n, e } oder { kind: 'corridor', points, width }
function areaTiles(area, zmin, zmax, limit = 50000) {
  const out = new Set();
  const addBox = (s, w, n, e, z) => {
    const N = 2 ** z;
    for (let x = Math.max(0, tileX(w, N)); x <= Math.min(N - 1, tileX(e, N)); x++) {
      for (let y = Math.max(0, tileY(n, N)); y <= Math.min(N - 1, tileY(s, N)); y++) {
        out.add(z + '/' + x + '/' + y);
        if (out.size > limit) return false;
      }
    }
    return true;
  };
  for (let z = zmin; z <= zmax; z++) {
    if (area.kind === 'rect') {
      if (!addBox(area.s, area.w, area.n, area.e, z)) return null;
    } else {
      const pts = area.points;
      const dLat = area.width / 111320;
      // Schrittweite kleiner als eine Kachel dieser Zoomstufe
      const step = Math.min(area.width, 40075016 / 2 ** z / 2);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[i + 1] || pts[i];
        const len = distance({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
        const n = Math.max(1, Math.ceil(len / step));
        for (let k = 0; k <= n; k++) {
          const lat = a[0] + (b[0] - a[0]) * k / n, lon = a[1] + (b[1] - a[1]) * k / n;
          const dLon = area.width / (111320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
          if (!addBox(lat - dLat, lon - dLon, lat + dLat, lon + dLon, z)) return null;
        }
      }
    }
  }
  return [...out];
}

function currentArea() {
  if (areaMode === 'corridor') {
    if (corridor.length < 2) return null;
    return { kind: 'corridor', points: corridor.slice(), width: Math.max(50, Math.min(20000, Number($('fWidth').value) || 1000)) };
  }
  const b = map.getBounds();
  return { kind: 'rect', s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
}

function zoomRange() {
  let a = Number($('fZmin').value), b = Number($('fZmax').value);
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

function updateEstimate() {
  if (popupSec !== 'map') return;
  const area = currentArea();
  if (!area) { $('estimate').textContent = 'Draw a corridor, then choose zoom levels.'; return; }
  const [a, b] = zoomRange();
  const list = areaTiles(area, a, b, 20000);
  $('estimate').textContent = list ? `≈ ${list.length} tiles, approx. ${Math.max(1, Math.round(list.length * 0.02))} MB` : 'Too many tiles (over 20,000) – lower "zoom to" or use a smaller area.';
}
map.on('moveend', updateEstimate);

function tileUrl(src, key) {
  const [z, x, y] = key.split('/');
  return new URL(sourceTemplate(src).replace('{z}', z).replace('{x}', x).replace('{y}', y), location.href).href;
}

// Korridor zeichnen: Punkte antippen
function startDraw() {
  drawing = true;
  setPitch(0);
  if (measuring) toggleMeasure();
  map.getContainer().classList.add('drawing'); // Antippen trifft die Karte, nicht Marker/Overlays
  corridor = [];
  drawCorridor();
  closePopup();
  setTool(null);
  $('drawBar').classList.remove('hidden');
  $('drawHint').textContent = 'Tap the points of the route on the map';
}
function drawCorridor() {
  if (corridorLine) corridorLine.remove();
  corridorLine = null;
  if (!corridor.length) return;
  const width = Math.max(50, Number($('fWidth').value) || 1000);
  // Breite grob in Pixel der aktuellen Zoomstufe umrechnen (nur zur Anzeige)
  const mpp = 40075016 * Math.cos(corridor[0][0] * Math.PI / 180) / (256 * 2 ** map.getZoom());
  corridorLine = L.layerGroup([
    L.polyline(corridor, { color: '#007bff', weight: Math.max(4, Math.min(200, 2 * width / mpp)), opacity: 0.2, interactive: false }),
    L.polyline(corridor, { color: '#007bff', weight: 3, dashArray: '6 6', interactive: false }),
    ...corridor.map(p => L.circleMarker(p, { radius: 5, color: '#fff', weight: 2, fillColor: '#007bff', fillOpacity: 1, interactive: false })),
  ]).addTo(map);
}
map.on('click', e => {
  if (tool) return placeMarker(e.latlng); // Symbol gewählt: Antippen setzt den Marker (wie ATAK)
  if (measuring) return addMeasurePoint(e.latlng);
  if (!drawing) return;
  corridor.push([e.latlng.lat, e.latlng.lng]);
  drawCorridor();
  $('drawHint').textContent = `${corridor.length} point(s) – keep tapping or DONE`;
});
map.on('zoomend', () => { if (corridor.length) drawCorridor(); });
$('drawUndo').addEventListener('click', () => { corridor.pop(); drawCorridor(); });
$('drawCancel').addEventListener('click', () => { drawing = false; map.getContainer().classList.remove('drawing'); corridor = []; drawCorridor(); $('drawBar').classList.add('hidden'); openPopup('map'); });
$('drawDone').addEventListener('click', () => {
  if (corridor.length < 2) return toast('Tap at least two points.');
  drawing = false;
  map.getContainer().classList.remove('drawing');
  $('drawBar').classList.add('hidden');
  let len = 0;
  for (let i = 1; i < corridor.length; i++) len += distance({ lat: corridor[i - 1][0], lon: corridor[i - 1][1] }, { lat: corridor[i][0], lon: corridor[i][1] });
  openPopup('map');
  $('corridorInfo').textContent = `Corridor: ${corridor.length} points, ${fmtDist(len)} long.`;
  updateEstimate();
});
$('drawBtn').addEventListener('click', startDraw);

// Speichern über den Service Worker (läuft weiter, auch wenn das Fenster zu ist)
let prefetchPort = null;
async function swReady() {
  const reg = navigator.serviceWorker && await navigator.serviceWorker.ready.catch(() => null);
  return reg && reg.active ? reg.active : null;
}
$('prefetchBtn').addEventListener('click', async () => {
  const msg = $('prefetchMsg');
  const area = currentArea();
  if (!area) return setMsg(msg, 'Please draw a corridor first.');
  if (profile.tiles === 'custom' && !profile.customUrl) return setMsg(msg, 'Please enter a custom source first.');
  const [zmin, zmax] = zoomRange();
  const keys = areaTiles(area, zmin, zmax, 20000);
  if (!keys) return setMsg(msg, 'Too many tiles – lower "zoom to" or use a smaller area.');
  const sw = await swReady();
  if (!sw) return setMsg(msg, 'Offline storage not available (HTTPS only).');
  const rec = { id: rnd(4), kind: area.kind, src: profile.tiles, srcName: profile.tiles === 'custom' ? 'Custom source' : SOURCES[profile.tiles].name,
    zmin, zmax, count: keys.length, date: Date.now(), area, template: sourceTemplate(profile.tiles) };
  const ch = new MessageChannel();
  prefetchPort = ch.port1;
  $('prefetchBtn').disabled = true;
  $('prefetchStop').classList.remove('hidden');
  ch.port1.onmessage = e => {
    const d = e.data;
    if (!d.finished) return setMsg(msg, `Saving … ${d.done} / ${d.total}`, true);
    $('prefetchBtn').disabled = false;
    $('prefetchStop').classList.add('hidden');
    prefetchPort = null;
    setMsg(msg, `${d.stopped ? 'Stopped' : 'Done'}: ${d.done - d.failed} tiles saved${d.failed ? `, ${d.failed} failed` : ''}.`, !d.failed);
    if (d.done - d.failed > 0) {
      rec.count = d.done - d.failed;
      areas.unshift(rec);
      areas = areas.slice(0, 30);
      store.set('eud.areas', areas);
      renderAreas();
    }
  };
  setMsg(msg, `Saving … 0 / ${keys.length}`, true);
  sw.postMessage({ type: 'prefetch', urls: keys.map(k => tileUrl(profile.tiles, k)) }, [ch.port2]);
});
$('prefetchStop').addEventListener('click', async () => {
  const sw = await swReady();
  if (sw) sw.postMessage({ type: 'prefetch-stop' });
});

function renderAreas() {
  const box = $('areaList');
  box.textContent = '';
  for (const a of areas) {
    const row = document.createElement('div');
    row.className = 'area';
    const t = document.createElement('span');
    t.textContent = `${a.kind === 'corridor' ? 'Corridor' : 'Area'} · ${a.srcName}`;
    const s = document.createElement('small');
    s.textContent = `Zoom ${a.zmin}–${a.zmax} · ${a.count} tiles · ${new Date(a.date).toLocaleDateString('en-GB')}`;
    t.append(s);
    t.style.cursor = 'pointer';
    t.onclick = () => {
      closePopup();
      const pts = a.kind === 'rect' ? [[a.area.s, a.area.w], [a.area.n, a.area.e]] : a.area.points;
      follow = false;
      $('btnLocate').classList.remove('active');
      map.fitBounds(pts);
    };
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', 'Delete');
    del.onclick = async () => {
      if (!confirm('Delete saved area?')) return;
      const keys = areaTiles(a.area, a.zmin, a.zmax, 50000) || [];
      const tpl = a.template;
      const urls = keys.map(k => { const [z, x, y] = k.split('/'); return new URL(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y), location.href).href; });
      const sw = await swReady();
      if (sw) sw.postMessage({ type: 'delete', urls });
      areas = areas.filter(x => x !== a);
      store.set('eud.areas', areas);
      renderAreas();
    };
    row.append(t, del);
    box.append(row);
  }
}

// ======================================================================
// Kompass, Karte drehen und kippen, Entfernung messen, Symbolleiste
// ======================================================================

// Winkel (Grad, im Uhrzeigersinn), in dem Norden gerade auf dem Bildschirm liegt (= Drehung der Karte)
function northAngle() {
  const b = map.getBearing ? map.getBearing() : 0;
  return ((b % 360) + 360) % 360;
}
// Karte so drehen, dass die Richtung "deg" oben liegt
function headingUp(deg) { map.setBearing(-deg); }

let compassMode = 'north'; // 'north' = Nord oben (wie ATAK Standard), 'heading' = Blickrichtung oben
let heading = null;        // Gerätekompass in Grad
let lastTurn = 0;

let needleAngle = 0; // fortlaufend, damit die Nadel immer den kurzen Weg dreht
function updateCompass() {
  const n = northAngle();
  needleAngle += ((n - needleAngle) % 360 + 540) % 360 - 180;
  $('needle').style.transform = `rotate(${Math.round(needleAngle * 10) / 10}deg)`;
  const shown = compassMode === 'heading' && heading != null ? heading : (360 - n) % 360;
  $('compassText').textContent = String(Math.round(shown) % 360).padStart(3, '0') + '°';
  $('compassMode').textContent = compassMode === 'heading' ? 'HDG' : 'N';
  $('compass').classList.toggle('heading', compassMode === 'heading');
}

function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading; // iPhone
  else if (e.absolute && typeof e.alpha === 'number') h = 360 - e.alpha;    // Android
  if (h == null) return;
  const sc = screen.orientation ? screen.orientation.angle || 0 : (window.orientation || 0);
  heading = (h + sc + 360) % 360;
  if (compassMode !== 'heading') return;
  const now = Date.now();
  if (now - lastTurn < 120) return; // ruhig drehen, Akku schonen
  lastTurn = now;
  headingUp(heading);
  updateCompass();
}

function startHeading() {
  window.addEventListener('deviceorientationabsolute', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
  // iPhone (und neuere Chrome) fragen beim Antippen nach Erlaubnis – nicht darauf warten
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(r => { if (r !== 'granted') throw new Error('denied'); })
      .catch(() => toast('Compass not allowed – using GPS course while moving.'));
  }
}
function stopHeading() {
  window.removeEventListener('deviceorientationabsolute', onOrientation);
  window.removeEventListener('deviceorientation', onOrientation);
}

$('compass').addEventListener('click', () => {
  if (compassMode === 'north') {
    compassMode = 'heading';
    startHeading();
    if (heading != null) headingUp(heading);
    else if (me && Number.isFinite(me.course) && me.speed > 0.5) headingUp(me.course);
    setTimeout(() => { if (compassMode === 'heading' && heading == null && !(me && me.speed > 0.5)) toast('No compass sensor – map turns with GPS course while moving.'); }, 2500);
  } else {
    compassMode = 'north';
    stopHeading();
    map.setBearing(0);
  }
  updateCompass();
});
// Ohne Kompass-Sensor: beim Gehen/Fahren nach GPS-Kurs drehen
setInterval(() => {
  if (compassMode === 'heading' && heading == null && me && Number.isFinite(me.course) && me.speed > 0.5) headingUp(me.course);
}, 2000);

// Pfeile der Kontakte und des eigenen Symbols folgen der Kartendrehung
let rotateTimer = null;
map.on('rotate', () => {
  updateCompass();
  if (rotateTimer) return;
  rotateTimer = setTimeout(() => {
    rotateTimer = null;
    if (me) drawMe();
    for (const it of items.values()) if (it.c.team && it.c.speed > 0.5) drawItem(it);
  }, 300);
});
map.on('moveend zoomend', updateCompass);
updateCompass();

// ---------------- Kippen (0–60°) ----------------

let pitch = 0;
const PITCH_MAX = 60;
function setPitch(p) {
  p = Math.max(0, Math.min(PITCH_MAX, Math.round(p)));
  const was = pitch;
  pitch = p;
  const el = $('map');
  if ((was > 0) !== (p > 0)) {
    el.classList.toggle('tilted', p > 0); // Karte größer, damit der hintere Teil gefüllt ist
    map.invalidateSize({ pan: true, animate: false });
  }
  el.style.transform = p ? `rotateX(${p}deg)` : '';
  const box = $('pitchBox').clientHeight || 96;
  $('pitchThumb').style.top = (4 + (1 - p / PITCH_MAX) * (box - 14)) + 'px';
  $('pitchText').textContent = p + '°';
  $('pitchFill').setAttribute('points', `12,2 22,2 32,86 2,86`);
  $('pitchFill').style.opacity = String(0.3 + 0.7 * p / PITCH_MAX);
}
(() => {
  const box = $('pitchBox');
  let dragging = false;
  const fromEvent = e => {
    const r = box.getBoundingClientRect();
    const y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
    setPitch((1 - y / r.height) * PITCH_MAX);
  };
  box.addEventListener('pointerdown', e => { dragging = true; box.setPointerCapture(e.pointerId); fromEvent(e); });
  box.addEventListener('pointermove', e => { if (dragging) fromEvent(e); });
  box.addEventListener('pointerup', () => { dragging = false; });
  box.addEventListener('pointercancel', () => { dragging = false; });
  box.addEventListener('dblclick', () => setPitch(0));
})();
setPitch(0);

// ---------------- Entfernung messen ----------------

let measuring = false;
let measurePts = [];
const measureLayer = L.layerGroup().addTo(map);

function drawMeasure() {
  measureLayer.clearLayers();
  if (!measurePts.length) return;
  L.polyline(measurePts, { color: '#ffd700', weight: 3, dashArray: '8 6', interactive: false }).addTo(measureLayer);
  let total = 0;
  measurePts.forEach((p, i) => {
    L.circleMarker(p, { radius: 5, color: '#000', weight: 1.5, fillColor: '#ffd700', fillOpacity: 1, interactive: false }).addTo(measureLayer);
    if (i > 0) total += distance({ lat: measurePts[i - 1].lat, lon: measurePts[i - 1].lng }, { lat: p.lat, lon: p.lng });
  });
  const last = measurePts[measurePts.length - 1];
  if (measurePts.length > 1) {
    const prev = measurePts[measurePts.length - 2];
    const brg = Math.round(bearing({ lat: prev.lat, lon: prev.lng }, { lat: last.lat, lon: last.lng }));
    L.tooltip({ permanent: true, direction: 'right', offset: [10, 0], className: 'measure-label' })
      .setLatLng(last).setContent(`${fmtDist(total)} · ${String(brg).padStart(3, '0')}°`).addTo(measureLayer);
  }
}
function addMeasurePoint(ll) {
  measurePts.push(ll);
  drawMeasure();
}
function toggleMeasure() {
  measuring = !measuring;
  closeSheets();
  $('btnMeasure').classList.toggle('active', measuring);
  $('measureHint').classList.toggle('hidden', !measuring);
  map.getContainer().classList.toggle('drawing', measuring);
  if (measuring) { setTool(null); setPitch(0); measurePts = []; } else { measurePts = []; drawMeasure(); }
}
$('btnMeasure').addEventListener('click', toggleMeasure);

// ---------------- Symbolleiste ein/aus (Pin) ----------------

$('toolsClose').addEventListener('click', () => showTools(false));
$('mkPrefix').value = profile.markerPrefix || '';
$('mkIndex').value = profile.markerIndex || 1;
function showTools(on) {
  if (on) closeSheets('markers');
  profile.showTools = !!on;
  saveProfile();
  $('toolbar').classList.toggle('hidden', !on);
  $('btnPin').classList.toggle('pinned', !!on);
  if (!on) { setTool(null); if (measuring) toggleMeasure(); }
}
$('btnPin').addEventListener('click', () => showTools(!profile.showTools));
showTools(profile.showTools);

// ======================================================================
// Eigene Position unten rechts (wie ATAK): Rufname, MGRS, Höhe, Richtung, Tempo, Genauigkeit
// ======================================================================

// WGS84 -> MGRS (z. B. "33U VP 49594 44664")
function toMGRS(lat, lon) {
  if (!(lat > -80 && lat < 84)) return '';
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72) zone = lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : lon < 42 ? 37 : zone;
  const r = Math.PI / 180;
  const phi = lat * r, lam = lon * r, lam0 = ((zone - 1) * 6 - 180 + 3) * r;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const E = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let Nn = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) Nn += 10000000;
  const band = 'CDEFGHJKLMNPQRSTUVWX'[Math.min(19, Math.floor((lat + 80) / 8))];
  const set = zone % 6 || 6;
  const col = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][(set - 1) % 3][Math.floor(E / 100000) - 1];
  const row = 'ABCDEFGHJKLMNPQRSTUV'[(Math.floor(Nn / 100000) + (set % 2 === 0 ? 5 : 0)) % 20];
  const pad = v => String(Math.floor(v % 100000)).padStart(5, '0');
  return `${zone}${band} ${col}${row} ${pad(E)} ${pad(Nn)}`;
}
window.eudMGRS = toMGRS;

function updateSelfInfo() {
  $('siCall').textContent = profile.callsign || '---';
  if (!me) { $('siGrid').textContent = 'No GPS'; $('siAlt').textContent = $('siHdg').textContent = $('siSpd').textContent = $('siAcc').textContent = ''; return; }
  $('siGrid').textContent = toMGRS(me.lat, me.lon);
  $('siAlt').textContent = Number.isFinite(me.alt) && me.alt !== null ? `${Math.round(me.alt)} m MSL` : '--- m MSL';
  const dir = compassMode === 'heading' && heading != null ? heading : (heading != null ? heading : (Number.isFinite(me.course) ? me.course : null));
  $('siHdg').textContent = dir == null ? '---°' : `${String(Math.round(dir) % 360).padStart(3, '0')}°`;
  $('siSpd').textContent = `${Number.isFinite(me.speed) && me.speed !== null ? Math.round(me.speed * 3.6) : 0} km/h`;
  $('siAcc').textContent = `+/- ${Math.round(me.acc || 0)}m`;
}
setInterval(updateSelfInfo, 2000);

L.control.scale({ metric: true, imperial: false, position: 'bottomleft', maxWidth: 110 }).addTo(map);

// ======================================================================
// Start
// ======================================================================

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// Alle Streams im Lagebild (Kontakte mit Video-Link)
function videoItems() {
  return [...items.values()].map(it => ({ name: it.c.callsign || it.uid, url: videoUrl(it.c), stale: Date.now() > it.c.stale, time: it.c.time }))
    .filter(v => v.url && !v.stale).sort((a, b) => a.name.localeCompare(b.name));
}

window.eud = { videoItems, browserVideoUrl, $, store, profile, toast, setMsg, openPopup, closePopup, rnd, esc, map, handleCot, askTrust, postJson, getServers: () => servers, saveServers, fmtDist, distance };

loadPicture();
renderChat();
showMe();
updateStatus();

// Vorgaben aus dem QR-Code des Admins (…/eud/#host=…) oder vom Server
(async () => {
  const hash = location.hash.slice(1);
  let handled = false;
  if (hash && new URLSearchParams(hash).has('host')) {
    history.replaceState(null, '', location.pathname);
    try {
      const cfg = parseQr(location.origin + location.pathname + '#' + hash);
      if (!servers.some(s => s.host === cfg.host)) { await applyConfig(cfg, true); handled = true; }
    } catch (e) { /* ungültig */ }
  } else if (!servers.length) {
    try {
      const r = await fetch('/api/eud/config').then(x => x.json());
      if (r.preset && r.preset.host) {
        openEdit(null);
        await applyConfig({ host: r.preset.host, port: r.preset.port, proto: r.preset.proto, enrollPort: r.preset.enrollPort }, false);
        handled = true;
      }
    } catch (e) { /* offline */ }
  }
  if (!handled) {
    if (!profile.callsign) openPopup('me');
    else if (!servers.length) openEdit(null);
  }
  for (const srv of servers) if (srv.auto) openConn(srv);
  if (profile.wake) wakeLock();
})();
