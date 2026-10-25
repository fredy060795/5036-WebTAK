// Drone telemetry from the video: KLV metadata (MISB ST 0601 "UAS Datalink Local Set") in MPEG-TS/RTSP/SRT
// streams – where the drone is, where the camera looks and which area is on the video. For the map it becomes
// CoT like in ATAK: the drone with its field of view (<sensor>), the image area on the ground (shape) and the
// image centre (SPI). Value mapping and tags as in MISB ST 0601 (checked against the klvdata library).

const UAS_KEY = Buffer.from('060e2b34020b01010e01030101000000', 'hex');

// tag -> [name, type, min, max]; types: u/i = unsigned/signed integer mapped linearly to min..max,
// s = string, t = time stamp (µs since 1970), n = plain number
const TAGS = {
  2: ['time', 't'], 3: ['mission', 's'], 4: ['tail', 's'], 10: ['platform', 's'], 11: ['sensorName', 's'],
  5: ['heading', 'u', 0, 360], 6: ['pitch', 'i', -20, 20], 7: ['roll', 'i', -50, 50],
  13: ['lat', 'i', -90, 90], 14: ['lon', 'i', -180, 180], 15: ['alt', 'u', -900, 19000],
  16: ['hfov', 'u', 0, 180], 17: ['vfov', 'u', 0, 180],
  18: ['relAz', 'u', 0, 360], 19: ['relEl', 'i', -180, 180], 20: ['relRoll', 'u', 0, 360],
  21: ['slant', 'u', 0, 5e6],
  23: ['fcLat', 'i', -90, 90], 24: ['fcLon', 'i', -180, 180], 25: ['fcElev', 'u', -900, 19000],
  26: ['oLat1', 'i', -0.075, 0.075], 27: ['oLon1', 'i', -0.075, 0.075], 28: ['oLat2', 'i', -0.075, 0.075], 29: ['oLon2', 'i', -0.075, 0.075],
  30: ['oLat3', 'i', -0.075, 0.075], 31: ['oLon3', 'i', -0.075, 0.075], 32: ['oLat4', 'i', -0.075, 0.075], 33: ['oLon4', 'i', -0.075, 0.075],
  56: ['speed', 'u', 0, 255], 65: ['version', 'n'], 75: ['hae', 'u', -900, 19000],
  82: ['cLat1', 'i', -90, 90], 83: ['cLon1', 'i', -180, 180], 84: ['cLat2', 'i', -90, 90], 85: ['cLon2', 'i', -180, 180],
  86: ['cLat3', 'i', -90, 90], 87: ['cLon3', 'i', -180, 180], 88: ['cLat4', 'i', -90, 90], 89: ['cLon4', 'i', -180, 180],
};

// BER length at buf[i] -> [length, bytes used] (or null if incomplete)
function berLength(buf, i) {
  if (i >= buf.length) return null;
  const b = buf[i];
  if (b < 0x80) return [b, 1];
  const n = b & 0x7f;
  if (!n || n > 4 || i + n >= buf.length) return n > 4 ? [-1, 1] : null;
  let len = 0;
  for (let k = 1; k <= n; k++) len = len * 256 + buf[i + k];
  return [len, 1 + n];
}
// BER-OID tag (tags above 127 use several bytes)
function berOid(buf, i) {
  let v = 0, n = 0;
  do { v = v * 128 + (buf[i + n] & 0x7f); } while (buf[i + n++] & 0x80 && n < 4);
  return [v, n];
}

// 16-bit running sum over the packet up to the checksum value (MISB ST 0601, tag 1)
function checksum(packet, end) {
  let sum = 0;
  for (let i = 0; i < end; i++) sum = (sum + (packet[i] << (8 * ((i + 1) % 2)))) & 0xffff;
  return sum;
}

function mapped(v, type, min, max) {
  const n = v.length;
  if (type === 'i') {
    const x = v.readIntBE(0, Math.min(n, 6));
    if (x === -(2 ** (8 * n - 1))) return null; // "out of range" marker
    return (x * max) / (2 ** (8 * n - 1) - 1);
  }
  const x = v.readUIntBE(0, Math.min(n, 6));
  return min + (x * (max - min)) / (2 ** (8 * n) - 1);
}

// value of one UAS local set (without key/length) -> { tag values … }; null if the checksum (always the last
// item, MISB ST 0601) is missing or wrong. Without "packet" (tests) the checksum is not checked.
function parseLocalSet(value, packet, valueStart) {
  const out = {};
  let i = 0, checked = !packet;
  while (i < value.length) {
    const [tag, tn] = berOid(value, i);
    const l = berLength(value, i + tn);
    if (!l || l[0] < 0 || i + tn + l[1] + l[0] > value.length) break;
    const v = value.subarray(i + tn + l[1], i + tn + l[1] + l[0]);
    if (tag === 1 && packet && l[0] === 2) {
      // checksum covers everything up to (and including) the checksum's own tag and length
      if (checksum(packet, valueStart + i + tn + l[1]) !== v.readUInt16BE(0)) return null;
      checked = true;
    } else {
      const def = TAGS[tag];
      if (def && v.length) {
        const [name, type, min, max] = def;
        if (type === 's') out[name] = v.toString('utf8').replace(/\0+$/, '').trim();
        else if (type === 't') out[name] = v.length === 8 ? Number(v.readBigUInt64BE(0)) / 1000 : null; // -> ms
        else if (type === 'n') out[name] = v.readUIntBE(0, Math.min(v.length, 6));
        else out[name] = mapped(v, type, min, max);
      }
    }
    i += tn + l[1] + l[0];
  }
  return checked ? out : null;
}

// ffmpeg up to version 6 cuts the first 5 bytes of every KLV packet in MPEG-TS (it treats all KLV like
// synchronous metadata with an access unit header) – then only this rest of the key arrives
const KEY_TAIL = UAS_KEY.subarray(5);

// stream of KLV bytes (ffmpeg -f data) -> calls onSet(values) for every complete UAS local set
class KlvReader {
  constructor(onSet) { this.onSet = onSet; this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      let k = this.buf.indexOf(UAS_KEY);
      const t = this.buf.indexOf(KEY_TAIL);
      if (t >= 0 && (k < 0 || t < k + 5)) {
        // cut key: put the missing start back (the checksum covers the whole key and confirms it)
        this.buf = Buffer.concat([this.buf.subarray(0, t), UAS_KEY.subarray(0, 5), this.buf.subarray(t)]);
        k = t;
      }
      if (k < 0) { this.buf = this.buf.subarray(Math.max(0, this.buf.length - KEY_TAIL.length + 1)); return; }
      const l = berLength(this.buf, k + 16);
      if (!l) { this.buf = this.buf.subarray(k); return; } // wait for more
      if (l[0] < 0 || l[0] > 65535) { this.buf = this.buf.subarray(k + 1); continue; }
      const start = k + 16 + l[1], end = start + l[0];
      if (end > this.buf.length) { this.buf = this.buf.subarray(k); return; }
      const packet = this.buf.subarray(k, end);
      const set = parseLocalSet(this.buf.subarray(start, end), packet, start - k);
      if (set) this.onSet(set);
      this.buf = this.buf.subarray(end);
    }
  }
}

// ---------------- geometry ----------------

const R = 6371000, rad = Math.PI / 180;
function dest(lat, lon, m, brg) {
  const d = m / R, b = brg * rad, la = lat * rad;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lon * rad + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 / rad, ((lo2 / rad + 540) % 360) - 180];
}
function dist(a, b) {
  const dLa = (b[0] - a[0]) * rad, dLo = (b[1] - a[1]) * rad;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const num = x => typeof x === 'number' && Number.isFinite(x);

// combined state (KLV often sends only changed tags) -> what the map needs
function interpret(t) {
  if (!num(t.lat) || !num(t.lon)) return null;
  const az = ((num(t.heading) ? t.heading : 0) + (num(t.relAz) ? t.relAz : 0)) % 360;
  const el = num(t.relEl) ? t.relEl + (num(t.pitch) ? t.pitch : 0) : null; // below the horizon < 0
  const out = { lat: t.lat, lon: t.lon, alt: num(t.alt) ? t.alt : null, heading: num(t.heading) ? t.heading : null, speed: num(t.speed) ? t.speed : null,
    az, el, hfov: num(t.hfov) ? t.hfov : null, vfov: num(t.vfov) ? t.vfov : null, center: null, corners: null, range: null,
    name: t.tail || t.platform || t.mission || '' };
  if (num(t.fcLat) && num(t.fcLon)) out.center = [t.fcLat, t.fcLon];
  // image area: full corners (tags 82-89), else offsets to the image centre (26-33), else computed (flat ground)
  if ([1, 2, 3, 4].every(i => num(t['cLat' + i]) && num(t['cLon' + i]))) {
    out.corners = [1, 2, 3, 4].map(i => [t['cLat' + i], t['cLon' + i]]);
  } else if (out.center && [1, 2, 3, 4].every(i => num(t['oLat' + i]) && num(t['oLon' + i]))) {
    out.corners = [1, 2, 3, 4].map(i => [out.center[0] + t['oLat' + i], out.center[1] + t['oLon' + i]]);
  } else if (num(out.alt) && num(el) && out.hfov && out.vfov) {
    const ground = num(t.fcElev) ? t.fcElev : null;
    if (ground != null && out.alt > ground) {
      const h = out.alt - ground;
      const at = (dAz, dEl) => {
        const e = Math.min(el + dEl, -1); // a ray at or above the horizon ends 5 km away
        return dest(out.lat, out.lon, Math.min(h / Math.tan(-e * rad), 5000), az + dAz);
      };
      out.corners = [at(-out.hfov / 2, out.vfov / 2), at(out.hfov / 2, out.vfov / 2), at(out.hfov / 2, -out.vfov / 2), at(-out.hfov / 2, -out.vfov / 2)];
      if (!out.center) out.center = at(0, 0);
    }
  }
  out.range = num(t.slant) && t.slant > 0 ? t.slant : out.center ? dist([out.lat, out.lon], out.center) : null;
  return out;
}

// ---------------- CoT ----------------

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iso = d => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
const f7 = x => Number(x).toFixed(7);

// drone (a-f-A-M-H-Q = UAV), image area (u-d-f, closed) and image centre (b-m-p-s-p-i = SPI, like ATAK)
function toCot(v, { uid, name, video, now = new Date(), staleMs = 60000 }) {
  const t = iso(now), stale = iso(new Date(+now + staleMs));
  const call = esc(v.name || name || 'UAS');
  const head = (u, type, how, lat, lon, hae) => `<event version="2.0" uid="${esc(u)}" type="${type}" how="${how}" time="${t}" start="${t}" stale="${stale}">`
    + `<point lat="${f7(lat)}" lon="${f7(lon)}" hae="${num(hae) ? hae.toFixed(1) : 9999999}" ce="9999999" le="9999999"/><detail>`;
  const out = [];
  const sensor = v.hfov ? `<sensor azimuth="${v.az.toFixed(1)}" fov="${v.hfov.toFixed(1)}" vfov="${(v.vfov || 0).toFixed(1)}" range="${Math.round(v.range || 500)}"`
    + ` elevation="${num(v.el) ? v.el.toFixed(1) : 0}" roll="0" north="0" type="r-e" model="KLV" version="0.6" fovRed="1" fovGreen="0.85" fovBlue="0" fovAlpha="0.3"/>` : '';
  out.push(head(uid, 'a-f-A-M-H-Q', 'm-g', v.lat, v.lon, v.alt)
    + `<contact callsign="${call}"/>${sensor}`
    + (video ? `<__video url="${esc(video)}"/>` : '')
    + `<track course="${(num(v.heading) ? v.heading : v.az).toFixed(1)}" speed="${num(v.speed) ? v.speed.toFixed(1) : 0}"/>`
    + `<remarks>UAS from video telemetry (KLV)${num(v.alt) ? ` – ${Math.round(v.alt)} m MSL` : ''}</remarks></detail></event>`);
  if (v.corners) {
    const ring = v.corners.concat([v.corners[0]]);
    out.push(head(uid + '-fp', 'u-d-f', 'h-e', v.corners[0][0], v.corners[0][1])
      + `<contact callsign="${call} image"/>` + ring.map(c => `<link point="${f7(c[0])},${f7(c[1])}"/>`).join('')
      + '<strokeColor value="-10240"/><strokeWeight value="2.0"/><fillColor value="822072320"/><closed value="true"/>'
      + `<link uid="${esc(uid)}" type="a-f-A-M-H-Q" relation="p-p"/></detail></event>`);
  }
  if (v.center) {
    out.push(head(uid + '-spi', 'b-m-p-s-p-i', 'm-i', v.center[0], v.center[1])
      + `<contact callsign="${call} SPI"/><link uid="${esc(uid)}" type="a-f-A-M-H-Q" relation="p-p"/></detail></event>`);
  }
  return out;
}

module.exports = { UAS_KEY, KlvReader, parseLocalSet, interpret, toCot, checksum };
