// Video relay: rewrite playlist addresses to the proxy, pass on access parameters (OTS ?jwt=…)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rewritePlaylist } = require('../lib/mediaproxy');

const back = line => new URL(decodeURIComponent(line.split('?u=')[1]));

test('playlist jwt is passed to sub-playlists and segments of the same server', () => {
  const base = 'https://tak.example.com/hls/ataktest/index.m3u8?jwt=abc.def';
  const out = rewritePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio1_stream.m3u8"\nvideo1_stream.m3u8\nseg1.mp4?jwt=own\nhttps://cdn.example.org/x.ts', base).split('\n');
  assert.equal(back(out[1].match(/URI="([^"]+)"/)[1]).searchParams.get('jwt'), 'abc.def');
  assert.equal(back(out[2]).href, 'https://tak.example.com/hls/ataktest/video1_stream.m3u8?jwt=abc.def');
  assert.equal(back(out[3]).searchParams.get('jwt'), 'own'); // own value is kept
  assert.equal(back(out[4]).search, ''); // another server does not get the key
});

test('own OTS video: login (jwt) added by the server, never in the playlist the browser gets; renewed on 401', async () => {
  const http = require('http');
  const { proxyMedia } = require('../lib/mediaproxy');
  let token = 'T1';
  const ots = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('jwt') !== token) { res.writeHead(401); return res.end(); }
    if (u.pathname === '/hls/cam/index.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\nseg1.ts\n'); }
    if (u.pathname === '/hls/cam/seg1.ts') { res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end('VIDEO'); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => ots.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ots.address().port}`;
  let current = 'OLD', logins = 0;
  const mapUpstream = async (url, { fresh }) => {
    let path;
    if (url.origin === base && url.pathname.startsWith('/hls/')) path = url.pathname;
    else if (url.hostname === 'tak.example.com' && url.port === '8888') path = '/hls' + url.pathname;
    else return null;
    if (fresh) { current = token; logins++; }
    const b = new URL(path, base);
    const f = new URL(b);
    f.searchParams.set('jwt', current);
    return { fetch: f, base: b };
  };
  const relay = http.createServer((req, res) => proxyMedia(req, res, { allowed: async () => false, mapUpstream }));
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  const get = u => fetch(`http://127.0.0.1:${relay.address().port}/api/eud/media?u=` + encodeURIComponent(u));
  try {
    const pl = await get('http://tak.example.com:8888/cam/index.m3u8');
    assert.equal(pl.status, 200);
    const text = await pl.text();
    assert.equal(logins, 1, 'old login rejected -> logged in again');
    assert.doesNotMatch(text, /jwt|T1/, 'the browser never sees the login');
    const seg = text.split('\n').find(l => l.startsWith('/api/eud/media'));
    const s = await fetch(`http://127.0.0.1:${relay.address().port}${seg}`);
    assert.equal(await s.text(), 'VIDEO');
    assert.equal((await get('http://other.example.com:8888/cam/index.m3u8')).status, 403, 'other servers still checked');
  } finally { ots.close(); relay.close(); }
});
