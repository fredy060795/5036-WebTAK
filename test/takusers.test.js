// TAK-Zugänge gegen einen nachgebauten OpenTAKServer: Registrierung, Freigabe, Teams/Sichtbarkeit,
// Rufname/Team in Geräte-Profilen, Sperren, Löschen.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { TakUsers } = require('../lib/takusers');
const { Ots } = require('../lib/ots');
const { createMockOts } = require('./ots-mock');

let mock, url, dir, store, tu;

before(async () => {
  mock = createMockOts();
  url = await mock.listen();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takusers-'));
  store = new Store(dir);
  tu = new TakUsers(store);
});

after(() => {
  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Altes Standard-Passwort "atakatak" wird beim Start auf zufällig umgestellt (einmalig)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tu-pw-'));
  const st = new Store(d);
  st.data.tak = { ots: { url: '', userPassword: 'atakatak' } };
  assert.equal(new TakUsers(st).t.ots.userPassword, '');
  // danach bewusst gesetzt: bleibt
  st.data.tak.ots.userPassword = 'atakatak';
  assert.equal(new TakUsers(st).t.ots.userPassword, 'atakatak');
  fs.rmSync(d, { recursive: true, force: true });
});

test('OTS-Client: Anmeldung mit falschem und richtigem Passwort', async () => {
  await assert.rejects(new Ots({ url, username: 'otsadmin', password: 'falsch' }).test(), /login failed/);
  const r = await new Ots({ url, username: 'otsadmin', password: 'otspass' }).test();
  assert.equal(r.ok, true);
});

test('Registrierung: Codewort, Pflichtfelder, doppelte E-Mail, ohne SMTP direkt "pending"', () => {
  tu.setRegistration({ open: true, codeword: 'Adler', emailConfirm: true });
  assert.throws(() => tu.register({ name: 'Horst', email: 'h@example.com', codeword: 'falsch' }, { smtpReady: false }), /code word/);
  assert.throws(() => tu.register({ name: 'Horst', email: 'kaputt', codeword: 'adler' }, { smtpReady: false }), /e-mail/);
  const u = tu.register({ name: 'Horst', unit: 'Zug 1', email: 'H@Example.com', callsign: 'Horst', codeword: 'adler' }, { smtpReady: false });
  assert.equal(u.status, 'pending');
  assert.equal(u.email, 'h@example.com');
  assert.equal(u.token.length, 48);
  assert.throws(() => tu.register({ name: 'X', email: 'h@example.com', codeword: 'adler' }, { smtpReady: false }), /already registered/);
  // mit SMTP: erst E-Mail bestätigen
  const v = tu.register({ name: 'Vera', email: 'v@example.com', codeword: 'Adler' }, { smtpReady: true });
  assert.equal(v.status, 'unconfirmed');
  assert.equal(tu.confirmEmail('falsch'), null);
  assert.equal(tu.confirmEmail(v.emailToken).status, 'pending');
  tu.setRegistration({ open: false, codeword: '', emailConfirm: true });
  assert.throws(() => tu.register({ name: 'Y', email: 'y@example.com' }, { smtpReady: false }), /closed/);
  tu.setRegistration({ open: true, codeword: '', emailConfirm: true });
});

test('Freigabe nur mit OTS; legt Konto, Gruppen und QR an; Rufname überschreiben', async () => {
  const horst = tu.list().find(u => u.name === 'Horst');
  await assert.rejects(tu.approve(horst.id), /OpenTAKServer/);
  tu.setOts({ url, username: 'otsadmin', password: 'otspass', host: 'tak.example.com' });
  assert.equal(tu.fixQr('tak://com.atakmap.app/enroll?host=127.0.0.1:8089&username=a&token=b'), 'tak://com.atakmap.app/enroll?host=tak.example.com:8089&username=a&token=b');
  await tu.setTeams([{ name: 'Blau', color: 'Blue' }, { name: 'Rot', color: 'Red' }], []);
  const blau = tu.t.teams[0], rot = tu.t.teams[1];
  const u = await tu.approve(horst.id, { callsign: 'Alpha 10', team: blau.id, role: 'Team Lead' });
  assert.equal(u.status, 'active');
  assert.equal(u.callsign, 'Alpha 10');
  assert.equal(u.username, 'alpha_10');
  assert.match(u.password, /^[A-Za-z0-9]{14}$/, 'neue Konten: zufälliges Passwort');
  assert.equal(mock.state.users.alpha_10.password, u.password);
  assert.equal(mock.state.users.alpha_10.password, u.password);
  assert.match(u.atakQr, /^tak:\/\/com\.atakmap\.app\/enroll\?host=tak\.example\.com:8089&username=alpha_10&token=/);
  // Ohne Sperren: keine Gruppe – wie von Hand angelegte OTS-Benutzer (OTS nimmt dann __ANON__)
  assert.deepEqual(mock.groupsOf('alpha_10'), []);
  // Zugangsseite zeigt Daten erst nach Freigabe
  const pv = tu.publicView(u);
  assert.equal(pv.username, 'alpha_10');
  assert.equal(pv.host, 'tak.example.com');
  const vera = tu.list().find(x => x.name === 'Vera');
  assert.equal(tu.publicView(vera).password, undefined);
  await tu.approve(vera.id, { callsign: 'Rot 1', team: rot.id });
  assert.deepEqual(mock.groupsOf('rot_1'), []);
});

test('Sichtbarkeit: Rot darf Blau nicht sehen -> Rot liest Blau nicht mehr', async () => {
  const [blau, rot] = tu.t.teams;
  const errors = await tu.setTeams(tu.t.teams, [[rot.id, blau.id]]);
  assert.deepEqual(errors, []);
  // Rot liest Blau nicht; mit Geräten ohne Gruppe (__ANON__) tauscht Rot weiter aus. Blau ist für Rot
  // ausgeblendet und sendet daher nicht nach __ANON__ (sonst sähe Rot es dort doch).
  assert.deepEqual(mock.groupsOf('rot_1'), ['TEAM_ROT.IN', 'TEAM_ROT.OUT', '__ANON__.IN', '__ANON__.OUT']);
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_BLAU.IN', 'TEAM_BLAU.OUT', 'TEAM_ROT.OUT', '__ANON__.OUT']);
  assert.equal(tu.canSee(blau.id, rot.id), true);
  assert.equal(tu.canSee(rot.id, blau.id), false);
  // neues Team mit Sperre in einem Schritt (Entwurfs-Kennung)
  await tu.setTeams([...tu.t.teams, { id: 'new1', name: 'Gelb', color: 'Yellow' }], [[rot.id, blau.id], ['new1', rot.id]]);
  const gelb = tu.t.teams.find(t => t.name === 'Gelb');
  assert.notEqual(gelb.id, 'new1');
  assert.equal(tu.canSee(gelb.id, rot.id), false);
  assert.equal(tu.canSee(gelb.id, blau.id), true);
  // Gelb ist neu: Blau und Rot (sofern nicht gesperrt) lesen es mit
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_BLAU.IN', 'TEAM_BLAU.OUT', 'TEAM_GELB.OUT', 'TEAM_ROT.OUT', '__ANON__.OUT']);
  // Sperren wieder weg: alle Gruppen werden entfernt
  await tu.setTeams(tu.t.teams.filter(t => t.name !== 'Gelb'), []);
  assert.deepEqual(mock.groupsOf('alpha_10'), []);
  assert.deepEqual(mock.groupsOf('rot_1'), []);
  // Ohne __ANON__-Austausch nur die Team-Gruppen
  tu.setOts({ ...tu.t.ots, anon: false });
  await tu.setTeams(tu.t.teams, [[rot.id, blau.id]]);
  assert.deepEqual(mock.groupsOf('rot_1'), ['TEAM_ROT.IN', 'TEAM_ROT.OUT']);
  tu.setOts({ ...tu.t.ots, anon: true });
  await tu.syncAllGroups();
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_BLAU.IN', 'TEAM_BLAU.OUT', 'TEAM_ROT.OUT', '__ANON__.OUT']);
});

test('Rufname/Team/Rolle als Geräte-Profil für alle Geräte des Benutzers, Teamwechsel ändert Gruppen', async () => {
  mock.state.euds.push({ uid: 'ANDROID-abc', callsign: 'Horst', username: 'alpha_10' }, { uid: 'ANDROID-def', callsign: 'Horsti', username: 'alpha_10' });
  let r = await tu.syncProfiles();
  assert.equal(r.updated, 2);
  assert.equal(mock.profileOf('ANDROID-abc', 'locationCallsign'), 'Alpha 10');
  assert.equal(mock.profileOf('ANDROID-def', 'locationTeam'), 'Blue');
  assert.equal(mock.profileOf('ANDROID-def', 'atakRoleType'), 'Team Lead');
  r = await tu.syncProfiles();
  assert.equal(r.updated, 0, 'unverändert -> nichts erneut senden');
  const horst = tu.list().find(u => u.username === 'alpha_10');
  const rot = tu.t.teams[1];
  await tu.update(horst.id, { callsign: 'Alpha 11', team: rot.id });
  assert.equal(mock.profileOf('ANDROID-abc', 'locationCallsign'), 'Alpha 11');
  assert.equal(mock.profileOf('ANDROID-abc', 'locationTeam'), 'Red');
  assert.deepEqual(mock.groupsOf('alpha_10'), ['TEAM_ROT.IN', 'TEAM_ROT.OUT', '__ANON__.IN', '__ANON__.OUT']);
  assert.deepEqual(tu.assignmentFor('alpha_10'), { callsign: 'Alpha 11', team: 'Red', role: 'Team Lead' });
  assert.equal(tu.assignmentFor('unbekannt'), null);
});

test('Sperren, Entsperren, neues Passwort, Löschen', async () => {
  const horst = tu.list().find(u => u.username === 'alpha_10');
  await tu.block(horst.id);
  assert.equal(mock.state.users.alpha_10.active, false);
  assert.equal(tu.assignmentFor('alpha_10'), null);
  await tu.unblock(horst.id);
  assert.equal(mock.state.users.alpha_10.active, true);
  // Passwort-Einstellung leer = zufällig; ungültige Werte abgelehnt
  assert.throws(() => tu.setOts({ ...tu.t.ots, userPassword: 'kurz' }), /8–64/);
  assert.throws(() => tu.setOts({ ...tu.t.ots, userPassword: 'a&b<c>defgh' }), /OTS/);
  // festes Passwort bleibt als Option möglich
  tu.setOts({ ...tu.t.ots, userPassword: 'feldtest1' });
  await tu.newPassword(horst.id);
  assert.equal(horst.password, 'feldtest1');
  tu.setOts({ ...tu.t.ots, userPassword: '' });
  await tu.newPassword(horst.id);
  assert.match(horst.password, /^[A-Za-z0-9]{14}$/);
  assert.equal(mock.state.users.alpha_10.password, horst.password);
  await tu.remove(horst.id);
  assert.equal(mock.state.users.alpha_10, undefined);
  assert.equal(tu.list().some(u => u.username === 'alpha_10'), false);
});
