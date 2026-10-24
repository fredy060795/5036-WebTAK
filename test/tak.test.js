// Test der TAK-Anbindung gegen einen nachgebauten TAK-Server:
// Zertifikatsanforderung (Port 8446, Benutzer/Passwort) und CoT über TLS mit Client-Zertifikat.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const tls = require('tls');
const forge = require('node-forge');
const tak = require('../lib/tak');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 30);
  const attrs = [{ shortName: 'CN', value: 'Test TAK CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey, pem: forge.pki.certificateToPem(cert) };
}

function sign(ca, publicKey, cn, serial, server) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 86400000 * 30);
  cert.setSubject([{ shortName: 'CN', value: cn }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions(server
    ? [{ name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]
    : [{ name: 'extKeyUsage', clientAuth: true }]);
  cert.sign(ca.key, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

const body = pem => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

let ca, serverKeyPem, serverCertPem, enrollSrv, cotSrv, enrollPort, cotPort;
const received = [];
let lastSubject = null;

before(async () => {
  ca = makeCa();
  const sk = forge.pki.rsa.generateKeyPair(2048);
  serverKeyPem = forge.pki.privateKeyToPem(sk.privateKey);
  serverCertPem = sign(ca, sk.publicKey, 'tak.test', '02', true);

  enrollSrv = https.createServer({ key: serverKeyPem, cert: serverCertPem }, (req, res) => {
    const ok = req.headers.authorization === 'Basic ' + Buffer.from('max:geheim').toString('base64');
    if (!ok) { res.writeHead(401); return res.end(); }
    if (req.url.startsWith('/Marti/api/tls/config')) {
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      return res.end('<certificateConfig><nameEntries><nameEntry name="O" value="TestOrg"/><nameEntry name="OU" value="EUD"/></nameEntries></certificateConfig>');
    }
    if (req.url.startsWith('/Marti/api/tls/signClient/v2') && req.method === 'POST') {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => {
        const csr = forge.pki.certificationRequestFromAsn1(forge.asn1.fromDer(forge.util.decode64(data.replace(/\s+/g, ''))));
        assert.ok(csr.verify());
        lastSubject = csr.subject.attributes.map(a => `${a.shortName}=${a.value}`).join(',');
        const signed = sign(ca, csr.publicKey, csr.subject.getField('CN').value, '0' + Date.now(), false);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ signedCert: body(signed), ca0: body(ca.pem) }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => enrollSrv.listen(0, '127.0.0.1', r));
  enrollPort = enrollSrv.address().port;

  // CoT-Port: nur Client-Zertifikate der Test-CA
  cotSrv = tls.createServer({ key: serverKeyPem, cert: serverCertPem, ca: [ca.pem], requestCert: true, rejectUnauthorized: true }, sock => {
    sock.setEncoding('utf8');
    sock.on('data', d => received.push(d));
    // Ein Kontakt vom TAK-Server, in zwei Teilen gesendet (Datenstrom)
    const ev = '<event version="2.0" uid="ANDROID-1" type="a-f-G-U-C" how="m-g" time="2026-01-01T00:00:00Z" start="2026-01-01T00:00:00Z" stale="2030-01-01T00:00:00Z"><point lat="48.3" lon="14.3" hae="0" ce="10" le="10"/><detail><contact callsign="ALPHA"/></detail></event>';
    sock.write(ev.slice(0, 50));
    setTimeout(() => sock.write(ev.slice(50)), 50);
  });
  await new Promise(r => cotSrv.listen(0, '127.0.0.1', r));
  cotPort = cotSrv.address().port;
});

after(() => {
  enrollSrv.close();
  cotSrv.close();
});

test('CoT-Datenstrom wird in vollständige Events zerlegt', () => {
  const a = tak.splitEvents('xx<event uid="1"></event><event uid="2"><det');
  assert.equal(a.events.length, 1);
  assert.equal(a.rest, '<event uid="2"><det');
  const b = tak.splitEvents(a.rest + 'ail/></event>');
  assert.equal(b.events[0], '<event uid="2"><detail/></event>');
});

let enrolled;

test('Zertifikat anfordern: unbekannter Server wird erst nach Bestätigung des Fingerabdrucks genutzt', async () => {
  await assert.rejects(
    tak.enroll({ host: '127.0.0.1', port: enrollPort, username: 'max', password: 'geheim', uid: 'EUD-1' }),
    e => e.code === 'UNTRUSTED' && e.fingerprint === tak.fingerprintOf(serverCertPem),
  );
  await assert.rejects(
    tak.enroll({ host: '127.0.0.1', port: enrollPort, username: 'max', password: 'falsch', fingerprint: tak.fingerprintOf(serverCertPem) }),
    /rejected user name\/password/,
  );
  enrolled = await tak.enroll({ host: '127.0.0.1', port: enrollPort, username: 'max', password: 'geheim', uid: 'EUD-1', fingerprint: tak.fingerprintOf(serverCertPem) });
  assert.match(enrolled.certPem, /BEGIN CERTIFICATE/);
  assert.match(enrolled.keyPem, /BEGIN RSA PRIVATE KEY/);
  assert.equal(enrolled.caPems.length, 1);
  assert.equal(lastSubject, 'CN=max,O=TestOrg,OU=EUD');
  assert.match(enrolled.info.subject, /CN=max/);
});

test('Zertifikat anfordern mit Truststore (CA) ohne Rückfrage', async () => {
  const r = await tak.enroll({ host: '127.0.0.1', port: enrollPort, username: 'max', password: 'geheim', caPems: [ca.pem] });
  assert.match(r.certPem, /BEGIN CERTIFICATE/);
});

test('CoT-Verbindung über SSL mit Client-Zertifikat: empfangen und senden', async () => {
  const statuses = [];
  const cots = [];
  const link = new tak.TakLink({
    host: '127.0.0.1', port: cotPort, proto: 'ssl', uid: 'EUD-1',
    certPem: enrolled.certPem, keyPem: enrolled.keyPem, caPems: enrolled.caPems,
    onStatus: (s, m) => statuses.push(s), onCot: x => cots.push(x),
  });
  link.send('<event uid="EUD-1" type="a-f-G-U-C"><detail/></event>'); // vor der Verbindung: wird gepuffert
  link.start();
  for (let i = 0; i < 50 && !cots.length; i++) await sleep(50);
  assert.ok(statuses.includes('connected'), statuses.join());
  assert.equal(cots.length, 1);
  assert.match(cots[0], /callsign="ALPHA"/);
  await sleep(100);
  assert.match(received.join(''), /uid="EUD-1"/, 'gepufferte Meldung wurde nach dem Verbinden gesendet');
  link.stop();
});

test('CoT-Verbindung ohne passende CA meldet "nicht vertrauenswürdig" mit Fingerabdruck', async () => {
  let untrusted = null;
  const link = new tak.TakLink({
    host: '127.0.0.1', port: cotPort, proto: 'ssl', uid: 'EUD-2',
    certPem: enrolled.certPem, keyPem: enrolled.keyPem, caPems: [],
    onStatus: (s, m, extra) => { if (s === 'untrusted') untrusted = extra; },
  });
  link.start();
  for (let i = 0; i < 50 && !untrusted; i++) await sleep(50);
  assert.equal(untrusted.fingerprint, tak.fingerprintOf(serverCertPem));
  link.stop();
});

test('.p12 lesen: Client-Zertifikat und Truststore', () => {
  const key = forge.pki.privateKeyFromPem(enrolled.keyPem);
  const cert = forge.pki.certificateFromPem(enrolled.certPem);
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert, ca.cert], 'atakatak', { algorithm: '3des' });
  const b64 = forge.util.encode64(forge.asn1.toDer(p12).getBytes());
  const r = tak.readP12(b64, 'atakatak');
  assert.equal(r.kind, 'client');
  assert.equal(tak.fingerprintOf(r.certPem), tak.fingerprintOf(enrolled.certPem));
  assert.equal(r.caPems.length, 1);
  assert.throws(() => tak.readP12(b64, 'falsch'), /wrong password/);

  const ts = forge.pkcs12.toPkcs12Asn1(null, [ca.cert], 'atakatak', { algorithm: '3des' });
  const t = tak.readP12(forge.util.encode64(forge.asn1.toDer(ts).getBytes()), 'atakatak');
  assert.equal(t.kind, 'truststore');
  assert.equal(t.caPems.length, 1);
});

test('ATAK-Datenpaket (.zip) mit .pref, Client- und CA-.p12', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  fs.mkdirSync(path.join(dir, 'certs'));
  const key = forge.pki.privateKeyFromPem(enrolled.keyPem);
  const cert = forge.pki.certificateFromPem(enrolled.certPem);
  const der = a => Buffer.from(forge.asn1.toDer(a).getBytes(), 'binary');
  fs.writeFileSync(path.join(dir, 'certs', 'max.p12'), der(forge.pkcs12.toPkcs12Asn1(key, [cert], 'clientpw', { algorithm: '3des' })));
  fs.writeFileSync(path.join(dir, 'certs', 'truststore-root.p12'), der(forge.pkcs12.toPkcs12Asn1(null, [ca.cert], 'capw', { algorithm: '3des' })));
  fs.writeFileSync(path.join(dir, 'certs', 'config.pref'), `<?xml version='1.0' standalone='yes'?>
<preferences><preference version="1" name="cot_streams">
<entry key="count" class="class java.lang.Integer">1</entry>
<entry key="description0" class="class java.lang.String">Mein TAK</entry>
<entry key="connectString0" class="class java.lang.String">tak.example.com:8089:ssl</entry>
</preference><preference version="1" name="com.atakmap.app_preferences">
<entry key="caLocation" class="class java.lang.String">cert/truststore-root.p12</entry>
<entry key="caPassword" class="class java.lang.String">capw</entry>
<entry key="certificateLocation" class="class java.lang.String">cert/max.p12</entry>
<entry key="clientPassword" class="class java.lang.String">clientpw</entry>
</preference></preferences>`);
  execFileSync('zip', ['-qr', path.join(dir, 'pkg.zip'), 'certs'], { cwd: dir });
  const r = tak.readDataPackage(fs.readFileSync(path.join(dir, 'pkg.zip')).toString('base64'));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(r.server, { host: 'tak.example.com', port: 8089, proto: 'ssl', description: 'Mein TAK' });
  assert.equal(tak.fingerprintOf(r.certPem), tak.fingerprintOf(enrolled.certPem));
  assert.match(r.keyPem, /PRIVATE KEY/);
  assert.equal(r.caPems.length, 1);
});

test('TAK-Server-API: Datenpakete, Missionen (Data Sync), Video-Feeds mit Client-Zertifikat', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  // Datenpaket mit CoT und KML bauen
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  fs.mkdirSync(path.join(dir, 'MANIFEST'));
  fs.writeFileSync(path.join(dir, 'MANIFEST', 'manifest.xml'), '<MissionPackageManifest/>');
  fs.writeFileSync(path.join(dir, 'punkt.cot'), '<event version="2.0" uid="PKG-1" type="b-m-p-s-p-i"><point lat="1" lon="2"/><detail/></event>');
  fs.writeFileSync(path.join(dir, 'gebiet.kml'), '<kml><Document><Placemark><name>A</name><Point><coordinates>14,48</coordinates></Point></Placemark></Document></kml>');
  execFileSync('zip', ['-qr', 'p.zip', 'MANIFEST', 'punkt.cot', 'gebiet.kml'], { cwd: dir });
  const zip = fs.readFileSync(path.join(dir, 'p.zip'));
  fs.rmSync(dir, { recursive: true, force: true });
  const HASH = 'ab'.repeat(32);
  let subscribed = '';
  const api = https.createServer({ key: serverKeyPem, cert: serverCertPem, ca: [ca.pem], requestCert: true, rejectUnauthorized: true }, (req, res) => {
    const u = new URL(req.url, 'https://x');
    const send = (type, body) => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
    if (u.pathname === '/Marti/sync/search') return send('application/json', JSON.stringify({ resultCount: 1, results: [{ Hash: HASH, Name: 'Lage.zip', Size: zip.length, SubmissionUser: 'max' }] }));
    if (u.pathname === '/Marti/sync/content' && u.searchParams.get('hash') === HASH) return send('application/zip', zip);
    if (u.pathname === '/Marti/api/video') return send('application/xml', '<videoConnections><feed><alias>Drohne</alias><url>rtsp://10.0.0.9:8554/live</url></feed></videoConnections>');
    if (u.pathname === '/Marti/api/missions') return send('application/json', JSON.stringify({ data: [{ name: 'Einsatz 1', description: 'Test', contents: [{}], uids: [{}] }] }));
    if (u.pathname === '/Marti/api/missions/Einsatz%201/subscription' && req.method === 'PUT') { subscribed = u.searchParams.get('uid'); return send('application/json', '{}'); }
    if (u.pathname === '/Marti/api/missions/Einsatz%201/cot') return send('application/xml', '<events><event version="2.0" uid="MIS-1" type="a-h-G"><point lat="1" lon="2"/><detail/></event></events>');
    if (u.pathname === '/Marti/api/missions/Einsatz%201') return send('application/json', JSON.stringify({ data: [{ name: 'Einsatz 1', contents: [{ data: { name: 'gebiet.zip', hash: HASH } }] }] }));
    res.writeHead(404); res.end();
  });
  await new Promise(r => api.listen(0, '127.0.0.1', r));
  const conn = { host: '127.0.0.1', apiPort: api.address().port, caPems: [ca.pem], certPem: enrolled.certPem, keyPem: enrolled.keyPem };
  try {
    const { packages } = await tak.marti(conn, 'packages');
    assert.equal(packages[0].name, 'Lage.zip');
    const pkg = await tak.marti(conn, 'package', { hash: HASH, name: 'Lage.zip' });
    assert.equal(pkg.cot.length, 1);
    assert.match(pkg.cot[0], /PKG-1/);
    assert.equal(pkg.overlays.length, 1);
    assert.equal(pkg.overlays[0].name, 'gebiet');
    assert.deepEqual((await tak.marti(conn, 'videos')).feeds, [{ alias: 'Drohne', url: 'rtsp://10.0.0.9:8554/live' }]);
    assert.equal((await tak.marti(conn, 'missions')).missions[0].name, 'Einsatz 1');
    const mis = await tak.marti(conn, 'mission', { name: 'Einsatz 1', uid: 'EUD-1' });
    assert.equal(subscribed, 'EUD-1');
    assert.ok(mis.cot.some(x => x.includes('MIS-1')) && mis.cot.some(x => x.includes('PKG-1')));
    assert.equal(mis.overlays.length, 1);
    await assert.rejects(tak.marti(conn, 'package', { hash: '../etc' }), /Invalid id/);
    await assert.rejects(tak.marti({ ...conn, certPem: '' }, 'packages'), /client certificate/);
  } finally {
    api.close();
  }
});

test('KMZ-Overlay im Datenpaket: KML mit Namensraum und Bild (GroundOverlay)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kmz-'));
  fs.mkdirSync(path.join(dir, 'k', 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'k', 'doc.kml'), '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><GroundOverlay><Icon><href>files/karte.png</href></Icon><LatLonBox><north>48.4</north><south>48.3</south><east>14.4</east><west>14.3</west></LatLonBox></GroundOverlay></Document></kml>');
  fs.writeFileSync(path.join(dir, 'k', 'files', 'karte.png'), Buffer.alloc(200, 1));
  fs.mkdirSync(path.join(dir, 'k', '1'));
  fs.writeFileSync(path.join(dir, 'k', '1', '0.kml'), '<kml><GroundOverlay><Icon><href>0.png</href></Icon></GroundOverlay></kml>');
  execFileSync('zip', ['-qr', '../karte.kmz', '.'], { cwd: path.join(dir, 'k') });
  execFileSync('zip', ['-q', 'paket.zip', 'karte.kmz'], { cwd: dir });
  const r = tak.extractContent('paket.zip', fs.readFileSync(path.join(dir, 'paket.zip')));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.overlays.length, 1);
  assert.equal(r.overlays[0].name, 'karte');
  assert.match(r.overlays[0].kml, /GroundOverlay/);
  assert.match(r.overlays[0].images['files/karte.png'], /^data:image\/png;base64,/);
  assert.equal(r.overlays[0].path, 'doc.kml');
  assert.deepEqual(Object.keys(r.overlays[0].extra), ['1/0.kml']);
});

test('Erlaubte TAK-Server', () => {
  assert.equal(tak.hostAllowed('', 'irgendwas'), true);
  assert.equal(tak.hostAllowed('tak.example.com, 10.0.0.5', 'TAK.example.com'), true);
  assert.equal(tak.hostAllowed('tak.example.com', 'evil.com'), false);
});

test('Ohne Liste: eigener Rechner und Link-Local gesperrt, ausdrücklich gelistet erlaubt', async () => {
  assert.equal(await tak.targetAllowed('', '127.0.0.1'), false);
  assert.equal(await tak.targetAllowed('', 'localhost'), false);
  assert.equal(await tak.targetAllowed('', '169.254.169.254'), false);
  assert.equal(await tak.targetAllowed('', '::ffff:127.0.0.1'), false);
  assert.equal(await tak.targetAllowed('', '10.0.0.5'), true);
  assert.equal(await tak.targetAllowed('', 'a b'), false);
  assert.equal(await tak.targetAllowed('127.0.0.1', '127.0.0.1'), true);
});
