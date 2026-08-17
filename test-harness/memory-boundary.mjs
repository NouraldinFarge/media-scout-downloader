import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const resultRoot = path.join(root, 'test-results', 'performance');
await mkdir(resultRoot, { recursive: true });

const heapLimitMiB = 256;
const simulatedAggregateMiB = 64;
const partMiB = 8;
const before = process.memoryUsage();
const started = performance.now();
const parts = [];
for (let index = 0; index < simulatedAggregateMiB / partMiB; index += 1) {
  const part = new Uint8Array(partMiB * 1024 * 1024);
  part[0] = index;
  part[part.length - 1] = 255 - index;
  parts.push(part);
}
const afterParts = process.memoryUsage();
const blob = new Blob(parts, { type: 'video/mp2t' });
assert.equal(blob.size, simulatedAggregateMiB * 1024 * 1024);
const afterBlob = process.memoryUsage();
const elapsedMs = performance.now() - started;
const peakRssDeltaMiB = Math.max(afterParts.rss, afterBlob.rss) / (1024 ** 2) - before.rss / (1024 ** 2);
const budget = { elapsedMs: 1500, peakRssDeltaMiB: 200 };
const pass = elapsedMs <= budget.elapsedMs && peakRssDeltaMiB <= budget.peakRssDeltaMiB;

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  result: pass ? 'PASS' : 'FAIL',
  environment: {
    operatingSystem: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    constrainedV8HeapMiB: heapLimitMiB,
    totalMachineMemoryGiB: Math.round((os.totalmem() / (1024 ** 3)) * 100) / 100
  },
  method: 'Node Blob proxy under --max-old-space-size=256; this is not a claim of low-memory browser safety.',
  simulatedAggregateMiB,
  partMiB,
  measured: {
    elapsedMs: Math.round(elapsedMs * 1000) / 1000,
    peakRssDeltaMiB: Math.round(peakRssDeltaMiB * 1000) / 1000
  },
  budget,
  productBoundary: {
    perSegmentMiB: 24,
    aggregateMiB: 128,
    estimatedRejectMiB: 83.2,
    status: 'experimental'
  },
  limitation: 'The proxy checks bounded allocation behavior only. Browser HLS merge/remux remains experimental and makes no low-memory support claim.'
};
await writeFile(path.join(resultRoot, 'memory-boundary.json'), `${JSON.stringify(result, null, 2)}\n`);
if (!pass) throw new Error(`Constrained-memory proxy failed: ${JSON.stringify(result.measured)}`);
console.log(`Constrained-memory proxy PASS: ${simulatedAggregateMiB} MiB Blob assembly in ${result.measured.elapsedMs} ms, RSS delta ${result.measured.peakRssDeltaMiB} MiB.`);
