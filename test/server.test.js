// Ende-zu-Ende-Test: startet den Server in einem eigenen Datenordner und spielt
// Admin, Handy (WebSocket) und Zuschauer (MJPEG/HLS/TS) durch.
//   npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const JPEG_A = fs.readFileSync(path.join(__dirname, 'fixtures', 'a.jpg'));
const JPEG_B = fs.readFileSync(path.join(__dirname, 'fixtures', 'b.jpg'));
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let proc, base, dataDir, cookie = '';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmcam-test-'));
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', BIND: '127.0.0.1', DATA_DIR: dataDir, PUBLIC_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', d => {
      out += d;
      const m = out.match(/läuft auf http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) resolve('http://127.0.0.1:' + m[1]);
    });
    proc.stderr.on('data', d => process.stderr.write(d));
    proc.on('exit', code => reject(new Error('Server beendet: ' + code + '\n' + out)));
  });
});

after(() => {
  proc.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function api(p, { method = 'GET', body, csrf = true } = {}) {
  const res = await fetch(base + '/api/admin/' + p, {
    method,
    headers: {
      ...(csrf ? { 'X-Requested-With': 'helm' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}

function publisher(stream, key) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/publish?u=${stream.user}&s=${stream.streamId}&k=${key}`);
  const messages = [];
  ws.on('message', (d, bin) => { if (!bin) messages.push(JSON.parse(d.toString())); });
  const closed = new Promise(r => ws.on('close', (code) => r(code)));
  const waitFor = async (type, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = messages.find(x => x.type === type);
      if (m) return m;
      await sleep(20);
    }
    throw new Error('Nachricht fehlt: ' + type + ' (bekommen: ' + JSON.stringify(messages) + ')');
  };
  return { ws, messages, waitFor, closed };
}

// Liest den MJPEG-Stream, bis n Bilder angekommen sind
function readMjpeg(url, n, ms = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      assert.match(res.headers['content-type'], /multipart\/x-mixed-replace/);
      let buf = Buffer.alloc(0);
      const frames = [];
      res.on('data', d => {
        buf = Buffer.concat([buf, d]);
        let m;
        while ((m = buf.toString('latin1').match(/Content-Length: (\d+)\r\n\r\n/))) {
          const start = m.index + m[0].length;
          const len = Number(m[1]);
          if (buf.length < start + len) break;
          frames.push(buf.subarray(start, start + len));
          buf = buf.subarray(start + len);
          if (frames.length >= n) { req.destroy(); resolve(frames); return; }
        }
      });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('MJPEG: zu wenige Bilder')); }, ms);
  });
}

let s1, s2;

test('erster Login mit admin/admin123 erzwingt Passwortwechsel', async () => {
  assert.equal((await api('streams')).status, 401);
  assert.equal((await api('login', { method: 'POST', body: { username: 'admin', password: 'falsch' } })).status, 400);
  const login = await api('login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChange, true);
  const blocked = await api('streams');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.mustChange, true);
  // Standardpasswort darf nicht bleiben
  const same = await api('credentials', { method: 'POST', body: { current: 'admin123', username: 'admin', password: 'admin123' } });
  assert.equal(same.status, 400);
  const ok = await api('credentials', { method: 'POST', body: { current: 'admin123', username: 'chef', email: 'chef@example.com', password: 'geheim-12345' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await api('streams')).status, 200);
  const me = await api('me');
  assert.equal(me.data.username, 'chef');
  assert.equal(me.data.mustChange, false);
});

test('schreibende Admin-Anfragen ohne CSRF-Header werden abgelehnt', async () => {
  const r = await api('streams', { method: 'POST', body: { user: 'x' }, csrf: false });
  assert.equal(r.status, 403);
});

test('Streams anlegen: eindeutige Pfade, ungültige Namen abgelehnt', async () => {
  assert.equal((await api('streams', { method: 'POST', body: { user: 'admin' } })).status, 400);
  assert.equal((await api('streams', { method: 'POST', body: { user: '../x' } })).status, 400);
  const a = await api('streams', { method: 'POST', body: { user: 'Mueller', label: 'Trupp 1' } });
  const b = await api('streams', { method: 'POST', body: { user: 'mueller', label: 'Trupp 2' } });
  assert.equal(a.status, 200);
  s1 = a.data.stream;
  s2 = b.data.stream;
  assert.equal(s1.user, 'mueller');
  assert.notEqual(s1.streamId, s2.streamId);
  assert.equal(s1.links.stream, `${base}/mueller/${s1.streamId}`);
  assert.match(s1.links.app, /\/app\/#u=mueller&s=\w+&k=[\w-]+$/);
  const qr = await fetch(base + `/api/admin/streams/mueller/${s1.streamId}/qr.svg`, { headers: { cookie } });
  assert.match(await qr.text(), /^<svg/);
});

const keyOf = s => new URLSearchParams(s.links.app.split('#')[1]).get('k');

test('Handy sendet Bilder, Zuschauer bekommen MJPEG, Streams getrennt', async () => {
  const bad = publisher(s1, 'falscher-schluessel');
  assert.equal((await bad.waitFor('invalid')).type, 'invalid');

  const p1 = publisher(s1, keyOf(s1));
  const p2 = publisher(s2, keyOf(s2));
  await p1.waitFor('welcome');
  await p2.waitFor('welcome');
  p1.ws.send(JSON.stringify({ type: 'hello', camera: 'Helm 1' }));
  p1.ws.send(Buffer.from('kein jpeg'));

  const viewer1 = readMjpeg(s1.links.stream, 2);
  const viewer2 = readMjpeg(s2.links.stream, 1);
  await sleep(200);
  p1.ws.send(JPEG_A);
  p2.ws.send(JPEG_B);
  await sleep(100);
  p1.ws.send(JPEG_B);
  const [f1, f2] = [await viewer1, await viewer2];
  assert.ok(f1[0].equals(JPEG_A));
  assert.ok(f1[1].equals(JPEG_B));
  assert.ok(f2[0].equals(JPEG_B), 'Stream 2 bekommt nur seine eigenen Bilder');

  const snap = await fetch(s1.links.snapshot);
  assert.ok(Buffer.from(await snap.arrayBuffer()).equals(JPEG_B));

  const list = (await api('streams')).data.streams;
  const st = list.find(x => x.streamId === s1.streamId);
  assert.equal(st.phoneConnected, true);
  assert.equal(st.receiving, true);
  assert.equal(st.camera, 'Helm 1');
  p1.ws.close();
  p2.ws.close();
});

test('zweites Handy auf demselben Stream löst das erste ab', async () => {
  const a = publisher(s2, keyOf(s2));
  await a.waitFor('welcome');
  const b = publisher(s2, keyOf(s2));
  await b.waitFor('welcome');
  await a.waitFor('replaced');
  b.ws.close();
});

test('HLS und MPEG-TS über ffmpeg', { skip: !HAS_FFMPEG && 'ffmpeg fehlt' }, async () => {
  const p = publisher(s1, keyOf(s1));
  await p.waitFor('welcome');
  const feeder = setInterval(() => p.ws.send(JPEG_A), 100);
  try {
    let playlist;
    for (let i = 0; i < 20; i++) {
      const r = await fetch(s1.links.hls);
      if (r.status === 200) { playlist = await r.text(); if (/seg\d+\.ts/.test(playlist)) break; }
      await sleep(500);
    }
    assert.match(playlist, /#EXTM3U/);
    const seg = playlist.match(/(seg\d+\.ts)/)[1];
    const segRes = await fetch(`${s1.links.stream}/${seg}`);
    assert.equal(segRes.status, 200);
    const segData = Buffer.from(await segRes.arrayBuffer());
    assert.equal(segData[0], 0x47, 'MPEG-TS Sync-Byte');

    const ts = await new Promise((resolve, reject) => {
      const req = http.get(s1.links.ts, res => {
        let n = Buffer.alloc(0);
        res.on('data', d => { n = Buffer.concat([n, d]); if (n.length > 4000) { req.destroy(); resolve(n); } });
      });
      req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
      setTimeout(() => reject(new Error('kein TS')), 8000);
    });
    assert.equal(ts[0], 0x47);
  } finally {
    clearInterval(feeder);
    p.ws.close();
  }
});

test('Stoppen, Alle stoppen, Freigeben, Rauswerfen, Löschen', async () => {
  const p = publisher(s1, keyOf(s1));
  await p.waitFor('welcome');
  assert.equal((await api(`streams/mueller/${s1.streamId}/stop`, { method: 'POST', body: {} })).status, 200);
  await p.waitFor('stopped');
  await p.closed;
  const again = publisher(s1, keyOf(s1));
  await again.waitFor('stopped');

  assert.equal((await api(`streams/mueller/${s1.streamId}/start`, { method: 'POST', body: {} })).status, 200);
  const p2 = publisher(s1, keyOf(s1));
  await p2.waitFor('welcome');
  const p3 = publisher(s2, keyOf(s2));
  await p3.waitFor('welcome');
  assert.equal((await api('streams/stop-all', { method: 'POST', body: {} })).status, 200);
  await p2.waitFor('stopped');
  await p3.waitFor('stopped');
  const list = (await api('streams')).data.streams;
  assert.ok(list.every(s => !s.enabled));

  await api(`streams/mueller/${s1.streamId}/start`, { method: 'POST', body: {} });
  const oldKey = keyOf(s1);
  const p4 = publisher(s1, oldKey);
  await p4.waitFor('welcome');
  const rev = await api(`streams/mueller/${s1.streamId}/revoke`, { method: 'POST', body: {} });
  assert.equal(rev.status, 200);
  await p4.waitFor('revoked');
  assert.notEqual(keyOf(rev.data), oldKey);
  await publisher(s1, oldKey).waitFor('invalid');
  const p5 = publisher(s1, keyOf(rev.data));
  await p5.waitFor('welcome');

  assert.equal((await api(`streams/mueller/${s1.streamId}`, { method: 'DELETE', body: {} })).status, 200);
  await p5.waitFor('removed');
  assert.equal((await fetch(s1.links.stream)).status, 404);
});

test('Passwort vergessen verrät nichts, Reset-Link ungültig ohne Token', async () => {
  const r = await api('forgot', { method: 'POST', body: { username: 'unbekannt' } });
  assert.equal(r.status, 200);
  const reset = await api('reset', { method: 'POST', body: { token: 'x', password: 'neues-passwort' } });
  assert.equal(reset.status, 400);
});

test('Admin nur auf der Admin-Domain, wenn ADMIN_HOST gesetzt ist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helmcam-test2-'));
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', BIND: '127.0.0.1', DATA_DIR: dir, ADMIN_HOST: 'admin.example.com' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const url = await new Promise(resolve => {
      let out = '';
      p.stdout.on('data', d => { out += d; const m = out.match(/:(\d+)\n/); if (m) resolve('http://127.0.0.1:' + m[1]); });
    });
    const req = (host, p_) => new Promise(resolve => http.get(url + p_, { headers: { host } }, res => { res.resume(); resolve(res.statusCode); }));
    assert.equal(await req('cam.example.com', '/admin/'), 404);
    assert.equal(await req('cam.example.com', '/api/admin/me'), 404);
    assert.equal(await req('admin.example.com', '/admin/'), 200);
    assert.equal(await req('admin.example.com', '/api/admin/me'), 401);
    assert.equal(await req('cam.example.com', '/app/'), 200);
  } finally {
    p.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Minimaler SMTP-Server, der die Mail auffängt
function smtpSink() {
  const net = require('net');
  const mails = [];
  const srv = net.createServer(sock => {
    let data = false, body = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', chunk => {
      for (const line of chunk.toString().split('\r\n')) {
        if (data) {
          if (line === '.') { data = false; mails.push(body); sock.write('250 OK\r\n'); } else body += line + '\n';
          continue;
        }
        if (!line) continue;
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
        else if (cmd === 'DATA') { data = true; body = ''; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, mails })));
}

test('Passwort vergessen per SMTP: Mail mit Link, neues Passwort, Login', async () => {
  const sink = await smtpSink();
  try {
    const save = await api('smtp', { method: 'POST', body: { host: '127.0.0.1', port: sink.port, secure: false, from: 'helm@example.com' } });
    assert.equal(save.status, 200);
    assert.equal((await api('smtp/test', { method: 'POST', body: {} })).status, 200);
    assert.match(sink.mails[0], /SMTP funktioniert/);

    await api('logout', { method: 'POST', body: {} });
    cookie = '';
    assert.equal((await api('forgot', { method: 'POST', body: { username: 'chef@example.com' } })).status, 200);
    for (let i = 0; i < 50 && sink.mails.length < 2; i++) await sleep(50);
    const mail = sink.mails[1].replace(/=\n/g, '').replace(/=3D/g, '=');
    const token = mail.match(/#reset=([\w-]+)/)[1];
    assert.equal((await api('reset', { method: 'POST', body: { token, password: 'kurz' } })).status, 400);
    assert.equal((await api('reset', { method: 'POST', body: { token, password: 'ganz-neues-passwort' } })).status, 200);
    assert.equal((await api('reset', { method: 'POST', body: { token, password: 'noch-ein-passwort' } })).status, 400, 'Link nur einmal gültig');
    assert.equal((await api('login', { method: 'POST', body: { username: 'chef', password: 'geheim-12345' } })).status, 400);
    assert.equal((await api('login', { method: 'POST', body: { username: 'chef', password: 'ganz-neues-passwort' } })).status, 200);
  } finally {
    sink.srv.close();
  }
});

test('JPEG-Größe wird aus dem Kopf gelesen', () => {
  const { jpegSize } = require('../lib/streams');
  assert.equal(jpegSize(JPEG_A), '320x240');
  assert.equal(jpegSize(fs.readFileSync(path.join(__dirname, 'fixtures', 'portrait.jpg'))), '240x320');
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0x00])), null);
});

test('Drehung: Standard für neue Streams, Änderung geht sofort ans Handy', async () => {
  assert.equal((await api('defaults', { method: 'POST', body: { rotate: 90, mirror: false } })).status, 200);
  const created = await api('streams', { method: 'POST', body: { user: 'helm', label: 'quer' } });
  const s = created.data.stream;
  assert.equal(s.rotate, 90);

  const p = publisher(s, keyOf(s));
  await p.waitFor('welcome');
  const cfg = await p.waitFor('config');
  assert.equal(cfg.rotate, 90);

  p.messages.length = 0;
  assert.equal((await api(`streams/helm/${s.streamId}/options`, { method: 'POST', body: { rotate: 270, mirror: true } })).status, 200);
  const cfg2 = await p.waitFor('config');
  assert.equal(cfg2.rotate, 270);
  assert.equal(cfg2.mirror, true);
  // ungültige Werte werden auf 0 gesetzt
  await api(`streams/helm/${s.streamId}/options`, { method: 'POST', body: { rotate: 45 } });
  let st = (await api('streams')).data.streams.find(x => x.streamId === s.streamId);
  assert.equal(st.rotate, 0);

  // auf alle bestehenden anwenden
  await api('defaults', { method: 'POST', body: { rotate: 180, mirror: false, applyAll: true } });
  const all = (await api('streams')).data.streams;
  assert.ok(all.every(x => x.rotate === 180));
  st = all.find(x => x.streamId === s.streamId);
  assert.equal(st.mirror, false);
  p.ws.close();
});

test('HLS läuft weiter, wenn das Bild von quer auf hoch wechselt', { skip: !HAS_FFMPEG && 'ffmpeg fehlt' }, async () => {
  const PORTRAIT = fs.readFileSync(path.join(__dirname, 'fixtures', 'portrait.jpg'));
  const s = (await api('streams', { method: 'POST', body: { user: 'helm', label: 'wechsel' } })).data.stream;
  const p = publisher(s, keyOf(s));
  await p.waitFor('welcome');
  let current = JPEG_A;
  const feeder = setInterval(() => p.ws.send(current), 100);
  const waitSegments = async () => {
    for (let i = 0; i < 30; i++) {
      const r = await fetch(s.links.hls);
      if (r.status === 200) {
        const text = await r.text();
        const segs = text.match(/seg\d+\.ts/g);
        if (segs) return segs;
      }
      await sleep(400);
    }
    throw new Error('keine HLS-Segmente');
  };
  try {
    await waitSegments();
    current = PORTRAIT;
    await sleep(800);
    const segs = await waitSegments();
    const seg = await fetch(`${s.links.stream}/${segs[segs.length - 1]}`);
    assert.equal(seg.status, 200);
    // ffprobe prüft, dass das neue Segment hochkant ist
    const file = path.join(os.tmpdir(), 'helmcam-seg.ts');
    fs.writeFileSync(file, Buffer.from(await seg.arrayBuffer()));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]);
    assert.equal(probe.stdout.toString().trim().split('\n')[0], '240,320', 'ffprobe: ' + probe.stderr);
    const st = (await api('streams')).data.streams.find(x => x.streamId === s.streamId);
    assert.equal(st.resolution, '240x320');
  } finally {
    clearInterval(feeder);
    p.ws.close();
  }
});
