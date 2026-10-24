// Videostream aus dem EUD: Handy-Kamera oder Helmkamera (Bluetooth) antippen -> Stream läuft sofort.
// Nutzt dieselbe Durchreiche wie /app/ (Anmeldung /api/app/register, Bilder über /ws/publish).
'use strict';

(() => {
  const { $, store, profile, toast, setMsg, openPopup } = window.eud;
  // Bluetooth-Protokoll der Kamera: PROTOCOL.md im Repository ESP32-Flash
  const SVC = '7b3c0001-6b1a-4d6e-9c55-3a2f1e0c8a01';
  const COMMAND = '7b3c0003-6b1a-4d6e-9c55-3a2f1e0c8a01';
  const IMAGE = '7b3c0004-6b1a-4d6e-9c55-3a2f1e0c8a01';
  const RES_PX = { 1: 160, 5: 320, 8: 640, 11: 1280 };
  const RES_NAME = { 1: '160x120', 5: '320x240', 8: '640x480', 11: '1280x720' };
  const PHONE_FPS = 5;
  const enc = new TextEncoder();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let link = store.get('eud.video', null); // { u, s, k } vom Server
  let ws = null, wsTimer = null, wsRetry = 0;
  let running = false;     // Nutzer will senden
  let onAir = false;       // Server lässt Bilder durch
  let source = null;       // 'phone' | 'ble'
  let mediaStream = null, captureTimer = null, capturing = false;
  let device = null, cmdChr = null, frame = null, writeChain = Promise.resolve();
  let framesize = 1, rotate = 0, mirror = false, fit = 'fill';
  let sent = [], busy = false, lastPreview = 0, wakeLock = null;
  let streamUrl = '';

  const msg = (text, ok) => setMsg($('vidMsg'), text, ok);

  function render() {
    const active = running && !!source;
    $('vidStart').classList.toggle('hidden', active);
    $('vidRun').classList.toggle('hidden', !active);
    $('livePreview').classList.toggle('hidden', !active);
    const live = active && onAir && ws && ws.readyState === 1;
    $('livePreview').classList.toggle('ready', active && !live);
    $('liveTag').textContent = live ? '● LIVE' : 'VERBINDE';
    $('vidBanner').className = 'nw-banner ' + (live ? 'ok' : 'wait');
    $('vidState').textContent = live ? 'LIVE – wird gesendet' : (ws && ws.readyState === 1 ? 'Warte auf Freigabe …' : 'Verbinde mit Server …');
    $('btnVideo').classList.toggle('live', live);
    $('bleBtn').disabled = !navigator.bluetooth;
    $('camPickRow').classList.toggle('hidden', source !== 'phone' || $('camSelect').options.length < 2);
    // Eigene SA bekommt den Video-Link, solange gesendet wird (ATAK zeigt ihn beim Kontakt an)
    const url = live && streamUrl ? streamUrl + '/stream.ts' : null;
    if (url !== window.eudVideoUrl) {
      window.eudVideoUrl = url;
      if (window.eudSendSelf) window.eudSendSelf();
    }
  }

  // ---------------- Anmeldung + Server ----------------

  async function ensureLink() {
    if (link) return link;
    const res = await fetch('/api/app/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: profile.callsign || 'EUD', unit: profile.team, source: 'eud' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Anmeldung beim Server fehlgeschlagen.');
    link = { u: data.u, s: data.s, k: data.k };
    store.set('eud.video', link);
    return link;
  }

  function connectServer() {
    clearTimeout(wsTimer);
    if (!running || !link) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws/publish?u=${encodeURIComponent(link.u)}&s=${encodeURIComponent(link.s)}&k=${encodeURIComponent(link.k)}`);
    ws = sock;
    sock.binaryType = 'arraybuffer';
    sock.onopen = () => { wsRetry = 0; };
    sock.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'welcome') {
        streamUrl = m.stream || '';
        sock.send(JSON.stringify({ type: 'hello', camera: $('vidCam').textContent, phone: navigator.userAgent, resolution: RES_NAME[framesize] }));
        sock.send(JSON.stringify({ type: 'state', ready: true }));
        sock.send(JSON.stringify({ type: 'golive', on: true })); // sofort senden
      } else if (m.type === 'live') {
        const was = onAir;
        onAir = m.mode === 'user' || !!m.on;
        if (was && !onAir && m.mode !== 'user') { msg('Der Admin hat den Stream beendet.'); toast('Videostream vom Admin beendet.'); stop(); return; }
      } else if (m.type === 'config') {
        rotate = m.rotate || 0;
        mirror = !!m.mirror;
        fit = m.fit === 'fit' ? 'fit' : 'fill';
        const fs = RES_PX[m.framesize] ? m.framesize : 1;
        if (fs !== framesize) {
          framesize = fs;
          if (source === 'ble') camSend({ cmd: 'cam', framesize });
        }
      } else if (m.type === 'stats') {
        $('vidViewers').textContent = m.viewers;
      } else if (m.type === 'stopped') {
        msg(m.message || 'Stream wurde vom Admin gestoppt.');
        toast('Videostream vom Admin gestoppt.');
        stop();
        return;
      } else if (m.type === 'removed' || m.type === 'invalid' || m.type === 'revoked') {
        // Zugang gibt es nicht mehr: beim nächsten Start neu anmelden
        link = null;
        store.del('eud.video');
        if (m.type === 'revoked') { msg(m.message || 'Zugang wurde vom Admin entzogen.'); stop(); return; }
        if (running) ensureLink().then(connectServer).catch(e => { msg(e.message); stop(); });
        return;
      } else if (m.type === 'replaced') {
        msg('Ein anderes Gerät sendet jetzt auf diesem Stream.');
        stop();
        return;
      }
      render();
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      onAir = false;
      render();
      if (running) wsTimer = setTimeout(connectServer, Math.min(15000, 1000 * 2 ** wsRetry++));
    };
  }

  // ---------------- Bilder ----------------

  async function rotateJpeg(jpeg, deg, flip) {
    const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    const w = bmp.width, h = bmp.height;
    const quarter = Math.round(deg / 90) % 4;
    const W = quarter % 2 ? h : w, H = quarter % 2 ? w : h;
    const rad = deg * Math.PI / 180;
    const c = Math.abs(Math.cos(rad)), si = Math.abs(Math.sin(rad));
    const scale = fit === 'fit' ? Math.min(W / (w * c + h * si), H / (w * si + h * c)) : Math.max((W * c + H * si) / w, (W * si + H * c) / h);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rad);
    ctx.scale(flip ? -scale : scale, scale);
    ctx.drawImage(bmp, -w / 2, -h / 2);
    bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function onJpeg(raw) {
    let jpeg = raw;
    if (rotate || mirror) {
      if (busy) return;
      busy = true;
      try { jpeg = await rotateJpeg(raw, rotate, mirror); } catch (e) { return; } finally { busy = false; }
    }
    const now = performance.now();
    if (ws && ws.readyState === 1 && onAir && ws.bufferedAmount < 512 * 1024) {
      ws.send(jpeg);
      sent.push(now);
    }
    sent = sent.filter(t => now - t < 5000);
    $('vidFps').textContent = (sent.length / 5).toFixed(1);
    if (source === 'ble' && now - lastPreview > 200) {
      lastPreview = now;
      const img = $('camImg');
      const old = img.src;
      img.src = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
      if (old) URL.revokeObjectURL(old);
    }
  }

  // Handy-Kamera: Bild aus dem Video holen (die Vorschau ist das Video selbst – iPhone braucht es sichtbar)
  async function captureFrame() {
    const v = $('camVideo');
    if (capturing || !v.videoWidth) return;
    capturing = true;
    try {
      const scale = Math.min(1, (RES_PX[framesize] || 160) / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.75));
      if (blob) await onJpeg(new Uint8Array(await blob.arrayBuffer()));
    } finally {
      capturing = false;
    }
  }

  async function openPhoneCamera(deviceId) {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Die Kamera geht nur über HTTPS.');
    }
    const attempts = deviceId
      ? [{ video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }]
      : [
        { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: { facingMode: 'environment' }, audio: false },
        { video: true, audio: false },
      ];
    let last = null;
    for (const c of attempts) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) {
        last = e;
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break;
      }
    }
    if (last && (last.name === 'NotAllowedError' || last.name === 'SecurityError')) {
      throw new Error(isIOS ? 'Kamera nicht erlaubt: Einstellungen → Safari → Kamera → „Erlauben“.' : 'Kamera-Zugriff verweigert – in den Seiteneinstellungen erlauben.');
    }
    if (last && last.name === 'NotReadableError') throw new Error('Die Kamera wird gerade von einer anderen App benutzt.');
    throw new Error('Kamera konnte nicht gestartet werden' + (last ? ` (${last.name})` : '') + '.');
  }

  async function attach(stream) {
    if (mediaStream && mediaStream !== stream) mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = stream;
    const v = $('camVideo');
    v.classList.remove('hidden');
    $('camImg').classList.add('hidden');
    v.srcObject = stream;
    await v.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    $('vidCam').textContent = (track && track.label) || 'Handy-Kamera';
    await listCameras();
  }

  async function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const track = mediaStream && mediaStream.getVideoTracks()[0];
    const current = track ? track.getSettings().deviceId : '';
    const sel = $('camSelect');
    sel.replaceChildren(...cams.map((c, i) => new Option(c.label || 'Kamera ' + (i + 1), c.deviceId)));
    if (current) sel.value = current;
    render();
  }

  $('camSelect').addEventListener('change', async () => {
    try {
      if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); // viele Handys erlauben nur eine Kamera
      await attach(await openPhoneCamera($('camSelect').value));
      try { localStorage.setItem('eud.camera', $('camSelect').value); } catch (e) { /* privat */ }
    } catch (e) { msg(e.message); }
  });

  // Helmkamera über Bluetooth
  function camSend(obj) {
    writeChain = writeChain.then(() => cmdChr && cmdChr.writeValueWithResponse(enc.encode(JSON.stringify(obj)))).catch(() => {});
    return writeChain;
  }

  function onImagePacket(ev) {
    const dv = ev.target.value;
    const type = dv.getUint8(0);
    if (type === 1) {
      frame = { buf: new Uint8Array(dv.getUint32(1, true)), got: 0 };
    } else if (type === 2 && frame) {
      const part = new Uint8Array(dv.buffer, dv.byteOffset + 5, dv.byteLength - 5);
      frame.buf.set(part, dv.getUint32(1, true));
      frame.got += part.length;
    } else if (type === 3 && frame) {
      if (frame.got === frame.buf.length) onJpeg(frame.buf);
      frame = null;
    }
  }

  async function setupGatt() {
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(SVC);
    cmdChr = await svc.getCharacteristic(COMMAND);
    const img = await svc.getCharacteristic(IMAGE);
    img.addEventListener('characteristicvaluechanged', onImagePacket);
    await img.startNotifications();
    await camSend({ cmd: 'cam', framesize });
    await camSend({ cmd: 'stream', on: true, interval: 0 });
  }

  async function onBleLost() {
    if (!device || source !== 'ble') return;
    toast('Helmkamera getrennt – verbinde neu …');
    for (let i = 0; i < 30 && device && running; i++) {
      try { await setupGatt(); toast('Helmkamera wieder verbunden.'); return; } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    if (running) { msg('Helmkamera nicht erreichbar.'); stop(); }
  }

  // ---------------- Start / Stopp ----------------

  async function start(kind) {
    if (!profile.callsign) { openPopup('me'); toast('Bitte zuerst einen Rufnamen eintragen.'); return; }
    msg('');
    $('phoneBtn').disabled = $('bleBtn').disabled = true;
    try {
      if (kind === 'phone') {
        let saved = '';
        try { saved = localStorage.getItem('eud.camera') || ''; } catch (e) { /* privat */ }
        let stream;
        try { stream = await openPhoneCamera(saved || undefined); } catch (e) { if (!saved) throw e; stream = await openPhoneCamera(); }
        source = 'phone';
        await attach(stream);
        clearInterval(captureTimer);
        captureTimer = setInterval(captureFrame, 1000 / PHONE_FPS);
      } else {
        if (!navigator.bluetooth) throw new Error(isIOS ? 'Bluetooth geht am iPhone nur in der App „Bluefy“ – Handy-Kamera nutzen.' : 'Dieser Browser kann kein Bluetooth (Chrome verwenden).');
        device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }, { namePrefix: 'Helm' }], optionalServices: [SVC] });
        device.addEventListener('gattserverdisconnected', onBleLost);
        msg('Verbinde mit ' + (device.name || 'Helmkamera') + ' …', true);
        source = 'ble';
        await setupGatt();
        $('vidCam').textContent = (device.name || 'Helmkamera') + ' (Bluetooth)';
        $('camVideo').classList.add('hidden');
        $('camImg').classList.remove('hidden');
      }
      running = true;
      await ensureLink();
      connectServer();
      try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* nicht erlaubt */ }
      msg('');
      render();
    } catch (e) {
      if (!(e.name === 'NotFoundError' && /cancel/i.test(e.message))) msg(e.message);
      stop(true);
    } finally {
      $('phoneBtn').disabled = false;
      render();
    }
  }

  function stop(quiet) {
    running = false;
    onAir = false;
    clearInterval(captureTimer);
    clearTimeout(wsTimer);
    if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
    $('camVideo').srcObject = null;
    if (source === 'ble' && cmdChr) camSend({ cmd: 'stream', on: false });
    const d = device;
    device = null;
    cmdChr = null;
    if (d && d.gatt.connected) d.gatt.disconnect();
    source = null;
    if (ws) {
      const s = ws;
      ws = null;
      try { if (s.readyState === 1) s.send(JSON.stringify({ type: 'golive', on: false })); } catch (e) { /* egal */ }
      s.close();
    }
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    if (!quiet) toast('Videostream beendet.');
    render();
  }

  // ---------------- Streams ansehen (eigene und fremde) ----------------

  // Was der Browser abspielen kann: MJPEG (unsere Streams, als Bild), HLS (.m3u8), MP4/WebM.
  // RTSP/RTMP/SRT/UDP gehen im Browser nicht -> Adresse kopieren (z. B. für VLC).
  function play(name, url) {
    const img = $('vwImg'), vid = $('vwVideo');
    const say = t => { $('vwMsg').textContent = t || ''; };
    stopViewer();
    $('vwTitle').textContent = name || 'Stream';
    $('viewer').classList.remove('hidden');
    say('Lade …');
    if (!/^https?:\/\//i.test(url)) {
      say('Dieses Format (' + url.split(':')[0].toUpperCase() + ') kann der Browser nicht abspielen. Adresse wurde kopiert – z. B. in VLC öffnen.');
      if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
      return;
    }
    const u = window.eud.browserVideoUrl(url);
    // Unsere Streams (…/benutzer/id/stream.ts usw.): als MJPEG-Bild, geringe Verzögerung
    const mjpeg = /\/[a-z0-9][a-z0-9_-]*\/[a-z0-9]{4,32}\/?$/i.test(new URL(u).pathname) ? u.replace(/\/$/, '')
      : /\/(stream\.ts|snapshot\.jpg)$/i.test(url) ? url.replace(/\/(stream\.ts|snapshot\.jpg)$/i, '') : '';
    const asVideo = () => {
      img.classList.add('hidden');
      vid.classList.remove('hidden');
      vid.onloadeddata = () => say('');
      vid.onerror = () => say('Stream lässt sich nicht abspielen (Format oder nicht erreichbar).');
      vid.src = url;
      vid.play().catch(() => {});
    };
    if (mjpeg && !/\.m3u8|\.mp4|\.webm/i.test(u)) {
      img.classList.remove('hidden');
      img.onload = () => say('');
      img.onerror = () => asVideo(); // kein MJPEG: als Video versuchen
      img.src = mjpeg + (mjpeg.includes('?') ? '&' : '?') + 't=' + Date.now();
    } else {
      asVideo();
    }
  }
  function stopViewer() {
    const img = $('vwImg'), vid = $('vwVideo');
    img.onerror = img.onload = null;
    img.removeAttribute('src'); // MJPEG-Verbindung beenden
    img.classList.add('hidden');
    vid.onerror = vid.onloadeddata = null;
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
    vid.classList.add('hidden');
  }
  window.eudPlay = play;
  $('vwClose').addEventListener('click', () => { stopViewer(); $('viewer').classList.add('hidden'); $('viewer').classList.remove('full'); });
  $('vwFull').addEventListener('click', () => $('viewer').classList.toggle('full'));

  function renderStreams() {
    const box = $('streamList');
    box.textContent = '';
    const list = window.eud.videoItems();
    if (streamUrl && running) list.unshift({ name: 'Mein Stream', url: streamUrl, own: true });
    if (!list.length) box.innerHTML = '<div class="empty">Gerade sendet niemand im Lagebild ein Video.</div>';
    for (const v of list) {
      const row = document.createElement('div');
      row.className = 'item';
      const t = document.createElement('span');
      t.textContent = v.name;
      const s = document.createElement('small');
      s.textContent = v.url;
      t.append(s);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '▶';
      b.onclick = () => { window.eud.closePopup(); play(v.name, v.url); };
      row.append(t, b);
      box.append(row);
    }
  }
  document.addEventListener('eud-popup', e => { if (e.detail === 'video') renderStreams(); });

  $('phoneBtn').addEventListener('click', () => start('phone'));
  $('bleBtn').addEventListener('click', () => start('ble'));
  $('vidStop').addEventListener('click', () => stop());
  $('btnVideo').addEventListener('click', () => openPopup('video'));
  $('livePreview').addEventListener('click', () => openPopup('video'));
  if (!navigator.bluetooth) $('bleBtn').title = isIOS ? 'Am iPhone nur mit der App „Bluefy“' : 'Browser ohne Bluetooth';
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running && 'wakeLock' in navigator) navigator.wakeLock.request('screen').then(w => { wakeLock = w; }).catch(() => {});
  });
  render();
})();
