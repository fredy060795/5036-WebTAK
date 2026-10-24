// Admin: TAK-Zugänge (OpenTAKServer) – Anfragen freigeben, Benutzer verwalten, Rufname/Team/Rolle
// überschreiben, Teams und Sichtbarkeit, OTS- und Registrierungs-Einstellungen.
'use strict';

(() => {
  const COLORS = { White: '#FFFFFF', Yellow: '#FFFF00', Orange: '#FF7700', Magenta: '#FF00FF', Red: '#FF0000', Maroon: '#7F0000', Purple: '#7F007F',
    'Dark Blue': '#00007F', Blue: '#0000FF', Cyan: '#00FFFF', Teal: '#007F7F', Green: '#00FF00', 'Dark Green': '#007F00', Brown: '#A0714F' };
  const STATUS = { unconfirmed: 'E-Mail unbestätigt', pending: 'Offen', active: 'Aktiv', blocked: 'Gesperrt', rejected: 'Abgelehnt' };
  let state = null;
  let teamsDraft = [];
  let blocksDraft = [];

  const tapi = (path, opts) => api('takusers/' + path, opts);
  const msg = (t, ok) => setMsg($('takMsg'), t, ok);
  const chip = color => el('span', { class: 'chip', style: `display:inline-block;width:12px;height:12px;border-radius:50%;border:1px solid #000;margin-right:6px;vertical-align:-1px;background:${COLORS[color] || '#0ff'}` });
  const fmt = iso => (iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '–');

  async function load() {
    try {
      state = await tapi('state');
    } catch (e) { return; }
    const pending = state.users.filter(u => u.status === 'pending').length;
    $('takPending').textContent = pending ? String(pending) : '';
    $('navPending').textContent = pending ? String(pending) : '';
    renderUsers();
    if (!$('takTeams').dataset.dirty) { teamsDraft = state.teams.map(t => ({ ...t })); blocksDraft = state.blocks.map(b => [...b]); renderTeams(); }
    fillSettings();
    if (!state.otsReady) msg('OpenTAKServer ist noch nicht verbunden – unter „OpenTAKServer & Registrierung“ eintragen. Ohne OTS können Anfragen nicht freigegeben werden.');
  }
  window.loadTakUsers = load;

  // ---------------- Tabs ----------------
  for (const b of document.querySelectorAll('[data-takt]')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('[data-takt]')) x.classList.toggle('pri', x === b);
      for (const p of document.querySelectorAll('[data-takp]')) p.classList.toggle('hidden', p.dataset.takp !== b.dataset.takt);
    });
  }
  $('takTabUsers').classList.add('pri');

  // ---------------- Benutzer ----------------
  function renderUsers() {
    const tb = $('takTable').querySelector('tbody');
    const q = $('takFilter').value.trim().toLowerCase();
    const st = $('takStatus').value;
    const list = state.users.filter(u => (!st || u.status === st)
      && (!q || [u.name, u.unit, u.callsign, u.requestedCallsign, u.email, u.username].join(' ').toLowerCase().includes(q)));
    tb.replaceChildren();
    if (!list.length) tb.append(el('tr', {}, el('td', { colspan: '8', class: 'mut', text: st === 'pending' ? 'Keine offenen Anfragen.' : 'Keine Einträge.' })));
    for (const u of list) {
      const actions = el('div', { class: 'btns' });
      if (['pending', 'unconfirmed', 'rejected'].includes(u.status)) actions.append(el('button', { class: 'sm pri', text: 'Freigeben …', onclick: () => edit(u, true) }));
      actions.append(el('button', { class: 'sm', text: 'Bearbeiten', onclick: () => edit(u, false) }));
      tb.append(el('tr', {},
        el('td', { 'data-label': 'Status' }, el('span', { class: 'badge ' + (u.status === 'active' ? 'live' : u.status === 'pending' ? 'wait' : 'off'), text: STATUS[u.status] || u.status })),
        el('td', { 'data-label': 'Name', class: 'name' }, el('b', { text: u.name }), el('span', { class: 'mut small', text: [u.unit, u.email].filter(Boolean).join(' · ') })),
        el('td', { 'data-label': 'Rufname' }, el('b', { text: u.callsign }),
          u.requestedCallsign && u.requestedCallsign !== u.callsign ? el('div', { class: 'mut small', text: 'Wunsch: ' + u.requestedCallsign }) : null),
        el('td', { 'data-label': 'Team' }, chip(u.teamColor), document.createTextNode(`${u.teamName} · ${u.role}`)),
        el('td', { 'data-label': 'OTS' }, el('code', { text: u.username || '–' })),
        el('td', { 'data-label': 'Geräte', class: 'num', text: u.devices ? String(u.devices.length) : '–' }),
        el('td', { 'data-label': 'Angefragt', text: fmt(u.created) }),
        el('td', {}, actions)));
    }
  }
  $('takFilter').addEventListener('input', () => state && renderUsers());
  $('takStatus').addEventListener('change', () => state && renderUsers());
  $('takSync').addEventListener('click', async () => {
    msg('Gleiche mit OTS ab …', true);
    try {
      const r = await tapi('sync', { method: 'POST', body: {} });
      msg(`Abgeglichen: ${r.updated} Gerät(e) mit neuem Rufnamen/Team.` + (r.errors.length ? ' Fehler: ' + r.errors.join('; ') : ''), !r.errors.length);
      load();
    } catch (e) { msg(e.message); }
  });

  // Bearbeiten / Freigeben in einem Dialog
  function edit(u, approve) {
    const f = el('form', {});
    const field = (label, input) => el('div', {}, el('label', { text: label }), input);
    const callsign = el('input', { value: u.callsign || '', maxlength: '30', required: '' });
    const team = el('select', {}, ...state.teams.map(t => el('option', { value: t.id, text: `${t.name} (${t.color})` })));
    team.value = u.team;
    const role = el('select', {}, ...state.roles.map(r => el('option', { value: r, text: r })));
    role.value = u.role;
    const name = el('input', { value: u.name || '', maxlength: '60' });
    const unit = el('input', { value: u.unit || '', maxlength: '60' });
    const notes = el('input', { value: u.notes || '', maxlength: '500', placeholder: 'nur für Admins sichtbar' });
    const out = el('p', { class: 'msg' });
    const info = el('div', { class: 'mut small' },
      el('div', { text: `E-Mail: ${u.email}${u.phone ? ' · Tel. ' + u.phone : ''}` }),
      el('div', { text: `Angefragt: ${fmt(u.created)}${u.requestedCallsign ? ' · Wunsch-Rufname: ' + u.requestedCallsign : ''}` }),
      u.username ? el('div', { text: `OTS-Benutzer: ${u.username} · freigegeben ${fmt(u.approvedAt)}` }) : null,
      u.devices && u.devices.length ? el('div', { text: 'Geräte: ' + u.devices.map(d => `${d.callsign || d.uid} (${d.platform || d.device || 'TAK'})`).join(', ') }) : null);
    f.append(info,
      field('Rufname (überschreibt den Namen des Nutzers in ATAK und für alle anderen)', callsign),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, field('Team (Farbe)', team)), el('div', { class: 'grow' }, field('Rolle', role))),
      el('div', { class: 'row' }, el('div', { class: 'grow' }, field('Name', name)), el('div', { class: 'grow' }, field('Einheit', unit))),
      field('Notiz', notes));
    const body = () => ({ callsign: callsign.value, team: team.value, role: role.value, name: name.value, unit: unit.value, notes: notes.value });
    const run = async (path, opts, done) => {
      setMsg(out, 'Bitte warten …', true);
      try {
        const r = await tapi(`user/${u.id}/${path}`, opts);
        await load();
        if (done) done(r); else closeModal();
      } catch (e) { setMsg(out, e.message); }
    };
    const btns = el('div', { class: 'row', style: 'margin-top:12px' });
    if (approve) {
      btns.append(el('button', { class: 'pri', type: 'submit', text: '✓ Freigeben & OTS-Konto anlegen' }));
      btns.append(el('button', { type: 'button', text: 'Ablehnen', onclick: () => run('reject', { method: 'POST', body: {} }) }));
      f.addEventListener('submit', e => {
        e.preventDefault();
        run('approve', { method: 'POST', body: body() }, r => {
          const link = r.link;
          const { input, btn } = copyField(link);
          $('modalBody').replaceChildren(
            el('p', { class: 'msg ok', text: `Freigegeben: ${r.user.callsign} (OTS-Benutzer ${r.user.username}).` }),
            el('p', { class: 'small', text: r.mailed ? 'Der Nutzer hat eine E-Mail mit seinem Zugangslink bekommen.' : 'Keine E-Mail gesendet (SMTP nicht eingerichtet) – bitte diesen Link an den Nutzer geben:' }),
            el('div', { class: 'link' }, input, btn));
        });
      });
    } else {
      btns.append(el('button', { class: 'pri', type: 'submit', text: 'Speichern' }));
      f.addEventListener('submit', e => { e.preventDefault(); run('update', { method: 'POST', body: body() }); });
      if (u.status === 'active') btns.append(el('button', { type: 'button', text: 'Sperren', onclick: () => { if (confirm(`${u.callsign} sperren? Das OTS-Konto wird deaktiviert.`)) run('block', { method: 'POST', body: {} }); } }));
      if (u.status === 'blocked') btns.append(el('button', { type: 'button', text: 'Entsperren', onclick: () => run('unblock', { method: 'POST', body: {} }) }));
      if (['pending', 'unconfirmed'].includes(u.status)) btns.append(el('button', { type: 'button', text: 'Ablehnen', onclick: () => run('reject', { method: 'POST', body: {} }) }));
    }
    const more = el('div', { class: 'row', style: 'margin-top:8px' });
    if (u.username) {
      more.append(el('button', { class: 'sm', type: 'button', text: 'Neues Passwort', onclick: () => { if (confirm('Neues Passwort erzeugen? Das alte gilt dann nicht mehr.')) run('password', { method: 'POST', body: {} }, () => setMsg(out, 'Neues Passwort gesetzt – der Nutzer sieht es auf seiner Zugangsseite.', true)); } }));
      more.append(el('button', { class: 'sm', type: 'button', text: 'Neuer ATAK-QR', onclick: () => run('qr', { method: 'POST', body: {} }, () => setMsg(out, 'Neuer QR-Code erzeugt.', true)) }));
    }
    more.append(el('button', { class: 'sm', type: 'button', text: 'Zugangslink kopieren', onclick: async ev => { const r = await tapi(`user/${u.id}/link`); copy(r.link, ev.target); } }));
    more.append(el('button', { class: 'sm', type: 'button', text: 'Löschen', onclick: () => {
      if (confirm(`${u.callsign} löschen?${u.username ? ' Das OTS-Konto wird ebenfalls gelöscht.' : ''}`)) run('', { method: 'DELETE' });
    } }));
    f.append(btns, more, out);
    openModal(approve ? `Freigeben: ${u.name}` : `${u.callsign} bearbeiten`, f);
  }

  // ---------------- Teams und Sichtbarkeit ----------------
  const blocked = (a, b) => blocksDraft.some(([x, y]) => x === a && y === b);
  function renderTeams() {
    const box = $('takTeams');
    box.replaceChildren();
    teamsDraft.forEach((t, i) => {
      const name = el('input', { value: t.name, maxlength: '40', style: 'max-width:220px' });
      name.addEventListener('input', () => { t.name = name.value; box.dataset.dirty = '1'; renderMatrix(); });
      const color = el('select', { style: 'width:auto' }, ...state.colors.map(c => el('option', { value: c, text: c })));
      color.value = t.color;
      color.addEventListener('change', () => { t.color = color.value; box.dataset.dirty = '1'; renderTeams(); });
      const del = el('button', { class: 'sm', type: 'button', text: 'Entfernen', onclick: () => {
        if (teamsDraft.length < 2) return;
        teamsDraft.splice(i, 1);
        blocksDraft = blocksDraft.filter(b => b[0] !== t.id && b[1] !== t.id);
        box.dataset.dirty = '1';
        renderTeams();
      } });
      const count = state.users.filter(u => u.team === t.id && u.status === 'active').length;
      box.append(el('div', { class: 'row', style: 'margin-top:6px' }, chip(t.color), name, color, el('span', { class: 'mut small', text: `${count} aktiv` }), del));
    });
    renderMatrix();
  }
  function renderMatrix() {
    const tbl = $('takMatrix');
    tbl.replaceChildren();
    tbl.append(el('thead', {}, el('tr', {}, el('th', { text: 'Team … sieht →' }), ...teamsDraft.map(t => el('th', {}, chip(t.color), document.createTextNode(t.name || '?'))))));
    const tb = el('tbody');
    for (const a of teamsDraft) {
      const row = el('tr', {}, el('td', {}, chip(a.color), el('b', { text: a.name || '?' })));
      for (const b of teamsDraft) {
        const cb = el('input', { type: 'checkbox', style: 'width:auto' });
        cb.checked = !blocked(a.id, b.id);
        if (a.id === b.id) cb.disabled = true;
        cb.addEventListener('change', () => {
          blocksDraft = blocksDraft.filter(([x, y]) => !(x === a.id && y === b.id));
          if (!cb.checked) blocksDraft.push([a.id, b.id]);
          $('takTeams').dataset.dirty = '1';
        });
        row.append(el('td', { style: 'text-align:center' }, cb));
      }
      tb.append(row);
    }
    tbl.append(tb);
  }
  $('takAddTeam').addEventListener('click', () => {
    teamsDraft.push({ id: 'new' + Date.now(), name: `Team ${teamsDraft.length + 1}`, color: state.colors[teamsDraft.length % state.colors.length] });
    $('takTeams').dataset.dirty = '1';
    renderTeams();
  });
  $('takSaveTeams').addEventListener('click', async () => {
    msg('Speichere Teams und wende sie auf OTS an …', true);
    try {
      // neue Teams bekommen ihre Kennung vom Server; Sperren auf neue Teams über den Namen zuordnen
      const r = await tapi('teams', { method: 'POST', body: { teams: teamsDraft, blocks: blocksDraft } });
      delete $('takTeams').dataset.dirty;
      msg(r.errors.length ? 'Gespeichert, aber OTS meldet: ' + r.errors.join('; ') : 'Teams gespeichert und auf OTS angewendet.', !r.errors.length);
      await load();
    } catch (e) { msg(e.message); }
  });

  // ---------------- Einstellungen ----------------
  function fillSettings() {
    const f = $('otsForm');
    if (document.activeElement && f.contains(document.activeElement)) return;
    f.url.value = state.ots.url || '';
    f.username.value = state.ots.username || '';
    f.insecure.checked = !!state.ots.insecure;
    f.host.value = state.ots.host || '';
    f.streamPort.value = state.ots.streamPort || '';
    f.enrollPort.value = state.ots.enrollPort || '';
    f.apiPort.value = state.ots.apiPort || '';
    $('otsHasPass').textContent = state.ots.hasPassword ? '(gespeichert)' : '';
    const r = $('regForm2');
    r.open.checked = !!state.registration.open;
    r.emailConfirm.checked = !!state.registration.emailConfirm;
    r.codeword.value = state.registration.codeword || '';
    $('joinUrl').value = state.joinUrl;
    $('joinQr').src = '/api/admin/takusers/join-qr.svg?t=' + Date.now();
  }
  const otsBody = () => {
    const f = $('otsForm');
    return { url: f.url.value, username: f.username.value, password: f.password.value, insecure: f.insecure.checked, host: f.host.value,
      streamPort: f.streamPort.value, enrollPort: f.enrollPort.value, apiPort: f.apiPort.value };
  };
  $('otsForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await tapi('ots', { method: 'POST', body: otsBody() });
      $('otsForm').password.value = '';
      msg('OTS-Einstellungen gespeichert.', true);
      load();
    } catch (err) { msg(err.message); }
  });
  $('otsTest').addEventListener('click', async () => {
    msg('Teste Verbindung …', true);
    try {
      await tapi('ots', { method: 'POST', body: otsBody() });
      $('otsForm').password.value = '';
      const r = await tapi('ots/test', { method: 'POST', body: {} });
      msg(`Verbunden mit OpenTAKServer. Gruppen: ${r.groups.length ? r.groups.join(', ') : 'keine'}.`, true);
      load();
    } catch (err) { msg(err.message); }
  });
  $('regForm2').addEventListener('submit', async e => {
    e.preventDefault();
    const r = $('regForm2');
    try {
      await tapi('registration', { method: 'POST', body: { open: r.open.checked, emailConfirm: r.emailConfirm.checked, codeword: r.codeword.value } });
      msg('Registrierung gespeichert.' + (r.emailConfirm.checked && !state.mail ? ' Hinweis: ohne SMTP wird keine Bestätigungs-E-Mail verschickt.' : ''), true);
      load();
    } catch (err) { msg(err.message); }
  });
  $('joinCopy').addEventListener('click', () => copy($('joinUrl').value, $('joinCopy')));
  $('joinQr').addEventListener('click', () => {
    const img = el('img', { class: 'qr', alt: 'QR-Code zur Registrierung', src: '/api/admin/takusers/join-qr.svg?t=' + Date.now() });
    const print = el('button', { type: 'button', text: 'Drucken', onclick: () => {
      const w = window.open('', '_blank', 'width=480,height=640');
      if (!w) return;
      const d = w.document;
      d.title = 'WebTAK Access';
      d.body.style.fontFamily = 'system-ui, sans-serif';
      d.body.style.textAlign = 'center';
      const h = d.createElement('h1'); h.textContent = 'WebTAK Access';
      const i = d.createElement('img'); i.src = img.src; i.style.width = '340px';
      const t = d.createElement('p'); t.textContent = 'Scan to request your WebTAK access';
      d.body.append(h, i, t);
      i.onload = () => w.print();
    } });
    openModal('QR-Code zur Registrierung', img, el('p', { class: 'mut small', text: $('joinUrl').value }), el('div', { class: 'row' }, print));
  });

  // Neue Anfragen: Liste regelmäßig auffrischen (Hinweis kommt über die normalen Admin-Hinweise)
  setInterval(() => { if (!document.hidden && $('modal').classList.contains('hidden')) load(); }, 20000);
})();
