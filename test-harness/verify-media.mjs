import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const expected = new Map([
  ['docs/media/inspector-route.png', { width: 1280, height: 900 }],
  ['docs/media/report-route.png', { width: 1280, height: 900 }],
  ['docs/media/settings-overview.png', { width: 1280, height: 900 }],
  ['docs/media/github-social-preview.png', { width: 1280, height: 640 }]
]);

for (const [relative, dimensions] of expected) {
  const bytes = await readFile(path.join(root, relative));
  assert.deepEqual(pngDimensions(bytes, relative), dimensions, `${relative} dimensions drifted`);
  const chunkTypes = pngChunkTypes(bytes);
  for (const forbidden of ['eXIf', 'iTXt', 'tEXt', 'zTXt']) {
    assert.ok(!chunkTypes.includes(forbidden), `${relative} contains metadata chunk ${forbidden}`);
  }
}

const provenance = await readFile(path.join(root, 'docs', 'media', 'README.md'), 'utf8');
assert.match(provenance, /aeda9d2e703e5292939643255a8926244a1fa934/);
assert.match(provenance, /disposable Playwright Chromium profile/i);
assert.doesNotMatch(provenance, /private alpha/i);

const readme = await readFile(path.join(root, 'README.md'), 'utf8');
for (const relative of [...expected.keys()].filter((item) => !item.endsWith('github-social-preview.png'))) {
  assert.ok(readme.includes(relative), `README does not reference ${relative}`);
}
assert.match(provenance, /github-social-preview\.png/);
assert.match(readme, /Applies only to `validators\.js`, `report-privacy\.js`, `download-allow-list\.js`, and `report-manager\.js`/);

console.log(`Recruiter-media gate passed: ${expected.size} metadata-free PNG assets with verified dimensions and scoped evidence wording.`);

function pngDimensions(bytes, relative) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.subarray(0, 8).equals(signature), `${relative} is not a PNG`);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', `${relative} has no IHDR`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function pngChunkTypes(bytes) {
  const types = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    types.push(type);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return types;
}
