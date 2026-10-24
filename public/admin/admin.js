// Helm Camera Admin
// Alle Texte aus Streams/Handys werden nur über textContent eingesetzt (kein HTML).

const $ = id => document.getElementById(id);
const POLL_MS = 2000;
// Drehung: beliebiger Winkel im Uhrzeigersinn, 0 bis 359,5°
const normDeg = v => {
  const r = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(r)) return 0;
  return (Math.round((((r % 360) + 360) % 360) * 2) / 2) % 360;
};
const fmtDeg = v => String(v || 0).replace('.', ',') + '°';

function angleInput(value, cls = 'rot') {
  const i = el('input', { class: cls, type: 'number', min: '0', max: '359.5', step: '0.5', title: 'Drehung in Grad (im Uhrzeigersinn)' });
  i.value = String(value || 0);
  return i;
}

const SIZES = [[1, '160x120 – sehr schnell'], [5, '320x240'], [8, '640x480 – langsam'], [11, '1280x720 – nur Handy-Kamera']];
function sizeSelect(value, cls = '') {
  const sel = el('select', { class: cls, title: 'Bildgröße (gilt sofort am Handy)' });
  for (const [v, t] of SIZES) sel.append(el('option', { value: String(v), text: t }));
  sel.value = String(value || 1);
  return sel;
}

function fitSelect(value) {
  const sel = el('select', { title: 'Bei schrägen Winkeln' });
  sel.append(el('option', { value: 'fill', text: 'Füllen (Rand abschneiden)' }), el('option', { value: 'fit', text: 'Ganzes Bild (schwarze Ecken)' }));
  sel.value = value === 'fit' ? 'fit' : 'fill';
  return sel;
}

// Änderungen beim Schieben gesammelt senden (nicht bei jedem Pixel)
const pendingOpts = new Map();
function sendOptionsSoon(id, opts) {
  const p = pendingOpts.get(id) || { opts: {} };
  clearTimeout(p.timer);
  Object.assign(p.opts, opts);
  p.timer = setTimeout(() => {
    pendingOpts.delete(id);
    setOptions(id, p.opts);
  }, 250);
  pendingOpts.set(id, p);
}

let me = null;
let lastLoginPassword = '';
let streams = [];
let pollTimer = null;
const rows = new Map();     // id -> { tr, cells }
const windows = new Map();  // id -> Fenster
let zTop = 500;
let winOffset = 0;

// ======================================================================
// API
// ======================================================================

class ApiError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/admin/' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'helm', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* leer */ }
  if (res.status === 401 && path !== 'login') {
    showAuth('login');
    throw new ApiError(data.error || 'Bitte anmelden.');
  }
  if (res.status === 403 && data.mustChange) {
    showFirst();
    throw new ApiError(data.error);
  }
  if (!res.ok) throw new ApiError(data.error || 'Fehler ' + res.status);
  return data;
}

function setMsg(el, text, ok) {
  el.textContent = text || '';
  el.className = 'msg' + (text ? (ok ? ' ok' : ' err') : '');
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const t = el('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = 'Kopiert';
    setTimeout(() => { btn.textContent = old; }, 1200);
  }
}

function copyField(value) {
  const input = el('input', { readonly: '', value });
  input.addEventListener('focus', () => input.select());
  const btn = el('button', { class: 'sm', type: 'button', text: 'Kopieren' });
  btn.addEventListener('click', () => copy(input.value, btn));
  return { input, btn };
}

// ======================================================================
// Anmeldung
// ======================================================================

function showAuth(which) {
  stopPolling();
  $('appView').classList.add('hidden');
  $('authView').classList.remove('hidden');
  for (const f of ['loginForm', 'forgotForm', 'resetForm', 'firstForm']) $(f).classList.toggle('hidden', f !== which + 'Form');
  const first = $(which + 'Form').querySelector('input:not([type=hidden])');
  if (first) first.focus();
}

function showFirst() {
  showAuth('first');
  $('xUser').value = me ? me.username : 'admin';
  $('xMail').value = me ? me.email || '' : '';
  $('xCurWrap').classList.toggle('hidden', !!lastLoginPassword);
  $('xCur').required = !lastLoginPassword;
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  setMsg($('loginMsg'), '');
  try {
    const r = await api('login', { method: 'POST', body: { username: $('lUser').value, password: $('lPass').value } });
    lastLoginPassword = $('lPass').value;
    $('lPass').value = '';
    me = await api('me');
    if (r.mustChange) showFirst(); else showApp();
  } catch (err) {
    setMsg($('loginMsg'), err.message);
  }
});

$('forgotLink').addEventListener('click', e => { e.preventDefault(); showAuth('forgot'); });
for (const a of document.querySelectorAll('.backLink')) {
  a.addEventListener('click', e => { e.preventDefault(); history.replaceState(null, '', location.pathname); showAuth('login'); });
}

$('forgotForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('forgot', { method: 'POST', body: { username: $('fUser').value } });
    setMsg($('forgotMsg'), 'Wenn die Angaben stimmen und SMTP eingerichtet ist, kommt gleich eine E-Mail mit dem Link.', true);
  } catch (err) {
    setMsg($('forgotMsg'), err.message);
  }
});

$('resetForm').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('rPass').value !== $('rPass2').value) return setMsg($('resetMsg'), 'Die Passwörter stimmen nicht überein.');
  const token = new URLSearchParams(location.hash.slice(1)).get('reset');
  try {
    await api('reset', { method: 'POST', body: { token, password: $('rPass').value } });
    history.replaceState(null, '', location.pathname);
    showAuth('login');
    setMsg($('loginMsg'), 'Passwort geändert. Bitte neu anmelden.', true);
  } catch (err) {
    setMsg($('resetMsg'), err.message);
  }
});

$('firstForm').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('xPass').value !== $('xPass2').value) return setMsg($('firstMsg'), 'Die Passwörter stimmen nicht überein.');
  try {
    await api('credentials', {
      method: 'POST',
      body: {
        current: lastLoginPassword || $('xCur').value,
        username: $('xUser').value,
        email: $('xMail').value,
        password: $('xPass').value,
      },
    });
    lastLoginPassword = '';
    me = await api('me');
    showApp();
  } catch (err) {
    setMsg($('firstMsg'), err.message);
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('logout', { method: 'POST', body: {} }); } catch (e) { /* egal */ }
  for (const w of [...windows.values()]) w.close();
  me = null;
  showAuth('login');
});

// ======================================================================
// Übersicht
// ======================================================================

// ---- Seitenleiste (wie das ATAK-Menü): immer nur ein Bereich sichtbar ----
const VIEW_TITLES = { users: 'Benutzer & Anfragen', teams: 'Teams & Sichtbarkeit', ots: 'OpenTAKServer & Registrierung' };
const TAK_TAB = { users: 'users', teams: 'teams', ots: 'settings' };
function showView(view) {
  if (!document.querySelector(`[data-nav="${view}"]`)) view = 'users';
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('on', a.dataset.nav === view);
  for (const sec of document.querySelectorAll('[data-view]')) sec.classList.toggle('hidden', !sec.dataset.view.split(' ').includes(view));
  if (TAK_TAB[view]) {
    const b = document.querySelector(`[data-takt="${TAK_TAB[view]}"]`);
    if (b) b.click();
    $('takTitle').textContent = VIEW_TITLES[view];
  }
  if (view === 'system') renderSystem();
  document.dispatchEvent(new CustomEvent('admin-view', { detail: view }));
  if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
  document.body.classList.remove('navopen');
  try { localStorage.setItem('webtak.adminView', view); } catch (e) { /* privat */ }
}
for (const a of document.querySelectorAll('[data-nav]')) {
  a.addEventListener('click', e => { e.preventDefault(); showView(a.dataset.nav); });
}
$('navToggle').addEventListener('click', () => document.body.classList.toggle('navopen'));

function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  let view = location.hash.slice(1);
  if (!view || view.startsWith('reset=')) { try { view = localStorage.getItem('webtak.adminView') || 'users'; } catch (e) { view = 'users'; } }
  showView(view);
  $('noFfmpeg').classList.toggle('hidden', !!me.ffmpeg);
  loadRegistration();
  loadTak();
  loadEudLinks();
  if (window.loadTakUsers) window.loadTakUsers();
  refresh();
  startPolling();
}

// ---- allgemeiner QR-Code + Selbst-Anmeldung --------------------------------
async function loadRegistration() {
  try {
    const r = await api('registration');
    $('regToggle').checked = r.enabled;
    liveMode = r.liveMode;
    $('liveToggle').checked = liveMode === 'admin';
    $('userStartToggle').checked = !!r.userCanStart;
    $('userStartWrap').classList.toggle('hidden', liveMode !== 'admin');
    $('liveOffAllBtn').classList.toggle('hidden', liveMode !== 'admin');
    $('appUrl').value = r.appUrl;
    if (document.activeElement !== $('baseUrl')) $('baseUrl').value = r.publicUrl;
    $('baseUrl').placeholder = 'automatisch: ' + r.autoUrl;
    $('appQr').src = '/api/admin/app-qr.svg?t=' + Date.now();
    $('appQr').closest('.appqr').classList.toggle('off', !r.enabled);
  } catch (e) { /* angezeigt durch api() */ }
}

$('userStartToggle').addEventListener('change', async () => {
  const on = $('userStartToggle').checked;
  try {
    await api('live-mode', { method: 'POST', body: { userCanStart: on } });
    setMsg($('regMsg'), on ? 'Nutzer können selbst starten – du bekommst einen Hinweis.' : 'Nur der Admin schaltet live.', true);
  } catch (e) { setMsg($('regMsg'), e.message); }
});

// ======================================================================
// Hinweise: Popup + Ton + Desktop-Benachrichtigung
// ======================================================================

function beep() {
  try {
    const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
    [0, 0.18].forEach(t => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.16);
    });
  } catch (e) { /* kein Ton möglich */ }
}

function showToast(ev) {
  const s = streams.find(x => sid(x) === ev.id);
  const time = new Date(ev.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const close = () => t.remove();
  const btns = el('div', { class: 'row' });
  if (ev.kind === 'takreg') {
    btns.append(el('button', { class: 'sm pri', text: 'Anfragen öffnen', onclick: () => { showView('users'); if (window.loadTakUsers) window.loadTakUsers(); close(); } }));
    if (window.loadTakUsers) window.loadTakUsers();
  }
  if (s) {
    btns.append(el('button', { class: 'sm pri', text: 'Ansehen', onclick: () => { openWindow(ev.id); close(); } }));
    if (liveMode === 'admin' && !s.onAir && ev.kind !== 'stop') {
      btns.append(el('button', { class: 'sm golive', text: '▶ Live', onclick: () => { setLive(ev.id, true); close(); } }));
    }
  }
  btns.append(el('button', { class: 'sm', text: 'OK', onclick: close }));
  const t = el('div', { class: 'toast ' + ev.kind },
    el('div', { class: 'toast-head' }, el('b', { text: ev.text }), el('span', { class: 'mut small', text: time })),
    btns);
  $('toasts').prepend(t);
  setTimeout(close, 30000);
  if (ev.kind !== 'stop') beep();
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('WebTAK', { body: ev.text, tag: ev.id }); } catch (e) { /* nicht unterstützt */ }
  }
}

function updateNotifyBtn() {
  const b = $('notifyBtn');
  if (!('Notification' in window) || !window.isSecureContext) { b.classList.add('hidden'); return; }
  b.textContent = Notification.permission === 'granted' ? '🔔 Hinweise an' : '🔔 Hinweise';
  b.title = Notification.permission === 'granted' ? 'Desktop-Benachrichtigungen sind erlaubt'
    : 'Desktop-Benachrichtigungen erlauben (auch wenn dieses Fenster im Hintergrund ist)';
}
$('notifyBtn').addEventListener('click', async () => {
  beep(); // Ton einmal freischalten (Browser erlauben Ton erst nach einem Klick)
  if ('Notification' in window && Notification.permission !== 'granted') await Notification.requestPermission();
  updateNotifyBtn();
});
updateNotifyBtn();

$('liveToggle').addEventListener('change', async () => {
  const admin = $('liveToggle').checked;
  try {
    await api('live-mode', { method: 'POST', body: { mode: admin ? 'admin' : 'user' } });
    setMsg($('regMsg'), admin ? 'Admin schaltet live: Nutzer warten auf „▶ Live“.' : 'Nutzer starten den Stream selbst.', true);
    await loadRegistration();
    await refresh();
  } catch (e) { setMsg($('regMsg'), e.message); }
});

$('regToggle').addEventListener('change', async () => {
  const enabled = $('regToggle').checked;
  try {
    await api('registration', { method: 'POST', body: { enabled } });
    setMsg($('regMsg'), enabled ? 'Selbst-Anmeldung erlaubt.' : 'Selbst-Anmeldung gesperrt – neue Nutzer können sich nicht mehr anmelden.', enabled);
    loadRegistration();
  } catch (e) { setMsg($('regMsg'), e.message); }
});
$('appUrlCopy').addEventListener('click', () => copy($('appUrl').value, $('appUrlCopy')));

async function saveBase(url) {
  try {
    const r = await api('public-url', { method: 'POST', body: { url } });
    setMsg($('regMsg'), r.publicUrl ? 'Adresse gespeichert: ' + r.publicUrl + ' – QR-Code und Links sind angepasst.'
      : 'Adresse wieder automatisch.', true);
    await loadRegistration();
    await refresh();
    me = await api('me');
  } catch (e) { setMsg($('regMsg'), e.message); }
}
$('baseForm').addEventListener('submit', e => { e.preventDefault(); saveBase($('baseUrl').value); });
$('baseAuto').addEventListener('click', () => { $('baseUrl').value = ''; saveBase(''); });
$('appQrBig').addEventListener('click', () => {
  const img = el('img', { class: 'qr', alt: 'QR-Code zur Handy-Seite', src: '/api/admin/app-qr.svg?t=' + Date.now() });
  const print = el('button', { type: 'button', text: 'Drucken', onclick: () => {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) return;
    const d = w.document;
    d.title = 'WebTAK Kamera';
    d.body.style.fontFamily = 'system-ui, sans-serif';
    d.body.style.textAlign = 'center';
    const h = d.createElement('h1'); h.textContent = 'Helmkamera';
    const i = d.createElement('img'); i.src = img.src; i.style.width = '340px';
    const t = d.createElement('p'); t.textContent = '1. Scannen  2. Name und Einheit eingeben  3. Kamera verbinden  4. Stream starten';
    const t2 = d.createElement('p'); t2.textContent = 'Android: Chrome · iPhone: App „Bluefy“';
    d.body.append(h, i, t, t2);
    i.onload = () => w.print();
  } });
  openModal('QR-Code für alle Nutzer', img, el('p', { class: 'mut small', text: $('appUrl').value }), el('div', { class: 'row' }, print));
});

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refresh, POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

let eventSeq = -1; // letzte gesehene Hinweis-Nummer (-1 = noch keine Abfrage)

async function refresh() {
  try {
    const data = await api('streams' + (eventSeq >= 0 ? '?since=' + eventSeq : ''));
    streams = data.streams;
    if (data.takVideo) { takVideo = data.takVideo; renderTakVideo(); }
    render();
    for (const ev of data.events || []) showToast(ev);
    eventSeq = data.eventSeq;
  } catch (e) {
    if (!(e instanceof ApiError)) console.warn(e);
  }
}

const sid = s => s.user + '/' + s.streamId;

// ---------- Streams automatisch in den TAK-Server (OpenTAKServer/MediaMTX) ----------
let takVideo = { ready: false, auto: true, when: 'all', prefix: 'cam' };

function renderTakVideo() {
  $('tvAuto').checked = !!takVideo.auto;
  if (document.activeElement !== $('tvWhen')) $('tvWhen').value = takVideo.when;
  if (document.activeElement !== $('tvPrefix')) $('tvPrefix').value = takVideo.prefix || '';
  const inTak = streams.filter(s => s.tak && s.tak.inTak).length;
  const errs = streams.filter(s => s.tak && s.tak.error).length;
  $('tvStatus').textContent = !takVideo.ready ? 'OpenTAKServer ist nicht verbunden – unter „OpenTAKServer & Registrierung“ eintragen.'
    : `${inTak} von ${streams.length} Stream${streams.length === 1 ? '' : 's'} im TAK-Server` + (errs ? ` · ${errs} Fehler (Punkt antippen)` : '');
  $('tvStatus').className = 'small ' + (!takVideo.ready || errs ? 'warn' : 'mut');
}

async function setTak(id, body) {
  try {
    await api(streamPath(id) + '/tak', { method: 'POST', body });
  } catch (e) { alert(e.message); }
  await refresh();
}

async function saveTakVideo(body) {
  try {
    takVideo = { ...takVideo, ...await api('takvideo/settings', { method: 'POST', body }) };
    renderTakVideo();
  } catch (e) { alert(e.message); }
}
$('tvAuto').addEventListener('change', () => saveTakVideo({ auto: $('tvAuto').checked }));
$('tvWhen').addEventListener('change', () => saveTakVideo({ when: $('tvWhen').value }));
$('tvPrefix').addEventListener('change', () => saveTakVideo({ prefix: $('tvPrefix').value }));
$('tvSync').addEventListener('click', async () => {
  $('tvSync').disabled = true;
  try {
    const r = await api('takvideo/sync', { method: 'POST', body: {} });
    if (r.errors && r.errors.length) alert('Abgleich mit Fehlern:\n\n' + r.errors.join('\n'));
    else if (r.error) alert(r.error);
  } catch (e) { alert(e.message); }
  $('tvSync').disabled = false;
  await refresh();
});

let liveMode = 'admin'; // "admin" = Admin schaltet live, "user" = Nutzer startet selbst

function state(s) {
  if (!s.enabled) return ['Gesperrt', 'stop'];
  if (s.receiving) return ['Live', 'live'];
  if (liveMode === 'admin' && s.onAir && s.phoneConnected) return ['Live angefordert', 'wait'];
  if (s.ready) return ['Bereit', 'ready'];
  if (s.phoneConnected) return ['Verbunden', 'wait'];
  return ['Offline', 'off'];
}

async function setLive(id, on) {
  try {
    await api(streamPath(id) + '/live', { method: 'POST', body: { on } });
    await refresh();
  } catch (e) { alert(e.message); }
}

function ago(iso) {
  if (!iso) return '–';
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'vor ' + sec + ' s';
  if (sec < 3600) return 'vor ' + Math.round(sec / 60) + ' min';
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
}

function buildRow(s) {
  const id = sid(s);
  const c = {};
  const td = (label, cls) => el('td', { 'data-label': label, class: cls || '' });
  c.status = td('Status');
  c.badge = el('span', { class: 'badge' });
  c.status.append(c.badge);
  c.name = td('Stream', 'name');
  c.label = el('b');
  c.path = el('code', { text: id });
  c.name.append(c.label, c.path);
  c.camera = td('Kamera');
  c.fps = td('Bilder/s', 'num');
  c.viewers = td('Zuschauer', 'num');
  c.last = td('Letztes Bild');
  c.rotTd = td('Drehung');
  c.rot = angleInput(s.rotate);
  c.rot.addEventListener('change', () => setOptions(id, { rotate: normDeg(c.rot.value) }));
  c.rotTd.append(el('span', { class: 'deg' }, c.rot, '°'));
  c.sizeTd = td('Bildgröße');
  c.size = sizeSelect(s.framesize, 'rot-size');
  c.size.addEventListener('change', () => setOptions(id, { framesize: +c.size.value }));
  c.sizeTd.append(c.size);
  // TAK-Pfad: Stream steht automatisch als Video-Feed im TAK-Server; hier nur den Pfad pflegen
  c.link = td('TAK-Pfad');
  c.takOn = el('input', { type: 'checkbox', title: 'Im TAK-Server als Video-Feed eintragen', onchange: () => setTak(id, { enabled: c.takOn.checked }) });
  c.takPath = el('input', { class: 'tak-path', placeholder: 'automatisch', autocomplete: 'off', spellcheck: 'false' });
  const savePath = () => { if (c.takPath.value.trim() !== (c.takPathOld || '')) setTak(id, { path: c.takPath.value }); };
  c.takPath.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); c.takPath.blur(); } });
  c.takPath.addEventListener('change', savePath);
  c.takDot = el('span', { class: 'tak-dot' });
  c.link.append(el('div', { class: 'link' }, c.takOn, c.takDot, c.takPath));
  c.actions = td('', '');
  c.onair = el('button', { class: 'sm', onclick: () => {
    const cur = streams.find(x => sid(x) === id);
    if (cur) setLive(id, !cur.onAir);
  } });
  c.view = el('button', { class: 'sm pri', text: 'Ansehen', onclick: () => openWindow(id) });
  c.qr = el('button', { class: 'sm', text: 'QR / Links', onclick: () => showQr(id) });
  c.toggle = el('button', { class: 'sm', onclick: () => toggleStream(id) });
  c.revoke = el('button', { class: 'sm danger', text: 'Rauswerfen', onclick: () => revokeStream(id) });
  c.remove = el('button', { class: 'sm danger', text: 'Löschen', onclick: () => removeStream(id) });
  c.actions.append(el('div', { class: 'btns' }, c.onair, c.view, c.qr, c.toggle, c.revoke, c.remove));
  const tr = el('tr', {}, c.status, c.name, c.camera, c.fps, c.viewers, c.last, c.rotTd, c.sizeTd, c.link, c.actions);
  return { tr, c };
}

function updateRow(r, s) {
  const c = r.c;
  const [text, cls] = state(s);
  c.badge.textContent = text;
  c.badge.className = 'badge ' + cls;
  c.label.textContent = s.label || s.user;
  c.camera.textContent = s.camera || '–';
  c.fps.textContent = s.receiving ? s.fps.toFixed(1) : '–';
  c.viewers.textContent = String(s.viewers);
  c.last.textContent = ago(s.lastFrameAt);
  if (document.activeElement !== c.rot && !pendingOpts.has(sid(s))) c.rot.value = String(s.rotate || 0);
  c.rotTd.title = (s.mirror ? 'gespiegelt, ' : '') + (s.fit === 'fit' ? 'ganzes Bild' : 'füllen');
  if (document.activeElement !== c.size) c.size.value = String(s.framesize || 1);
  const t = s.tak || {};
  c.takOn.checked = !!t.enabled;
  c.takOn.disabled = !takVideo.ready;
  if (document.activeElement !== c.takPath) { c.takPath.value = t.path || ''; c.takPathOld = t.path || ''; }
  c.takPath.disabled = !takVideo.ready;
  const takState = !takVideo.ready ? ['off', 'OpenTAKServer nicht verbunden (Menü: OpenTAKServer & Registrierung)']
    : t.error ? ['err', 'Fehler: ' + t.error]
      : t.inTak ? ['ok', 'Im TAK-Server: ' + (t.rtsp || t.path)]
        : t.enabled ? ['wait', takVideo.when === 'live' ? 'Wird eingetragen, sobald die Kamera sendet' : 'Wird eingetragen …'] : ['off', 'Nicht im TAK-Server'];
  c.takDot.className = 'tak-dot ' + takState[0];
  c.takDot.title = takState[1];
  c.link.title = takState[1];
  c.toggle.textContent = s.enabled ? 'Sperren' : 'Freigeben';
  c.onair.textContent = s.onAir ? '■ Live aus' : '▶ Live';
  c.onair.className = 'sm ' + (s.onAir ? 'danger' : 'golive');
  c.onair.classList.toggle('hidden', liveMode !== 'admin' || !s.enabled);
}

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const visible = streams.filter(s => !q || [s.user, s.streamId, s.label, s.camera].join(' ').toLowerCase().includes(q));
  const ids = new Set(streams.map(sid));
  for (const [id, r] of rows) if (!ids.has(id)) { r.tr.remove(); rows.delete(id); }
  const tbody = $('rows');
  for (const s of visible) {
    const id = sid(s);
    let r = rows.get(id);
    if (!r) { r = buildRow(s); rows.set(id, r); }
    updateRow(r, s);
    tbody.append(r.tr); // hängt in sortierter Reihenfolge an
  }
  for (const [id, r] of rows) if (!visible.some(s => sid(s) === id)) r.tr.remove();
  $('empty').classList.toggle('hidden', streams.length > 0);
  const live = streams.filter(s => s.enabled && s.receiving).length;
  $('summary').textContent = `${live} live · ${streams.length} Stream${streams.length === 1 ? '' : 's'}`;
  $('navLive').textContent = live ? String(live) : '';
  for (const [id, w] of windows) {
    const s = streams.find(x => sid(x) === id);
    if (!s) w.close(); else w.update(s);
  }
}

$('filter').addEventListener('input', render);

$('createForm').addEventListener('submit', async e => {
  e.preventDefault();
  setMsg($('createMsg'), '');
  try {
    const r = await api('streams', { method: 'POST', body: { user: $('cUser').value, label: $('cLabel').value } });
    $('cUser').value = '';
    $('cLabel').value = '';
    await refresh();
    showQr(sid(r.stream));
  } catch (err) {
    setMsg($('createMsg'), err.message);
  }
});

const streamPath = id => 'streams/' + id.split('/').map(encodeURIComponent).join('/');

async function setOptions(id, opts) {
  try {
    await api(streamPath(id) + '/options', { method: 'POST', body: opts });
    await refresh();
  } catch (e) { alert(e.message); }
}

async function toggleStream(id) {
  const s = streams.find(x => sid(x) === id);
  if (!s) return;
  try {
    await api(streamPath(id) + (s.enabled ? '/stop' : '/start'), { method: 'POST', body: {} });
    await refresh();
  } catch (e) { alert(e.message); }
}

async function revokeStream(id) {
  if (!confirm(`Handy von „${id}“ rauswerfen?\n\nDas Handy wird sofort getrennt und der alte QR-Code gilt nicht mehr. Der Stream-Link für ATAK bleibt gleich. Danach wird ein neuer QR-Code angezeigt.`)) return;
  try {
    await api(streamPath(id) + '/revoke', { method: 'POST', body: {} });
    await refresh();
    showQr(id);
  } catch (e) { alert(e.message); }
}

async function removeStream(id) {
  if (!confirm(`Stream „${id}“ endgültig löschen?\n\nDas Handy wird getrennt, Link und QR-Code funktionieren nicht mehr.`)) return;
  try {
    await api(streamPath(id), { method: 'DELETE', body: {} });
    if (windows.has(id)) windows.get(id).close();
    await refresh();
  } catch (e) { alert(e.message); }
}

$('liveOffAllBtn').addEventListener('click', async () => {
  try {
    await api('streams/live-off-all', { method: 'POST', body: {} });
    await refresh();
  } catch (e) { alert(e.message); }
});

$('stopAllBtn').addEventListener('click', async () => {
  if (!confirm('ALLE Streams sperren?\n\nAlle Handys werden getrennt. Einzelne Streams kann man danach mit „Freigeben“ wieder erlauben.')) return;
  try {
    await api('streams/stop-all', { method: 'POST', body: {} });
    await refresh();
  } catch (e) { alert(e.message); }
});

// ======================================================================
// Dialoge
// ======================================================================

function openModal(title, ...content) {
  $('modalTitle').textContent = title;
  $('modalBody').replaceChildren(...content.filter(Boolean));
  $('modal').classList.remove('hidden');
}

function closeModal() {
  $('modal').classList.add('hidden');
  $('modalBody').replaceChildren();
}

$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').classList.contains('hidden')) closeModal(); });

function showQr(id) {
  const s = streams.find(x => sid(x) === id);
  if (!s) return;
  const img = el('img', { class: 'qr', alt: 'QR-Code für die Handy-App', src: '/api/admin/' + streamPath(id) + '/qr.svg?t=' + Date.now() });
  const dl = el('dl', { class: 'links' });
  const add = (label, value) => {
    const f = copyField(value);
    dl.append(el('dt', { text: label }), el('dd', {}, f.input, f.btn));
  };
  add('Stream-Link für ATAK/WinTAK (MJPEG)', s.links.stream);
  if (me.ffmpeg) {
    add('HLS – als „Quelle“ in OpenTAKServer/MediaMTX eintragen', s.links.hls);
    add('Alternativ MPEG-TS', s.links.ts);
  }
  add('Einzelbild', s.links.snapshot);
  add('Handy-App (enthält den Zugangsschlüssel – nur an den Benutzer geben)', s.links.app);
  const hint = el('p', { class: 'mut small', text: !me.ffmpeg
    ? 'Für OpenTAKServer (MediaMTX) wird der HLS-Link gebraucht – dafür ffmpeg auf dem Server installieren.'
    : s.tak && s.tak.inTak ? `Im TAK-Server eingetragen als „${s.tak.path}“ – ATAK: ${s.tak.rtsp}`
      : 'Der Stream wird automatisch im OpenTAKServer eingetragen (Spalte „TAK-Pfad“), sobald der verbunden ist.' });
  const caBox = me.testCa ? el('div', { class: 'card', style: 'margin-top:12px' },
    el('b', { text: 'Testbetrieb: Zertifikat fürs Handy' }),
    el('p', { class: 'mut small', text: 'Einmal pro Handy: QR-Code scannen, Datei laden. Android: Einstellungen → Sicherheit → '
      + 'Verschlüsselung & Anmeldedaten → Zertifikat installieren → CA-Zertifikat → Datei wählen. '
      + 'iPhone: Profil laden, unter Einstellungen → Allgemein → VPN & Geräteverwaltung installieren und unter '
      + 'Info → Zertifikatsvertrauenseinstellungen „volles Vertrauen“ einschalten. '
      + 'Die Warnung beim ersten Öffnen mit „Erweitert → Weiter“ bestätigen.' }),
    el('img', { class: 'qr', alt: 'QR-Code Zertifikat', src: '/api/admin/ca-qr.svg', style: 'max-width:200px' }),
    el('a', { href: me.publicBase + '/ca.crt', text: me.publicBase + '/ca.crt' })) : null;
  const print = el('button', { text: 'QR-Code drucken', type: 'button', onclick: () => printQr(s, img.src) });
  openModal('QR-Code: ' + (s.label || s.user),
    el('p', { class: 'mut small', text: `Diesen QR-Code dem Benutzer „${s.user}“ geben. Er öffnet die Handy-App, verbindet die Helmkamera per Bluetooth und sendet die Bilder an diesen Stream.` }),
    img, dl, hint, el('div', { class: 'row', style: 'margin-top:12px' }, print), caBox);
}

function printQr(s, src) {
  const w = window.open('', '_blank', 'width=420,height=560');
  if (!w) return;
  const d = w.document;
  d.title = 'QR ' + s.user;
  const h = d.createElement('h2'); h.textContent = s.label || s.user;
  const p = d.createElement('p'); p.textContent = s.user + '/' + s.streamId;
  const img = d.createElement('img'); img.src = src; img.style.width = '320px';
  const t = d.createElement('p'); t.textContent = 'Scannen, Kamera verbinden, Stream starten.';
  d.body.style.fontFamily = 'system-ui, sans-serif';
  d.body.style.textAlign = 'center';
  d.body.append(h, p, img, t);
  img.onload = () => w.print();
}

// System: Standard für neue Streams, Admin-Zugang, SMTP
async function renderSystem() {
  const frag = $('settingsTpl').content.cloneNode(true);
  const cred = frag.querySelector('#credForm');
  const smtp = frag.querySelector('#smtpForm');
  const defs = frag.querySelector('#defaultsForm');
  cred.username.value = me.username;
  cred.email.value = me.email || '';
  const defFit = fitSelect('fill');
  defFit.name = 'fit';
  defs.querySelector('[data-fit]').replaceWith(defFit);
  const defSize = sizeSelect(1);
  defs.querySelector('[data-size]').replaceWith(defSize);
  $('systemCard').replaceChildren(el('h2', { text: 'System' }), defs, cred, smtp);

  try {
    const d = await api('defaults');
    defs.rotate.value = String(d.rotate);
    defs.mirror.checked = d.mirror;
    defFit.value = d.fit;
    defSize.value = String(d.framesize);
  } catch (e) { /* angezeigt durch api() */ }
  defs.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = defs.querySelector('[data-msg]');
    try {
      await api('defaults', { method: 'POST', body: { rotate: normDeg(defs.rotate.value), mirror: defs.mirror.checked, fit: defFit.value, framesize: +defSize.value, applyAll: defs.applyAll.checked } });
      defs.applyAll.checked = false;
      await refresh();
      setMsg(msg, 'Gespeichert.', true);
    } catch (err) { setMsg(msg, err.message); }
  });

  cred.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = cred.querySelector('[data-msg]');
    try {
      await api('credentials', { method: 'POST', body: {
        current: cred.current.value, username: cred.username.value, email: cred.email.value,
        password: cred.password.value || undefined,
      } });
      me = await api('me');
      cred.current.value = '';
      cred.password.value = '';
      setMsg(msg, 'Gespeichert.', true);
    } catch (err) { setMsg(msg, err.message); }
  });

  try {
    const s = await api('smtp');
    smtp.host.value = s.host; smtp.port.value = s.port; smtp.secure.checked = s.secure;
    smtp.user.value = s.user; smtp.from.value = s.from;
    smtp.querySelector('[data-haspass]').textContent = s.hasPass ? '(gespeichert)' : '';
  } catch (e) { /* angezeigt durch api() */ }

  const smtpBody = () => ({
    host: smtp.host.value, port: smtp.port.value, secure: smtp.secure.checked,
    user: smtp.user.value, from: smtp.from.value, pass: smtp.pass.value || undefined,
  });
  smtp.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = smtp.querySelector('[data-msg]');
    try {
      await api('smtp', { method: 'POST', body: smtpBody() });
      if (smtp.pass.value) smtp.querySelector('[data-haspass]').textContent = '(gespeichert)';
      smtp.pass.value = '';
      setMsg(msg, 'Gespeichert.', true);
    } catch (err) { setMsg(msg, err.message); }
  });
  smtp.querySelector('[data-test]').addEventListener('click', async () => {
    const msg = smtp.querySelector('[data-msg]');
    setMsg(msg, 'Sende …', true);
    try {
      await api('smtp', { method: 'POST', body: smtpBody() });
      smtp.pass.value = '';
      await api('smtp/test', { method: 'POST', body: {} });
      setMsg(msg, 'Test-Mail an ' + me.email + ' gesendet.', true);
    } catch (err) { setMsg(msg, err.message); }
  });
}

// ======================================================================
// Video-Fenster: verschieben, Größe ändern, maximieren, minimieren, schließen
// ======================================================================

function openWindow(id) {
  if (windows.has(id)) { windows.get(id).focus(); return; }
  const s = streams.find(x => sid(x) === id);
  if (!s) return;

  const title = el('span', { class: 'win-title' });
  const btnAlign = el('button', { title: 'Bild ausrichten (drehen, spiegeln)', text: '∠ Ausrichten' });
  const btnLive = el('button', { title: 'Live schalten / beenden' });
  btnLive.addEventListener('click', () => {
    const cur = streams.find(x => sid(x) === id);
    if (cur) setLive(id, !cur.onAir);
  });
  const btnFull = el('button', { title: 'Vollbild am Bildschirm', text: '⛶' });
  const btnMin = el('button', { title: 'Minimieren', text: '–' });
  const btnMax = el('button', { title: 'Maximieren', text: '□' });
  const btnClose = el('button', { title: 'Schließen', text: '✕' });
  const bar = el('div', { class: 'win-bar' }, title, btnLive, btnAlign, btnFull, btnMin, btnMax, btnClose);

  // Ausrichten: Regler 0–359,5°, Feinschritte, Spiegeln, Füllen/Ganzes Bild
  const range = el('input', { type: 'range', min: '0', max: '359.5', step: '0.5', class: 'grow', 'aria-label': 'Drehung' });
  const num = angleInput(s.rotate, 'rot');
  const mirrorBox = el('input', { type: 'checkbox' });
  const fitSel = fitSelect(s.fit);
  const sizeSel = sizeSelect(s.framesize);
  const setAngle = (v, now) => {
    const a = normDeg(v);
    range.value = String(a);
    num.value = String(a);
    if (now) setOptions(id, { rotate: a }); else sendOptionsSoon(id, { rotate: a });
  };
  range.addEventListener('input', () => setAngle(range.value));
  num.addEventListener('change', () => setAngle(num.value, true));
  const step = d => el('button', { class: 'sm', type: 'button', text: (d > 0 ? '+' : '−') + Math.abs(d) + '°',
    onclick: () => setAngle(normDeg(num.value) + d) });
  const align = el('div', { class: 'win-align hidden' },
    el('div', { class: 'row' }, range, el('span', { class: 'deg' }, num, '°')),
    el('div', { class: 'row' }, step(-90), step(-5), step(-1), step(1), step(5), step(90),
      el('button', { class: 'sm', type: 'button', text: '0°', onclick: () => setAngle(0, true) })),
    el('div', { class: 'row' },
      el('label', { class: 'check' }, mirrorBox, 'Spiegeln'), fitSel),
    el('div', { class: 'row' }, el('span', { class: 'mut', text: 'Bildgröße' }), sizeSel),
  );
  mirrorBox.addEventListener('change', () => setOptions(id, { mirror: mirrorBox.checked }));
  fitSel.addEventListener('change', () => setOptions(id, { fit: fitSel.value }));
  sizeSel.addEventListener('change', () => setOptions(id, { framesize: +sizeSel.value }));
  btnAlign.addEventListener('click', () => {
    align.classList.toggle('hidden');
    btnAlign.classList.toggle('pri', !align.classList.contains('hidden'));
  });
  const img = el('img', { alt: 'Live-Bild' });
  const off = el('div', { class: 'win-off' });
  const info = el('div', { class: 'win-info' });
  const body = el('div', { class: 'win-body' }, img, off, info);
  const win = el('div', { class: 'win' }, bar, align, body);

  // Fenster an das Seitenverhältnis des Bildes anpassen -> kein schwarzer Rand
  let lastDims = '';
  const fitAspect = () => {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    const dims = iw + 'x' + ih;
    if (dims === lastDims) return;
    lastDims = dims;
    if (win.classList.contains('max') || win.classList.contains('min')) return;
    const chrome = win.offsetHeight - body.offsetHeight; // Titelleiste + Ausrichten-Bereich
    let width = win.offsetWidth;
    let height = chrome + width * ih / iw;
    const maxH = window.innerHeight - 16;
    if (height > maxH) {
      height = maxH;
      width = Math.max(220, (maxH - chrome) * iw / ih);
    }
    win.style.width = Math.round(width) + 'px';
    win.style.height = Math.round(height) + 'px';
    const r = win.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) win.style.top = Math.max(8, window.innerHeight - 8 - r.height) + 'px';
  };
  img.addEventListener('load', fitAspect);
  btnFull.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (body.requestFullscreen) body.requestFullscreen().catch(() => {});
  });

  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(480, vw - 16), h = Math.min(400, vh - 80);
  winOffset = (winOffset + 32) % 256;
  win.style.width = w + 'px';
  win.style.height = h + 'px';
  win.style.left = Math.max(8, Math.min(vw - w - 8, 80 + winOffset)) + 'px';
  win.style.top = Math.max(60, Math.min(vh - h - 8, 90 + winOffset)) + 'px';
  if (vw < 600) win.classList.add('max');
  $('windows').append(win);

  // Bild direkt vom Admin-Server holen (relativer Pfad): unabhängig von der eingestellten
  // öffentlichen Adresse und ohne Dauerverbindung (Browser erlauben nur ~6 pro Server)
  const snapUrl = '/' + encodeURIComponent(s.user) + '/' + encodeURIComponent(s.streamId) + '/snapshot.jpg';
  let alive = true, shownUrl = null, lastFrameAt = null;
  (async function pull() {
    while (alive) {
      const st = streams.find(x => sid(x) === id);
      // nur ein neues Bild holen, wenn es eins gibt
      if (!shownUrl || (st && st.lastFrameAt !== lastFrameAt) || (st && st.receiving)) {
        try {
          const r = await fetch(snapUrl + '?t=' + Date.now(), { cache: 'no-store', credentials: 'same-origin' });
          if (r.ok && alive) {
            const url = URL.createObjectURL(await r.blob());
            img.src = url;
            if (shownUrl) URL.revokeObjectURL(shownUrl);
            shownUrl = url;
            lastFrameAt = st ? st.lastFrameAt : null;
          }
        } catch (e) { /* Server kurz weg: weiter versuchen */ }
      }
      await new Promise(r => setTimeout(r, 250));
    }
  })();

  const api_ = {
    focus() { win.style.zIndex = ++zTop; },
    update(st) {
      title.textContent = (st.label || st.user) + ' – ' + sid(st);
      const [text] = state(st);
      info.textContent = st.receiving ? `${st.fps.toFixed(1)} Bilder/s · ${st.camera || ''}` : text;
      off.textContent = st.receiving ? '' : (!st.enabled ? 'Stream gesperrt'
        : !st.phoneConnected ? 'Kein Live-Bild (Handy offline)'
        : liveMode === 'admin' && !st.onAir ? (st.ready ? 'Bereit – „▶ Live“ drücken' : 'Handy verbunden, Kamera noch nicht bereit')
        : 'Warte auf Bilder vom Handy …');
      btnLive.textContent = st.onAir ? '■ Live aus' : '▶ Live';
      btnLive.className = st.onAir ? 'danger' : 'golive';
      btnLive.classList.toggle('hidden', liveMode !== 'admin' || !st.enabled);
      off.classList.toggle('hidden', st.receiving);
      // Regler nur nachführen, wenn gerade niemand daran dreht
      const busy = pendingOpts.has(id) || [range, num, fitSel].includes(document.activeElement);
      if (!busy) {
        range.value = String(st.rotate || 0);
        num.value = String(st.rotate || 0);
        fitSel.value = st.fit === 'fit' ? 'fit' : 'fill';
        if (document.activeElement !== sizeSel) sizeSel.value = String(st.framesize || 1);
      }
      mirrorBox.checked = !!st.mirror;
      btnAlign.textContent = '∠ ' + (st.rotate ? fmtDeg(st.rotate) : 'Ausrichten');
    },
    close() {
      alive = false; // Bildabfrage beenden
      if (shownUrl) URL.revokeObjectURL(shownUrl);
      img.removeAttribute('src');
      win.remove();
      windows.delete(id);
    },
  };
  windows.set(id, api_);
  api_.update(s);
  api_.focus();

  win.addEventListener('pointerdown', () => api_.focus());
  btnClose.addEventListener('click', () => api_.close());
  btnMin.addEventListener('click', () => {
    win.classList.toggle('min');
    win.classList.remove('max');
  });
  const toggleMax = () => {
    win.classList.toggle('max');
    win.classList.remove('min');
    btnMax.textContent = win.classList.contains('max') ? '❐' : '□';
  };
  btnMax.addEventListener('click', toggleMax);
  bar.addEventListener('dblclick', e => { if (e.target.tagName !== 'BUTTON') toggleMax(); });

  // Verschieben an der Titelleiste
  let drag = null;
  bar.addEventListener('pointerdown', e => {
    if (e.target.tagName === 'BUTTON' || win.classList.contains('max')) return;
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = win.getBoundingClientRect();
    const x = Math.max(-r.width + 80, Math.min(window.innerWidth - 80, e.clientX - drag.dx));
    const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
    win.style.left = x + 'px';
    win.style.top = y + 'px';
  });
  const endDrag = () => { drag = null; };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}

// ======================================================================
// Start
// ======================================================================

(async function init() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('reset')) return showAuth('reset');
  try {
    me = await api('me');
    if (me.mustChange) showFirst(); else showApp();
  } catch (e) {
    if (!(e instanceof ApiError)) showAuth('login');
  }
})();

// ======================================================================
// TAK-EUD
// ======================================================================

async function loadTak() {
  try {
    const t = await api('tak');
    $('eudUrl').value = t.eudUrl;
    $('eudQr').src = '/api/admin/eud-qr.svg?t=' + Date.now();
    const f = $('takForm');
    f.allowedHosts.value = t.allowedHosts || '';
    f.host.value = t.preset ? t.preset.host : '';
    f.port.value = t.preset ? t.preset.port : '';
    f.proto.value = t.preset ? t.preset.proto : 'ssl';
    f.enrollPort.value = t.preset ? t.preset.enrollPort : '';
  } catch (e) { /* nicht angemeldet */ }
}

async function loadEudLinks() {
  try {
    const { links } = await api('eud-links');
    const box = $('eudLinks');
    box.textContent = links.length ? 'Verbundene WebTAK-Geräte:' : 'Zurzeit kein WebTAK-Gerät verbunden.';
    for (const l of links) {
      box.append(el('div', { text: `${l.callsign || '–'} → ${l.host || '–'} (${l.state})` }));
    }
  } catch (e) { /* ignorieren */ }
}

$('takForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const host = f.host.value.trim();
  try {
    await api('tak', { method: 'POST', body: {
      allowedHosts: f.allowedHosts.value,
      preset: host ? { host, port: Number(f.port.value) || 8089, proto: f.proto.value, enrollPort: Number(f.enrollPort.value) || 8446 } : null,
    } });
    setMsg($('eudMsg'), 'Gespeichert – der QR-Code ist angepasst.', true);
    loadTak();
  } catch (err) { setMsg($('eudMsg'), err.message); }
});
function showEudQr() {
  const img = el('img', { class: 'qr', alt: 'QR-Code zu WebTAK', src: '/api/admin/eud-qr.svg?t=' + Date.now() });
  const print = el('button', { type: 'button', text: 'Drucken', onclick: () => {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) return;
    const d = w.document;
    d.title = 'WebTAK';
    d.body.style.fontFamily = 'system-ui, sans-serif';
    d.body.style.textAlign = 'center';
    const h = d.createElement('h1'); h.textContent = 'WebTAK';
    const i = d.createElement('img'); i.src = img.src; i.style.width = '340px';
    const t = d.createElement('p'); t.textContent = '1. Scan  2. Enter callsign  3. Connect to the TAK server';
    const t2 = d.createElement('p'); t2.textContent = 'iPhone: Safari → Share → Add to Home Screen';
    d.body.append(h, i, t, t2);
    i.onload = () => w.print();
  } });
  openModal('QR-Code WebTAK', img, el('p', { class: 'mut small', text: $('eudUrl').value }), el('div', { class: 'row' }, print));
}
$('eudQrBig').addEventListener('click', showEudQr);
$('eudQr').addEventListener('click', showEudQr);
$('eudQr').style.cursor = 'pointer';
$('eudUrlCopy').addEventListener('click', () => copy($('eudUrl').value, $('eudUrlCopy')));
setInterval(() => { if (!document.hidden && $('eudLinks').offsetParent) loadEudLinks(); }, 10000);
