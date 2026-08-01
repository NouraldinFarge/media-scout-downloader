import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runSelfTests } from '../src/shared/self-tests.js';

const results = runSelfTests();
assert.equal(results.passed, true, JSON.stringify(results.results.filter((result) => !result.passed)));

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

assert.equal(manifest.version, packageJson.version, 'manifest and package versions must match');
assert.match(manifest.content_security_policy.extension_pages, /object-src 'none'/, 'extension pages must block object/embed content');
assert.equal(manifest.permissions.includes('cookies'), false, 'cookie access must not be requested');
assert.equal(manifest.permissions.includes('history'), false, 'history access must not be requested');
assert.equal(manifest.permissions.includes('webRequestBlocking'), false, 'request blocking must not be requested');
assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*'], 'website access must remain optional');

console.log(`Media Scout regression gate: ${results.results.length} suites passed.`);
