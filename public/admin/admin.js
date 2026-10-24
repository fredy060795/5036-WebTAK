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

function showApp() {
  $('authView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('noFfmpeg').classList.toggle('hidden', !!me.ffmpeg);
  loadRegistration();
  refresh();
  startPolling();
}

// ---- allgemeiner QR-Code + Selbst-Anmeldung --------------------------------
async function loadRegistration() {
  try {
    const r = await api('registration');
    $('regToggle').checked = r.enabled;
    $('appUrl').value = r.appUrl;
    $('appQr').src = '/api/admin/app-qr.svg?t=' + Date.now();
    $('appQr').closest('.appqr').classList.toggle('off', !r.enabled);
  } catch (e) { /* angezeigt durch api() */ }
}

$('regToggle').addEventListener('change', async () => {
  const enabled = $('regToggle').checked;
  try {
    await api('registration', { method: 'POST', body: { enabled } });
    setMsg($('regMsg'), enabled ? 'Selbst-Anmeldung erlaubt.' : 'Selbst-Anmeldung gesperrt – neue Nutzer können sich nicht mehr anmelden.', enabled);
    loadRegistration();
  } catch (e) { setMsg($('regMsg'), e.message); }
});
$('appUrlCopy').addEventListener('click', () => copy($('appUrl').value, $('appUrlCopy')));
$('appQrBig').addEventListener('click', () => {
  const img = el('img', { class: 'qr', alt: 'QR-Code zur Handy-Seite', src: '/api/admin/app-qr.svg?t=' + Date.now() });
  const print = el('button', { type: 'button', text: 'Drucken', onclick: () => {
    const w = window.open('', '_blank', 'width=480,height=640');
    if (!w) return;
    const d = w.document;
    d.title = 'Helm Camera';
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

async function refresh() {
  try {
    const data = await api('streams');
    streams = data.streams;
    render();
  } catch (e) {
    if (!(e instanceof ApiError)) console.warn(e);
  }
}

const sid = s => s.user + '/' + s.streamId;

function state(s) {
  if (!s.enabled) return ['Gestoppt', 'stop'];
  if (s.receiving) return ['Live', 'live'];
  if (s.phoneConnected) return ['Verbunden', 'wait'];
  return ['Offline', 'off'];
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
  c.link = td('Link');
  const f = copyField(s.links.stream);
  c.linkInput = f.input;
  c.link.append(el('div', { class: 'link' }, f.input, f.btn));
  c.actions = td('', '');
  c.view = el('button', { class: 'sm pri', text: 'Ansehen', onclick: () => openWindow(id) });
  c.qr = el('button', { class: 'sm', text: 'QR / Links', onclick: () => showQr(id) });
  c.toggle = el('button', { class: 'sm', onclick: () => toggleStream(id) });
  c.revoke = el('button', { class: 'sm danger', text: 'Rauswerfen', onclick: () => revokeStream(id) });
  c.remove = el('button', { class: 'sm danger', text: 'Löschen', onclick: () => removeStream(id) });
  c.actions.append(el('div', { class: 'btns' }, c.view, c.qr, c.toggle, c.revoke, c.remove));
  const tr = el('tr', {}, c.status, c.name, c.camera, c.fps, c.viewers, c.last, c.rotTd, c.link, c.actions);
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
  if (document.activeElement !== c.linkInput) c.linkInput.value = s.links.stream;
  c.toggle.textContent = s.enabled ? 'Stoppen' : 'Freigeben';
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

$('stopAllBtn').addEventListener('click', async () => {
  if (!confirm('ALLE Streams stoppen?\n\nAlle Handys werden getrennt. Einzelne Streams kann man danach mit „Freigeben“ wieder erlauben.')) return;
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
  const hint = el('p', { class: 'mut small', text: me.ffmpeg
    ? 'OpenTAKServer (MediaMTX) kann kein MJPEG abholen: Dort unter Videostreams „Add Video“ den HLS-Link als Quelle eintragen.'
    : 'Für OpenTAKServer (MediaMTX) wird der HLS-Link gebraucht – dafür ffmpeg auf dem Server installieren.' });
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

$('settingsBtn').addEventListener('click', async () => {
  const frag = $('settingsTpl').content.cloneNode(true);
  const cred = frag.querySelector('#credForm');
  const smtp = frag.querySelector('#smtpForm');
  const defs = frag.querySelector('#defaultsForm');
  cred.username.value = me.username;
  cred.email.value = me.email || '';
  const defFit = fitSelect('fill');
  defFit.name = 'fit';
  defs.querySelector('[data-fit]').replaceWith(defFit);
  openModal('Einstellungen', defs, cred, smtp);

  try {
    const d = await api('defaults');
    defs.rotate.value = String(d.rotate);
    defs.mirror.checked = d.mirror;
    defFit.value = d.fit;
  } catch (e) { /* angezeigt durch api() */ }
  defs.addEventListener('submit', async e => {
    e.preventDefault();
    const msg = defs.querySelector('[data-msg]');
    try {
      await api('defaults', { method: 'POST', body: { rotate: normDeg(defs.rotate.value), mirror: defs.mirror.checked, fit: defFit.value, applyAll: defs.applyAll.checked } });
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
});

// ======================================================================
// Video-Fenster: verschieben, Größe ändern, maximieren, minimieren, schließen
// ======================================================================

function openWindow(id) {
  if (windows.has(id)) { windows.get(id).focus(); return; }
  const s = streams.find(x => sid(x) === id);
  if (!s) return;

  const title = el('span', { class: 'win-title' });
  const btnAlign = el('button', { title: 'Bild ausrichten (drehen, spiegeln)', text: '∠ Ausrichten' });
  const btnMin = el('button', { title: 'Minimieren', text: '–' });
  const btnMax = el('button', { title: 'Maximieren', text: '□' });
  const btnClose = el('button', { title: 'Schließen', text: '✕' });
  const bar = el('div', { class: 'win-bar' }, title, btnAlign, btnMin, btnMax, btnClose);

  // Ausrichten: Regler 0–359,5°, Feinschritte, Spiegeln, Füllen/Ganzes Bild
  const range = el('input', { type: 'range', min: '0', max: '359.5', step: '0.5', class: 'grow', 'aria-label': 'Drehung' });
  const num = angleInput(s.rotate, 'rot');
  const mirrorBox = el('input', { type: 'checkbox' });
  const fitSel = fitSelect(s.fit);
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
  );
  mirrorBox.addEventListener('change', () => setOptions(id, { mirror: mirrorBox.checked }));
  fitSel.addEventListener('change', () => setOptions(id, { fit: fitSel.value }));
  btnAlign.addEventListener('click', () => {
    align.classList.toggle('hidden');
    btnAlign.classList.toggle('pri', !align.classList.contains('hidden'));
  });
  const img = el('img', { alt: 'Live-Bild' });
  const off = el('div', { class: 'win-off' });
  const info = el('div', { class: 'win-info' });
  const body = el('div', { class: 'win-body' }, img, off, info);
  const win = el('div', { class: 'win' }, bar, align, body);

  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(480, vw - 16), h = Math.min(400, vh - 80);
  winOffset = (winOffset + 32) % 256;
  win.style.width = w + 'px';
  win.style.height = h + 'px';
  win.style.left = Math.max(8, Math.min(vw - w - 8, 80 + winOffset)) + 'px';
  win.style.top = Math.max(60, Math.min(vh - h - 8, 90 + winOffset)) + 'px';
  if (vw < 600) win.classList.add('max');
  $('windows').append(win);

  img.src = s.links.stream + '?v=' + Date.now();

  const api_ = {
    focus() { win.style.zIndex = ++zTop; },
    update(st) {
      title.textContent = (st.label || st.user) + ' – ' + sid(st);
      const [text] = state(st);
      info.textContent = st.receiving ? `${st.fps.toFixed(1)} Bilder/s · ${st.camera || ''}` : text;
      off.textContent = st.receiving ? '' : (st.enabled ? 'Kein Live-Bild (Handy ' + (st.phoneConnected ? 'verbunden, keine Bilder' : 'offline') + ')' : 'Stream gestoppt');
      off.classList.toggle('hidden', st.receiving);
      // Regler nur nachführen, wenn gerade niemand daran dreht
      const busy = pendingOpts.has(id) || [range, num, fitSel].includes(document.activeElement);
      if (!busy) {
        range.value = String(st.rotate || 0);
        num.value = String(st.rotate || 0);
        fitSel.value = st.fit === 'fit' ? 'fit' : 'fill';
      }
      mirrorBox.checked = !!st.mirror;
      btnAlign.textContent = '∠ ' + (st.rotate ? fmtDeg(st.rotate) : 'Ausrichten');
    },
    close() {
      img.src = ''; // Verbindung zum Stream beenden
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
