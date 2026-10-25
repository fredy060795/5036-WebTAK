// Read the drone telemetry (KLV, MISB ST 0601) of a video feed with ffmpeg while someone watches it.
// One reader per feed, shared by all viewers; stops a few seconds after the last viewer left.
// The address candidates are tried in order (e.g. RTSP of the TAK server's MediaMTX, then the direct source).

const { spawn } = require('child_process');
const { KlvReader, interpret, toCot } = require('./klv');

const SEND_MS = 1000;       // positions to the viewers at most once per second
const LINGER_MS = 5000;     // keep reading briefly after the last viewer (switching windows)
const NO_DATA_MS = 20000;   // no KLV within this time -> next candidate / "no telemetry"
const MAX_READERS = 6;

class KlvFeeds {
  constructor({ ffmpeg, log }) {
    this.ffmpeg = ffmpeg;
    this.log = log || (() => {});
    this.readers = new Map(); // key -> reader
  }

  // candidates: [{ url, label }] (label without a password, for the log); send(event, data) to the viewer
  // returns close()
  watch(key, { candidates, uid, name, video }, send) {
    let r = this.readers.get(key);
    if (!r) {
      if (!this.ffmpeg) { send('status', { state: 'unsupported', message: 'ffmpeg is missing on the server.' }); return () => {}; }
      if (this.readers.size >= MAX_READERS) { send('status', { state: 'busy', message: 'Too many telemetry readers right now.' }); return () => {}; }
      r = { key, candidates, uid, name, video, viewers: new Set(), state: {}, last: null, proc: null, idx: -1, timer: null, status: null };
      this.readers.set(key, r);
      this.next(r);
    }
    clearTimeout(r.linger);
    r.viewers.add(send);
    if (r.status) send('status', r.status);
    if (r.last) send('cot', r.last);
    return () => {
      r.viewers.delete(send);
      if (!r.viewers.size) r.linger = setTimeout(() => this.stop(r), LINGER_MS);
    };
  }

  broadcast(r, ev, data) { for (const s of r.viewers) s(ev, data); }
  setStatus(r, status) { r.status = status; this.broadcast(r, 'status', status); }

  next(r) {
    r.idx++;
    if (r.idx >= r.candidates.length) {
      this.setStatus(r, { state: 'no-klv', message: r.gotVideo ? 'This stream carries no telemetry (KLV).' : (r.error || 'Stream not reachable for telemetry.') });
      return;
    }
    const c = r.candidates[r.idx];
    this.setStatus(r, { state: 'connecting', message: 'Looking for telemetry …' });
    // only network protocols – never files or other ffmpeg inputs from an address that came from outside
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'tcp,tls,udp,rtp,rtsp,rtsps,http,https,srt,crypto'];
    // 15 s network timeout: RTSP/SRT call it "timeout", HTTP "rw_timeout"
    if (/^rtsps?:/i.test(c.url)) args.push('-rtsp_transport', 'tcp', '-timeout', '15000000');
    else if (/^srt:/i.test(c.url)) args.push('-timeout', '15000000');
    else args.push('-rw_timeout', '15000000');
    args.push('-i', c.url, '-map', '0:d:0', '-c', 'copy', '-f', 'data', 'pipe:1');
    const proc = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    r.proc = proc;
    let err = '', got = false;
    const reader = new KlvReader(set => {
      Object.assign(r.state, set);
      if (!got) { got = true; this.log(`KLV telemetry from ${c.label}`); }
    });
    proc.stdout.on('data', chunk => reader.push(chunk));
    proc.stderr.on('data', d => { err = (err + d.toString()).slice(-2000); });
    const noData = setTimeout(() => { if (!got && r.proc === proc) proc.kill('SIGKILL'); }, NO_DATA_MS);
    clearInterval(r.timer);
    r.timer = setInterval(() => {
      if (r.proc !== proc || !got) return;
      const v = interpret(r.state);
      if (!v) return;
      r.last = { xml: toCot(v, { uid: r.uid, name: r.name, video: r.video }), info: summary(v) };
      if (r.status.state !== 'live') this.setStatus(r, { state: 'live', message: '' });
      this.broadcast(r, 'cot', r.last);
    }, SEND_MS);
    proc.on('exit', () => {
      clearTimeout(noData);
      if (r.proc !== proc) return;
      r.proc = null;
      if (this.readers.get(r.key) !== r) return;
      // no data track: the stream itself was reachable
      if (/matches no streams|does not contain any stream/i.test(err)) r.gotVideo = true;
      else if (err.trim() && !r.error) r.error = 'Stream not reachable for telemetry: ' + err.trim().split('\n').pop().slice(0, 160);
      if (got) {
        // the stream broke off: try the same address again shortly
        this.setStatus(r, { state: 'connecting', message: 'Telemetry interrupted – reconnecting …' });
        r.retry = setTimeout(() => { if (this.readers.get(r.key) === r) { r.idx--; this.next(r); } }, 3000);
        return;
      }
      this.next(r);
    });
  }

  stop(r) {
    if (r.viewers.size) return;
    clearInterval(r.timer);
    clearTimeout(r.retry);
    if (r.proc) { const p = r.proc; r.proc = null; p.kill('SIGKILL'); }
    this.readers.delete(r.key);
  }

  close() { for (const r of [...this.readers.values()]) { r.viewers.clear(); this.stop(r); } }
}

function summary(v) {
  return {
    lat: v.lat, lon: v.lon, alt: v.alt, heading: v.heading, az: v.az, el: v.el, hfov: v.hfov,
    footprint: !!v.corners, center: v.center,
  };
}

module.exports = { KlvFeeds };
