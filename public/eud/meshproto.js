// Meshtastic protocol for the EUD: a small protobuf codec (only the fields we need) and the conversion
// between Meshtastic packets and CoT. Field numbers from github.com/meshtastic/protobufs (mesh.proto,
// atak.proto, channel.proto, portnums.proto). TAK data uses ATAK_PLUGIN (port 72, TAKPacket V1,
// uncompressed) like the official Meshtastic ATAK plugin. Runs in the browser and in Node (tests).
'use strict';

(function (root, factory) {
  const m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.meshProto = m;
})(this, () => {
  const PORT = { TEXT: 1, POSITION: 3, NODEINFO: 4, ATAK: 72 };
  const BROADCAST = 0xffffffff;
  const ALL_CHAT = 'All Chat Rooms';
  // TAKPacket Team / MemberRole enums: index = enum value (0 = unspecified)
  const TEAMS = ['', 'White', 'Yellow', 'Orange', 'Magenta', 'Red', 'Maroon', 'Purple', 'Dark Blue', 'Blue', 'Cyan', 'Teal', 'Green', 'Dark Green', 'Brown'];
  const ROLES = ['', 'Team Member', 'Team Lead', 'HQ', 'Sniper', 'Medic', 'Forward Observer', 'RTO', 'K9'];

  const utf8 = new TextEncoder();
  const utf8d = new TextDecoder();

  // ---------------- Writing ----------------

  class Writer {
    constructor() { this.b = []; }
    varint(n) {
      // int32 below 0 is sent as a 64-bit two's complement (10 bytes) like protobuf does
      if (n < 0) {
        let v = BigInt.asUintN(64, BigInt(n));
        while (v > 0x7fn) { this.b.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
        this.b.push(Number(v));
        return this;
      }
      n = Math.floor(n);
      while (n > 0x7f) { this.b.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80); }
      this.b.push(n);
      return this;
    }
    tag(field, wt) { return this.varint(field * 8 + wt); }
    uint(field, n) { return n ? this.tag(field, 0).varint(n >>> 0) : this; }
    int(field, n) { return n ? this.tag(field, 0).varint(n | 0) : this; }
    bool(field, v) { return v ? this.tag(field, 0).varint(1) : this; }
    fixed(field, n, signed) {
      if (!n) return this;
      const d = new DataView(new ArrayBuffer(4));
      if (signed) d.setInt32(0, n, true); else d.setUint32(0, n >>> 0, true);
      this.tag(field, 5);
      for (let i = 0; i < 4; i++) this.b.push(d.getUint8(i));
      return this;
    }
    bytes(field, bytes, always) {
      if (!bytes || (!bytes.length && !always)) return this;
      this.tag(field, 2).varint(bytes.length);
      for (const x of bytes) this.b.push(x);
      return this;
    }
    str(field, s) { return s ? this.bytes(field, utf8.encode(String(s))) : this; }
    msg(field, w) { return w ? this.bytes(field, w.done(), true) : this; }
    done() { return Uint8Array.from(this.b); }
  }

  // ---------------- Reading ----------------

  // -> Map(field -> [{ wt, v }]); varints as uint32 (low 32 bits – all our varint fields are 32 bit)
  function decode(buf) {
    const out = new Map();
    let i = 0;
    const varint = () => {
      let lo = 0, shift = 0, byte;
      do {
        if (i >= buf.length) throw new Error('truncated varint');
        byte = buf[i++];
        if (shift < 32) lo += (byte & 0x7f) * 2 ** shift;
        shift += 7;
      } while (byte & 0x80);
      return lo % 2 ** 32;
    };
    while (i < buf.length) {
      const key = varint();
      const field = Math.floor(key / 8), wt = key & 7;
      let v;
      if (wt === 0) v = varint();
      else if (wt === 2) { const len = varint(); if (i + len > buf.length) throw new Error('truncated field'); v = buf.subarray(i, i + len); i += len; }
      else if (wt === 5) { if (i + 4 > buf.length) throw new Error('truncated field'); v = buf.subarray(i, i + 4); i += 4; }
      else if (wt === 1) { if (i + 8 > buf.length) throw new Error('truncated field'); v = buf.subarray(i, i + 8); i += 8; }
      else throw new Error('unsupported wire type ' + wt);
      if (!out.has(field)) out.set(field, []);
      out.get(field).push({ wt, v });
    }
    return out;
  }
  const one = (f, n) => { const l = f.get(n); return l ? l[l.length - 1] : null; };
  const has = (f, n) => f.has(n);
  const u32 = (f, n) => { const x = one(f, n); return x && x.wt === 0 ? x.v : 0; };
  const i32 = (f, n) => u32(f, n) | 0;
  const fixed = (f, n, signed) => {
    const x = one(f, n);
    if (!x || x.wt !== 5) return 0;
    const d = new DataView(x.v.buffer, x.v.byteOffset, 4);
    return signed ? d.getInt32(0, true) : d.getUint32(0, true);
  };
  const bytes = (f, n) => { const x = one(f, n); return x && x.wt === 2 ? x.v : null; };
  const str = (f, n) => { const b = bytes(f, n); return b ? utf8d.decode(b) : ''; };
  const sub = (f, n) => { const b = bytes(f, n); return b ? decode(b) : null; };

  // ---------------- ToRadio ----------------

  function wantConfig(nonce) { return new Writer().uint(3, nonce).done(); }

  // MeshPacket with Data to the mesh; hop_limit must be set (0 = the node would not rebroadcast)
  function toRadioPacket({ to = BROADCAST, channel = 0, portnum, payload, id, hopLimit = 3, wantAck = false }) {
    const data = new Writer().uint(1, portnum).bytes(2, payload);
    const pkt = new Writer().fixed(2, to).uint(3, channel).msg(4, data).fixed(6, id).uint(9, hopLimit).bool(10, wantAck);
    return new Writer().msg(1, pkt).done();
  }

  // ---------------- TAKPacket (ATAK plugin, V1) ----------------

  const enumOf = (list, name) => Math.max(0, list.indexOf(name));

  function takPli({ callsign, uid, team, role, battery, lat, lon, alt, speed, course }) {
    const contact = new Writer().str(1, callsign).str(2, uid);
    const group = new Writer().uint(1, enumOf(ROLES, role) || 1).uint(2, enumOf(TEAMS, team) || 10);
    const status = new Writer().uint(1, Math.max(0, Math.min(100, Math.round(battery || 0))));
    const pli = new Writer()
      .fixed(1, Math.round(lat * 1e7), true).fixed(2, Math.round(lon * 1e7), true)
      .int(3, Number.isFinite(alt) ? Math.round(alt) : 0)
      .uint(4, Number.isFinite(speed) && speed > 0 ? Math.round(speed) : 0)
      .uint(5, Number.isFinite(course) && course > 0 ? Math.round(course) % 360 : 0);
    return new Writer().msg(2, contact).msg(3, group).msg(4, status).msg(5, pli).done();
  }

  // the ATAK plugin carries the GeoChat messageId in device_callsign ("uid|messageId")
  function takChat({ callsign, uid, msgId, message, to = ALL_CHAT }) {
    const contact = new Writer().str(1, callsign).str(2, msgId ? `${uid}|${msgId}` : uid);
    const chat = new Writer().str(1, message).str(2, to);
    return new Writer().msg(2, contact).msg(6, chat).done();
  }

  function parseTak(buf) {
    const f = decode(buf);
    const c = sub(f, 2), g = sub(f, 3), s = sub(f, 4), p = sub(f, 5), ch = sub(f, 6);
    const [uid, msgId] = (c ? str(c, 2) : '').split('|');
    return {
      compressed: !!u32(f, 1),
      callsign: c ? str(c, 1) : '',
      uid: uid || '',
      msgId: msgId || '',
      team: g ? TEAMS[u32(g, 2)] || '' : '',
      role: g ? ROLES[u32(g, 1)] || '' : '',
      battery: s && has(s, 1) ? u32(s, 1) : null,
      pli: p ? { lat: fixed(p, 1, true) / 1e7, lon: fixed(p, 2, true) / 1e7, alt: i32(p, 3), speed: u32(p, 4), course: u32(p, 5) } : null,
      chat: ch ? { message: str(ch, 1), to: str(ch, 2), toCallsign: str(ch, 3) } : null,
    };
  }

  // ---------------- FromRadio ----------------

  function parseUser(f) {
    return f ? { id: str(f, 1), longName: str(f, 2), shortName: str(f, 3) } : null;
  }

  function parsePosition(f) {
    if (!f || !has(f, 1) || !has(f, 2)) return null;
    const lat = fixed(f, 1, true) / 1e7, lon = fixed(f, 2, true) / 1e7;
    if (!lat && !lon) return null;
    return { lat, lon, alt: has(f, 3) ? i32(f, 3) : null, time: fixed(f, 4) || fixed(f, 7) || 0, speed: has(f, 15) ? u32(f, 15) : null, course: has(f, 16) ? u32(f, 16) : null };
  }

  function parsePacket(f) {
    const d = sub(f, 4);
    return {
      from: fixed(f, 1), to: fixed(f, 2), channel: u32(f, 3), id: fixed(f, 6), rxTime: fixed(f, 7),
      portnum: d ? u32(d, 1) : 0, payload: d ? bytes(d, 2) || new Uint8Array(0) : null, // null = encrypted (not for us)
    };
  }

  function parseFromRadio(buf) {
    const f = decode(buf);
    if (has(f, 2)) return { kind: 'packet', packet: parsePacket(sub(f, 2)) };
    if (has(f, 3)) return { kind: 'myInfo', nodeNum: u32(sub(f, 3), 1) };
    if (has(f, 4)) {
      const n = sub(f, 4);
      return { kind: 'nodeInfo', node: { num: u32(n, 1), user: parseUser(sub(n, 2)), position: parsePosition(sub(n, 3)), lastHeard: fixed(n, 5) } };
    }
    if (has(f, 10)) {
      const c = sub(f, 10), s = sub(c, 2);
      return { kind: 'channel', channel: { index: i32(c, 1), role: u32(c, 3), name: s ? str(s, 3) : '' } };
    }
    if (has(f, 7)) return { kind: 'configComplete', id: u32(f, 7) };
    if (has(f, 8)) return { kind: 'rebooted' };
    return { kind: 'other' };
  }

  const parseUserPayload = buf => parseUser(decode(buf));
  const parsePositionPayload = buf => parsePosition(decode(buf));

  // ---------------- CoT ----------------

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cotTime = d => d.toISOString().replace(/\.(\d{3})\d*Z$/, '.$1Z');
  const nodeId = num => '!' + (num >>> 0).toString(16).padStart(8, '0');

  function event({ uid, type, how, time, staleMs, lat, lon, hae, detail }) {
    return `<event version="2.0" uid="${esc(uid)}" type="${type}" how="${how}" time="${cotTime(time)}" start="${cotTime(time)}" stale="${cotTime(new Date(+time + staleMs))}">`
      + `<point lat="${lat}" lon="${lon}" hae="${hae == null ? 9999999 : hae}" ce="9999999" le="9999999"/><detail>${detail}<__meshtastic/></detail></event>`;
  }

  // TAK PLI from the mesh -> contact (like the ATAK plugin: UID = device_callsign, stale 10 min)
  function pliCot(tak, from, now = new Date()) {
    const p = tak.pli;
    return event({
      uid: tak.uid || 'MESH-' + nodeId(from), type: 'a-f-G-U-C', how: 'm-g', time: now, staleMs: 600000, lat: p.lat, lon: p.lon, hae: p.alt || null,
      detail: `<contact callsign="${esc(tak.callsign || nodeId(from))}" endpoint="0.0.0.0:4242:tcp"/>`
        + `<__group name="${esc(tak.team || 'Cyan')}" role="${esc(tak.role || 'Team Member')}"/>`
        + (tak.battery != null ? `<status battery="${tak.battery}"/>` : '')
        + `<track course="${p.course}" speed="${p.speed}"/><takv platform="Meshtastic" device="Mesh"/>`,
    });
  }

  // GeoChat: to "All Chat Rooms" or directly to us (to = our UID)
  function chatCot({ senderUid, senderCallsign, msgId, text, toUid = '', now = new Date() }) {
    const direct = !!toUid;
    const room = direct ? senderCallsign : ALL_CHAT;
    const id = direct ? toUid : ALL_CHAT;
    return event({
      uid: `GeoChat.${senderUid}.${direct ? toUid : ALL_CHAT}.${msgId}`, type: 'b-t-f', how: 'h-g-i-g-o', time: now, staleMs: 86400000, lat: 0, lon: 0,
      detail: `<__chat parent="RootContactGroup" groupOwner="false" messageId="${esc(msgId)}" chatroom="${esc(room)}" id="${esc(id)}" senderCallsign="${esc(senderCallsign)}">`
        + `<chatgrp uid0="${esc(senderUid)}" uid1="${esc(id)}" id="${esc(id)}"/></__chat>`
        + `<link uid="${esc(senderUid)}" type="a-f-G-U-C" relation="p-p"/>`
        + `<remarks source="BAO.F.ATAK.${esc(senderUid)}" to="${esc(id)}" time="${cotTime(now)}">${esc(text)}</remarks>`,
    });
  }

  // plain Meshtastic node (Meshtastic app, no TAK) with a position -> point on the map, stale 30 min
  function nodeCot({ num, user, position }, now = new Date()) {
    const time = position.time ? new Date(Math.min(position.time * 1000, +now)) : now;
    const name = (user && (user.longName || user.shortName)) || nodeId(num);
    return event({
      uid: 'MESH-' + nodeId(num), type: 'a-f-G-U-C', how: 'm-g', time, staleMs: 1800000, lat: position.lat, lon: position.lon, hae: position.alt,
      detail: `<contact callsign="${esc(name)}"/>`
        + (position.course != null ? `<track course="${position.course}" speed="${position.speed || 0}"/>` : '')
        + `<remarks>Meshtastic ${esc(nodeId(num))}${user && user.shortName ? ' (' + esc(user.shortName) + ')' : ''}</remarks>`,
    });
  }

  return {
    PORT, BROADCAST, ALL_CHAT, TEAMS, ROLES, Writer, decode,
    wantConfig, toRadioPacket, takPli, takChat, parseTak, parseFromRadio, parseUserPayload, parsePositionPayload,
    pliCot, chatCot, nodeCot, nodeId, utf8,
  };
});
