// Admin: TAK-Server verwalten wie in der OTS-Oberfläche – alle Benutzer (anlegen, übernehmen, Rolle, aktiv,
// Passwort, Gruppen, löschen), Gruppen, Missionen (Data Sync), Video-Feeds (MediaMTX) und Meshtastic-Kanäle.
'use strict';

(() => {
  const oapi = (path, opts) => api('ots/' + path, opts);
  const fmt = iso => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–');
  const enc = s => encodeURIComponent(s);
  const btn = (text, cls, onclick) => el('button', { class: 'sm ' + (cls || ''), type: 'button', text, onclick });
  const td = (label, ...kids) => el('td', { 'data-label': label }, ...kids);
  const empty = (tb, cols, text) => tb.append(el('tr', {}, el('td', { colspan: String(cols), class: 'mut', text })));
  let users = [];
  let groups = [];
  let teams = null; // { teams, roles } aus der WebTAK-Verwaltung

  async function guard(msgEl, fn, okText) {
    try {
      const r = await fn();
      if (okText) setMsg(msgEl, okText, true);
      return r;
    } catch (e) { setMsg(msgEl, e.message); return null; }
  }

  // ---------------- OTS-Benutzer ----------------
  async function loadUsers() {
    const r = await guard($('ouMsg'), () => oapi('users'));
    if (!r) return;
    users = r.users;
    groups = r.groups;
    if (!$('ouMsg').classList.contains('ok')) setMsg($('ouMsg'), '');
    renderUsers();
  }

  function renderUsers() {
    const tb = $('ouTable').querySelector('tbody');
    const q = $('ouFilter').value.trim().toLowerCase();
    tb.replaceChildren();
    const list = users.filter(u => !q || [u.username, ...(u.euds || []).map(e => e.callsign), u.managed && u.managed.callsign].join(' ').toLowerCase().includes(q));
    if (!list.length) empty(tb, 8, 'Keine Benutzer.');
    for (const u of list) {
      const admin = u.roles.includes('administrator');
      const role = el('select', { class: 'sm-select' }, el('option', { value: 'user', text: 'User' }), el('option', { value: 'admin', text: 'Administrator' }));
      role.value = admin ? 'admin' : 'user';
      role.onchange = async () => {
        if (!confirm(`Rolle von „${u.username}“ auf ${role.value === 'admin' ? 'Administrator' : 'User'} setzen?`)) { role.value = admin ? 'admin' : 'user'; return; }
        await guard($('ouMsg'), () => oapi(`users/${enc(u.username)}/role`, { method: 'POST', body: { admin: role.value === 'admin' } }), 'Rolle gesetzt.');
        loadUsers();
      };
      const active = el('input', { type: 'checkbox' });
      active.checked = u.active;
      active.onchange = async () => {
        await guard($('ouMsg'), () => oapi(`users/${enc(u.username)}/active`, { method: 'POST', body: { on: active.checked } }), active.checked ? 'Aktiviert.' : 'Gesperrt.');
        loadUsers();
      };
      const grp = u.memberships.length
        ? el('div', { class: 'tags' }, ...u.memberships.map(m => el('span', { class: 'tag' + (m.enabled ? '' : ' off'), text: `${m.group} ${m.direction}` })))
        : el('span', { class: 'mut small', text: '__ANON__ (keine)' });
      const devs = u.euds.length ? el('div', { class: 'small' }, ...u.euds.map(e => el('div', { text: `${e.callsign || e.uid}${e.lastStatus ? ' · ' + e.lastStatus : ''}` }))) : el('span', { class: 'mut small', text: '–' });
      const managed = u.managed
        ? el('span', { class: 'badge live', text: u.managed.callsign })
        : btn('Übernehmen …', '', () => importUser(u));
      const actions = el('div', { class: 'btns' },
        btn('Gruppen …', '', () => editGroups(u)),
        btn('Passwort …', '', () => setPassword(u)),
        admin ? null : btn('Löschen', 'danger', async () => {
          if (!confirm(`Benutzer „${u.username}“ in OTS löschen?${u.managed ? '\n\nAuch die WebTAK-Verwaltung wird entfernt.' : ''}`)) return;
          await guard($('ouMsg'), () => oapi(`users/${enc(u.username)}`, { method: 'DELETE' }), 'Gelöscht.');
          loadUsers();
          if (window.loadTakUsers) window.loadTakUsers();
        }));
      tb.append(el('tr', {}, td('Benutzer', el('b', { text: u.username })), td('Rolle', role), td('Aktiv', active), td('Gruppen', grp),
        td('Geräte', devs), td('Letzte Anmeldung', el('span', { class: 'small', text: fmt(u.lastLogin) })), td('WebTAK', managed), td('', actions)));
    }
  }

  async function teamOptions() {
    if (!teams) teams = await api('takusers/state').catch(() => ({ teams: [], roles: [] }));
    return teams;
  }

  function form(fields) {
    const f = el('form');
    for (const [name, label, attrs = {}] of fields) {
      if (attrs.type === 'checkbox') { f.append(el('label', { class: 'check' }, el('input', { type: 'checkbox', name }), ' ' + label)); continue; }
      f.append(el('label', { text: label }));
      if (attrs.options) f.append(el('select', { name }, ...attrs.options.map(([v, t]) => el('option', { value: v, text: t }))));
      else f.append(el('input', { name, autocomplete: 'off', ...attrs }));
    }
    return f;
  }

  async function newUser() {
    const t = await teamOptions();
    const f = form([
      ['callsign', 'Rufname *', { required: '', maxlength: '30', placeholder: 'z. B. ALPHA 10' }],
      ['username', 'Benutzername (leer = aus dem Rufnamen)', { maxlength: '40' }],
      ['password', 'Passwort (leer = laut Einstellung, Standard atakatak)', { maxlength: '64' }],
      ['name', 'Name', { maxlength: '60' }],
      ['email', 'E-Mail (optional, für den Zugangslink)', { type: 'email', maxlength: '120' }],
      ['team', 'Team', { options: (t.teams || []).map(x => [x.id, `${x.name} (${x.color})`]) }],
      ['role', 'Rolle in ATAK', { options: (t.roles || ['Team Member']).map(r => [r, r]) }],
      ['admin', 'OTS-Administrator (darf den Server verwalten)', { type: 'checkbox' }],
    ]);
    const m = el('p', { class: 'msg' });
    f.append(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'pri', type: 'submit', text: 'Anlegen' })), m);
    f.onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.admin = f.admin.checked;
      const r = await guard(m, () => oapi('users', { method: 'POST', body }));
      if (!r) return;
      openModal('Benutzer angelegt',
        el('p', {}, 'Benutzer ', el('b', { text: r.user.username }), ' · Passwort ', el('b', { class: 'secret', text: r.password })),
        el('p', { class: 'mut small', text: 'Zugangsseite mit QR-Codes, ATAK-Einrichtungspaket und Anleitung (nur an den Nutzer geben):' }),
        el('div', { class: 'link' }, ...Object.values(copyField(r.link))));
      loadUsers();
      if (window.loadTakUsers) window.loadTakUsers();
    };
    openModal('Neuer TAK-Benutzer', el('p', { class: 'mut small', text: 'Ohne Registrierung: das Konto wird sofort in OTS angelegt und ist aktiv.' }), f);
  }

  async function importUser(u) {
    const t = await teamOptions();
    const f = form([
      ['callsign', 'Rufname', { value: (u.euds[0] && u.euds[0].callsign) || u.username, maxlength: '30' }],
      ['team', 'Team', { options: (t.teams || []).map(x => [x.id, `${x.name} (${x.color})`]) }],
      ['role', 'Rolle in ATAK', { options: (t.roles || ['Team Member']).map(r => [r, r]) }],
      ['email', 'E-Mail (optional)', { type: 'email' }],
      ['newPassword', 'Neues Passwort setzen (sonst kennt WebTAK es nicht und die Zugangsseite zeigt keins)', { type: 'checkbox' }],
      ['password', 'Neues Passwort (leer = laut Einstellung)', { maxlength: '64' }],
      ['syncGroups', 'Gruppen nach WebTAK-Teams setzen (sonst bleiben die OTS-Gruppen wie sie sind)', { type: 'checkbox' }],
    ]);
    const m = el('p', { class: 'msg' });
    f.append(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'pri', type: 'submit', text: 'Übernehmen' })), m);
    f.onsubmit = async e => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f));
      body.newPassword = f.newPassword.checked;
      body.syncGroups = f.syncGroups.checked;
      const r = await guard(m, () => oapi(`users/${enc(u.username)}/import`, { method: 'POST', body }));
      if (!r) return;
      closeModal();
      setMsg($('ouMsg'), `„${u.username}“ wird jetzt in WebTAK verwaltet (Benutzer & Anfragen).`, true);
      loadUsers();
      if (window.loadTakUsers) window.loadTakUsers();
    };
    openModal('In WebTAK übernehmen: ' + u.username, f);
  }

  function setPassword(u) {
    const f = form([['password', 'Neues Passwort (leer = laut Einstellung, Standard atakatak)', { maxlength: '64' }]]);
    const m = el('p', { class: 'msg' });
    f.append(el('div', { class: 'row', style: 'margin-top:12px' }, el('button', { class: 'pri', type: 'submit', text: 'Setzen' })), m);
    f.onsubmit = async e => {
      e.preventDefault();
      const r = await guard(m, () => oapi(`users/${enc(u.username)}/password`, { method: 'POST', body: { password: f.password.value } }));
      if (r) setMsg(m, `Gesetzt: ${r.password} – Gerät muss sich ggf. neu anmelden.`, true);
    };
    openModal('Passwort: ' + u.username, f);
  }

  function editGroups(u) {
    const box = el('div');
    const m = el('p', { class: 'msg' });
    const render = () => {
      const cur = users.find(x => x.username === u.username) || u;
      const rows = cur.memberships.map(g => el('tr', {}, el('td', { text: g.group }), el('td', { text: g.direction }),
        el('td', {}, btn('Entfernen', 'danger', async () => {
          await guard(m, () => oapi(`users/${enc(u.username)}/groups`, { method: 'POST', body: { group: g.group, direction: g.direction, remove: true } }), 'Entfernt.');
          await loadUsers();
          render();
        }))));
      const sel = el('select', {}, ...groups.map(g => el('option', { value: g.name, text: g.name })));
      const dir = el('select', {}, el('option', { value: 'IN', text: 'IN (senden)' }), el('option', { value: 'OUT', text: 'OUT (empfangen)' }));
      const both = btn('IN + OUT', '', () => add(['IN', 'OUT']));
      const add = async dirs => {
        for (const d of dirs) await guard(m, () => oapi(`users/${enc(u.username)}/groups`, { method: 'POST', body: { group: sel.value, direction: d } }), 'Hinzugefügt.');
        await loadUsers();
        render();
      };
      box.replaceChildren(
        el('table', { class: 'streams' }, el('thead', {}, el('tr', {}, el('th', { text: 'Gruppe' }), el('th', { text: 'Richtung' }), el('th'))),
          el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '3', class: 'mut', text: 'Keine Gruppe – der Benutzer ist in __ANON__ (sieht alle ohne Gruppe).' }))]))),
        el('div', { class: 'row', style: 'margin-top:10px' }, sel, dir, btn('Hinzufügen', 'pri', () => add([dir.value])), both),
        el('p', { class: 'mut small', text: 'Hinweis: Ist ein Benutzer in irgendeiner Gruppe, sendet/empfängt er nur noch dort. Änderungen gelten nach dem nächsten Verbinden des Geräts.' }),
        m);
    };
    render();
    openModal('Gruppen: ' + u.username, box);
  }

  $('ouNew').addEventListener('click', newUser);
  $('ouReload').addEventListener('click', loadUsers);
  $('ouFilter').addEventListener('input', renderUsers);

  // ---------------- Gruppen ----------------
  async function loadGroups() {
    const r = await guard($('ogMsg'), () => oapi('groups'));
    if (!r) return;
    groups = r.groups;
    const tb = $('ogTable').querySelector('tbody');
    tb.replaceChildren();
    if (!groups.length) empty(tb, 3, 'Keine Gruppen.');
    for (const g of groups) {
      tb.append(el('tr', {}, td('Gruppe', el('b', { text: g.name })), td('Beschreibung', el('span', { class: 'small', text: g.description || '' })),
        td('', g.name === '__ANON__' ? el('span', { class: 'mut small', text: 'Standard' }) : btn('Löschen', 'danger', async () => {
          if (!confirm(`Gruppe „${g.name}“ löschen? Mitglieder verlieren diese Gruppe.`)) return;
          await guard($('ogMsg'), () => oapi('groups/' + enc(g.name), { method: 'DELETE' }), 'Gelöscht.');
          loadGroups();
        }))));
    }
  }
  $('ogForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const ok = await guard($('ogMsg'), () => oapi('groups', { method: 'POST', body: { name: f.elements.namedItem('name').value.trim(), description: f.description.value } }), 'Gruppe angelegt.');
    if (ok) { f.reset(); loadGroups(); }
  });
  $('ogReload').addEventListener('click', loadGroups);

  // ---------------- Missionen ----------------
  async function loadMissions() {
    const [r, g, eu] = await Promise.all([guard($('omMsg'), () => oapi('missions')), oapi('groups').catch(() => null), oapi('euds').catch(() => null)]);
    if (g) {
      groups = g.groups;
      $('omGroups').replaceChildren(...groups.map(x => el('label', { class: 'check' }, el('input', { type: 'checkbox', value: x.name }), ' ' + x.name)));
    }
    if (eu) {
      const keep = $('omCreator').value;
      $('omCreator').replaceChildren(...(eu.euds.length ? eu.euds.map(e => el('option', { value: e.uid, text: `${e.callsign || e.uid}${e.username ? ' (' + e.username + ')' : ''}` }))
        : [el('option', { value: '', text: 'Noch kein Gerät bekannt' })]));
      if (keep) $('omCreator').value = keep;
    }
    if (!r) return;
    const tb = $('omTable').querySelector('tbody');
    tb.replaceChildren();
    if (!r.missions.length) empty(tb, 5, 'Keine Missionen.');
    for (const m of r.missions) {
      tb.append(el('tr', {}, td('Mission', el('b', { text: m.name + (m.password ? ' 🔒' : '') })), td('Beschreibung', el('span', { class: 'small', text: m.description })),
        td('Inhalt', el('span', { class: 'small', text: `${m.items} Punkte · ${m.files} Dateien` })), td('Erstellt', el('span', { class: 'small', text: fmt(m.created) })),
        td('', btn('Löschen', 'danger', async () => {
          if (!confirm(`Mission „${m.name}“ mit allen Inhalten löschen?`)) return;
          await guard($('omMsg'), () => oapi('missions/' + enc(m.name), { method: 'DELETE' }), 'Gelöscht.');
          loadMissions();
        }))));
    }
  }
  $('omForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.elements.namedItem('name').value.trim(), description: f.description.value, password: f.password.value, creatorUid: f.creatorUid.value,
      groups: [...$('omGroups').querySelectorAll('input:checked')].map(x => x.value) };
    const ok = await guard($('omMsg'), () => oapi('missions', { method: 'POST', body }), 'Mission angelegt – in ATAK/WebTAK unter Data Sync sichtbar.');
    if (ok) { f.reset(); loadMissions(); }
  });
  $('omReload').addEventListener('click', loadMissions);

  // ---------------- Video-Feeds (MediaMTX) ----------------
  async function loadFeeds() {
    const r = await guard($('ofMsg'), () => oapi('feeds'));
    if (!r) return;
    const tb = $('ofTable').querySelector('tbody');
    tb.replaceChildren();
    if (!r.feeds.length) empty(tb, 4, 'Keine Feeds.');
    for (const f of r.feeds) {
      const rtsp = r.rtspHost ? `rtsp://${r.rtspHost}:8554/${f.path}` : '';
      tb.append(el('tr', {}, td('Pfad', el('b', { text: f.path })), td('Quelle', el('span', { class: 'small', text: f.source || '(Kamera sendet selbst)' })),
        td('Für ATAK', rtsp ? el('div', { class: 'link' }, ...Object.values(copyField(rtsp))) : el('span', { class: 'mut', text: '–' })),
        td('', btn('Löschen', 'danger', async () => {
          if (!confirm(`Feed „${f.path}“ löschen?`)) return;
          await guard($('ofMsg'), () => oapi('feeds/' + f.path.split('/').map(enc).join('/'), { method: 'DELETE' }), 'Gelöscht.');
          loadFeeds();
        }))));
    }
  }
  $('ofForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const ok = await guard($('ofMsg'), () => oapi('feeds', { method: 'POST', body: { path: f.path.value, source: f.source.value } }), 'Feed angelegt.');
    if (ok) { f.reset(); loadFeeds(); }
  });
  $('ofReload').addEventListener('click', loadFeeds);

  // ---------------- Meshtastic ----------------
  async function loadMesh() {
    const r = await guard($('omeMsg'), () => oapi('mesh'));
    if (!r) return;
    const tb = $('omeTable').querySelector('tbody');
    tb.replaceChildren();
    if (!r.channels.length) empty(tb, 5, 'Keine Kanäle.');
    for (const c of r.channels) {
      tb.append(el('tr', {}, td('Kanal', el('b', { text: c.name || '(ohne Name)' })), td('Funk', el('span', { class: 'small', text: [c.modem_preset, c.lora_region].filter(x => x != null && x !== '').join(' · ') })),
        td('Up/Down', el('span', { class: 'small', text: `${c.uplink_enabled ? '↑' : '–'} ${c.downlink_enabled ? '↓' : '–'}` })),
        td('Link', c.url ? el('div', { class: 'link' }, ...Object.values(copyField(c.url))) : el('span', { text: '–' })),
        td('', btn('Löschen', 'danger', async () => {
          if (!confirm(`Kanal „${c.name}“ löschen?`)) return;
          await guard($('omeMsg'), () => oapi('mesh?url=' + enc(c.url), { method: 'DELETE' }), 'Gelöscht.');
          loadMesh();
        }))));
    }
  }
  $('omePsk').addEventListener('click', async () => {
    const r = await guard($('omeMsg'), () => oapi('mesh/psk'));
    if (r) $('omeForm').psk.value = r.psk;
  });
  $('omeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const body = f.url.value.trim() ? { url: f.url.value.trim() }
      : { name: f.elements.namedItem('name').value.trim(), modemPreset: f.modemPreset.value, region: f.region.value, psk: f.psk.value.trim(), uplink: f.uplink.checked, downlink: f.downlink.checked };
    const ok = await guard($('omeMsg'), () => oapi('mesh', { method: 'POST', body }), 'Kanal angelegt.');
    if (ok) { f.reset(); loadMesh(); }
  });
  $('omeReload').addEventListener('click', loadMesh);

  // Bereich geöffnet: frisch laden
  document.addEventListener('admin-view', e => {
    if (e.detail === 'otsusers') { teams = null; loadUsers(); }
    if (e.detail === 'otsgroups') loadGroups();
    if (e.detail === 'missions') loadMissions();
    if (e.detail === 'feeds') loadFeeds();
    if (e.detail === 'mesh') loadMesh();
  });
})();
