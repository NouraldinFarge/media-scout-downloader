import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const siteRoot = path.join(root, 'test-fixtures', 'site');
const generatedRoot = path.join(siteRoot, 'generated');

export async function startFixtureServer({ host = '127.0.0.1', port = 0 } = {}) {
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`Controlled fixture server error: ${error.message}`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url || '/', 'http://fixture.local');
  const commonHeaders = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };

  if (url.pathname === '/health') return sendText(response, 200, 'ok\n', 'text/plain; charset=utf-8', commonHeaders);
  if (url.pathname === '/favicon.ico') return sendBytes(response, 200, Buffer.alloc(0), 'image/x-icon', commonHeaders);
  if (url.pathname === '/empty/media.mp4') return sendBytes(response, 200, Buffer.alloc(0), 'video/mp4', commonHeaders);
  if (url.pathname === '/auth/media.mp4') return sendText(response, 401, 'Controlled authentication requirement.\n', 'text/plain; charset=utf-8', { ...commonHeaders, 'www-authenticate': 'Bearer realm="controlled-fixture"' });
  if (url.pathname === '/expired/media.mp4') return sendText(response, 403, 'Controlled expired-link simulation.\n', 'text/plain; charset=utf-8', commonHeaders);
  if (url.pathname === '/cors/media.mp4') return sendFile(response, path.join(generatedRoot, 'scout-demo.mp4'), 'video/mp4', commonHeaders);
  if (url.pathname === '/slow/media.mp4') {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return sendFile(response, path.join(generatedRoot, 'scout-demo.mp4'), 'video/mp4', commonHeaders);
  }
  if (url.pathname === '/signed/media.mp4') return sendFile(response, path.join(generatedRoot, 'scout-demo.mp4'), 'video/mp4', commonHeaders);

  if (url.pathname === '/fixtures/encrypted.m3u8') {
    return sendText(response, 200, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-KEY:METHOD=AES-128,URI="/fixtures/key.bin"\n#EXTINF:2.0,\n/generated/hls/segment-00.ts\n#EXT-X-ENDLIST\n', 'application/vnd.apple.mpegurl', commonHeaders);
  }
  if (url.pathname === '/fixtures/key.bin') return sendBytes(response, 200, Buffer.alloc(16, 7), 'application/octet-stream', commonHeaders);
  if (url.pathname === '/fixtures/fmp4.m3u8') return sendFile(response, path.join(generatedRoot, 'fmp4', 'media.m3u8'), 'application/vnd.apple.mpegurl', commonHeaders);
  if (url.pathname === '/fixtures/separate-audio.m3u8') {
    return sendText(response, 200, '#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Controlled tone",DEFAULT=YES,URI="/generated/hls/media.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=320000,RESOLUTION=320x180,AUDIO="audio"\n/generated/hls/media.m3u8\n', 'application/vnd.apple.mpegurl', commonHeaders);
  }
  if (url.pathname === '/fixtures/live.m3u8') {
    return sendText(response, 200, '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:42\n#EXTINF:2.0,\n/generated/hls/segment-00.ts\n', 'application/vnd.apple.mpegurl', commonHeaders);
  }
  if (url.pathname === '/fixtures/low-latency.m3u8') {
    return sendText(response, 200, '#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-PART-INF:PART-TARGET=0.333\n#EXT-X-PART:DURATION=0.333,URI="/generated/fmp4/segment-00.m4s"\n#EXTINF:2.0,\n/generated/fmp4/segment-00.m4s\n', 'application/vnd.apple.mpegurl', commonHeaders);
  }
  if (url.pathname === '/fixtures/sample.mpd') {
    return sendText(response, 200, '<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT2S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="controlled-320" bandwidth="320000" width="320" height="180"><BaseURL>/generated/scout-demo.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>\n', 'application/dash+xml', commonHeaders);
  }
  if (url.pathname === '/fixtures/segments-6001.m3u8') {
    const segments = Array.from({ length: 6001 }, (_value, index) => `#EXTINF:1.0,\n/generated/hls/segment-${String(index % 2).padStart(2, '0')}.ts`).join('\n');
    return sendText(response, 200, `#EXTM3U\n#EXT-X-VERSION:3\n${segments}\n#EXT-X-ENDLIST\n`, 'application/vnd.apple.mpegurl', commonHeaders);
  }
  if (url.pathname === '/fixtures/large-master.m3u8') {
    const variants = Array.from({ length: 1000 }, (_value, index) => `#EXT-X-STREAM-INF:BANDWIDTH=${200000 + index},RESOLUTION=320x180\n/generated/hls/media.m3u8?variant=${index}`).join('\n');
    return sendText(response, 200, `#EXTM3U\n${variants}\n`, 'application/vnd.apple.mpegurl', commonHeaders);
  }

  const relativePath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const target = path.resolve(siteRoot, relativePath);
  if (target !== siteRoot && !target.startsWith(`${siteRoot}${path.sep}`)) return sendText(response, 403, 'Forbidden.\n', 'text/plain; charset=utf-8', commonHeaders);
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('Not a file');
  } catch (_error) {
    return sendText(response, 404, 'Controlled fixture not found.\n', 'text/plain; charset=utf-8', commonHeaders);
  }
  return sendFile(response, target, contentType(target), commonHeaders);
}

async function sendFile(response, file, type, headers) {
  const bytes = await readFile(file);
  return sendBytes(response, 200, bytes, type, headers);
}

function sendText(response, status, value, type, headers) {
  return sendBytes(response, status, Buffer.from(value), type, headers);
}

function sendBytes(response, status, bytes, type, headers) {
  response.writeHead(status, { ...headers, 'content-type': type, 'content-length': bytes.length });
  response.end(bytes);
}

function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.m4s': 'video/iso.segment',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.png': 'image/png',
    '.ts': 'video/mp2t',
    '.vtt': 'text/vtt; charset=utf-8',
    '.webm': 'video/webm'
  })[extension] || 'application/octet-stream';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await startFixtureServer({ port: Number(process.env.MEDIA_SCOUT_FIXTURE_PORT || 4173) });
  console.log(`Controlled fixture server listening at ${fixture.origin}`);
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
