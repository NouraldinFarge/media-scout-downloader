import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.join(root, 'release', packageJson.version);

runReleaseBuild();
const first = await hashes();
runReleaseBuild();
const second = await hashes();

if (JSON.stringify(first) !== JSON.stringify(second)) {
  throw new Error(`Release outputs were not reproducible.\nFirst: ${JSON.stringify(first, null, 2)}\nSecond: ${JSON.stringify(second, null, 2)}`);
}
console.log(`Release reproducibility PASS: ${first.length} files matched byte-for-byte across consecutive clean builds.`);

function runReleaseBuild() {
  const result = spawnSync(process.execPath, ['test-harness/build-release.mjs'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Release build failed.');
}

async function hashes() {
  const entries = (await readdir(output, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const values = [];
  for (const entry of entries) {
    const bytes = await readFile(path.join(output, entry));
    values.push({ name: entry, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return values;
}
