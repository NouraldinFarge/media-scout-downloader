import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZipBlob } from '../src/shared/zip-utils.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const outputParent = path.join(root, 'release');
const output = path.join(outputParent, version);
const distRoot = path.join(root, 'dist', 'media-scout-downloader');

if (path.dirname(output) !== outputParent || path.basename(output) !== version) throw new Error('Refusing to replace an unexpected release output path.');
const status = run('git', ['status', '--porcelain'], { trim: false });
if (status.trim() && process.env.MEDIA_SCOUT_ALLOW_DIRTY !== '1') {
  throw new Error('Release artifacts require a clean tracked worktree. Commit reviewed source/evidence first.');
}

runNpm(['run', 'build']);
runNpm(['run', 'artifact:inspect']);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const commit = run('git', ['rev-parse', 'HEAD']);
const tree = run('git', ['rev-parse', 'HEAD^{tree}']);
const commitTimestamp = new Date(run('git', ['show', '-s', '--format=%cI', 'HEAD']));
const fixedZipTimestamp = new Date('1980-01-01T00:00:00.000Z');
const basename = `media-scout-downloader-${version}`;

const extensionZip = path.join(output, `${basename}-extension.zip`);
const extensionFiles = await filesAsZipEntries(distRoot);
await writeZip(extensionZip, extensionFiles, fixedZipTimestamp);
await verifyStoredZip(extensionZip, extensionFiles);

const sourceZip = path.join(output, `${basename}-source.zip`);
const trackedPaths = run('git', ['ls-files', '-z'], { trim: false }).split('\0').filter(Boolean).sort();
const sourceEntries = [];
for (const trackedPath of trackedPaths) {
  sourceEntries.push({ path: `${basename}-source/${trackedPath.replaceAll('\\', '/')}`, content: await readFile(path.join(root, trackedPath)) });
}
await writeZip(sourceZip, sourceEntries, fixedZipTimestamp);
await verifyStoredZip(sourceZip, sourceEntries);

const sampleZip = path.join(output, `${basename}-sample-redacted-report.zip`);
const sampleRoot = path.join(root, 'docs', 'evidence', 'samples', `redacted-report-${version}`);
const sampleEntries = await filesAsZipEntries(sampleRoot);
await writeZip(sampleZip, sampleEntries, fixedZipTimestamp);
await verifyStoredZip(sampleZip, sampleEntries);

const npmResult = spawnNpm(['sbom', '--sbom-format', 'spdx']);
if (npmResult.status !== 0) throw new Error(`npm SPDX SBOM generation failed: ${npmResult.stderr || npmResult.stdout}`);
const sbom = JSON.parse(npmResult.stdout);
sbom.documentNamespace = `https://github.com/NouraldinFarge/media-scout-downloader/sbom/${commit}`;
sbom.creationInfo.created = commitTimestamp.toISOString();
const sbomPath = path.join(output, `${basename}.spdx.json`);
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

const releaseDocs = [
  ['RELEASE_NOTES.md', path.join(root, 'docs', 'releases', version, 'RELEASE_NOTES.md')],
  ['KNOWN_LIMITATIONS.md', path.join(root, 'docs', 'releases', version, 'KNOWN_LIMITATIONS.md')],
  ['RELEASE_CHECKLIST.md', path.join(root, 'docs', 'releases', version, 'RELEASE_CHECKLIST.md')],
  ['TEST_EVIDENCE.md', path.join(root, 'docs', 'evidence', `P1_TEST_EVIDENCE_${version}.md`)]
];
for (const [name, source] of releaseDocs) await cp(source, path.join(output, name));

const artifactPaths = [extensionZip, sourceZip, sampleZip, sbomPath];
const artifacts = [];
for (const file of artifactPaths) artifacts.push(await describeFile(file));
const fixtureManifest = JSON.parse(await readFile(path.join(root, 'test-fixtures', 'site', 'generated', 'FIXTURE_MANIFEST.json'), 'utf8'));
const buildManifest = {
  schemaVersion: 1,
  product: 'Media Scout Downloader',
  version,
  source: {
    repository: 'https://github.com/NouraldinFarge/media-scout-downloader',
    commit,
    tree,
    commitTimestamp: commitTimestamp.toISOString(),
    trackedFileCount: trackedPaths.length
  },
  build: {
    deterministicZipTimestamp: fixedZipTimestamp.toISOString(),
    node: process.version,
    npm: runNpm(['--version']),
    git: run('git', ['--version']),
    developmentDependencies: packageJson.devDependencies,
    runtimeDependencyCount: Object.keys(packageJson.dependencies || {}).length,
    extensionFileCount: extensionEntriesCount(extensionFiles),
    extensionUncompressedBytes: extensionFiles.reduce((sum, entry) => sum + entry.content.byteLength, 0),
    fixtureGenerator: fixtureManifest.ffmpeg
  },
  artifacts
};
const buildManifestPath = path.join(output, 'BUILD_MANIFEST.json');
await writeFile(buildManifestPath, `${JSON.stringify(buildManifest, null, 2)}\n`);
const buildManifestDescription = await describeFile(buildManifestPath);

const provenancePath = path.join(output, 'PROVENANCE.intoto.jsonl');
const provenance = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: [{
    name: path.basename(extensionZip),
    digest: { sha256: artifacts.find((artifact) => artifact.name === path.basename(extensionZip)).sha256 }
  }],
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType: 'https://github.com/NouraldinFarge/media-scout-downloader/blob/main/test-harness/build-release.mjs',
      externalParameters: { version, commit },
      internalParameters: { deterministicZipTimestamp: fixedZipTimestamp.toISOString() },
      resolvedDependencies: [{ uri: 'git+https://github.com/NouraldinFarge/media-scout-downloader', digest: { gitCommit: commit } }]
    },
    runDetails: {
      builder: { id: 'local:media-scout-downloader/release-builder' },
      metadata: { invocationId: commit, startedOn: commitTimestamp.toISOString(), finishedOn: commitTimestamp.toISOString() },
      byproducts: [{ name: buildManifestDescription.name, digest: { sha256: buildManifestDescription.sha256 } }]
    }
  },
  mediaScoutDisclosure: {
    signed: false,
    note: 'Deterministic local provenance statement; this is not a cryptographic signature or Chrome Web Store attestation.'
  }
};
await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`);

const checksumFiles = (await readdir(output, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS')
  .map((entry) => path.join(output, entry.name))
  .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
const checksumLines = [];
for (const file of checksumFiles) checksumLines.push(`${(await describeFile(file)).sha256}  ${path.basename(file)}`);
await writeFile(path.join(output, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);

console.log(`Built deterministic ${version} release candidate for commit ${commit}: ${checksumFiles.length + 1} files in ${path.relative(root, output)}.`);

function run(command, args, { trim = true } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return trim ? String(result.stdout).trim() : String(result.stdout);
}

function spawnNpm(args) {
  if (process.env.npm_execpath) return spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, encoding: 'utf8' });
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
}

function runNpm(args) {
  const result = spawnNpm(args);
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return String(result.stdout).trim();
}

async function filesAsZipEntries(directory) {
  const files = await walk(directory);
  const entries = [];
  for (const file of files.sort()) entries.push({ path: path.relative(directory, file).replaceAll('\\', '/'), content: await readFile(file) });
  return entries;
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

async function writeZip(target, entries, modifiedAt) {
  const blob = createZipBlob(entries, { modifiedAt });
  await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
}

async function describeFile(file) {
  const bytes = await readFile(file);
  return { name: path.basename(file), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function extensionEntriesCount(entries) {
  return entries.length;
}

async function verifyStoredZip(file, expectedEntries) {
  const bytes = await readFile(file);
  const expected = new Map(expectedEntries.map((entry) => [entry.path, Buffer.from(entry.content)]));
  let offset = 0;
  let found = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const method = bytes.readUInt16LE(offset + 8);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (method !== 0) throw new Error(`${path.basename(file)} contains a non-stored ZIP entry: ${name}`);
    const expectedBytes = expected.get(name);
    if (!expectedBytes) throw new Error(`${path.basename(file)} contains an unexpected ZIP entry: ${name}`);
    if (!bytes.subarray(dataStart, dataStart + size).equals(expectedBytes)) throw new Error(`${path.basename(file)} entry bytes differ: ${name}`);
    expected.delete(name);
    found += 1;
    offset = dataStart + size;
  }
  if (expected.size || found !== expectedEntries.length) throw new Error(`${path.basename(file)} is missing expected entries: ${Array.from(expected.keys()).join(', ')}`);
}
