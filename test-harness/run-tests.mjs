import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runSelfTests } from '../src/shared/self-tests.js';
import { createZipBlob } from '../src/shared/zip-utils.js';
import { redactReportValue } from '../src/background/report-manager.js';
import { QueueManager } from '../src/background/queue-manager.js';
import { MAX_MEDIA_ITEMS_PER_TAB, TabMediaStore } from '../src/background/tab-media-store.js';
import { classifyChromeDownloadError, downloadWithAllowedStrategies } from '../src/background/download-strategies.js';
import { DownloadManager } from '../src/background/download-manager.js';
import { MediaDetector, parseHlsInspection } from '../src/background/media-detector.js';
import { DiagnosticsManager } from '../src/background/diagnostics-manager.js';
import { DOWNLOAD_STATUSES, ERROR_CATEGORIES, MEDIA_TYPES, MESSAGE_TYPES, STORAGE_KEYS } from '../src/shared/constants.js';
import { buildExtensionState, summarizeUrl } from '../src/shared/report-utils.js';
import { validateMediaUrl, validateMessage } from '../src/shared/validators.js';

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

const reportZip = createZipBlob([
  { path: '../report.txt', content: 'local report' },
  { path: 'details/settings.json', content: '{}' }
]);
const zipBytes = new Uint8Array(await reportZip.arrayBuffer());
assert.deepEqual([...zipBytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'report ZIP must start with a local-file signature');
const zipText = new TextDecoder().decode(zipBytes);
assert.equal(zipText.includes('../report.txt'), false, 'report ZIP paths must not retain traversal segments');
assert.equal(zipText.includes('report.txt'), true, 'report ZIP retains the safe report filename');

const redactedReport = JSON.stringify(redactReportValue({
  referrer: 'https://example.com/private/watch?token=secret-value',
  poster: 'https://cdn.example.com/poster.jpg?signature=private-signature',
  url: '/private/relative/path?token=relative-secret',
  message: 'Fetch failed for https://media.example.com/video.mp4?auth=private-auth',
  blobMessage: 'Page-local source blob:https://example.com/private-blob-identifier could not be read.',
  relativeMessage: 'Fetch failed for /private/path?token=relative-message-secret',
  relativeGenericMessage: 'Fetch failed for /private/path?account_email=user@example.com',
  authorization: 'Bearer private-credential',
  accessToken: 'camel-case-secret'
}));
assert.equal(redactedReport.includes('secret-value'), false, 'report redaction removes referrer query values');
assert.equal(redactedReport.includes('private-signature'), false, 'report redaction removes poster query values');
assert.equal(redactedReport.includes('relative-secret'), false, 'report redaction removes malformed or relative URL values');
assert.equal(redactedReport.includes('private-auth'), false, 'report redaction removes URLs embedded in diagnostic text');
assert.equal(redactedReport.includes('private-blob-identifier'), false, 'report redaction removes blob URLs embedded in diagnostic text');
assert.equal(redactedReport.includes('relative-message-secret'), false, 'report redaction removes secret query values from relative URLs in diagnostic text');
assert.equal(redactedReport.includes('account_email'), false, 'report redaction removes arbitrary query names from relative URLs in diagnostic text');
assert.equal(redactedReport.includes('user@example.com'), false, 'report redaction removes arbitrary query values from relative URLs in diagnostic text');
assert.equal(redactedReport.includes('private-credential'), false, 'report redaction removes secret-shaped fields');
assert.equal(redactedReport.includes('camel-case-secret'), false, 'report redaction removes camel-case secret fields');
const summarizedUrl = summarizeUrl('https://example.com/private/path?account_email=user%40example.com&token=secret');
assert.equal(summarizedUrl.queryParameterCount, 2, 'redacted URL summaries retain only the number of query parameters');
assert.equal(JSON.stringify(summarizedUrl).includes('account_email'), false, 'redacted URL summaries do not retain query-parameter names');
assert.equal(buildExtensionState({}).schemaVersion, 6, 'report schema advances when the redacted URL-summary shape changes');

assert.equal(validateMessage({ type: MESSAGE_TYPES.DOWNLOAD_PROGRESS, taskId: 'task-1', percent: 12, loaded: -1, total: 5 }), false, 'progress messages reject negative counters');
assert.equal(validateMessage({ type: MESSAGE_TYPES.DOM_MEDIA_FOUND, items: [{ url: 'https://example.com/video.mp4', transferSize: -1 }] }), false, 'scan messages reject negative resource metrics');
assert.equal(validateMediaUrl(`https://example.com/${'a'.repeat(4096)}.mp4`)?.code, 'invalid-url', 'oversized media URLs are rejected before entering retained state');
assert.equal(classifyChromeDownloadError('USER_CANCELED'), ERROR_CATEGORIES.USER_CANCELED, 'Chrome user cancellations are not retried as network errors');
assert.equal(classifyChromeDownloadError('NETWORK_FAILED'), ERROR_CATEGORIES.NETWORK, 'Chrome network interruptions remain retryable network errors');

installChromeStorageStub();
await testMalformedDiagnosticsAreHarmless();
await testQueueHistoryClearWinsPendingWrite();
await testActiveCancellationWinsWorkerRace();
await testSettledQueueRetention();
await testDuplicateEnqueueDoesNotConsumeFilenameIndex();
await testStaleInFlightScanIsDiscarded();
testProtectionEvidenceIsMonotonic();
testPerTabMediaRetentionIsBounded();
testManifestStructuresAreBounded();
await testMissingChromeDownloadIdDoesNotRetry();

const popupSource = await readFile(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
assert.equal(popupSource.includes('sourceUrl:'), false, 'one-shot side-panel route intent must not retain page URLs');
assert.equal(popupSource.includes('sourceTitle:'), false, 'one-shot side-panel route intent must not retain page titles');
assert.equal(popupSource.includes('message.navigationReset || message.cacheCleared'), true, 'popup live state clears candidates after navigation or cache reset');
assert.equal(popupSource.includes('message.replaceMediaItems'), true, 'popup accepts bounded full-state replacement broadcasts');
const sidepanelSource = await readFile(new URL('../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
assert.equal(sidepanelSource.includes('message.navigationReset || message.cacheCleared'), true, 'side-panel live state clears candidates after navigation or cache reset');
assert.equal(sidepanelSource.includes('message.replaceMediaItems'), true, 'side panel accepts bounded full-state replacement broadcasts');
const contentSource = await readFile(new URL('../src/content/content.js', import.meta.url), 'utf8');
assert.equal(contentSource.includes('queryParameterNames'), false, 'runtime HLS errors do not retain sensitive query-parameter names');
const serviceWorkerSource = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
assert.equal(serviceWorkerSource.includes('The source tab was closed. Media Scout cleared its stale detections'), true, 'closing a monitored source tab broadcasts an authoritative UI reset');
const pageScannerSource = await readFile(new URL('../src/content/page-media-scanner.js', import.meta.url), 'utf8');
assert.equal(pageScannerSource.includes('querySelectorAll'), false, 'page scanning uses visit-bounded traversal instead of materializing unbounded DOM snapshots');
assert.equal(serviceWorkerSource.includes('querySelectorAll'), false, 'injected fallback and episode scans use visit-bounded DOM traversal');

console.log(`Media Scout regression gate: ${results.results.length} self-test suites and repository assertions passed.`);

async function testMalformedDiagnosticsAreHarmless() {
  const diagnostics = new DiagnosticsManager();
  diagnostics.state = {
    strategies: JSON.parse('{"__proto__":{"success":999},"constructor":{"failure":999}}'),
    errors: JSON.parse('{"__proto__":999,"constructor":999}'),
    updatedAt: { invalid: true }
  };
  await diagnostics.recordStrategySuccess('direct-file');
  await diagnostics.recordStrategyFailure('direct-file', ERROR_CATEGORIES.NETWORK);
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.strategies['direct-file'].success, 1, 'corrupt diagnostics state is normalized before recording success');
  assert.equal(snapshot.strategies['direct-file'].failure, 1, 'diagnostic failure recording remains available after normalization');
  assert.equal(snapshot.errors.network, 1, 'diagnostic error counters are rebuilt safely');
  assert.equal(Object.hasOwn(snapshot.strategies, '__proto__'), false, 'corrupt diagnostic prototype keys are discarded');
  assert.equal(Object.hasOwn(snapshot.strategies, 'constructor'), false, 'corrupt diagnostic constructor keys are discarded');
  assert.equal(Object.prototype.success, undefined, 'diagnostic normalization cannot mutate shared object prototypes');
}

async function testQueueHistoryClearWinsPendingWrite() {
  const storage = {};
  installChromeStorageStub(storage);
  const queue = new QueueManager({ worker: async () => ({ status: DOWNLOAD_STATUSES.COMPLETED }), maxParallel: 1 });
  queue.hasEverHadTask = true;
  queue._persistState({
    maxParallel: 1,
    activeCount: 0,
    paused: false,
    pending: [],
    active: [],
    completed: [],
    failed: [],
    canceled: []
  }, true);
  await queue.clearPersistedHistory();
  assert.equal(Object.hasOwn(storage, STORAGE_KEYS.QUEUE_SUMMARY), false, 'explicit history clearing runs after an already-scheduled queue summary write');
  assert.equal(Object.hasOwn(storage, STORAGE_KEYS.QUEUE_HISTORY), false, 'explicit history clearing runs after an already-scheduled queue history write');
}

async function testActiveCancellationWinsWorkerRace() {
  let releaseWorker;
  const queue = testQueue(() => new Promise((resolve) => { releaseWorker = resolve; }));
  queue.enqueue(testTask('cancel-race'));
  await waitUntil(() => queue.getState().active.length === 1);
  assert.equal(queue.cancel('cancel-race'), true, 'active task can be canceled');
  assert.equal(queue.updateProgress('cancel-race', { phase: 'remuxing', percent: 99 }), false, 'late progress cannot revive a canceled task');
  releaseWorker({ status: DOWNLOAD_STATUSES.COMPLETED });
  await waitUntil(() => queue.getState().active.length === 0);
  const state = queue.getState();
  assert.equal(state.completed.length, 0, 'a canceled task cannot become completed when its worker resolves');
  assert.equal(state.canceled.length, 1, 'the canceled task settles in the canceled bucket');
}

async function testSettledQueueRetention() {
  const queue = testQueue(async () => ({ status: DOWNLOAD_STATUSES.COMPLETED }), 6);
  for (let index = 0; index < 25; index += 1) queue.enqueue(testTask(`retention-${index}`));
  await waitUntil(() => {
    const state = queue.getState();
    return state.active.length === 0 && state.pending.length === 0;
  });
  assert.equal(queue.completed.length, 20, 'in-memory completed history stays bounded');
  assert.equal(queue.taskIndex.size, 20, 'evicted settled tasks are removed from the task index');
}

async function testDuplicateEnqueueDoesNotConsumeFilenameIndex() {
  installChromeStorageStub();
  const store = new TabMediaStore();
  const tab = { id: 11, title: 'Example video', url: 'https://example.com/watch' };
  const media = {
    id: 'media-11-video-direct',
    tabId: tab.id,
    normalizedUrl: 'https://example.com/video.mp4',
    url: 'https://example.com/video.mp4',
    hostname: 'example.com',
    mediaType: MEDIA_TYPES.VIDEO,
    extension: 'mp4',
    isProtected: false,
    status: DOWNLOAD_STATUSES.DETECTED,
    detectionMethods: ['test']
  };
  store.setTabInfo(tab);
  store.addMedia(tab.id, media);
  const manager = new DownloadManager({ tabMediaStore: store, diagnostics: {}, broadcast: () => {} });
  manager.queue._persistState = () => {};
  manager.queue.setPaused(true);
  const first = await manager.enqueue({ tabId: tab.id, mediaId: media.id, tab });
  const duplicate = await manager.enqueue({ tabId: tab.id, mediaId: media.id, tab });
  assert.equal(duplicate.duplicateOf, first.id, 'repeat enqueue returns the existing runnable task');
  assert.equal(manager.downloadCountsByTab.get(tab.id), 1, 'repeat enqueue does not advance filename numbering');
}

async function testStaleInFlightScanIsDiscarded() {
  const store = new TabMediaStore();
  const tab = { id: 12, title: 'Old page', url: 'https://example.com/old' };
  let releaseBuild;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const detector = new MediaDetector({ tabMediaStore: store, diagnostics: {}, getSettings: async () => ({}) });
  detector._buildMediaItem = async () => {
    markStarted();
    return new Promise((resolve) => { releaseBuild = resolve; });
  };
  const pendingScan = detector.ingestDomScan(tab, [{ url: 'https://example.com/old/video.mp4', source: 'dom-video' }]);
  await started;
  store.clearTab(tab.id);
  releaseBuild({
    id: 'media-stale',
    normalizedUrl: 'https://example.com/old/video.mp4',
    url: 'https://example.com/old/video.mp4',
    mediaType: MEDIA_TYPES.VIDEO,
    extension: 'mp4'
  });
  assert.deepEqual(await pendingScan, [], 'scan results that finish after a navigation revision are discarded');
  assert.equal(store.getTabState(tab.id).mediaItems.length, 0, 'stale scan results do not repopulate the cleared tab');
}

function testProtectionEvidenceIsMonotonic() {
  const store = new TabMediaStore();
  const tabId = 7;
  const id = 'media-7-hls-protected';
  const url = 'https://example.com/video/index.m3u8';
  store.setTabInfo({ id: tabId, title: 'Example', url: 'https://example.com/watch' });
  store.addMedia(tabId, {
    id,
    normalizedUrl: url,
    url,
    mediaType: MEDIA_TYPES.HLS,
    extension: 'm3u8',
    isProtected: true,
    status: DOWNLOAD_STATUSES.ENCRYPTED,
    unsupportedReason: 'Encrypted HLS playlist detected.',
    detectionMethods: ['detailed-probe']
  });
  store.addMedia(tabId, {
    id,
    normalizedUrl: url,
    url,
    mediaType: MEDIA_TYPES.HLS,
    extension: 'm3u8',
    isProtected: false,
    status: DOWNLOAD_STATUSES.DETECTED,
    unsupportedReason: '',
    detectionMethods: ['repeat-scan']
  });
  const item = store.getMedia(tabId, id);
  assert.equal(item.isProtected, true, 'weaker repeat evidence cannot clear a protected finding');
  assert.equal(item.status, DOWNLOAD_STATUSES.ENCRYPTED, 'encrypted status survives weaker repeat evidence');
  const revision = store.getTabRevision(tabId);
  store.clearTab(tabId);
  assert.equal(store.isTabRevisionCurrent(tabId, revision), false, 'clearing a tab invalidates in-flight scan revisions');
}

function testPerTabMediaRetentionIsBounded() {
  const store = new TabMediaStore();
  const tabId = 19;
  store.setTabInfo({ id: tabId, title: 'Large page', url: 'https://example.com/watch' });
  const images = Array.from({ length: MAX_MEDIA_ITEMS_PER_TAB + 5 }, (_, index) => ({
    id: `media-image-${index}`,
    normalizedUrl: `https://example.com/image-${index}.jpg`,
    url: `https://example.com/image-${index}.jpg`,
    mediaType: MEDIA_TYPES.IMAGE,
    extension: 'jpg',
    isProtected: false,
    status: DOWNLOAD_STATUSES.DETECTED
  }));
  const retainedImages = store.addMany(tabId, images);
  const manifest = {
    id: 'media-important-hls',
    normalizedUrl: 'https://example.com/index.m3u8',
    url: 'https://example.com/index.m3u8',
    mediaType: MEDIA_TYPES.HLS,
    extension: 'm3u8',
    isProtected: false,
    status: DOWNLOAD_STATUSES.DETECTED
  };
  store.addMedia(tabId, manifest, { updateBadge: false });
  const state = store.getTabState(tabId);
  assert.equal(retainedImages.length, MAX_MEDIA_ITEMS_PER_TAB, 'batched scan results exclude candidates evicted during bounded retention');
  assert.equal(state.mediaItems.length, MAX_MEDIA_ITEMS_PER_TAB, 'per-tab detected-media retention stays bounded');
  assert.equal(state.mediaItems.some((item) => item.id === manifest.id), true, 'high-value manifests displace lower-priority artwork at the retention bound');
}

function testManifestStructuresAreBounded() {
  const variantText = ['#EXTM3U', ...Array.from({ length: 205 }, (_, index) => `#EXT-X-STREAM-INF:BANDWIDTH=${index + 1}\nvariant-${index}.m3u8`)].join('\n');
  const variantInfo = parseHlsInspection(variantText, 'https://example.com/master.m3u8');
  assert.equal(variantInfo.variants.length, 200, 'manifest variant detail retention is bounded');
  assert.equal(variantInfo.playlist.tooManyVariants, true, 'oversized variant structures are marked unsupported');

  const segmentText = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', ...Array.from({ length: 6001 }, (_, index) => `segment-${index}.ts`), '#EXT-X-ENDLIST'].join('\n');
  const segmentInfo = parseHlsInspection(segmentText, 'https://example.com/index.m3u8');
  assert.equal(segmentInfo.segmentUris.length, 6000, 'manifest segment URL retention is bounded');
  assert.equal(segmentInfo.playlist.segmentCount, 6001, 'bounded parsing preserves the exact segment count');
  assert.equal(segmentInfo.playlist.tooManySegments, true, 'oversized segment structures are marked unsupported');
}

async function testMissingChromeDownloadIdDoesNotRetry() {
  installChromeDownloadInvalidIdStub();
  const task = {
    id: 'task-invalid-download-id',
    filename: 'video.mp4',
    media: {
      id: 'media-invalid-download-id',
      url: 'https://example.com/video.mp4',
      normalizedUrl: 'https://example.com/video.mp4',
      mediaType: MEDIA_TYPES.VIDEO,
      extension: 'mp4',
      isProtected: false
    }
  };
  await assert.rejects(
    downloadWithAllowedStrategies(task, {
      settings: { duplicateBehavior: 'auto-number', enabledFileTypes: { mp4: true } },
      diagnostics: { prioritize: (names) => names, recordStrategySuccess: async () => {}, recordStrategyFailure: async () => {} },
      onProgress: () => {},
      onDownloadStarted: () => {},
      isCanceled: () => false,
      messageTypes: MESSAGE_TYPES
    }),
    (error) => error?.code === 'chrome-download-id-missing' && error?.category === ERROR_CATEGORIES.UNSUPPORTED,
    'a malformed Chrome download response fails without an automatic duplicate retry'
  );
  installChromeStorageStub();
}

function testQueue(worker, maxParallel = 1) {
  const queue = new QueueManager({ worker, maxParallel });
  queue._persistState = () => {};
  return queue;
}

function testTask(id) {
  return {
    id,
    mediaId: `media-${id}`,
    tabId: 1,
    filename: `${id}.mp4`,
    media: { url: `https://example.com/${id}.mp4`, mediaType: MEDIA_TYPES.VIDEO, extension: 'mp4' },
    attempts: 0,
    maxRetries: 0
  };
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for asynchronous queue state.');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function installChromeStorageStub(storage = {}) {
  globalThis.chrome = {
    action: null,
    runtime: { lastError: null },
    storage: {
      local: {
        get(keys, callback) {
          const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
          callback(Object.fromEntries(names.filter((key) => Object.hasOwn(storage, key)).map((key) => [key, storage[key]])));
        },
        set(value, callback) {
          Object.assign(storage, value || {});
          callback?.();
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          callback?.();
        }
      }
    }
  };
  return storage;
}

function installChromeDownloadInvalidIdStub() {
  globalThis.chrome = {
    runtime: { lastError: null },
    downloads: {
      download(_options, callback) { callback(undefined); }
    }
  };
}
