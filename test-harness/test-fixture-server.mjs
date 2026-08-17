import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startFixtureServer } from './fixture-server.mjs';

const fixture = await startFixtureServer();

try {
  const health = await fetch(`${fixture.origin}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok\n');

  const checks = [
    ['/generated/scout-demo.mp4', 200, 'video/mp4'],
    ['/generated/scout-demo.webm', 200, 'video/webm'],
    ['/generated/scout-tone.mp3', 200, 'audio/mpeg'],
    ['/generated/captions.vtt', 200, 'text/vtt'],
    ['/generated/poster.png', 200, 'image/png'],
    ['/generated/hls/master.m3u8', 200, 'application/vnd.apple.mpegurl'],
    ['/fixtures/encrypted.m3u8', 200, 'application/vnd.apple.mpegurl'],
    ['/fixtures/fmp4.m3u8', 200, 'application/vnd.apple.mpegurl'],
    ['/fixtures/separate-audio.m3u8', 200, 'application/vnd.apple.mpegurl'],
    ['/fixtures/live.m3u8', 200, 'application/vnd.apple.mpegurl'],
    ['/fixtures/low-latency.m3u8', 200, 'application/vnd.apple.mpegurl'],
    ['/fixtures/sample.mpd', 200, 'application/dash+xml'],
    ['/empty/media.mp4', 200, 'video/mp4'],
    ['/auth/media.mp4', 401, 'text/plain'],
    ['/expired/media.mp4?token=controlled-expired', 403, 'text/plain']
  ];

  for (const [pathname, expectedStatus, expectedType] of checks) {
    const response = await fetch(`${fixture.origin}${pathname}`);
    assert.equal(response.status, expectedStatus, `${pathname} status`);
    assert.match(response.headers.get('content-type') || '', new RegExp(`^${escapeRegExp(expectedType)}`), `${pathname} content type`);
    await response.arrayBuffer();
  }

  const empty = await fetch(`${fixture.origin}/empty/media.mp4`);
  assert.equal((await empty.arrayBuffer()).byteLength, 0, 'empty fixture is exactly empty');

  const cors = await fetch(`${fixture.origin}/cors/media.mp4`);
  assert.equal(cors.headers.has('access-control-allow-origin'), false, 'CORS failure fixture deliberately omits ACAO');

  const encrypted = await (await fetch(`${fixture.origin}/fixtures/encrypted.m3u8`)).text();
  assert.match(encrypted, /#EXT-X-KEY:METHOD=AES-128/, 'protected fixture has an explicit encryption marker');

  const separateAudio = await (await fetch(`${fixture.origin}/fixtures/separate-audio.m3u8`)).text();
  assert.match(separateAudio, /#EXT-X-MEDIA:TYPE=AUDIO/, 'separate-audio fixture declares an audio rendition');

  const live = await (await fetch(`${fixture.origin}/fixtures/live.m3u8`)).text();
  assert.equal(live.includes('#EXT-X-ENDLIST'), false, 'live fixture intentionally has no end marker');

  const lowLatency = await (await fetch(`${fixture.origin}/fixtures/low-latency.m3u8`)).text();
  assert.match(lowLatency, /#EXT-X-PART:/, 'low-latency fixture includes partial segments');

  const boundary = await (await fetch(`${fixture.origin}/fixtures/segments-6001.m3u8`)).text();
  assert.equal((boundary.match(/#EXTINF:/g) || []).length, 6001, 'segment boundary fixture contains exactly 6,001 entries');

  const largeMaster = await (await fetch(`${fixture.origin}/fixtures/large-master.m3u8`)).text();
  assert.equal((largeMaster.match(/#EXT-X-STREAM-INF:/g) || []).length, 1000, 'large master contains exactly 1,000 variants');

  const manifestUrl = new URL('../test-fixtures/site/generated/FIXTURE_MANIFEST.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.provenance, 'Synthetic FFmpeg generators and original project test copy only.');
  for (const entry of manifest.files) {
    const bytes = await readFile(new URL(`../test-fixtures/site/generated/${entry.path}`, import.meta.url));
    assert.equal(bytes.length, entry.bytes, `${entry.path} byte length`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.path} SHA-256`);
  }

  console.log(`Controlled fixture gate: ${checks.length} endpoints, boundary cases, and ${manifest.files.length} generated-file hashes passed.`);
} finally {
  await fixture.close();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
