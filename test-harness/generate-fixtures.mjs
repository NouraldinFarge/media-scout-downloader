import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const siteRoot = path.join(root, 'test-fixtures', 'site');
const output = path.join(siteRoot, 'generated');

if (path.dirname(output) !== siteRoot || path.basename(output) !== 'generated') {
  throw new Error('Refusing to replace an unexpected fixture path.');
}

const ffmpeg = process.env.MEDIA_SCOUT_FFMPEG || 'ffmpeg';
const version = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
if (version.status !== 0) {
  throw new Error('FFmpeg was not found. Put it on PATH or set MEDIA_SCOUT_FFMPEG to an exact executable.');
}

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, 'hls'), { recursive: true });
await mkdir(path.join(output, 'fmp4'), { recursive: true });

run([
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
  '-map_metadata', '-1', '-fflags', '+bitexact', '-threads', '1', '-shortest',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart',
  path.join(output, 'scout-demo.mp4')
]);

run([
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2',
  '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-threads', '1', '-an',
  '-c:v', 'libvpx-vp9', '-b:v', '180k', '-deadline', 'good',
  path.join(output, 'scout-demo.webm')
]);

run([
  '-f', 'lavfi', '-i', 'sine=frequency=523.25:sample_rate=44100:duration=2',
  '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-threads', '1', '-c:a', 'libmp3lame', '-b:a', '64k',
  path.join(output, 'scout-tone.mp3')
]);

run([
  '-f', 'lavfi', '-i', 'color=c=0x6978ff:size=640x360:duration=1',
  '-frames:v', '1', '-threads', '1', '-update', '1',
  path.join(output, 'poster.png')
]);

run([
  '-i', path.join(output, 'scout-demo.mp4'), '-map_metadata', '-1', '-threads', '1',
  '-c:v', 'libx264', '-c:a', 'aac', '-f', 'hls', '-hls_time', '0.5', '-hls_list_size', '0',
  '-hls_segment_filename', path.join(output, 'hls', 'segment-%02d.ts'),
  path.join(output, 'hls', 'media.m3u8')
]);

run([
  '-i', path.join(output, 'scout-demo.mp4'), '-map_metadata', '-1', '-threads', '1',
  '-c:v', 'libx264', '-c:a', 'aac', '-f', 'hls', '-hls_time', '0.5', '-hls_list_size', '0',
  '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', 'segment-%02d.m4s',
  'media.m3u8'
], { cwd: path.join(output, 'fmp4') });

await writeFile(path.join(output, 'captions.vtt'), `WEBVTT\n\n00:00.000 --> 00:01.000\nControlled fixture begins.\n\n00:01.000 --> 00:02.000\nNo third-party media is present.\n`);
await writeFile(path.join(output, 'hls', 'master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=320000,RESOLUTION=320x180,CODECS="avc1.42001e,mp4a.40.2"\nmedia.m3u8\n');

const files = await walk(output);
const inventory = [];
for (const file of files) {
  const bytes = await readFile(file);
  inventory.push({
    path: path.relative(output, file).replaceAll('\\', '/'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  });
}
inventory.sort((left, right) => left.path.localeCompare(right.path));
await writeFile(path.join(output, 'FIXTURE_MANIFEST.json'), `${JSON.stringify({
  schemaVersion: 1,
  generator: 'test-harness/generate-fixtures.mjs',
  ffmpeg: String(version.stdout).split(/\r?\n/, 1)[0],
  provenance: 'Synthetic FFmpeg generators and original project test copy only.',
  files: inventory
}, null, 2)}\n`);

console.log(`Generated ${inventory.length} controlled fixture files with ${String(version.stdout).split(/\r?\n/, 1)[0]}.`);

function run(args, options = {}) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: options.cwd || root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`FFmpeg fixture generation failed with exit code ${result.status}.`);
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
