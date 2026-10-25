// Meshtastic over Bluetooth (Web Bluetooth: Android/Chrome, iPhone only in the "Bluefy" app): the EUD talks
// directly to a Meshtastic radio. Positions and chat go over LoRa as TAK packets (port 72), markers and other
// CoT over port 257 – like the Meshtastic ATAK plugin, so ATAK users with the plugin and WebTAK users see each
// other without internet.
// Sending: only while no TAK server is connected (default) or always. During a video stream the radio is
// released (camera and LoRa share the phone's Bluetooth) and reconnected when the stream ends.
'use strict';

(() => {
  const { $, store, profile, toast, setMsg, openPopup, handleCot, removeItem, distance } = window.eud;
  const P = window.meshProto;
  // BLE service of the Meshtastic firmware (src/BluetoothCommon.h)
  const SVC = '6ba1b218-15a8-461f-9fa8-5dcae273eafd';
  const TORADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7';
  const FROMRADIO = '2c55e69e-4993-11ed-b878-0242ac120002';
  const FROMNUM = 'ed9da18c-a800-4f66-a670-aa7547e34453';
  const MAX_TEXT = 180;           // bytes of chat text per LoRa packet (payload limit ~230 bytes)
  const NODE_MAX_AGE = 2 * 3600;  // show Meshtastic nodes heard within the last 2 h
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const cfg = Object.assign({
    enabled: false, id: '', name: '', send: 'offline', interval: 60, channel: 0, nodes: true, text: true,
  }, store.get('eud.mesh', {}));
  const save = () => store.set('eud.mesh', cfg);

  let device = null, toRadio = null, fromRadio = null, fromNum = null;
  let state = 'off';   // off | tap | connecting | connected | paused | lost
  let message = '';
  let myNode = 0, nonce = 0;
  let pausedForVideo = false, retry = 0, retryTimer = null, pollTimer = null;
  let draining = false, drainAgain = false, writeChain = Promise.resolve();
  let lastPli = 0, pliAt = null;
  const nodes = new Map(); // num -> { user, position, lastHeard, takUid }
  let channels = [];

  const msg = (text, ok) => setMsg($('meshMsg'), text, ok);

  // ---------------- UI ----------------

  const STATE_TEXT = {
    off: 'Not connected', tap: 'Tap CONNECT to reconnect', connecting: 'Connecting …', connected: 'Connected',
    paused: 'Paused – video stream running', lost: 'Connection lost – retrying …',
  };

  function render() {
    // icon: green = connected, yellow = connecting / paused for video, red = not connected
    const kind = state === 'connected' ? 'ok' : ['connecting', 'paused'].includes(state) ? 'wait' : 'err';
    $('meshBanner').className = 'nw-banner ' + (state === 'connected' ? 'good' : state === 'off' ? 'off' : 'wait');
    $('meshState').textContent = state === 'connected'
      ? `Connected: ${cfg.name || 'Meshtastic'}${myNode ? ' (' + P.nodeId(myNode) + ')' : ''}`
      : (STATE_TEXT[state] || state) + (message ? ' – ' + message : '');
    const heard = [...nodes.values()].filter(n => n.lastHeard && Date.now() / 1000 - n.lastHeard < NODE_MAX_AGE).length;
    $('meshNodes').textContent = state === 'connected' ? String(heard) : '–';
    $('meshSending').textContent = state !== 'connected' ? '–' : shouldSend() ? 'Yes (LoRa)' : 'No – TAK server connected';
    $('meshPick').classList.toggle('hidden', ['connected', 'connecting', 'paused'].includes(state));
    $('meshPick').textContent = cfg.enabled && cfg.name ? 'RECONNECT ' + cfg.name : 'CONNECT MESHTASTIC RADIO';
    $('meshOff').classList.toggle('hidden', !cfg.enabled);
    $('meshNew').classList.toggle('hidden', !cfg.id || state === 'connecting');
    $('meshBt').classList.toggle('hidden', !!navigator.bluetooth);
    $('meshBluefy').classList.toggle('hidden', !!navigator.bluetooth || !isIOS);
    $('meshSend').value = cfg.send;
    $('meshInterval').value = String(cfg.interval);
    $('meshShowNodes').checked = cfg.nodes;
    $('meshText').checked = cfg.text;
    const sel = $('meshChannel');
    const list = channels.length ? channels : [{ index: cfg.channel, name: '' }];
    sel.textContent = '';
    for (const c of list) {
      const o = document.createElement('option');
      o.value = String(c.index);
      o.textContent = `${c.index}: ${c.name || (c.index === 0 ? 'Primary' : 'Channel ' + c.index)}`;
      sel.append(o);
    }
    sel.value = String(cfg.channel);
    // indicator on the map (above the server status) and on the tile in Tools
    $('meshBtn').className = (cfg.enabled ? '' : 'hidden ') + kind;
    $('meshBtn').title = 'Meshtastic: ' + $('meshState').textContent;
    $('meshTileDot').className = 'tile-dot ' + (cfg.enabled ? kind : 'hidden');
  }

  function setState(s, m = '') {
    state = s;
    message = m;
    render();
  }

  // ---------------- Bluetooth ----------------

  // user gesture: choose a radio (the browser shows its device list)
  async function pick() {
    msg('');
    if (!navigator.bluetooth) {
      msg(isIOS ? 'On iPhone, Bluetooth only works in the "Bluefy" app.' : 'This browser has no Bluetooth (use Chrome).');
      return;
    }
    try {
      const d = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }], optionalServices: [SVC] });
      if (device && device !== d) disconnect();
      useDevice(d);
      cfg.enabled = true;
      cfg.id = d.id;
      cfg.name = d.name || 'Meshtastic';
      save();
      retry = 0;
      await open();
    } catch (e) {
      if (!(e.name === 'NotFoundError' && /cancel/i.test(e.message))) msg(e.message);
    }
  }

  function useDevice(d) {
    if (device === d) return;
    if (device) device.removeEventListener('gattserverdisconnected', onLost);
    device = d;
    device.addEventListener('gattserverdisconnected', onLost);
  }

  // after a reload: the browser may give us the permitted radio again without a device dialog
  async function restore() {
    if (device || !cfg.enabled || !cfg.id) return !!device;
    try {
      if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return false;
      const d = (await navigator.bluetooth.getDevices()).find(x => x.id === cfg.id);
      if (d) useDevice(d);
    } catch (e) { /* not supported */ }
    return !!device;
  }

  async function open() {
    clearTimeout(retryTimer);
    if (!cfg.enabled || pausedForVideo || state === 'connecting') return;
    if (!device && !(await restore())) return setState('tap');
    setState('connecting');
    try {
      const server = await device.gatt.connect();
      const svc = await server.getPrimaryService(SVC);
      toRadio = await svc.getCharacteristic(TORADIO);
      fromRadio = await svc.getCharacteristic(FROMRADIO);
      fromNum = await svc.getCharacteristic(FROMNUM);
      if (pausedForVideo || !cfg.enabled) return disconnect(); // a stream started or switched off meanwhile
      clearInterval(pollTimer);
      try {
        fromNum.addEventListener('characteristicvaluechanged', drain);
        await fromNum.startNotifications();
        pollTimer = setInterval(drain, 15000); // safety net
      } catch (e) {
        pollTimer = setInterval(drain, 2000); // no notifications (some browsers): poll
      }
      myNode = 0;
      channels = [];
      nonce = 1 + Math.floor(Math.random() * 0x7ffffff0);
      await write(P.wantConfig(nonce));
      drain();
    } catch (e) {
      if (!pausedForVideo && cfg.enabled) { setState('lost', e.message); schedule(); }
    }
  }

  function schedule() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, Math.min(30000, 2000 * 2 ** retry++));
  }

  function onLost() {
    clearInterval(pollTimer);
    toRadio = fromRadio = fromNum = null;
    if (pausedForVideo || !cfg.enabled) return render();
    setState('lost');
    schedule();
  }

  function disconnect() {
    clearTimeout(retryTimer);
    clearInterval(pollTimer);
    toRadio = fromRadio = fromNum = null;
    if (device && device.gatt.connected) device.gatt.disconnect();
  }

  function write(bytes) {
    const run = () => {
      if (!toRadio) throw new Error('Meshtastic radio not connected');
      return toRadio.writeValueWithResponse ? toRadio.writeValueWithResponse(bytes) : toRadio.writeValue(bytes);
    };
    writeChain = writeChain.catch(() => {}).then(run);
    return writeChain;
  }

  // read FromRadio until it is empty (the radio announces new data via FromNum)
  async function drain() {
    if (draining) { drainAgain = true; return; }
    draining = true;
    try {
      do {
        drainAgain = false;
        while (fromRadio) {
          const v = await fromRadio.readValue();
          if (!v.byteLength) break;
          handle(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        }
      } while (drainAgain && fromRadio);
    } catch (e) {
      /* connection gone – onLost handles it */
    } finally {
      draining = false;
    }
  }

  // ---------------- Receiving ----------------

  function handle(buf) {
    let m;
    try { m = P.parseFromRadio(buf); } catch (e) { return; }
    if (m.kind === 'myInfo') myNode = m.nodeNum;
    else if (m.kind === 'channel') {
      if (m.channel.role) channels = channels.filter(c => c.index !== m.channel.index).concat(m.channel).sort((a, b) => a.index - b.index);
    } else if (m.kind === 'nodeInfo') {
      const n = node(m.node.num);
      if (m.node.user) n.user = m.node.user;
      if (m.node.position) n.position = m.node.position;
      n.lastHeard = Math.max(n.lastHeard || 0, m.node.lastHeard || 0);
      showNode(m.node.num);
    } else if (m.kind === 'configComplete' && m.id === nonce) {
      retry = 0;
      if (!channels.some(c => c.index === cfg.channel)) { cfg.channel = 0; save(); }
      setState('connected');
      toast('Meshtastic connected: ' + (cfg.name || 'radio'));
      lastPli = 0; // send our position right away
      tick();
    } else if (m.kind === 'rebooted') {
      write(P.wantConfig(nonce)).then(drain).catch(() => {});
    } else if (m.kind === 'packet') {
      receive(m.packet);
    }
    if (popupOpen()) render();
  }

  function node(num) {
    if (!nodes.has(num)) nodes.set(num, { user: null, position: null, lastHeard: 0, takUid: '' });
    return nodes.get(num);
  }

  function receive(p) {
    if (!p.payload || p.from === myNode) return; // encrypted for someone else / own echo
    const n = node(p.from);
    n.lastHeard = Math.floor(Date.now() / 1000);
    if (p.portnum === P.PORT.ATAK) {
      let tak;
      try { tak = P.parseTak(p.payload); } catch (e) { return; }
      if (tak.compressed) return; // old firmware compressed TAK strings (unishox2) – not readable here
      if (tak.uid && !n.takUid) {
        n.takUid = tak.uid;
        removeItem('MESH-' + P.nodeId(p.from)); // now shown as a TAK contact
      }
      if (tak.pli) handleCot(P.pliCot(tak, p.from));
      else if (tak.chat && (tak.chat.to === P.ALL_CHAT || tak.chat.to === profile.uid)) {
        handleCot(P.chatCot({
          senderUid: tak.uid || 'MESH-' + P.nodeId(p.from), senderCallsign: tak.callsign || P.nodeId(p.from),
          msgId: tak.msgId || String(p.id), text: tak.chat.message, toUid: tak.chat.to === P.ALL_CHAT ? '' : profile.uid,
        }));
      }
    } else if (p.portnum === P.PORT.FORWARDER) {
      receiveForwarder(p).catch(() => {});
    } else if (p.portnum === P.PORT.TEXT) {
      // TAK users send their chat as a TAK packet too (and the plugin ignores their text) -> skip duplicates
      if (n.takUid || (p.to !== P.BROADCAST && p.to !== myNode)) return;
      const name = P.nodeTeam((n.user && (n.user.longName || n.user.shortName)) || P.nodeId(p.from)).callsign; // without " -5" team suffix
      handleCot(P.chatCot({ senderUid: 'MESH-' + P.nodeId(p.from), senderCallsign: name, msgId: String(p.id), text: new TextDecoder().decode(p.payload) }));
    } else if (p.portnum === P.PORT.POSITION) {
      try { n.position = P.parsePositionPayload(p.payload) || n.position; } catch (e) { return; }
      if (n.position && !n.position.time) n.position.time = n.lastHeard;
      showNode(p.from);
    } else if (p.portnum === P.PORT.NODEINFO) {
      try { n.user = P.parseUserPayload(p.payload) || n.user; } catch (e) { /* ignore */ }
    }
  }

  // plain Meshtastic users (Meshtastic app, no TAK) as points on the map
  function showNode(num) {
    const n = nodes.get(num);
    if (!cfg.nodes || !n || num === myNode || n.takUid || !n.position) return;
    if (Date.now() / 1000 - (n.lastHeard || n.position.time || 0) > NODE_MAX_AGE) return;
    handleCot(P.nodeCot({ num, user: n.user, position: n.position }));
  }

  // ---------------- Sending ----------------

  const shouldSend = () => state === 'connected' && (cfg.send === 'always' || !window.eud.serverOnline());

  function send(portnum, payload, channel = cfg.channel) {
    return write(P.toRadioPacket({ portnum, payload, channel, id: 1 + Math.floor(Math.random() * 0xfffffff0) }));
  }

  function sendPli() {
    const me = window.eud.getMe();
    if (!me) return;
    lastPli = Date.now();
    pliAt = { lat: me.lat, lon: me.lon };
    send(P.PORT.ATAK, P.takPli({
      callsign: profile.callsign || profile.uid, uid: profile.uid, team: profile.team, role: profile.role, battery: window.eud.battery(),
      lat: me.lat, lon: me.lon, alt: me.alt, speed: me.speed, course: me.course,
    })).catch(e => msg('Sending position failed: ' + e.message));
  }

  // position: at the chosen interval, earlier when moved more than 50 m (but at most every 15 s)
  function tick() {
    if (!shouldSend()) return;
    const me = window.eud.getMe();
    if (!me) return;
    const since = Date.now() - lastPli;
    const moved = pliAt ? distance(pliAt, me) : Infinity;
    if (since >= cfg.interval * 1000 || (moved > 50 && since >= 15000)) sendPli();
  }
  setInterval(tick, 5000);

  // cut text to MAX_TEXT bytes without breaking a character
  function fit(text) {
    let t = text;
    while (P.utf8.encode(t).length > MAX_TEXT) t = t.slice(0, -1);
    return t;
  }

  // TAK packets (V1) know "All Chat Rooms" and direct messages to a UID – like the ATAK plugin; no team/group rooms
  document.addEventListener('eud-chat-out', e => {
    if (!shouldSend()) return;
    const { text, xml, conv = { key: 'all' } } = e.detail;
    const direct = conv.key.startsWith('dm:');
    if (conv.key !== 'all' && !direct) { toast('Mesh: team and group chats are not sent over LoRa – use All or a direct message.', 5000); return; }
    const m = /messageId="([^"]+)"/.exec(xml || '');
    const body = fit(text);
    const to = direct ? conv.uid || conv.key.slice(3) : P.ALL_CHAT;
    send(P.PORT.ATAK, P.takChat({ callsign: profile.callsign || profile.uid, uid: profile.uid, msgId: m ? m[1] : '', message: body, to }))
      // plain text is public on the channel: only for All
      .then(() => (cfg.text && !direct ? send(P.PORT.TEXT, P.utf8.encode(fit(`${profile.callsign || profile.uid}: ${text}`))) : null))
      .then(() => { if (body !== text) toast('Mesh: message shortened to fit one LoRa packet.'); })
      .catch(err => toast('Mesh: sending failed – ' + err.message));
  });

  // ---------------- Markers, changes, deletions: CoT over port 257 like the ATAK plugin ----------------
  // zlib-compressed CoT XML: below 233 bytes as one packet, larger as fountain blocks (receivers answer with an ACK)

  const MAX_DIRECT = 232;      // the plugin sends payloads below 233 bytes directly
  const MAX_SOURCE_BLOCKS = 10; // ~2 KB compressed – larger (long routes …) waits for the TAK server
  const BLOCK_GAP = 1600;      // ms between blocks (LongFast airtime like the plugin's default)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const sha8 = async b => new Uint8Array(await crypto.subtle.digest('SHA-256', b)).slice(0, 8);
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const through = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  const zlib = bytes => (window.CompressionStream ? through(bytes, new CompressionStream('deflate')) : Promise.resolve(bytes));
  async function unzlib(bytes) {
    if (window.DecompressionStream) {
      for (const f of ['deflate', 'deflate-raw']) {
        try { return await through(bytes, new DecompressionStream(f)); } catch (e) { /* next format */ }
      }
    }
    return bytes; // plain XML
  }

  const sending = new Map();   // transferId -> { hash, done, more }
  const receiving = new Map(); // "from:transferId" -> { K, totalLength, blocks, seeds, done, t }

  document.addEventListener('eud-cot-out', e => {
    if (!shouldSend()) return;
    e.detail.mesh = true;
    sendCotMesh(e.detail.xml).catch(err => toast('Mesh: sending failed – ' + err.message));
  });

  async function sendCotMesh(xml) {
    const z = await zlib(P.utf8.encode(xml));
    if (z.length <= MAX_DIRECT) return send(P.PORT.FORWARDER, z);
    const data = new Uint8Array(z.length + 1); // transfer type byte (0 = CoT) + zlib data
    data[0] = P.FOUNTAIN.TYPE_COT;
    data.set(z, 1);
    const K = Math.ceil(data.length / P.FOUNTAIN.BLOCK);
    if (K > MAX_SOURCE_BLOCKS) { toast('Mesh: too large for LoRa – it is sent once the TAK server is back.', 5000); return; }
    const transferId = 1 + Math.floor(Math.random() * 0xfffffe);
    const st = { hash: await sha8(data), done: false, more: 0 };
    sending.set(transferId, st);
    // like the plugin: blocks + ACK wait, up to 3 rounds; a further round sends NEW blocks (new seeds)
    let next = 0, count = P.fountainBlockCount(K);
    for (let round = 0; round < 3 && !st.done && state === 'connected'; round++) {
      const blocks = P.fountainEncode(data, next + count, transferId).slice(next);
      next += count;
      for (const b of blocks) {
        if (st.done || state !== 'connected') break;
        await send(P.PORT.FORWARDER, b);
        await sleep(BLOCK_GAP);
      }
      const until = Date.now() + Math.min(300000, 10000 + count * 6400 + 12800);
      while (!st.done && !st.more && Date.now() < until && state === 'connected') await sleep(250);
      count = st.more || Math.max(5, Math.ceil(K / 5));
      st.more = 0;
    }
    sending.delete(transferId);
  }

  async function receiveForwarder(p) {
    const b = p.payload;
    const f = P.parseFountain(b);
    if (f && f.ack) {
      const st = sending.get(f.ack.transferId);
      if (!st) return;
      if (f.ack.type === P.FOUNTAIN.COMPLETE) { if (same(f.ack.hash, st.hash)) st.done = true; } else if (f.ack.type === P.FOUNTAIN.NEED_MORE) st.more = f.ack.needed;
      return;
    }
    if (f && f.block) return receiveBlock(p, f.block);
    if (b[0] === 0xc2 || (b[0] === 0x4d && b[1] === 0x46 && b[2] === 0x54)) return; // codec2 voice, file transfer receipt
    showCot(await unzlib(b));
  }

  async function receiveBlock(p, blk) {
    const key = p.from + ':' + blk.transferId;
    let st = receiving.get(key);
    if (st && (st.K !== blk.K || st.totalLength !== blk.totalLength)) st = null; // new transfer with the same id
    if (!st) { st = { K: blk.K, totalLength: blk.totalLength, blocks: [], seeds: new Set(), done: false }; receiving.set(key, st); }
    st.t = Date.now();
    if (st.done || st.seeds.has(blk.seed)) return;
    st.seeds.add(blk.seed);
    st.blocks.push(blk);
    if (st.blocks.length < st.K) return;
    const data = P.fountainDecode(st.blocks, st.K, st.totalLength, blk.transferId);
    if (!data) return;
    st.done = true;
    // ACK like the plugin (twice), so the sender stops repeating
    const ack = P.fountainAck(blk.transferId, P.FOUNTAIN.COMPLETE, st.blocks.length, 0, await sha8(data));
    send(P.PORT.FORWARDER, ack, p.channel).then(() => sleep(200)).then(() => send(P.PORT.FORWARDER, ack, p.channel)).catch(() => {});
    if (data[0] === 0x00 || data[0] === 0x30) showCot(await unzlib(data.subarray(1))); // CoT (0x30 = "0" from iOS)
  }

  function showCot(bytes) {
    const xml = new TextDecoder().decode(bytes).trim();
    if (!xml.startsWith('<')) return;
    try { handleCot(xml); } catch (e) { /* not CoT */ }
  }

  setInterval(() => { for (const [k, st] of receiving) if (Date.now() - st.t > 300000) receiving.delete(k); }, 60000);

  // ---------------- Video: release the radio while streaming, reconnect afterwards ----------------

  document.addEventListener('eud-video', e => {
    if (!cfg.enabled) return;
    if (e.detail.on) {
      if (pausedForVideo) return;
      pausedForVideo = true;
      disconnect();
      setState('paused');
    } else if (pausedForVideo) {
      pausedForVideo = false;
      retry = 0;
      open();
    }
  });

  // ---------------- Settings ----------------

  const popupOpen = () => !$('popup').classList.contains('hidden') && document.querySelector('.mbody section.on[data-sec="mesh"]');

  // known radio: reconnect; after a reload without permission (or a new radio): the browser's device dialog
  $('meshPick').addEventListener('click', () => {
    if (!device) return pick();
    cfg.enabled = true;
    save();
    retry = 0;
    open();
  });
  $('meshNew').addEventListener('click', pick);
  $('meshOff').addEventListener('click', () => {
    cfg.enabled = false;
    save();
    pausedForVideo = false;
    disconnect();
    setState('off');
    toast('Meshtastic disconnected.');
  });
  $('meshSend').addEventListener('change', () => { cfg.send = $('meshSend').value === 'always' ? 'always' : 'offline'; save(); lastPli = 0; render(); });
  $('meshInterval').addEventListener('change', () => { cfg.interval = Number($('meshInterval').value) || 60; save(); });
  $('meshChannel').addEventListener('change', () => { cfg.channel = Number($('meshChannel').value) || 0; save(); });
  $('meshShowNodes').addEventListener('change', () => {
    cfg.nodes = $('meshShowNodes').checked;
    save();
    if (cfg.nodes) for (const num of nodes.keys()) showNode(num);
    else for (const num of nodes.keys()) removeItem('MESH-' + P.nodeId(num));
  });
  $('meshText').addEventListener('change', () => { cfg.text = $('meshText').checked; save(); });
  $('meshBluefy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied – open it in Bluefy.'); } catch (e) { toast(location.href, 8000); }
  });
  $('meshBtn').addEventListener('click', () => openPopup('mesh'));
  document.addEventListener('eud-popup', e => { if (e.detail === 'mesh') { msg(''); render(); } });

  render();
  if (cfg.enabled) open();
})();
