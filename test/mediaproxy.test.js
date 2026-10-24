// Video-Durchreiche: Playlist-Adressen auf den Proxy umschreiben, Zugangs-Parameter (OTS ?jwt=…) weitergeben
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rewritePlaylist } = require('../lib/mediaproxy');

const back = line => new URL(decodeURIComponent(line.split('?u=')[1]));

test('jwt der Playlist geht an Unter-Playlists und Segmente desselben Servers', () => {
  const base = 'https://tak.example.com/hls/ataktest/index.m3u8?jwt=abc.def';
  const out = rewritePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio1_stream.m3u8"\nvideo1_stream.m3u8\nseg1.mp4?jwt=own\nhttps://cdn.example.org/x.ts', base).split('\n');
  assert.equal(back(out[1].match(/URI="([^"]+)"/)[1]).searchParams.get('jwt'), 'abc.def');
  assert.equal(back(out[2]).href, 'https://tak.example.com/hls/ataktest/video1_stream.m3u8?jwt=abc.def');
  assert.equal(back(out[3]).searchParams.get('jwt'), 'own'); // eigener Wert bleibt
  assert.equal(back(out[4]).search, ''); // fremder Server bekommt den Schlüssel nicht
});
