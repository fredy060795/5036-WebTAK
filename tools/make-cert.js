// Erzeugt Test-Zertifikate für HTTPS am PC (nur zum Testen, nicht für den Server im Internet):
//   data/certs/ca.crt + ca.key          eigene Zertifizierungsstelle, bleibt erhalten
//   data/certs/server.crt + server.key  Zertifikat für die angegebenen IPs/Namen, wird bei Änderung neu erzeugt
//
//   node tools/make-cert.js <ordner> <ip-oder-name> [weitere ...]
// Ausgabe (stdout): Pfad der CA-Datei

const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const [dir, ...names] = process.argv.slice(2);
if (!dir || !names.length) {
  console.error('Aufruf: node tools/make-cert.js <ordner> <ip-oder-name> [...]');
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });
const file = n => path.join(dir, n);
const isIp = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

const hosts = [...new Set([...names, 'localhost', '127.0.0.1', os.hostname()])].filter(Boolean);
const wanted = hosts.slice().sort().join(',');

function serial() {
  return '01' + forge.util.bytesToHex(forge.random.getBytesSync(15));
}

// --- CA (einmalig) ---
let caCert, caKey;
if (fs.existsSync(file('ca.crt')) && fs.existsSync(file('ca.key'))) {
  caCert = forge.pki.certificateFromPem(fs.readFileSync(file('ca.crt'), 'utf8'));
  caKey = forge.pki.privateKeyFromPem(fs.readFileSync(file('ca.key'), 'utf8'));
} else {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  caKey = keys.privateKey;
  caCert = forge.pki.createCertificate();
  caCert.publicKey = keys.publicKey;
  caCert.serialNumber = serial();
  caCert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  caCert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const attrs = [
    { name: 'commonName', value: 'Helm Camera Test-CA (' + os.hostname() + ')' },
    { name: 'organizationName', value: 'Helm Camera Streams' },
  ];
  caCert.setSubject(attrs);
  caCert.setIssuer(attrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(caKey, forge.md.sha256.create());
  fs.writeFileSync(file('ca.crt'), forge.pki.certificateToPem(caCert));
  fs.writeFileSync(file('ca.key'), forge.pki.privateKeyToPem(caKey), { mode: 0o600 });
  console.error('Neue Test-CA erzeugt.');
}

// --- Server-Zertifikat (neu, wenn IP/Name sich geändert hat oder es bald abläuft) ---
let current = '';
try { current = fs.readFileSync(file('server.hosts'), 'utf8'); } catch (e) { /* neu */ }
let expiresSoon = true;
try {
  const old = forge.pki.certificateFromPem(fs.readFileSync(file('server.crt'), 'utf8'));
  expiresSoon = old.validity.notAfter.getTime() - Date.now() < 30 * 24 * 3600 * 1000;
} catch (e) { /* neu */ }

if (current !== wanted || expiresSoon || !fs.existsSync(file('server.key'))) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600 * 1000); // Browser erlauben max. 398 Tage
  cert.setSubject([{ name: 'commonName', value: names[0] }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: hosts.map(h => (isIp(h) ? { type: 7, ip: h } : { type: 2, value: h })) },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  fs.writeFileSync(file('server.crt'), forge.pki.certificateToPem(cert) + forge.pki.certificateToPem(caCert));
  fs.writeFileSync(file('server.key'), forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(file('server.hosts'), wanted);
  console.error('Server-Zertifikat erzeugt für: ' + hosts.join(', '));
}

console.log(file('ca.crt'));
