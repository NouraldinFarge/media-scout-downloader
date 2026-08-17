import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = path.join(root, 'dist', 'media-scout-downloader');
const failures = [];

const packageJson = await readJson(path.join(root, 'package.json'));
const packageLock = await readJson(path.join(root, 'package-lock.json'));
const sourceManifestBytes = await readFile(path.join(root, 'manifest.json'));
const sourceManifest = JSON.parse(sourceManifestBytes);
const stagedManifestBytes = await readFile(path.join(distRoot, 'manifest.json'));

if (createHash('sha256').update(sourceManifestBytes).digest('hex') !== createHash('sha256').update(stagedManifestBytes).digest('hex')) {
  failures.push('staged manifest is not byte-identical to the source manifest');
}
if (packageJson.version !== sourceManifest.version || packageLock.version !== sourceManifest.version || packageLock.packages?.['']?.version !== sourceManifest.version) {
  failures.push('manifest, package, and lockfile versions must match');
}
if (Object.keys(packageJson.dependencies || {}).length) failures.push('the shipped project must keep zero runtime dependencies');

const stagedFiles = await walk(distRoot);
const relativeStagedFiles = stagedFiles.map((file) => path.relative(distRoot, file).replaceAll('\\', '/')).sort();
for (const file of relativeStagedFiles) {
  if (!/^(?:manifest\.json|assets\/icons\/icon(?:16|32|48|128)\.png|src\/(?:background|content|options|popup|shared|sidepanel)\/[a-z0-9_./-]+\.(?:css|html|js))$/i.test(file)) {
    failures.push(`unexpected packaged file: ${file}`);
  }
  if (/\.(?:map|md|log|zip)$/i.test(file)) failures.push(`forbidden packaged file type: ${file}`);
}

for (const required of [
  'LICENSE.md',
  'PROVENANCE.md',
  'PRIVACY.md',
  'SECURITY.md',
  'TESTING.md',
  'TEST_PLAN.md',
  'DOWNLOAD_ALLOW_LIST.md',
  'docs/THREAT_MODEL.md',
  'docs/evidence/EVIDENCE_LEDGER.md',
  'docs/evidence/OWNER_ATTESTATION.md'
]) {
  try {
    await access(path.join(root, required));
  } catch (_error) {
    failures.push(`required release-readiness document is missing: ${required}`);
  }
}

const license = await readFile(path.join(root, 'LICENSE.md'), 'utf8');
if (!/^#? ?MIT License\n\nCopyright \(c\) 2026 Nouraldin Farge/m.test(license) || !/Permission is hereby granted, free of charge/.test(license)) {
  failures.push('LICENSE.md is not the approved MIT license text for the confirmed author');
}
const provenance = await readFile(path.join(root, 'PROVENANCE.md'), 'utf8');
if (!/Nouraldin Farge/.test(provenance) || !/AI/i.test(provenance) || !/fixture/i.test(provenance)) {
  failures.push('PROVENANCE.md must identify human ownership, AI assistance, and fixture provenance');
}

const sourceFiles = (await walk(root)).filter((file) => !isIgnored(file));
for (const file of sourceFiles.filter((item) => /\.(?:css|html|js|json|md|mjs|txt|ya?ml)$/i.test(item))) {
  const text = await readFile(file, 'utf8');
  const relative = path.relative(root, file).replaceAll('\\', '/');
  if (!/^(?:test-fixtures|test-harness)\//.test(relative) && /(?:[A-Za-z]:\\Users\\|[A-Za-z]:\\Extensions_Programs\\|\/Users\/[^/]+\/|\/home\/[^/]+\/)/.test(text)) {
    failures.push(`${relative}: public source contains a machine-specific absolute path`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) failures.push(`${relative}: private-key marker found`);
}

for (const file of sourceFiles.filter((item) => item.endsWith('.md'))) {
  const text = await readFile(file, 'utf8');
  const relative = path.relative(root, file).replaceAll('\\', '/');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/)[0];
    if (!rawTarget || /^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
    const withoutFragment = rawTarget.split('#')[0].split('?')[0];
    if (!withoutFragment) continue;
    const decoded = decodeURIComponent(withoutFragment);
    try {
      await access(path.resolve(path.dirname(file), decoded));
    } catch (_error) {
      failures.push(`${relative}: broken local Markdown link ${rawTarget}`);
    }
  }
}

const fixtureManifestPath = path.join(root, 'test-fixtures', 'site', 'generated', 'FIXTURE_MANIFEST.json');
const fixtureManifest = await readJson(fixtureManifestPath);
for (const entry of fixtureManifest.files || []) {
  const target = path.resolve(path.dirname(fixtureManifestPath), entry.path);
  if (!target.startsWith(`${path.dirname(fixtureManifestPath)}${path.sep}`)) {
    failures.push(`fixture manifest path escapes generated root: ${entry.path}`);
    continue;
  }
  try {
    const bytes = await readFile(target);
    if (bytes.length !== entry.bytes) failures.push(`fixture byte count mismatch: ${entry.path}`);
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) failures.push(`fixture hash mismatch: ${entry.path}`);
  } catch (_error) {
    failures.push(`fixture manifest file is missing: ${entry.path}`);
  }
}

if (failures.length) throw new Error(`Repository/artifact verification failed:\n- ${failures.join('\n- ')}`);
console.log(`Repository/artifact gate passed: ${relativeStagedFiles.length} allowlisted extension files; local links, license, provenance, paths, and fixture hashes verified.`);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'coverage', 'dist', 'node_modules', 'release', 'test-results'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function isIgnored(file) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  return /^(?:\.git|coverage|dist|node_modules|release|test-results)\//.test(relative);
}
