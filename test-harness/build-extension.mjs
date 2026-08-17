import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = path.join(root, 'dist');
const output = path.join(distRoot, 'media-scout-downloader');

if (path.dirname(output) !== distRoot || path.basename(output) !== 'media-scout-downloader') {
  throw new Error('Refusing to clean an unexpected build path.');
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, 'manifest.json'), path.join(output, 'manifest.json'));
await cp(path.join(root, 'src'), path.join(output, 'src'), { recursive: true });
await cp(path.join(root, 'assets'), path.join(output, 'assets'), { recursive: true });

const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
const files = await walk(output);
if (files.some((file) => file.endsWith('.map'))) throw new Error('Source maps must not be shipped in the extension staging directory.');
if (!files.some((file) => file.endsWith(path.join('assets', 'icons', 'icon128.png')))) throw new Error('Required extension icons were not staged.');

let bytes = 0;
for (const file of files) bytes += (await stat(file)).size;
console.log(`Built Media Scout ${manifest.version}: ${files.length} files, ${bytes} bytes.`);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}
