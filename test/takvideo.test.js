// Kamera-Streams automatisch im OpenTAKServer (MediaMTX) eintragen: Pfad, Abgleich, Umbenennen, Sperren, Löschen.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');
const { StreamHub } = require('../lib/streams');
const { TakUsers } = require('../lib/takusers');
const { TakVideo } = require('../lib/takvideo');
const { createMockOts } = require('./ots-mock');

let mock, url, dir, store, hub, tu, tv;
const BASE = 'https://cams.example.com';

before(async () => {
  mock = createMockOts();
  url = await mock.listen();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takvideo-'));
  store = new Store(dir);
  hub = new StreamHub({ store, ffmpeg: false, workDir: dir });
  tu = new TakUsers(store);
  tv = new TakVideo({ store, hub, takUsers: tu, base: () => BASE });
});

after(() => {
  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ohne OTS passiert nichts', async () => {
  const e = hub.register('Jörg Müller', 'Zug 1');
  await tv.touch(StreamHub.id(e.user, e.streamId));
  assert.equal(Object.keys(mock.state.videos).length, 0);
  assert.equal(tv.state().ready, false);
});

test('Abgleich trägt alle Streams mit automatischem Pfad und HLS-Quelle ein', async () => {
  tu.setOts({ url, username: 'otsadmin', password: 'otspass', host: 'tak.example.com' });
  hub.register('Jörg Müller', 'Zug 2'); // gleicher Name -> eindeutiger Pfad
  const r = await tv.syncAll();
  assert.equal(r.ok, true, JSON.stringify(r));
  const paths = Object.keys(mock.state.videos).sort();
  assert.deepEqual(paths, ['cam/joerg-mueller', 'cam/joerg-mueller-2']);
  const v = mock.state.videos['cam/joerg-mueller'];
  assert.match(v.source, /^https:\/\/cams\.example\.com\/joerg-mueller[^/]*\/[^/]+\/index\.m3u8$/);
  assert.equal(v.onDemand, true);
  assert.equal(v.host, 'tak.example.com'); // OTS setzt diese Adresse in den ATAK-Link
  const view = tv.state().streams.find(s => s.path === 'cam/joerg-mueller');
  assert.equal(view.inTak, true);
  assert.equal(view.rtsp, 'rtsp://tak.example.com:8554/cam/joerg-mueller');
});

test('Pfad ändern: alter Pfad raus, neuer rein; ungültig/doppelt abgelehnt', async () => {
  const id = tv.state().streams.find(s => s.path === 'cam/joerg-mueller').id;
  await assert.rejects(tv.set(id, { path: '../x' }), /Pfad/);
  await assert.rejects(tv.set(id, { path: 'cam/joerg-mueller-2' }), /anderer Stream/);
  const v = await tv.set(id, { path: '/alpha/helm-1/' });
  assert.equal(v.path, 'alpha/helm-1');
  assert.equal(v.inTak, true);
  assert.ok(mock.state.videos['alpha/helm-1']);
  assert.equal(mock.state.videos['cam/joerg-mueller'], undefined);
  // leer = wieder automatisch
  assert.equal((await tv.set(id, { path: '' })).path, 'cam/joerg-mueller');
});

test('Sperren, Abschalten und Löschen tragen aus; Freigeben wieder ein', async () => {
  const id = tv.state().streams.find(s => s.path === 'cam/joerg-mueller').id;
  hub.setEnabled(id, false);
  await tv.touch(id);
  assert.equal(mock.state.videos['cam/joerg-mueller'], undefined);
  hub.setEnabled(id, true);
  await tv.touch(id);
  assert.ok(mock.state.videos['cam/joerg-mueller']);
  await tv.set(id, { enabled: false });
  assert.equal(mock.state.videos['cam/joerg-mueller'], undefined);
  await tv.set(id, { enabled: true });
  hub.remove(id);
  await tv.removed(id);
  assert.equal(mock.state.videos['cam/joerg-mueller'], undefined);
  assert.equal(store.data.takVideo.paths[id], undefined);
});

test('Modus "nur live" und Automatik aus', async () => {
  tv.setSettings({ when: 'live' });
  await tv.syncAll();
  assert.equal(Object.keys(mock.state.videos).length, 0); // niemand sendet
  const id = tv.state().streams[0].id;
  hub.live(id).publisher = {}; // Kamera verbunden
  await tv.touch(id);
  assert.equal(Object.keys(mock.state.videos).length, 1);
  hub.live(id).publisher = null;
  tv.setSettings({ when: 'all', auto: false });
  const e = hub.register('Neu', '');
  await tv.touch(StreamHub.id(e.user, e.streamId));
  assert.equal(mock.state.videos['cam/neu'], undefined); // Automatik aus: nicht eintragen
  assert.equal(tv.view(StreamHub.id(e.user, e.streamId)).path, 'cam/neu'); // Pfad trotzdem vorgeschlagen
});

test('bereits vorhandener Pfad (z. B. nach Neustart) wird übernommen', async () => {
  tv.setSettings({ auto: true });
  const e = hub.register('Bravo', '');
  const id = StreamHub.id(e.user, e.streamId);
  mock.state.videos['cam/bravo'] = { source: 'alt', host: 'x' };
  await tv.touch(id);
  assert.equal(mock.state.videos['cam/bravo'].source, tv.sourceFor(id));
  assert.equal(tv.view(id).inTak, true);
});
