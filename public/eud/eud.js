// TAK-EUD im Browser: Karte + Lagebild vom TAK-Server (CoT), eigene Position, Marker, Chat.
// Der eigene Server reicht nur durch (WebSocket /ws/tak); Zertifikate bleiben auf diesem Gerät.
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

// ======================================================================
// Profil (nur auf diesem Gerät)
// ======================================================================

const profile = Object.assign({
  host: '', port: 8089, proto: 'ssl', enrollPort: 8446, username: '',
  certPem: '', keyPem: '', caPems: [], fingerprint: '', certInfo: null,
  callsign: '', team: 'Cyan', role: 'Team Member', uid: '', auto: false, tiles: 'OSM', wake: false,
}, store.get('eud.profile', {}));
if (!profile.uid) profile.uid = 'EUD-' + rnd(6).toUpperCase();
const saveProfile = () => store.set('eud.profile', profile);
saveProfile();

// ======================================================================
// Karte
// ======================================================================

const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true })
  .setView(store.get('eud.view', [51.1, 10.4, 6]).slice(0, 2), store.get('eud.view', [0, 0, 6])[2]);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
const LAYERS = {
  OSM: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }),
  Topo: L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '© OpenTopoMap, © OpenStreetMap' }),
  Satellit: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri' }),
};
(LAYERS[profile.tiles] || LAYERS.OSM).addTo(map);
L.control.layers(LAYERS, null, { position: 'bottomleft' }).addTo(map);
map.on('baselayerchange', e => { profile.tiles = e.name; saveProfile(); });
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

function openSheet(id) {
  for (const s of document.querySelectorAll('.sheet')) if (s.id !== 'trust') s.classList.add('hidden');
  $(id).classList.remove('hidden');
}
function closeSheet(id) { $(id).classList.add('hidden'); }
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('.sheet').classList.add('hidden'));

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
  if (s < 60) return 'vor ' + Math.max(s, 0) + ' s';
  if (s < 3600) return 'vor ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'vor ' + Math.round(s / 3600) + ' h';
  return new Date(ts).toLocaleString();
}

// ARGB-Zahl aus ATAK (-1 = weiß) -> CSS-Farbe
function argb(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v) >>> 0;
  const a = ((n >>> 24) & 255) / 255;
  return `rgba(${(n >>> 16) & 255},${(n >>> 8) & 255},${n & 255},${a.toFixed(2)})`;
}
function argbInt(hex) {
  const n = parseInt(hex.slice(1), 16);
  return ((0xff000000 | n) >> 0).toString();
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
const AFF_NAMES = { f: 'Freund', h: 'Feind', n: 'Neutral', u: 'Unbekannt', a: 'Vermutl. Freund', s: 'Verdächtig', p: 'Ausstehend' };

const symCache = new Map();
function symbolSvg(sidc) {
  if (!symCache.has(sidc)) {
    let out = null;
    try {
      const s = new ms.Symbol(sidc, { size: 26 });
      if (s.isValid()) out = { svg: s.asSVG(), w: s.getSize().width, h: s.getSize().height, a: s.getAnchor() };
    } catch (e) { /* unbekannter Code */ }
    if (!out) {
      const s = new ms.Symbol(sidc.slice(0, 4) + '------' + '-----', { size: 26 });
      out = { svg: s.asSVG(), w: s.getSize().width, h: s.getSize().height, a: s.getAnchor() };
    }
    symCache.set(sidc, out);
  }
  return symCache.get(sidc);
}

// ======================================================================
// Lagebild: CoT empfangen und zeichnen
// ======================================================================

const items = new Map(); // uid -> { uid, type, xml, lat, lon, callsign, team, stale, time, layer, own }
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
    how: ev.getAttribute('how') || '',
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
    video: attr('__video', 'url') || attr('__video ConnectionEntry', 'address'),
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

function iconFor(c, stale) {
  const label = `<span class="lbl" style="top:{T}px">${esc(c.callsign || '')}</span>`;
  const cls = 'cot-icon' + (stale ? ' stale' : '');
  if (c.type.startsWith('a-') && c.team) {
    // ATAK-Nutzer: farbiger Punkt in Teamfarbe mit Richtungspfeil
    const col = TEAMS[c.team] || '#00FFFF';
    const arrow = Number.isFinite(c.course) && c.speed > 0.5
      ? `<path d="M14 1 L19 9 L14 7 L9 9 Z" fill="${col}" stroke="#000" stroke-width="1" transform="rotate(${c.course} 14 14)"/>` : '';
    const html = `<svg width="28" height="28" viewBox="0 0 28 28">${arrow}<circle cx="14" cy="14" r="8" fill="${col}" stroke="#000" stroke-width="2"/></svg>${label.replace('{T}', 28)}`;
    return L.divIcon({ className: cls, html, iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -12] });
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
    ? (AFF_NAMES[c.type.split('-')[1]] || 'Objekt') + (c.team ? ` · ${esc(c.team)} · ${esc(c.role || '')}` : '')
    : c.type.startsWith('b-m-p') ? 'Punkt' : c.type.startsWith('u-d') ? 'Zeichnung' : c.type.startsWith('b-m-r') ? 'Route' : esc(c.type);
  rows.push(`<div class="t">${esc(c.callsign || c.uid)}</div><div class="k">${kind}</div>`);
  if (Number.isFinite(c.lat)) rows.push(`<div>${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}${Number.isFinite(c.hae) && c.hae < 9e6 ? ` · ${Math.round(c.hae)} m` : ''}</div>`);
  if (me && Number.isFinite(c.lat)) rows.push(`<div class="k">${fmtDist(distance(me, c))} · ${Math.round(bearing(me, c))}°</div>`);
  if (c.speed > 0.5) rows.push(`<div class="k">${(c.speed * 3.6).toFixed(0)} km/h</div>`);
  if (c.battery) rows.push(`<div class="k">Akku ${esc(c.battery)} %</div>`);
  rows.push(`<div class="k">${ago(c.time)}${Date.now() > c.stale ? ' · veraltet' : ''}</div>`);
  if (c.remarks) rows.push(`<div>${esc(c.remarks)}</div>`);
  const v = videoUrl(c);
  if (v && /^https?:\/\//i.test(v)) rows.push(`<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">▶ Video öffnen</a>`);
  else if (v) rows.push(`<div class="k">Video: ${esc(v)}</div>`);
  if (it.own) rows.push(`<button type="button" data-del="${esc(c.uid)}">Löschen</button>`);
  return rows.join('');
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
    const closed = c.type === 'u-d-r' || c.type === 'u-d-f-c' || c.detail && c.detail.querySelector('closed[value="true"]')
      || (pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]);
    it.layer = (closed ? L.polygon(pts, style) : L.polyline(pts, { ...style, fill: false })).addTo(shapesLayer);
  } else if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && !(c.lat === 0 && c.lon === 0)) {
    it.layer = L.marker([c.lat, c.lon], { icon: iconFor(c, stale), zIndexOffset: c.team ? 500 : 0 }).addTo(pointsLayer);
  }
  if (it.layer) it.layer.bindPopup(() => popupHtml(it), { maxWidth: 260 });
  it.stale = stale;
}

function handleCot(xml, { local = false, own = false } = {}) {
  const c = parseCot(xml);
  if (!c || !c.uid) return;
  if (c.type.startsWith('t-x-c-t')) return; // Ping/Pong
  if (c.type === 't-x-d-d') {
    for (const l of c.links) if (l.uid) removeItem(l.uid);
    return;
  }
  if (c.type === 'b-t-f') return receiveChat(c, xml, local);
  if (c.uid === profile.uid) return; // eigenes Echo
  const prev = items.get(c.uid);
  if (prev && prev.c.time > c.time && !local) return; // älter als bekannt
  const it = prev || { uid: c.uid };
  it.c = c;
  it.xml = xml;
  it.own = own || (prev && prev.own) || c.links.some(l => l.uid === profile.uid && l.relation === 'p-p');
  items.set(c.uid, it);
  drawItem(it);
  if (!local) persistSoon();
  if (!$('list').classList.contains('hidden')) renderList();
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

function receiveChat(c, xml, local) {
  const ch = c.chat;
  const room = ch ? ch.getAttribute('chatroom') || ch.getAttribute('id') || '' : '';
  const sender = ch ? ch.getAttribute('senderCallsign') || '' : c.callsign || '';
  const msgId = c.uid;
  if (chat.some(m => m.id === msgId)) return;
  const toMe = ch && (ch.getAttribute('id') === profile.uid || room === profile.callsign);
  const fromMe = c.uid.startsWith('GeoChat.' + profile.uid + '.');
  chat.push({ id: msgId, from: sender, room: toMe ? 'Direkt' : room, text: c.remarks, time: c.time, me: fromMe });
  chat = chat.slice(-200);
  store.set('eud.chat', chat);
  if (!local && !fromMe) {
    if ($('chat').classList.contains('hidden')) { unread++; updateBadge(); toast(`${sender}: ${c.remarks}`); }
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
  for (const m of chat) {
    const d = document.createElement('div');
    d.className = 'm' + (m.me ? ' me' : '');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = `${m.from}${m.room && m.room !== 'All Chat Rooms' ? ' → ' + m.room : ''} · ${new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = m.text;
    d.append(who, txt);
    log.append(d);
  }
  log.parentElement.scrollTop = log.parentElement.scrollHeight;
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
// Verbindung zum TAK-Server über die Durchreiche
// ======================================================================

let ws = null;
let wsRetry = 0;
let wsTimer = null;
let takState = 'idle';
let outbox = store.get('eud.outbox', []);

function setStatus(kind, text) {
  $('dot').className = 'dot ' + kind;
  $('statusText').textContent = text;
}

function updateStatus() {
  if (!profile.auto) return setStatus('', profile.host ? 'Nicht verbunden' : 'Einrichten');
  if (!ws || ws.readyState !== 1) return setStatus('warn', navigator.onLine ? 'Server nicht erreichbar – neuer Versuch …' : 'Offline – Karte und Lagebild aus dem Speicher');
  if (takState === 'connected') return setStatus('ok', profile.host);
  if (takState === 'error') return setStatus('err', lastError || 'Fehler');
  setStatus('warn', 'Verbinde mit ' + profile.host + ' …');
}
let lastError = '';

function sendCot(xml, queue) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'cot', xml }));
    return true;
  }
  if (queue) {
    outbox.push(xml);
    outbox = outbox.slice(-100);
    store.set('eud.outbox', outbox);
  }
  return false;
}

function flushOutbox() {
  while (outbox.length && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'cot', xml: outbox.shift() }));
  store.set('eud.outbox', outbox);
}

function openWs() {
  clearTimeout(wsTimer);
  if (!profile.auto || !profile.host) return updateStatus();
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/tak');
  ws = sock;
  takState = 'connecting';
  updateStatus();
  sock.onopen = () => {
    wsRetry = 0;
    sock.send(JSON.stringify({
      type: 'connect', host: profile.host, port: profile.port, proto: profile.proto, uid: profile.uid, callsign: profile.callsign,
      certPem: profile.proto === 'ssl' ? profile.certPem : '', keyPem: profile.proto === 'ssl' ? profile.keyPem : '',
      caPems: profile.caPems, fingerprint: profile.fingerprint,
    }));
    flushOutbox(); // die Durchreiche puffert, bis der TAK-Server verbunden ist
    sendSelf();
  };
  sock.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'cot') return handleCot(msg.xml);
    if (msg.type !== 'status') return;
    const was = takState;
    takState = msg.state;
    if (msg.state === 'error') lastError = msg.message;
    if (msg.state === 'connected' && was !== 'connected') { toast('Verbunden mit ' + profile.host); sendSelf(); }
    if (msg.state === 'untrusted') {
      askTrust(profile.host + ':' + profile.port, msg.fingerprint, msg.subject).then(ok => {
        if (!ok) { disconnect(); return; }
        profile.fingerprint = msg.fingerprint;
        saveProfile();
        reconnect();
      });
    }
    updateStatus();
    updateSetup();
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    takState = 'idle';
    updateStatus();
    if (profile.auto) wsTimer = setTimeout(openWs, Math.min(30000, 1000 * 2 ** wsRetry++));
  };
  sock.onerror = () => {};
}

function reconnect() {
  if (ws) { const s = ws; ws = null; s.onclose = null; s.close(); }
  wsRetry = 0;
  openWs();
}

function disconnect() {
  profile.auto = false;
  saveProfile();
  if (ws) {
    try { ws.send(JSON.stringify({ type: 'disconnect' })); } catch (e) { /* egal */ }
    const s = ws; ws = null; s.onclose = null; s.close();
  }
  takState = 'idle';
  updateStatus();
  updateSetup();
}

window.addEventListener('online', () => { wsRetry = 0; openWs(); });
window.addEventListener('offline', updateStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { wsRetry = 0; openWs(); sendSelf(); if (profile.wake) wakeLock(); }
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
  return `<event version="2.0" uid="${xmlEsc(profile.uid)}" type="a-f-G-U-C" how="m-g" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 120000))}">`
    + `<point lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}" hae="${Number.isFinite(p.alt) ? p.alt.toFixed(1) : '9999999'}" ce="${Math.round(p.acc || 9999999)}" le="9999999"/>`
    + `<detail><takv os="${xmlEsc(navigator.platform || 'Web')}" version="1.0" device="Browser" platform="TAK EUD (Web)"/>`
    + `<contact endpoint="*:-1:stcp" callsign="${xmlEsc(profile.callsign || profile.uid)}"/>`
    + `<uid Droid="${xmlEsc(profile.callsign || profile.uid)}"/>`
    + `<precisionlocation altsrc="GPS" geopointsrc="GPS"/>`
    + `<__group role="${xmlEsc(profile.role)}" name="${xmlEsc(profile.team)}"/>`
    + (battery != null ? `<status battery="${battery}"/>` : '')
    + `<track course="${course.toFixed(1)}" speed="${speed.toFixed(1)}"/></detail></event>`;
}

function sendSelf() {
  if (!me || !profile.auto) return;
  if (sendCot(selfXml(), false)) { lastSent = Date.now(); sentAt = { lat: me.lat, lon: me.lon }; }
}

let battery = null;
if (navigator.getBattery) navigator.getBattery().then(b => {
  const upd = () => { battery = Math.round(b.level * 100); };
  upd();
  b.addEventListener('levelchange', upd);
}).catch(() => {});

function drawMe() {
  const ll = [me.lat, me.lon];
  const col = TEAMS[profile.team] || '#00FFFF';
  const rot = Number.isFinite(me.course) && me.speed > 0.5 ? me.course : null;
  const html = `<svg width="30" height="30" viewBox="0 0 30 30">${rot != null ? `<path d="M15 0 L21 10 L15 8 L9 10 Z" fill="#fff" stroke="#000" transform="rotate(${rot} 15 15)"/>` : ''}`
    + `<circle cx="15" cy="15" r="9" fill="${col}" stroke="#fff" stroke-width="3"/></svg>`;
  const icon = L.divIcon({ className: 'cot-icon', html, iconSize: [30, 30], iconAnchor: [15, 15] });
  if (!meMarker) {
    meCircle = L.circle(ll, { radius: me.acc || 0, color: '#00c8ff', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    meMarker = L.marker(ll, { icon, zIndexOffset: 1000 }).addTo(map).bindPopup(() =>
      `<div class="t">${esc(profile.callsign || 'Ich')}</div><div>${me.lat.toFixed(5)}, ${me.lon.toFixed(5)}</div><div class="k">± ${Math.round(me.acc)} m</div>`);
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
    if (err.code === 1) toast('Standort nicht erlaubt – deine Position wird nicht gesendet.', 6000);
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
setInterval(() => { if (Date.now() - lastSent > 30000) sendSelf(); }, 10000);

map.on('dragstart', () => { follow = false; $('btnCenter').classList.remove('on'); });
$('btnCenter').addEventListener('click', () => {
  follow = true;
  $('btnCenter').classList.add('on');
  if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 16));
  else toast('Noch keine Position.');
});
$('btnCenter').classList.add('on');

// ======================================================================
// Marker setzen
// ======================================================================

let placeAt = null;
function startPlace() {
  $('crosshair').classList.remove('hidden');
  $('placeBar').classList.remove('hidden');
  for (const s of document.querySelectorAll('.sheet')) s.classList.add('hidden');
}
function endPlace() {
  $('crosshair').classList.add('hidden');
  $('placeBar').classList.add('hidden');
}
function markerDialog(latlng) {
  endPlace();
  placeAt = latlng;
  $('mName').value = '';
  $('mRemarks').value = '';
  openSheet('markerSheet');
}
$('btnMarker').addEventListener('click', startPlace);
$('placeCancel').addEventListener('click', endPlace);
$('placeOk').addEventListener('click', () => markerDialog(map.getCenter()));
map.on('contextmenu', e => markerDialog(e.latlng)); // langes Drücken / Rechtsklick

$('mSave').addEventListener('click', () => {
  if (!placeAt) return;
  const now = new Date();
  const type = $('mType').value;
  const uid = profile.uid + '-' + rnd(4);
  const name = $('mName').value.trim() || ($('mType').selectedOptions[0].text + ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const remarks = $('mRemarks').value.trim();
  const xml = `<event version="2.0" uid="${uid}" type="${type}" how="h-g-i-g-o" time="${cotTime(now)}" start="${cotTime(now)}" stale="${cotTime(new Date(+now + 30 * 86400000))}">`
    + `<point lat="${placeAt.lat.toFixed(7)}" lon="${placeAt.lng.toFixed(7)}" hae="9999999" ce="9999999" le="9999999"/>`
    + `<detail><contact callsign="${xmlEsc(name)}"/>`
    + `<link uid="${xmlEsc(profile.uid)}" production_time="${cotTime(now)}" type="a-f-G-U-C" parent_callsign="${xmlEsc(profile.callsign || profile.uid)}" relation="p-p"/>`
    + `<archive/>${type.startsWith('b-m-p') ? '<color argb="-65536"/>' : ''}`
    + `<remarks>${xmlEsc(remarks)}</remarks></detail></event>`;
  handleCot(xml, { own: true });
  sendCot(xml, true);
  closeSheet('markerSheet');
  toast(ws && ws.readyState === 1 ? 'Marker gesendet.' : 'Marker gespeichert – wird gesendet, sobald die Verbindung steht.');
});

map.on('popupopen', e => {
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
  if (!list.length) box.textContent = 'Noch keine Kontakte.';
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
      closeSheet('list');
      follow = false;
      $('btnCenter').classList.remove('on');
      map.setView([it.c.lat, it.c.lon], Math.max(map.getZoom(), 15));
      if (it.layer) it.layer.openPopup();
    });
    box.append(row);
  }
}
$('btnList').addEventListener('click', () => { renderList(); openSheet('list'); });
$('btnChat').addEventListener('click', () => { unread = 0; updateBadge(); renderChat(); openSheet('chat'); });

// ======================================================================
// Einrichtung
// ======================================================================

for (const t of Object.keys(TEAMS)) $('fTeam').append(new Option(t, t));
for (const r of ROLES) $('fRole').append(new Option(r, r));

function fillForm() {
  $('fHost').value = profile.host;
  $('fPort').value = profile.port || '';
  $('fProto').value = profile.proto;
  $('fEnroll').value = profile.enrollPort || '';
  $('fUser').value = profile.username || '';
  $('fCallsign').value = profile.callsign;
  $('fTeam').value = profile.team;
  $('fRole').value = profile.role;
  $('fWake').checked = !!profile.wake;
  $('uidText').textContent = profile.uid;
  updateSetup();
}

function readForm() {
  const host = $('fHost').value.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/:].*$/, '');
  if (host !== profile.host) profile.fingerprint = '';
  profile.host = host;
  profile.port = Number($('fPort').value) || 8089;
  profile.proto = $('fProto').value;
  profile.enrollPort = Number($('fEnroll').value) || 8446;
  profile.username = $('fUser').value.trim();
  profile.callsign = $('fCallsign').value.trim();
  profile.team = $('fTeam').value;
  profile.role = $('fRole').value;
  saveProfile();
}

function updateSetup() {
  $('sslBox').classList.toggle('hidden', $('fProto').value !== 'ssl');
  const st = $('certState');
  const i = profile.certInfo;
  if (profile.certPem && i) {
    st.textContent = `✓ Zertifikat: ${i.subject}${i.validTo ? ' · gültig bis ' + new Date(i.validTo).toLocaleDateString() : ''}`
      + (profile.caPems.length ? ` · ${profile.caPems.length} CA` : ' · ohne CA');
    st.className = 'state ok';
  } else if (profile.certPem) {
    st.textContent = '✓ Zertifikat vorhanden';
    st.className = 'state ok';
  } else {
    st.textContent = profile.caPems.length ? `Truststore geladen (${profile.caPems.length} CA) – noch kein eigenes Zertifikat` : 'Noch kein Zertifikat – anfordern oder .p12 / Datenpaket laden';
    st.className = 'state';
  }
  $('connectBtn').classList.toggle('hidden', !!profile.auto);
  $('disconnectBtn').classList.toggle('hidden', !profile.auto);
  $('meName').textContent = profile.callsign;
  $('meName').classList.toggle('hidden', !profile.callsign);
}
$('fProto').addEventListener('change', () => {
  const ports = { ssl: 8089, tcp: 8087, udp: 8087 };
  if (!$('fPort').value || Object.values(ports).includes(Number($('fPort').value))) $('fPort').value = ports[$('fProto').value];
  updateSetup();
});

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Server nicht erreichbar – dafür wird eine Verbindung gebraucht.');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* leer */ }
  if (!res.ok) { const err = new Error(data.error || 'Fehler ' + res.status); Object.assign(err, data, { status: res.status }); throw err; }
  return data;
}

function addCas(pems) {
  for (const p of pems || []) if (!profile.caPems.includes(p)) profile.caPems.push(p);
}

async function requestCert(password) {
  readForm();
  const msg = $('setupMsg');
  if (!profile.host) return setMsg(msg, 'Bitte Server-Adresse eintragen.');
  if (!profile.username || !password) return setMsg(msg, 'Bitte Benutzername und Passwort eintragen.');
  setMsg(msg, 'Fordere Zertifikat an …', true);
  $('enrollBtn').disabled = true;
  try {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await postJson('/api/eud/enroll', {
          host: profile.host, port: profile.enrollPort, username: profile.username, password,
          uid: profile.uid, caPems: profile.caPems, fingerprint: profile.fingerprint,
        });
        profile.certPem = r.certPem;
        profile.keyPem = r.keyPem;
        profile.certInfo = r.info;
        addCas(r.caPems);
        saveProfile();
        $('fPass').value = '';
        setMsg(msg, 'Zertifikat erhalten. Jetzt „Verbinden“.', true);
        updateSetup();
        return true;
      } catch (e) {
        if (e.code !== 'UNTRUSTED' || i) throw e;
        const ok = await askTrust(profile.host + ':' + profile.enrollPort, e.fingerprint, e.subject);
        if (!ok) { setMsg(msg, 'Abgebrochen.'); return false; }
        profile.fingerprint = e.fingerprint;
        saveProfile();
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

function connect() {
  readForm();
  const msg = $('setupMsg');
  if (!profile.host) return setMsg(msg, 'Bitte Server-Adresse eintragen.');
  if (!profile.callsign) return setMsg(msg, 'Bitte einen Rufnamen eintragen.');
  if (profile.proto === 'ssl' && !profile.certPem) setMsg(msg, 'Hinweis: ohne Zertifikat lehnen die meisten TAK-Server SSL ab.');
  else setMsg(msg, '');
  profile.auto = true;
  saveProfile();
  updateSetup();
  reconnect();
  closeSheet('setup');
}
$('connectBtn').addEventListener('click', connect);
$('disconnectBtn').addEventListener('click', disconnect);
for (const id of ['fCallsign', 'fTeam', 'fRole']) $(id).addEventListener('change', () => { readForm(); updateSetup(); sendSelf(); });
$('btnSettings').addEventListener('click', () => { fillForm(); openSheet('setup'); });
$('statusBtn').addEventListener('click', () => { fillForm(); openSheet('setup'); });

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
    r.onerror = () => reject(new Error('Datei lässt sich nicht lesen.'));
    r.readAsDataURL(file);
  });
}

async function loadFile(file) {
  const msg = $('setupMsg');
  readForm();
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith('.zip')) {
      const r = await postJson('/api/eud/package', { data: await fileBase64(file) });
      if (r.server) {
        if (r.server.host !== profile.host) profile.fingerprint = '';
        Object.assign(profile, { host: r.server.host, port: r.server.port, proto: r.server.proto });
      }
      if (r.certPem) Object.assign(profile, { certPem: r.certPem, keyPem: r.keyPem, certInfo: r.info });
      addCas(r.caPems);
      saveProfile();
      fillForm();
      setMsg(msg, 'Datenpaket geladen' + (r.server ? ': ' + r.server.host : '') + (r.enroll && !r.certPem ? ' – jetzt Benutzer/Passwort eintragen und Zertifikat anfordern.' : '.'), true);
    } else if (/\.(p12|pfx)$/.test(name)) {
      const data = await fileBase64(file);
      let r = null;
      for (const pw of ['atakatak', null]) {
        const password = pw != null ? pw : prompt('Passwort der Datei ' + file.name + ':');
        if (password == null) return;
        try { r = await postJson('/api/eud/p12', { data, password }); break; } catch (e) { if (pw == null) throw e; }
      }
      if (r.kind === 'client') Object.assign(profile, { certPem: r.certPem, keyPem: r.keyPem, certInfo: r.info });
      addCas(r.caPems);
      saveProfile();
      updateSetup();
      setMsg(msg, r.kind === 'client' ? 'Zertifikat geladen.' : `Truststore geladen (${r.caPems.length} CA).`, true);
    } else {
      const text = await file.text();
      const r = await postJson('/api/eud/pem', { data: text });
      addCas(r.caPems);
      saveProfile();
      updateSetup();
      setMsg(msg, `Truststore geladen (${r.caPems.length} CA).`, true);
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
    }
  };
  if (/^tak:\/\//i.test(text)) {
    const u = new URL(text.replace(/^tak:/i, 'https:'));
    if (!/enroll/i.test(u.pathname)) throw new Error('Dieser TAK-Code wird nicht unterstützt (nur Enrollment).');
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
    const [, host, port, proto] = text.split(',').map(s => s.trim());
    Object.assign(out, { host, port: Number(port), proto: proto.toLowerCase() === 'quic' ? 'ssl' : proto.toLowerCase() });
  } else if (/^[\w.-]+:\d+(:\w+)?$/.test(text)) {
    const [host, port, proto] = text.split(':');
    Object.assign(out, { host, port: Number(port), proto: (proto || 'ssl').toLowerCase() });
  } else {
    throw new Error('Unbekannter QR-Code.');
  }
  if (out.proto && !['ssl', 'tcp', 'udp'].includes(out.proto)) out.proto = 'ssl';
  if (!out.host) throw new Error('Im QR-Code steht kein Server.');
  return out;
}

async function applyConfig(cfg, auto) {
  if (cfg.host !== profile.host) {
    profile.fingerprint = '';
    // Anderer Server: altes Zertifikat passt nicht mehr
    if (profile.host) Object.assign(profile, { certPem: '', keyPem: '', certInfo: null, caPems: [] });
  }
  profile.host = cfg.host;
  if (cfg.port) profile.port = cfg.port;
  if (cfg.proto) profile.proto = cfg.proto;
  if (cfg.enrollPort) profile.enrollPort = cfg.enrollPort;
  if (cfg.username) profile.username = cfg.username;
  if (cfg.callsign && !profile.callsign) profile.callsign = cfg.callsign;
  saveProfile();
  fillForm();
  openSheet('setup');
  if (cfg.password) $('fPass').value = cfg.password;
  setMsg($('setupMsg'), 'Serverdaten übernommen.', true);
  if (auto && cfg.username && cfg.password && profile.proto === 'ssl') {
    const ok = await requestCert(cfg.password);
    if (ok && profile.callsign) connect();
    else if (ok) { setMsg($('setupMsg'), 'Zertifikat erhalten. Rufnamen eintragen und „Verbinden“.', true); $('fCallsign').focus(); }
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
    openSheet('setup');
    setMsg($('setupMsg'), e.message);
  }
}
async function startScan() {
  $('scanner').classList.remove('hidden');
  $('scanMsg').textContent = 'QR-Code in den Rahmen halten';
  const video = $('scanVideo');
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = scanStream;
    await video.play();
    const tick = () => {
      if (!scanStream) return;
      if (video.readyState >= 2) {
        const text = decodeImage(video, video.videoWidth, video.videoHeight);
        if (text) return onQr(text);
      }
      scanRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    $('scanMsg').textContent = 'Kamera nicht verfügbar – „Foto wählen“ nutzen.';
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
    else $('scanMsg').textContent = 'Kein QR-Code im Foto gefunden.';
  };
  img.src = URL.createObjectURL(f);
});

// ---------------- Sonstiges ----------------

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
  toast('Lagebild geleert.');
});
$('resetBtn').addEventListener('click', () => {
  if (!confirm('Alle Daten auf diesem Gerät löschen (Zertifikate, Server, Lagebild)?')) return;
  disconnect();
  for (const k of ['eud.profile', 'eud.picture', 'eud.chat', 'eud.outbox', 'eud.view']) store.del(k);
  location.reload();
});

// Sichtbaren Kartenausschnitt für offline speichern
function tileUrls() {
  const layer = LAYERS[profile.tiles] || LAYERS.OSM;
  const b = map.getBounds();
  const z0 = map.getZoom();
  const zMax = Math.min(layer.options.maxZoom, z0 + 3);
  const urls = [];
  for (let z = Math.max(1, z0 - 2); z <= zMax; z++) {
    const n = 2 ** z;
    const x = lon => Math.floor((lon + 180) / 360 * n);
    const y = lat => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
    for (let tx = Math.max(0, x(b.getWest())); tx <= Math.min(n - 1, x(b.getEast())); tx++) {
      for (let ty = Math.max(0, y(b.getNorth())); ty <= Math.min(n - 1, y(b.getSouth())); ty++) {
        urls.push(layer.getTileUrl({ x: tx, y: ty, z }));
        if (urls.length > 3000) return null;
      }
    }
  }
  return urls;
}
$('prefetchBtn').addEventListener('click', async () => {
  const msg = $('prefetchMsg');
  const urls = tileUrls();
  if (!urls) return setMsg(msg, 'Ausschnitt zu groß – bitte näher heranzoomen.');
  const reg = navigator.serviceWorker && await navigator.serviceWorker.ready.catch(() => null);
  if (!reg || !reg.active) return setMsg(msg, 'Offline-Speicher nicht verfügbar (nur über HTTPS).');
  const ch = new MessageChannel();
  ch.port1.onmessage = e => {
    const d = e.data;
    setMsg(msg, d.finished ? `Fertig: ${d.done - d.failed} Kacheln gespeichert${d.failed ? `, ${d.failed} fehlgeschlagen` : ''}.` : `Speichere … ${d.done} / ${d.total}`, !d.failed || !d.finished);
  };
  setMsg(msg, `Speichere … 0 / ${urls.length}`, true);
  reg.active.postMessage({ type: 'prefetch', urls }, [ch.port2]);
});

// ======================================================================
// Start
// ======================================================================

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

loadPicture();
renderChat();
fillForm();
updateStatus();

// Vorgaben aus dem QR-Code des Admins (…/eud/#host=…) oder vom Server
(async () => {
  const hash = location.hash.slice(1);
  if (hash) {
    history.replaceState(null, '', location.pathname);
    try {
      const cfg = parseQr(location.origin + location.pathname + '#' + hash);
      if (cfg.host !== location.hostname || new URLSearchParams(hash).has('host')) {
        if (!profile.host || cfg.host === profile.host || confirm(`Server auf ${cfg.host} umstellen?`)) await applyConfig(cfg, true);
      }
    } catch (e) { /* ungültig */ }
  } else if (!profile.host) {
    try {
      const r = await fetch('/api/eud/config').then(x => x.json());
      if (r.preset && r.preset.host) {
        Object.assign(profile, { host: r.preset.host, port: r.preset.port, proto: r.preset.proto, enrollPort: r.preset.enrollPort });
        saveProfile();
      }
    } catch (e) { /* offline */ }
  }
  fillForm();
  if (!profile.host || !profile.callsign || (profile.proto === 'ssl' && !profile.certPem && !profile.auto)) openSheet('setup');
  if (profile.auto) openWs();
  if (profile.wake) wakeLock();
})();
