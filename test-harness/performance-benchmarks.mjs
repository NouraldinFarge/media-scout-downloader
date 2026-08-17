import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseHlsInspection } from '../src/background/media-detector.js';
import { QueueManager } from '../src/background/queue-manager.js';
import { ReportManager } from '../src/background/report-manager.js';
import { MAX_MEDIA_ITEMS_PER_TAB, TabMediaStore } from '../src/background/tab-media-store.js';
import { DOWNLOAD_STATUSES, MEDIA_TYPES } from '../src/shared/constants.js';
import { groupCandidates } from '../src/shared/frontend-model.js';
import { createZipBlob } from '../src/shared/zip-utils.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const resultRoot = path.join(root, 'test-results', 'performance');
const budgetMultiplier = performanceBudgetMultiplier(process.env.MEDIA_SCOUT_PERF_BUDGET_MULTIPLIER);
await mkdir(resultRoot, { recursive: true });
installChromeStub();

const candidates = makeCandidates(MAX_MEDIA_ITEMS_PER_TAB);
const hlsMaster = ['#EXTM3U', ...Array.from({ length: 1000 }, (_value, index) => [
  `#EXT-X-STREAM-INF:BANDWIDTH=${200000 + index},RESOLUTION=320x180,CODECS="avc1.42001e,mp4a.40.2"`,
  `variant-${index}.m3u8`
]).flat()].join('\n');
const hlsSegments = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', ...Array.from({ length: 6001 }, (_value, index) => `#EXTINF:1.0,\nsegment-${index}.ts`), '#EXT-X-ENDLIST'].join('\n');

const benchmarks = [];
benchmarks.push(await measure('large HLS master parsing (1,000 variants)', 25, () => {
  const result = parseHlsInspection(hlsMaster, 'https://fixture.invalid/master.m3u8');
  assert.equal(result.playlist.variantCount, 1000);
  assert.equal(result.variants.length, 200);
}, { medianMs: 40, p95Ms: 80 }));

benchmarks.push(await measure('HLS segment boundary parsing (6,001 segments)', 25, () => {
  const result = parseHlsInspection(hlsSegments, 'https://fixture.invalid/media.m3u8');
  assert.equal(result.playlist.segmentCount, 6001);
  assert.equal(result.segmentUris.length, 6000);
}, { medianMs: 60, p95Ms: 120 }));

benchmarks.push(await measure('750-candidate bounded store', 20, () => {
  const store = new TabMediaStore();
  store.addMany(7, candidates);
  assert.equal(store.getTabState(7).mediaItems.length, 750);
}, { medianMs: 120, p95Ms: 240 }));

benchmarks.push(await measure('750-candidate grouping and classification', 30, () => {
  const groups = groupCandidates(candidates, { enabledFileTypes: { mp4: true } });
  assert.equal(groups.reduce((sum, group) => sum + group.items.length, 0), 750);
}, { medianMs: 90, p95Ms: 180 }));

benchmarks.push(await measure('large redacted report generation and preview digest', 12, async () => {
  const manager = reportManager();
  const report = await manager.buildActiveTabReport({
    tab: { id: 7, title: 'Controlled performance fixture', url: 'https://fixture.invalid/watch?token=redact-me' },
    tabRevision: 4,
    siteAccess: { granted: false, origin: 'https://fixture.invalid/*' },
    tabState: { mediaItems: candidates, queue: {} },
    detailedScan: {
      generatedAt: '2026-08-17T12:00:00.000Z',
      decisions: candidates.slice(0, 360).map((item) => ({ normalizedUrl: item.url, acceptedByBasicScanner: true, reasons: [] })),
      mediaElements: candidates.slice(0, 120),
      performance: { mediaLikeEntries: candidates.slice(0, 120), interestingEntries: [] }
    },
    scannerError: '',
    selfTests: { passed: true },
    includeSensitiveUrls: false
  });
  assert.equal(report.files.length, 9);
  assert.equal(report.summary.redacted, true);
  assert.equal(report.files.some((file) => file.content.includes('redact-me')), false);
}, { medianMs: 650, p95Ms: 900 }));

benchmarks.push(await measure('queue restart hydration (bounded retained history)', 40, () => {
  const queue = new QueueManager({ worker: async () => ({ status: DOWNLOAD_STATUSES.COMPLETED }) });
  queue._persistState = () => {};
  const restored = queue.restoreInterruptedHistory(makeQueueHistory());
  assert.equal(restored, true);
  assert.equal(queue.getState().canceled.length, 20);
}, { medianMs: 8, p95Ms: 20 }));

const reportPayloads = Array.from({ length: 9 }, (_value, index) => ({
  path: `report/file-${index}.json`,
  content: JSON.stringify({ index, controlled: 'x'.repeat(220000) })
}));
benchmarks.push(await measure('large report ZIP assembly (approximately 1.9 MiB)', 20, async () => {
  const blob = createZipBlob(reportPayloads);
  assert.ok(blob.size > 1_900_000);
  await blob.arrayBuffer();
}, { medianMs: 90, p95Ms: 180 }));

const failed = benchmarks.filter((entry) => !entry.pass);
const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    operatingSystem: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    cpu: os.cpus()[0]?.model || 'unknown',
    logicalCores: os.cpus().length,
    totalMemoryGiB: round(os.totalmem() / (1024 ** 3), 2)
  },
  timingMethod: 'performance.now; warm-up excluded; isolated local process',
  budgetMultiplier,
  benchmarks,
  result: failed.length ? 'FAIL' : 'PASS'
};
await writeFile(path.join(resultRoot, 'node-benchmark.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(`Performance gate ${failed.length ? 'FAIL' : 'PASS'}: ${benchmarks.length} repeatable Node benchmarks used a ${budgetMultiplier}x timing-budget multiplier.`);
for (const entry of benchmarks) {
  console.log(`- ${entry.pass ? 'PASS' : 'FAIL'} ${entry.name}: median ${entry.medianMs} ms / ${entry.budgetMedianMs} ms, p95 ${entry.p95Ms} ms / ${entry.budgetP95Ms} ms (${entry.runs} runs)`);
}
if (failed.length) throw new Error(`Performance budgets failed: ${failed.map((entry) => entry.name).join(', ')}`);

async function measure(name, runs, operation, budget) {
  for (let index = 0; index < 3; index += 1) await operation();
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    await operation();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const medianMs = round(percentile(samples, 0.5), 3);
  const p95Ms = round(percentile(samples, 0.95), 3);
  const budgetMedianMs = round(budget.medianMs * budgetMultiplier, 3);
  const budgetP95Ms = round(budget.p95Ms * budgetMultiplier, 3);
  return {
    name,
    runs,
    medianMs,
    p95Ms,
    baseBudgetMedianMs: budget.medianMs,
    baseBudgetP95Ms: budget.p95Ms,
    budgetMultiplier,
    budgetMedianMs,
    budgetP95Ms,
    pass: medianMs <= budgetMedianMs && p95Ms <= budgetP95Ms
  };
}

function performanceBudgetMultiplier(rawValue) {
  if (rawValue == null || rawValue === '') return 1;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 1 || value > 3) {
    throw new Error('MEDIA_SCOUT_PERF_BUDGET_MULTIPLIER must be a number from 1 through 3.');
  }
  return value;
}

function percentile(values, ratio) {
  return values[Math.max(0, Math.ceil(values.length * ratio) - 1)] || 0;
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function makeCandidates(count) {
  return Array.from({ length: count }, (_value, index) => ({
    id: `candidate-${index}`,
    tabId: 7,
    url: `https://media.fixture.invalid/video-${index}.mp4?fixture=${index}`,
    normalizedUrl: `https://media.fixture.invalid/video-${index}.mp4?fixture=${index}`,
    hostname: 'media.fixture.invalid',
    filename: `controlled-video-${index}.mp4`,
    mediaType: MEDIA_TYPES.VIDEO,
    extension: 'mp4',
    mime: 'video/mp4',
    contentType: 'video/mp4',
    status: DOWNLOAD_STATUSES.DETECTED,
    isProtected: false,
    stale: false,
    detectedAt: '2026-08-17T12:00:00.000Z',
    detectionMethods: ['controlled-performance-fixture']
  }));
}

function reportManager() {
  return new ReportManager({
    getSettings: async () => ({
      includeSensitiveUrlsInReports: false,
      queueHistoryRetentionDays: 0,
      filenameTemplate: '{tabTitle}{indexSuffix}.{extension}',
      preferredSubfolder: 'Media Scout Downloader'
    }),
    diagnostics: { snapshot: () => ({ errors: {}, strategies: {} }) },
    downloadManager: { getState: () => ({ pending: [], active: [], completed: [], failed: [], canceled: [] }) },
    getCurrentTime: () => '2026-08-17T12:00:00.000Z'
  });
}

function makeQueueHistory() {
  const tasks = (prefix, count, status) => Array.from({ length: count }, (_value, index) => ({
    id: `${prefix}-${index}`,
    mediaId: `${prefix}-media-${index}`,
    tabId: 7,
    filename: `${prefix}-${index}.mp4`,
    status,
    progress: { loaded: index, total: count, percent: Math.round((index / count) * 100) },
    createdAt: '2026-08-17T12:00:00.000Z'
  }));
  return {
    paused: false,
    active: tasks('active', 10, DOWNLOAD_STATUSES.ACTIVE),
    pending: tasks('pending', 10, DOWNLOAD_STATUSES.QUEUED),
    completed: tasks('completed', 20, DOWNLOAD_STATUSES.COMPLETED),
    failed: tasks('failed', 20, DOWNLOAD_STATUSES.FAILED),
    canceled: tasks('canceled', 20, DOWNLOAD_STATUSES.CANCELED)
  };
}

function installChromeStub() {
  globalThis.chrome = {
    action: null,
    runtime: { getManifest: () => ({ version: '3.7.13', manifest_version: 3, permissions: [], optional_host_permissions: [] }), lastError: null },
    storage: {
      local: {
        get(_keys, callback) { callback?.({}); },
        set(_value, callback) { callback?.(); },
        remove(_keys, callback) { callback?.(); }
      }
    }
  };
}
