// Wandelt die JPEG-Bilder eines Streams mit ffmpeg in H.264 um:
//   - HLS (index.m3u8 + Segmente) für Player, die HLS können
//   - MPEG-TS als fortlaufender HTTP-Stream (stream.ts)
// Läuft nur, solange jemand HLS/TS abruft; ein Prozess pro Stream.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IDLE_STOP_MS = 30000;   // ohne Abrufe nach 30 s beenden
const REFEED_MS = 500;        // letztes Bild wiederholen, damit der Stream nicht hängt

class Transcoder {
  constructor({ ffmpeg, dir, log }) {
    this.ffmpeg = ffmpeg;
    this.baseDir = dir;
    this.run = 0;
    this.dir = path.join(dir, 'run0'); // jeder Start schreibt in einen eigenen Unterordner
    this.dims = null;                  // Bildgröße "BxH" des laufenden Streams
    this.log = log || (() => {});
    this.proc = null;
    this.tsClients = new Set();
    this.lastAccess = Date.now();
    this.lastFed = 0;
    this.lastFrame = null;
    this.timer = null;
  }

  get running() {
    return !!this.proc;
  }

  start() {
    if (this.proc) return;
    fs.rmSync(this.baseDir, { recursive: true, force: true });
    this.dir = path.join(this.baseDir, 'run' + ++this.run);
    fs.mkdirSync(this.dir, { recursive: true });
    const hls = [
      'f=hls',
      'hls_time=2',
      'hls_list_size=6',
      'hls_flags=delete_segments+omit_endlist',
      'hls_segment_filename=' + path.join(this.dir, 'seg%05d.ts'),
    ].join(':');
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'mjpeg', '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
      '-map', '0:v',
      '-vf', 'fps=10,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-g', '20', '-keyint_min', '20', '-sc_threshold', '0', '-b:v', '800k',
      '-f', 'tee', `[${hls}]${path.join(this.dir, 'index.m3u8')}|[f=mpegts]pipe:1`,
    ];
    const proc = spawn(this.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdin.on('error', () => {});
    proc.stderr.on('data', d => this.log('ffmpeg: ' + d.toString().trim()));
    proc.stdout.on('data', chunk => {
      for (const res of this.tsClients) {
        if (res.writableLength > 4 * 1024 * 1024) continue; // langsamer Client: Daten auslassen
        res.write(chunk);
      }
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.cleanup();
    });
    if (this.lastFrame) this.feed(this.lastFrame);
    this.timer = setInterval(() => this.tick(), REFEED_MS);
  }

  tick() {
    if (!this.proc) return;
    if (this.tsClients.size === 0 && Date.now() - this.lastAccess > IDLE_STOP_MS) {
      this.stop();
      return;
    }
    if (this.lastFrame && Date.now() - this.lastFed >= REFEED_MS) this.feed(this.lastFrame);
  }

  feed(jpeg) {
    if (!this.proc || !this.proc.stdin.writable) return;
    if (this.proc.stdin.writableLength > 2 * 1024 * 1024) return; // ffmpeg kommt nicht hinterher
    this.lastFed = Date.now();
    this.proc.stdin.write(jpeg);
  }

  // dims = "BreitexHöhe"; ändert sich die Größe (z. B. Drehung hoch/quer), wird
  // ffmpeg neu gestartet, weil der H.264-Encoder keine Größenwechsel kann.
  push(jpeg, dims) {
    if (this.proc && dims && this.dims && dims !== this.dims) {
      this.log(`Bildgröße ${this.dims} -> ${dims}, Umwandlung startet neu`);
      this.stop();
      this.dims = dims;
      this.lastFrame = jpeg;
      this.start();
      return;
    }
    if (dims) this.dims = dims;
    this.lastFrame = jpeg;
    if (this.proc) this.feed(jpeg);
  }

  touch() {
    this.lastAccess = Date.now();
    this.start();
  }

  addTsClient(res) {
    this.touch();
    this.tsClients.add(res);
    res.on('close', () => {
      this.tsClients.delete(res);
      this.lastAccess = Date.now();
    });
  }

  // Wartet, bis ffmpeg die Playlist geschrieben hat
  async waitForPlaylist(timeoutMs = 10000) {
    const file = path.join(this.dir, 'index.m3u8');
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (fs.existsSync(file)) return file;
      if (!this.proc) return null;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  cleanup() {
    clearInterval(this.timer);
    this.timer = null;
    this.proc = null;
    for (const res of this.tsClients) res.end();
    this.tsClients.clear();
    fs.rmSync(this.baseDir, { recursive: true, force: true });
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.cleanup();
    proc.stdin.end();
    setTimeout(() => proc.kill('SIGKILL'), 2000).unref();
  }
}

module.exports = { Transcoder };
