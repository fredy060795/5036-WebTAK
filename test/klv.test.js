// Tests the drone telemetry (KLV, MISB ST 0601) in lib/klv.js. Reference values from the klvdata library
// (Python); the second packet comes from ffmpeg 6, which cuts the first 5 bytes of the KLV key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { KlvReader, interpret, toCot } = require('../lib/klv');

// built and decoded with klvdata (all mapped tags + tail number + checksum)
const PACKET = '060e2b34020b01010e010301010000006f050220970602d7fb07023d310d04c29a706d0e04cd039b700f0264f5100229621102e7ec12043853932e13047f18fe37150423bc91511704973910e618049751f56b190242231a0263221b02e9ac1c0206301d02d6951f0277b92102212f380137040844524f4e452d31340102e0ca';
const EXPECTED = {
  heading: 45.83016708628977, pitch: -6.253242591631825, roll: 23.903622547074804, lat: -43.169570189514, lon: -71.6989352142899,
  alt: 6947.951476310368, hfov: 29.097734035248344, vfov: 163.0725566491188, relAz: 79.20909076910678, relEl: 178.73104087949315,
  slant: 697980.3195451341, fcLat: -73.67138855795906, fcLon: -147.20603768118008, fcElev: 4241.174944686045,
  oLat1: 0.05808740501113925, oLon1: -0.013083285012359995, oLat2: 0.0036255989257484716, oLon2: -0.024269081698049866,
  oLon3: 0.07015213476973785, oLon4: 0.019444105349894714, speed: 55, tail: 'DRONE-14',
};
// drone 250 m north of 47.9135/7.8930 at 1050 m (150 m above ground), camera 35° down towards the south
const CUT = '0b01010e0103010100000040040b44524f4e4520414c504841050240000d04442597340e04059ce0760f02191610025555110238e31204400000001304e71c71c71902172838010d010214de';

const read = (buf, step = 7) => {
  const sets = [];
  const r = new KlvReader(s => sets.push(s));
  for (let i = 0; i < buf.length; i += step) r.push(buf.subarray(i, i + step));
  return sets;
};

test('MISB 0601 values like klvdata, also in small pieces', () => {
  const [s] = read(Buffer.from(PACKET, 'hex'));
  for (const [k, v] of Object.entries(EXPECTED)) {
    if (typeof v === 'string') assert.equal(s[k], v, k);
    else assert.ok(Math.abs(s[k] - v) < 1e-9, `${k}: ${s[k]} != ${v}`);
  }
});

test('wrong checksum is rejected, key cut by ffmpeg 6 is repaired', () => {
  const bad = Buffer.from(PACKET, 'hex');
  bad[40] ^= 0xff;
  assert.equal(read(bad).length, 0);
  const cut = Buffer.from(CUT, 'hex');
  assert.equal(read(Buffer.concat([cut, cut, cut]), 13).length, 3);
});

test('drone position, view direction and image area on the ground', () => {
  const [s] = read(Buffer.from(CUT, 'hex'));
  const v = interpret(s);
  assert.equal(v.name, 'DRONE ALPHA');
  assert.ok(Math.abs(v.lat - (47.9135 + 250 / 111320)) < 1e-6);
  assert.ok(Math.abs(v.az - 180) < 0.01, 'looks south: ' + v.az);
  assert.ok(Math.abs(v.el + 35) < 0.01);
  // image centre: 150 m / tan(35°) = 214 m south of the drone
  assert.ok(Math.abs(v.range - 214.2) < 0.5, 'range ' + v.range);
  assert.equal(v.corners.length, 4);
  const [ul, ur, lr, ll] = v.corners;
  assert.ok(ul[0] < ll[0] && ur[0] < lr[0], 'far edge further south than the near edge');
  assert.ok(ul[1] > ur[1], 'looking south: upper left is east');

  const cot = toCot(v, { uid: 'UAS-drone-alpha', name: 'DRONE ALPHA', video: 'rtsp://tak:8554/drone-alpha', now: new Date('2026-10-25T10:00:00Z') });
  assert.equal(cot.length, 4);
  assert.match(cot[0], /uid="UAS-drone-alpha" type="a-f-A-M-H-Q"/);
  assert.match(cot[0], /<sensor azimuth="180.0" fov="60.0" vfov="40.0" range="214" elevation="-35.0"/);
  assert.match(cot[0], /<__video url="rtsp:\/\/tak:8554\/drone-alpha"\/>/);
  assert.match(cot[1], /uid="UAS-drone-alpha-fp" type="u-d-f"/);
  assert.equal((cot[1].match(/<link point=/g) || []).length, 5, 'closed ring');
  assert.match(cot[2], /uid="UAS-drone-alpha-los" type="u-d-f"/);
  assert.equal((cot[2].match(/<link point=/g) || []).length, 2, 'drone -> image centre');
  assert.match(cot[3], /uid="UAS-drone-alpha-spi" type="b-m-p-s-p-i"/);
  assert.match(cot[3], /stale="2026-10-25T10:01:00.000Z"/);
});

test('image area from the corner offsets (tags 26-33) when sent', () => {
  const v = interpret({ lat: 48, lon: 14, alt: 500, hfov: 30, vfov: 20, heading: 90, relAz: 0, relEl: -45, fcLat: 48.001, fcLon: 14.002,
    oLat1: 0.001, oLon1: -0.001, oLat2: 0.001, oLon2: 0.001, oLat3: -0.001, oLon3: 0.001, oLat4: -0.001, oLon4: -0.001 });
  assert.deepEqual(v.corners.map(c => c.map(x => +x.toFixed(6))), [[48.002, 14.001], [48.002, 14.003], [48, 14.003], [48, 14.001]]);
  assert.equal(interpret({ alt: 100 }), null, 'no position, no drone');
});
