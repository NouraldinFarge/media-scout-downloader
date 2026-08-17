import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runSelfTests } from '../src/shared/self-tests.js';
import { createZipBlob, normalizeZipEntries } from '../src/shared/zip-utils.js';
import { ReportManager, redactReportValue } from '../src/background/report-manager.js';
import { QueueManager } from '../src/background/queue-manager.js';
import { MAX_MEDIA_ITEMS_PER_TAB, TabMediaStore } from '../src/background/tab-media-store.js';
import { classifyChromeDownloadError, downloadWithAllowedStrategies } from '../src/background/download-strategies.js';
import { DownloadManager } from '../src/background/download-manager.js';
import { MediaDetector, parseHlsInspection } from '../src/background/media-detector.js';
import { DiagnosticsManager } from '../src/background/diagnostics-manager.js';
import { DOWNLOAD_STATUSES, ERROR_CATEGORIES, MEDIA_TYPES, MESSAGE_TYPES, STORAGE_KEYS } from '../src/shared/constants.js';
import { buildExtensionState, summarizeUrl } from '../src/shared/report-utils.js';
import { buildReportContext, redactKnownReportText, reportContextsMatch, reportFilesDigest } from '../src/shared/report-privacy.js';
import { sanitizeLogValue } from '../src/shared/logger.js';
import { validateMediaUrl, validateMessage } from '../src/shared/validators.js';
import { reconcileSiteAccessGrant } from '../src/shared/permission-state.js';

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
const bulkRedactedText = redactKnownReportText('Alpha.Example PRIVATE(file)+ and alpha.example', ['example', 'alpha.example', 'PRIVATE(file)+']);
assert.equal(/alpha\.example|private\(file\)\+|\bexample\b/i.test(bulkRedactedText), false, 'bulk identifying-value redaction is case-insensitive, regex-safe, and handles overlapping values');
assert.equal(buildExtensionState({}).schemaVersion, 7, 'report schema advances when the privacy-preview contract changes');
const sanitizedLog = JSON.stringify(sanitizeLogValue({ message: 'Failed https://private.invalid/watch?token=LOG_SECRET', localPath: 'C:\\Users\\Private\\file.mp4', password: 'LOG_PASSWORD' }));
assert.equal(sanitizedLog.includes('LOG_SECRET'), false, 'warning/debug logging redacts URL query values');
assert.equal(sanitizedLog.includes('LOG_PASSWORD'), false, 'warning/debug logging redacts secret-shaped fields');
assert.equal(sanitizedLog.includes('C:\\Users\\Private'), false, 'warning/debug logging redacts local paths');

await testReportPrivacyAndPreviewEquality();
testReportContextInvalidation();

assert.equal(validateMessage({ type: MESSAGE_TYPES.DOWNLOAD_PROGRESS, taskId: 'task-1', percent: 12, loaded: -1, total: 5 }), false, 'progress messages reject negative counters');
assert.equal(validateMessage({ type: MESSAGE_TYPES.DOM_MEDIA_FOUND, items: [{ url: 'https://example.com/video.mp4', transferSize: -1 }] }), false, 'scan messages reject negative resource metrics');
assert.equal(validateMediaUrl(`https://example.com/${'a'.repeat(4096)}.mp4`)?.code, 'invalid-url', 'oversized media URLs are rejected before entering retained state');
assert.equal(classifyChromeDownloadError('USER_CANCELED'), ERROR_CATEGORIES.USER_CANCELED, 'Chrome user cancellations are not retried as network errors');
assert.equal(classifyChromeDownloadError('NETWORK_FAILED'), ERROR_CATEGORIES.NETWORK, 'Chrome network interruptions remain retryable network errors');

await testPermissionBoundWebRequestLifecycle();
await testPermissionDriftReconciliation();
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
assert.equal(sidepanelSource.includes("text: String(file.content ?? '')"), true, 'report preview renders each exact text-file content through textContent-safe element construction');
assert.equal(sidepanelSource.includes('MESSAGE_TYPES.VALIDATE_REPORT_PREVIEW'), true, 'report export validates the preview against current source evidence');
assert.equal(sidepanelSource.includes('reportFilesDigest(files)'), true, 'report export recomputes the exact preview/file-set digest');
assert.equal(sidepanelSource.includes('invalidateReportPreview'), true, 'side-panel report inputs share an explicit preview-invalidation path');
assert.equal(sidepanelSource.includes('chrome.permissions?.onRemoved?.addListener'), true, 'persistent side panel observes external site-access revocation');
assert.equal(sidepanelSource.includes('preserveSiteAccess: permissionRevision !== state.permissionRevision'), true, 'slow scans cannot overwrite a newer permission-drift result');
assert.equal(sidepanelSource.includes('Screenshots.'), true, 'report UI explicitly states that screenshots are never included');
const contentSource = await readFile(new URL('../src/content/content.js', import.meta.url), 'utf8');
assert.equal(contentSource.includes('queryParameterNames'), false, 'runtime HLS errors do not retain sensitive query-parameter names');
assert.equal(contentSource.includes('const MAX_HLS_BYTES = 128 * 1024 * 1024'), true, 'experimental HLS aggregate memory is capped at 128 MiB');
assert.equal(contentSource.includes('const MAX_HLS_SEGMENT_BYTES = 24 * 1024 * 1024'), true, 'experimental HLS segments are capped at 24 MiB each');
assert.equal(contentSource.includes('Math.floor(MAX_HLS_BYTES * 0.65)'), true, 'estimated HLS size rejects before the hard aggregate cap');
const serviceWorkerSource = await readFile(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
assert.equal(serviceWorkerSource.includes('The source tab was closed. Media Scout cleared its stale detections'), true, 'closing a monitored source tab broadcasts an authoritative UI reset');
const pageScannerSource = await readFile(new URL('../src/content/page-media-scanner.js', import.meta.url), 'utf8');
assert.equal(pageScannerSource.includes('querySelectorAll'), false, 'page scanning uses visit-bounded traversal instead of materializing unbounded DOM snapshots');
assert.equal(serviceWorkerSource.includes('querySelectorAll'), false, 'injected fallback and episode scans use visit-bounded DOM traversal');

console.log(`Media Scout regression gate: ${results.results.length} self-test suites and repository assertions passed.`);

async function testReportPrivacyAndPreviewEquality() {
  installChromeStorageStub();
  let sensitiveSettingAllowed = false;
  const tab = {
    id: 42,
    title: 'Fixture Δ Private Watch',
    url: 'https://media.fixture.invalid/watch/private-title?quality=ultra&viewer=sample&token=DO_NOT_EXPORT_TOKEN'
  };
  const mediaUrl = 'https://fixture-user:fixture-pass@cdn.fixture.invalid/private/fixture-video-秘密.mp4?quality=1080p&token=MEDIA_SECRET_TOKEN&opaque=abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const queue = {
    maxParallel: 1,
    activeCount: 0,
    paused: false,
    pending: [],
    active: [],
    completed: [{ id: 'done-1', filename: 'fixture-video-秘密.mp4', status: 'completed', result: { outputFilename: 'fixture-video-秘密.mp4' } }],
    failed: [],
    canceled: []
  };
  const tabState = {
    tab,
    mediaItems: [{
      id: 'media-fixture',
      tabId: tab.id,
      title: tab.title,
      hostname: 'cdn.fixture.invalid',
      filename: 'fixture-video-秘密.mp4',
      url: mediaUrl,
      normalizedUrl: mediaUrl,
      mediaType: MEDIA_TYPES.VIDEO,
      extension: 'mp4',
      status: DOWNLOAD_STATUSES.DETECTED,
      note: 'Καλημέρα κόσμε — synthetic Unicode survives.',
      localPath: 'C:\\Users\\Fixture\\Private\\fixture-video-秘密.mp4',
      blobUrl: 'blob:https://media.fixture.invalid/PRIVATE-BLOB-ID',
      accessToken: 'OBJECT_SECRET_TOKEN'
    }]
  };
  const detailedScan = {
    generatedAt: '2026-08-17T12:00:00.000Z',
    frame: { url: tab.url, title: tab.title, isTop: true },
    document: { url: tab.url, title: tab.title, iframeCount: 0, mediaElementCount: 1 },
    mediaElements: [{ tagName: 'video', currentSrc: mediaUrl, frameUrl: tab.url, currentTime: 12 }],
    literalMediaHints: [{ url: mediaUrl, source: 'fixture', context: 'Synthetic controlled fixture' }],
    decisions: [{ rawUrl: mediaUrl, normalizedUrl: mediaUrl, source: 'dom-video', acceptedByBasicScanner: true, reasons: [] }],
    playlistProbes: [],
    performance: { mediaLikeEntries: [{ url: mediaUrl, hostname: 'cdn.fixture.invalid', initiatorType: 'video' }], interestingEntries: [] },
    diagnosticMessage: 'Relative fetch /private/clip.mp4?account_email=user@fixture.invalid&token=RELATIVE_SECRET failed. Authorization: Bearer eyJfixtureHeader123.fixturePayload456.fixtureSignature789',
    protocolRelativeMessage: 'Mirror //mirror.fixture.invalid/private/clip.mp4?quality=high was observed.',
    localMessage: 'Temporary file C:\\Users\\Fixture\\AppData\\Local\\Temp\\fixture-video-秘密.mp4 was unavailable.'
  };
  const diagnostics = {
    snapshot: () => ({
      errors: { network: 1 },
      lastMessage: `Credential URL ${mediaUrl}`,
      password: 'DIAGNOSTIC_PASSWORD',
      safeUnicode: 'Καλημέρα κόσμε'
    })
  };
  const manager = new ReportManager({
    getSettings: async () => ({
      includeSensitiveUrlsInReports: sensitiveSettingAllowed,
      queueHistoryRetentionDays: 7,
      filenameTemplate: 'Personal-{tabTitle}.{extension}',
      preferredSubfolder: 'Private Folder'
    }),
    diagnostics,
    downloadManager: { getState: () => queue }
  });
  const build = (includeSensitiveUrls) => manager.buildActiveTabReport({
    tab,
    tabRevision: 3,
    siteAccess: { granted: true, origin: 'https://media.fixture.invalid/*' },
    tabState,
    detailedScan,
    scannerError: '',
    selfTests: { passed: true },
    includeSensitiveUrls
  });

  const settingBlocked = await build(true);
  assert.equal(settingBlocked.summary.redacted, true, 'a request alone cannot enable sensitive report data while the saved setting is disabled');

  sensitiveSettingAllowed = true;
  const redacted = await build(false);
  const redactedText = redacted.files.map((file) => String(file.content)).join('\n');
  for (const privateValue of [
    tab.title,
    'media.fixture.invalid',
    'cdn.fixture.invalid',
    'fixture-video-秘密.mp4',
    tab.url,
    mediaUrl,
    '/watch/private-title',
    '/private/clip.mp4',
    'quality',
    'viewer',
    'sample',
    'account_email',
    'user@fixture.invalid',
    'DO_NOT_EXPORT_TOKEN',
    'MEDIA_SECRET_TOKEN',
    'abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    'RELATIVE_SECRET',
    'OBJECT_SECRET_TOKEN',
    'DIAGNOSTIC_PASSWORD',
    'PRIVATE-BLOB-ID',
    'C:\\Users\\Fixture'
  ]) assert.equal(redactedText.includes(privateValue), false, `default report omits private fixture value: ${privateValue}`);
  assert.equal(redactedText.includes('Καλημέρα κόσμε'), true, 'default report preserves safe Unicode diagnostic text');
  assert.equal(redacted.summary.screenshotsIncluded, false, 'report summary explicitly excludes screenshots');
  assert.equal(redacted.exposure.find((item) => item.id === 'page-title')?.handling, 'omitted', 'default exposure manifest identifies title omission');
  assert.equal(redacted.exposure.find((item) => item.id === 'hostname')?.handling, 'hashed', 'default exposure manifest identifies hostname hashing');
  assert.equal(redacted.files.some((file) => file.path === 'data-exposure.json'), true, 'the exported report includes its exact exposure manifest');
  assert.equal(reportFilesDigest(redacted.files), redacted.previewDigest, 'preview digest covers the exact normalized file list and contents');

  const sensitive = await build(true);
  const sensitiveText = sensitive.files.map((file) => String(file.content)).join('\n');
  for (const expected of [tab.title, 'media.fixture.invalid', 'cdn.fixture.invalid', 'mirror.fixture.invalid', 'fixture-video-秘密.mp4', '/watch/private-title', 'quality=ultra', 'viewer=sample', 'quality=1080p', '//mirror.fixture.invalid/private/clip.mp4?quality=high', 'Καλημέρα κόσμε']) {
    assert.equal(sensitiveText.includes(expected), true, `confirmed sensitive report exposes the previewed non-secret fixture value: ${expected}`);
  }
  for (const alwaysPrivate of ['fixture-user', 'fixture-pass', 'DO_NOT_EXPORT_TOKEN', 'MEDIA_SECRET_TOKEN', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'fixtureHeader123', 'RELATIVE_SECRET', 'OBJECT_SECRET_TOKEN', 'DIAGNOSTIC_PASSWORD', 'PRIVATE-BLOB-ID', 'C:\\Users\\Fixture']) {
    assert.equal(sensitiveText.includes(alwaysPrivate), false, `sensitive report still redacts credential, secret, blob, or local-path value: ${alwaysPrivate}`);
  }
  assert.equal(sensitive.summary.redacted, false, 'saved setting plus explicit request enables sensitive URL mode');
  assert.equal(sensitive.exposure.find((item) => item.id === 'tokens-secrets')?.handling, 'redacted', 'sensitive exposure manifest truthfully describes always-redacted secret fields');

  const unsafeFiles = [
    { path: '../report.txt', content: 'first' },
    { path: './report.txt', content: 'second' },
    { path: '../../nested/../unicode-秘密.txt', content: 'Καλημέρα κόσμε' },
    { path: 'safe/ .. /escape.txt', content: 'spaced traversal' },
    { path: 'C:\\Users\\Fixture\\CON.txt', content: 'unsafe Windows path' }
  ];
  const normalizedFiles = normalizeZipEntries(unsafeFiles);
  assert.deepEqual(normalizedFiles.map((file) => file.path), ['report.txt', 'report-2.txt', 'nested/unicode-秘密.txt', 'safe/escape.txt', 'C-/Users/Fixture/_CON.txt'], 'traversal-shaped, platform-unsafe, and duplicate ZIP paths normalize to unique safe names');
  assert.equal(normalizedFiles.some((file) => file.path.split('/').some((segment) => segment === '..') || file.path.startsWith('/') || file.path.includes(':')), false, 'normalized ZIP paths contain no traversal, absolute roots, or drive prefixes');
  const zip = createZipBlob(redacted.files);
  const extracted = readStoredZipEntries(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(extracted, normalizeZipEntries(redacted.files).map((file) => ({ path: file.path, content: String(file.content) })), 'every exported ZIP path and byte-decoded text exactly matches the previewed file list');
}

function testReportContextInvalidation() {
  const base = {
    tab: { id: 9, title: 'Synthetic page', url: 'https://fixture.invalid/watch' },
    tabRevision: 4,
    state: { mediaItems: [{ id: 'one', url: 'https://fixture.invalid/one.mp4' }], queue: { pending: [] } },
    settings: { includeSensitiveUrlsInReports: false, queueHistoryRetentionDays: 7 },
    siteAccess: { granted: true, origin: 'https://fixture.invalid/*' },
    diagnostics: { errors: {} },
    detailedScan: { generatedAt: 'first', frame: { url: 'https://fixture.invalid/watch', title: 'Synthetic page' }, decisions: [{ normalizedUrl: 'https://fixture.invalid/one.mp4', acceptedByBasicScanner: true }] },
    persistedQueueHistory: { savedAt: '2026-08-17T12:00:00.000Z', pendingCount: 0 },
    includeSensitiveUrls: false
  };
  const context = buildReportContext(base);
  const volatileOnly = buildReportContext({ ...base, detailedScan: { ...base.detailedScan, generatedAt: 'later' } });
  assert.equal(reportContextsMatch(context, volatileOnly), true, 'volatile report-generation timestamps do not invalidate an otherwise identical preview');
  assert.equal(reportContextsMatch(context, buildReportContext({ ...base, tab: { ...base.tab, url: 'https://fixture.invalid/other' } })), false, 'source-page navigation invalidates the preview');
  assert.equal(reportContextsMatch(context, buildReportContext({ ...base, tabRevision: 5 })), false, 'source-tab revision changes invalidate the preview');
  assert.equal(reportContextsMatch(context, buildReportContext({ ...base, state: { ...base.state, mediaItems: [...base.state.mediaItems, { id: 'two', url: 'https://fixture.invalid/two.mp4' }] } })), false, 'candidate-state changes invalidate the preview');
  assert.equal(reportContextsMatch(context, buildReportContext({ ...base, state: { ...base.state, queue: { pending: [{ id: 'job' }] } } })), false, 'queue changes invalidate the preview');
  assert.equal(reportContextsMatch(context, buildReportContext({ ...base, settings: { ...base.settings, queueHistoryRetentionDays: 1 } })), false, 'settings changes invalidate the preview');
  assert.equal(reportContextsMatch(context, buildReportContext({ ...base, detailedScan: { ...base.detailedScan, decisions: [{ normalizedUrl: 'https://fixture.invalid/two.mp4', acceptedByBasicScanner: true }] } })), false, 'source-page scan evidence changes invalidate the preview');
  assert.equal(reportContextsMatch(context, buildReportContext({ ...base, includeSensitiveUrls: true })), false, 'sensitivity changes invalidate the preview');
}

function readStoredZipEntries(bytes) {
  const decoder = new TextDecoder();
  const entries = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.push({
      path: decoder.decode(bytes.slice(nameStart, nameStart + nameLength)),
      content: decoder.decode(bytes.slice(dataStart, dataStart + compressedSize))
    });
    offset = dataStart + compressedSize;
  }
  return entries;
}

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

async function testPermissionBoundWebRequestLifecycle() {
  const permissionOrigins = [];
  const permissionAdded = testChromeEvent();
  const permissionRemoved = testChromeEvent();
  const headersReceived = testChromeEvent();
  const completed = testChromeEvent();
  globalThis.chrome = {
    permissions: {
      getAll: async () => ({ origins: [...permissionOrigins] }),
      onAdded: permissionAdded,
      onRemoved: permissionRemoved
    },
    webRequest: {
      onHeadersReceived: headersReceived,
      onCompleted: completed
    }
  };

  const detector = new MediaDetector({ tabMediaStore: new TabMediaStore(), diagnostics: {}, getSettings: async () => ({}) });
  await detector.start();
  assert.equal(headersReceived.registrations.length, 0, 'network observation does not register before optional host access exists');
  assert.equal(completed.registrations.length, 0, 'completed-request observation does not register before optional host access exists');

  permissionOrigins.push('https://media.fixture.invalid/*');
  await permissionAdded.emit({ origins: [...permissionOrigins] });
  assert.deepEqual(headersReceived.registrations[0]?.filter?.urls, ['https://media.fixture.invalid/*'], 'per-site grants bind header observation to the granted origin only');
  assert.deepEqual(completed.registrations[0]?.filter?.urls, ['https://media.fixture.invalid/*'], 'per-site grants bind completed-request observation to the granted origin only');

  permissionOrigins.splice(0, permissionOrigins.length, 'http://*/*', 'https://*/*');
  await permissionAdded.emit({ origins: [...permissionOrigins] });
  assert.equal(headersReceived.removeCount, 1, 'changing host grants removes the stale header listener before replacement');
  assert.deepEqual(headersReceived.registrations.at(-1)?.filter?.urls, ['http://*/*', 'https://*/*'], 'all-site grants bind observation only after Chrome reports those origins');

  permissionOrigins.length = 0;
  await permissionRemoved.emit({ origins: ['http://*/*', 'https://*/*'] });
  assert.equal(headersReceived.listeners.size, 0, 'revoking host access unregisters header observation');
  assert.equal(completed.listeners.size, 0, 'revoking host access unregisters completed-request observation');

  detector.stop();
  assert.equal(permissionAdded.listeners.size, 0, 'stopping the detector removes the permission-added observer');
  assert.equal(permissionRemoved.listeners.size, 0, 'stopping the detector removes the permission-removed observer');
}

async function testPermissionDriftReconciliation() {
  const granted = await reconcileSiteAccessGrant(
    { origin: 'https://media.fixture.invalid/*', granted: false },
    async (query) => {
      assert.deepEqual(query, { origins: ['https://media.fixture.invalid/*'] }, 'permission drift checks only the current origin');
      return true;
    }
  );
  assert.equal(granted.checked, true, 'permission drift checks a known current-site origin');
  assert.equal(granted.changed, true, 'an external grant is reported as a state change');
  assert.deepEqual(granted.siteAccess, { origin: 'https://media.fixture.invalid/*', granted: true }, 'external grant updates only the current-site permission state');

  const revoked = await reconcileSiteAccessGrant(granted.siteAccess, async () => false);
  assert.equal(revoked.changed, true, 'an external revocation is reported as a state change');
  assert.deepEqual(revoked.siteAccess, { origin: 'https://media.fixture.invalid/*', granted: false }, 'external revocation disables advanced detection in persistent UI state');

  const unavailable = await reconcileSiteAccessGrant(null, async () => true);
  assert.deepEqual(unavailable, { checked: false, changed: false, siteAccess: null }, 'permission drift is a no-op until a current-site origin is known');
}

function testChromeEvent() {
  const listeners = new Set();
  const registrations = [];
  let removeCount = 0;
  return {
    listeners,
    registrations,
    get removeCount() { return removeCount; },
    addListener(listener, filter, extraInfoSpec) {
      listeners.add(listener);
      registrations.push({ listener, filter, extraInfoSpec });
    },
    removeListener(listener) {
      if (listeners.delete(listener)) removeCount += 1;
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    async emit(payload) {
      await Promise.all([...listeners].map((listener) => listener(payload)));
    }
  };
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
