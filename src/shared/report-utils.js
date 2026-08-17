import { DOWNLOAD_STATUSES, ERROR_CATEGORIES, MEDIA_TYPES } from './constants.js';
import { MEDIA_TYPE_REGISTRY } from './media-type-registry.js';
import { getHostname, nowISO, stableHash } from './utils.js';

const REPORT_SCHEMA_VERSION = 7;

/**
 * Returns a human-safe URL summary for logs/reports while preserving enough detail
 * to compare candidates. Full URLs are included elsewhere in the on-demand report
 * because the user explicitly exports it locally; diagnostics storage still never
 * stores full URLs.
 */
export function summarizeUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return {
      protocol: url.protocol.replace(':', ''),
      hostnameHash: url.hostname ? stableHash(url.hostname.toLowerCase()) : '',
      pathnameExtension: extensionFromPath(url.pathname),
      pathHash: stableHash(url.pathname || '/'),
      queryParameterCount: Array.from(url.searchParams.keys()).length,
      urlHash: stableHash(url.toString())
    };
  } catch (_error) {
    return { protocol: '', hostnameHash: '', pathnameExtension: '', pathHash: '', queryParameterCount: 0, urlHash: stableHash(rawUrl) };
  }
}

export function buildReportFilename(_tab = {}, generatedAt = nowISO()) {
  const timestamp = generatedAt.replace(/[:.]/g, '-').replace('T', '_');
  return `media-scout-report-${timestamp}.zip`;
}

export function buildReportReadme(mode = 'redacted') {
  return [
    'Media Scout Downloader report.zip',
    '',
    'This report was generated locally from the active browser tab. It is intended to help explain what Media Scout Downloader could see, what it accepted, what it rejected, and why a video may not have appeared in the popup.',
    '',
    'Privacy note:',
    '- The extension does not upload this report anywhere.',
    mode === 'full' ? '- Sensitive URL mode was explicitly confirmed. Exact titles, hostnames, filenames, URL paths, and non-secret query values may appear; URL credentials and secret-shaped fields remain redacted.' : '- Default mode omits page titles and filenames, replaces hostnames and URL paths with correlation hashes, and omits query names and values.',
    '- Review every file in the local preview before sharing it. Titles, hostnames, filenames, browser details, and diagnostic context can identify private activity.',
    '- Screenshots are never generated or included.',
    '',
    'Retention and cleanup:',
    '- Preview contents exist only in the open extension page memory and are replaced or cleared when source evidence changes.',
    '- The extension does not keep a copy of an exported ZIP. The browser and operating system control the downloaded file after export.',
    '- Delete exported ZIPs manually when they are no longer needed. Queue-history retention follows the configured local retention period and can be cleared from Diagnostics.',
    '',
    'Useful files:',
    '- data-exposure.json: field-by-field included, omitted, hashed, or redacted handling for this exact report mode.',
    '- summary.md: readable findings and likely reasons media was not found.',
    '- detected-media.json: items Media Scout accepted into the popup list.',
    '- page-scan.json: DOM/media/frame/performance details visible to the content script.',
    '- decision-log.json: candidate-by-candidate acceptance/rejection reasons.',
    '- extension-state.json: settings, permission state, queue summary, diagnostics, and self-test results.',
    '- limitations.txt: safety boundaries and expected detection gaps.',
    '- media-type-registry.json: complete local extension/MIME registry used by detection, settings, reports, and popup grouping.',
    ''
  ].join('\n');
}

export function buildLimitationsText() {
  return [
    'Known safe-detection limits',
    '',
    'Media Scout Downloader does not bypass DRM, encryption, paywalls, authentication, signed URL systems, CORS, or other access controls.',
    'Expanded detection includes videos, audio, HLS/DASH/other manifests, segments/fragments, subtitles, posters/thumbnails, and selected media metadata hints. Segment assembly/conversion remains intentionally limited to safe, normally accessible, non-encrypted HLS cases supported by the local remuxer.',
    'It does not include site-specific scraping logic for streaming platforms.',
    '',
    'Common reasons another extension may show a video that Media Scout does not:',
    '1. The other extension observed network traffic before Media Scout was opened or before site access was granted.',
    '2. The other extension has broader host permissions or site-specific logic.',
    '3. The page uses Media Source Extensions, where the <video> element points to a blob: URL while real segments are fetched separately; Media Scout can only merge non-encrypted MPEG-TS HLS segments when normal page fetch access exposes them.',
    '4. The stream uses DRM/EME, encrypted HLS, DASH ContentProtection, signed URLs, or authentication-bound URLs.',
    '5. The media is loaded by a service worker, cache, iframe, or player script in a way that is not exposed as a simple downloadable file URL.',
    '6. The media is inside an iframe origin that Chrome has not granted the extension permission to scan.',
    '7. The resource has no standard media extension or media response header visible to the extension.',
    '',
    'The report is diagnostic only. It should not be used to defeat restrictions. Non-encrypted HLS merging, when available, uses normal browser fetch access only and stops on encryption, DRM, CORS, authentication, signed URLs, and access-control failures.'
  ].join('\n');
}

export function buildSummaryMarkdown({ tab, siteAccess, state, detailedScan, generatedAt, scannerError, persistedQueueHistory }) {
  const mediaItems = state?.mediaItems || [];
  const queue = state?.queue || {};
  const persistedQueue = persistedQueueHistory || {};
  const decisions = detailedScan?.decisions || [];
  const performance = detailedScan?.performance || {};
  const playlistProbes = detailedScan?.playlistProbes || [];
  const rejected = decisions.filter((item) => !item.acceptedByBasicScanner);
  const accepted = decisions.filter((item) => item.acceptedByBasicScanner);
  const protectedItems = mediaItems.filter((item) => item.isProtected || item.status === DOWNLOAD_STATUSES.UNSUPPORTED || item.status === DOWNLOAD_STATUSES.ENCRYPTED);
  const likelyReasons = inferLikelyReasons({ tab, siteAccess, mediaItems, detailedScan, scannerError });

  return [
    '# Media Scout Downloader detection report',
    '',
    `Generated: ${generatedAt}`,
    `Active tab title: ${tab?.title || 'Unavailable'}`,
    `Active tab URL: ${tab?.url || 'Unavailable'}`,
    `Origin permission: ${siteAccess?.granted ? 'granted' : 'not granted'}${siteAccess?.origin ? ` (${siteAccess.origin})` : ''}`,
    '',
    '## Summary counts',
    '',
    `- Popup media items: ${mediaItems.length}`,
    `- Popup item groups: ${formatGroupCounts(mediaItems)}`,
    `- Protected/unsupported popup items: ${protectedItems.length}`,
    `- Page scan candidates accepted by the basic DOM scanner: ${accepted.length}`,
    `- Page scan candidates rejected by the basic DOM scanner: ${rejected.length}`,
    `- Accessible frames scanned: ${detailedScan?.scannedFrameCount || (detailedScan?.frame ? 1 : 0)}`,
    `- Top-page iframe elements: ${detailedScan?.document?.iframeCount || detailedScan?.iframes?.length || 0}`,
    `- Media elements across scanned frames: ${detailedScan?.mediaElements?.length || 0}`,
    `- Page-embedded media URL hints: ${detailedScan?.literalMediaHints?.length || 0}`,
    `- Media-looking performance entries: ${performance.mediaLikeEntries?.length || 0}`,
    `- Playlist/manifest probes attempted: ${playlistProbes.length}`,
    `- Interesting non-media-confirmed resource hints: ${performance.interestingEntries?.length || 0}`,
    `- Queue active/pending/completed/failed: ${queue.activeCount || 0}/${queue.pending?.length || 0}/${queue.completed?.length || 0}/${queue.failed?.length || 0}`,
    persistedQueue.savedAt ? `- Persisted queue history active/pending/completed/failed: ${persistedQueue.activeCount || 0}/${persistedQueue.pendingCount || 0}/${persistedQueue.completedCount || 0}/${persistedQueue.failedCount || 0} (saved ${persistedQueue.savedAt})` : '',
    scannerError ? `- Scanner error: ${scannerError}` : '',
    '',
    '## Likely reasons a visible video was not listed',
    '',
    ...likelyReasons.map((reason) => `- ${reason}`),
    '',
    '## What Media Scout accepted into the popup',
    '',
    ...(mediaItems.length ? mediaItems.map((item) => `- ${item.extension || 'media'} ${item.mediaType || MEDIA_TYPES.UNKNOWN} from ${item.hostname || getHostname(item.url)} — ${item.status || 'detected'}${item.unsupportedReason ? ` — ${item.unsupportedReason}` : ''}${item.safetyWarning ? ` — Warning: ${item.safetyWarning}` : ''}`) : ['- No accepted media items were available in the popup state.']),
    '',
    '## Observed media/player clues',
    '',
    ...formatObservedFindings(detailedScan),
    '',
    '## Playlist/manifest probe details',
    '',
    ...formatPlaylistProbes(playlistProbes),
    '',
    '## Recent HLS/remux results',
    '',
    ...formatRecentRemuxResults(queue, persistedQueue),
    '',
    '## Rejection reason counts from page scan',
    '',
    ...formatReasonCounts(rejected),
    '',
    '## Next diagnostic steps',
    '',
    '- Start playback, then press Rescan and Generate report again. Many players load media lazily only after playback begins.',
    '- Grant active site access from the popup, refresh the page, play the video, and generate another report to include future network-request observations.',
    '- If page-scan.json shows the player inside a different iframe origin, grant broader site access from Options or test on a page where Chrome permits that frame to be scanned, then refresh and generate another report.',
    '- Compare decision-log.json with what the other extension reports. If the other item is encrypted, signed, DRM-protected, or site-specific, Media Scout is expected to skip it.',
    '- Review page-scan.json for blob: URLs, empty currentSrc values, missing source tags, frame scan coverage, literal media URL hints, media-like resource timing entries, and iframe/player hints.',
    ''
  ].join('\n');
}

export function buildDecisionLog(detailedScan = {}) {
  const decisions = detailedScan.decisions || [];
  return decisions.map((decision) => ({
    ...decision,
    urlSummary: summarizeUrl(decision.normalizedUrl || decision.rawUrl || '')
  }));
}

export function buildExtensionState({ state, settings, diagnostics, siteAccess, selfTests, generatedAt, persistedQueueHistory, runtimeDetails, exposure, allowSensitiveUrls = false }) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt,
    siteAccess,
    settings,
    queue: state?.queue || {},
    persistedQueueHistory: persistedQueueHistory || null,
    diagnostics,
    selfTests,
    runtimeDetails: runtimeDetails || {},
    dataExposure: exposure || [],
    privacy: {
      generatedLocally: true,
      uploadedByExtension: false,
      fullUrlsStoredInDiagnostics: false,
      screenshotsIncluded: false,
      previewRetention: 'Extension-page memory only; invalidated when source evidence or report options change.',
      exportedZipRetention: 'Controlled by the browser, operating system, and user after export; delete manually when no longer needed.',
      queueHistoryRetentionDays: Number(settings?.queueHistoryRetentionDays) || 0,
      note: allowSensitiveUrls
        ? 'Sensitive URL mode may include exact titles, hostnames, filenames, URL paths, and non-secret query values after explicit confirmation. Credentials and secret-shaped fields remain redacted.'
        : 'Default mode omits titles and filenames, hashes host/path correlation values, and redacts full URLs, local paths, and secret-shaped fields.'
    }
  };
}

export function sanitizeMediaItemsForReport(mediaItems = []) {
  return mediaItems.map((item) => ({
    ...item,
    urlSummary: summarizeUrl(item.url || item.normalizedUrl || '')
  }));
}


function formatGroupCounts(mediaItems = []) {
  const counts = new Map();
  for (const item of mediaItems) {
    const group = item.mediaType || MEDIA_TYPES.UNKNOWN;
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  if (!counts.size) return 'none';
  return Array.from(counts.entries()).map(([group, count]) => `${group}:${count}`).join(', ');
}

export function registryCoverageForReport() {
  return MEDIA_TYPE_REGISTRY.map((entry) => ({
    id: entry.id,
    group: entry.group,
    extensions: entry.extensions,
    mimeTypes: entry.mimeTypes,
    label: entry.label,
    defaultEnabled: entry.defaultEnabled !== false,
    manifest: Boolean(entry.manifest),
    segment: Boolean(entry.segment),
    companion: Boolean(entry.companion),
    canConvertToMp4: Boolean(entry.canConvertToMp4),
    notes: [entry.legacy ? 'legacy' : '', entry.professional ? 'professional' : '', entry.lowPriority ? 'low-priority' : ''].filter(Boolean)
  }));
}

function inferLikelyReasons({ siteAccess, mediaItems, detailedScan, scannerError }) {
  const reasons = [];
  const decisions = detailedScan?.decisions || [];
  const mediaElements = detailedScan?.mediaElements || [];
  const performanceEntries = detailedScan?.performance?.mediaLikeEntries || [];
  const interestingEntries = detailedScan?.performance?.interestingEntries || [];
  const literalHints = detailedScan?.literalMediaHints || [];
  const playlistProbes = detailedScan?.playlistProbes || [];
  const encryptedHlsProbes = playlistProbes.filter((probe) => probe?.ok && probe.encrypted);
  const unsupportedHlsProbes = playlistProbes.filter((probe) => probe?.ok && (probe.hasMap || probe.hasByteRange));
  const iframeCount = detailedScan?.document?.iframeCount || detailedScan?.iframes?.length || 0;
  const scannedFrameCount = detailedScan?.scannedFrameCount || (detailedScan?.frame ? 1 : 0);
  const protectedItems = mediaItems.filter((item) => item.isProtected || item.status === DOWNLOAD_STATUSES.UNSUPPORTED || item.status === DOWNLOAD_STATUSES.ENCRYPTED);
  const blobCandidates = decisions.filter((item) => String(item.normalizedUrl || item.rawUrl || '').startsWith('blob:'));
  const emptyCurrentSrc = mediaElements.filter((item) => item.tagName === 'video' && !item.currentSrc && !item.srcAttribute);
  const signed = [...mediaItems, ...decisions].filter((item) => hasSignedCategory(item));
  const noAccepted = !mediaItems.length;

  if (scannerError) reasons.push(`The content scanner could not run on this page: ${scannerError}`);
  if (!siteAccess?.granted) reasons.push('Active-site host permission is not granted, so Media Scout can scan the DOM but may miss future network media requests until access is granted and the page is refreshed.');
  if (iframeCount && scannedFrameCount <= 1) reasons.push('The page contains iframe(s). If the actual player is inside a cross-origin frame, Chrome may require permission for that frame origin before Media Scout can inspect it.');
  if (noAccepted && !decisions.length) reasons.push('The page scan did not expose media URLs in <video>, <audio>, <source>, page-embedded media URL literals, or media-looking performance entries.');
  if (emptyCurrentSrc.length) reasons.push('At least one video element has no currentSrc/src. The player may attach media later, use an iframe, or use Media Source Extensions.');
  if (literalHints.length && !mediaItems.length) reasons.push('The page contains media-looking URL literals, but none became supported popup items. Check decision-log.json for extension, signed URL, or protection reasons.');
  if (blobCandidates.length) reasons.push('The page exposes blob: media URLs. Blob URLs are page-local and do not reveal the original segment or file URL; Media Scout only uses them when normal page-local download is possible.');
  if (blobCandidates.length && performanceEntries.some((entry) => entry.extension === 'm3u8' || entry.extension === 'mpd')) reasons.push('This looks like Media Source Extensions playback: the visible video element points to blob:, while playlist/manifest resources appear in Resource Timing.');
  if (protectedItems.length) reasons.push('Some media-like items were detected but marked unsupported/protected, so the popup disables download rather than attempting a bypass. Warning-only playlist/manifest items may still be downloadable as playlist files, not assembled videos.');
  if (encryptedHlsProbes.length) reasons.push('At least one HLS playlist probe found encryption markers. Media Scout marks matching playlists and segments unsupported rather than saving encrypted stream internals.');
  if (unsupportedHlsProbes.length) reasons.push('At least one HLS playlist probe found fMP4 map or byte-range markers, which the current local segment merger does not support.');
  if (signed.length) reasons.push('Some candidate URLs appear signed, tokenized, or expiring. Media Scout refuses to reuse or bypass protected authorization links.');
  if (performanceEntries.length && !mediaItems.length) reasons.push('The page performance log contains media-looking resources, but they were not accepted into the popup. Check decision-log.json for extension/MIME/protection reasons.');
  if (interestingEntries.length && !mediaItems.length) reasons.push('The Resource Timing log contains player/API-looking requests, but they did not expose a standard downloadable media extension or MIME type to the extension.');
  if (!reasons.length) reasons.push('Media Scout found supported media. If another extension shows a different item, compare its URL/type with detected-media.json and decision-log.json.');
  return reasons;
}

function hasSignedCategory(item = {}) {
  const reason = `${item.unsupportedReason || ''} ${item.reasons?.join(' ') || ''} ${item.errorCategory || ''}`.toLowerCase();
  return reason.includes(ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL) || reason.includes('signed') || reason.includes('expiring') || reason.includes('token');
}

function formatObservedFindings(detailedScan = {}) {
  const findings = [];
  const mediaElements = detailedScan?.mediaElements || [];
  const performanceEntries = detailedScan?.performance?.mediaLikeEntries || [];
  const literalHints = detailedScan?.literalMediaHints || [];

  for (const element of mediaElements.slice(0, 8)) {
    const url = element.currentSrc || element.srcProperty || element.srcAttribute || '';
    if (!url) continue;
    const label = url.startsWith('blob:') ? 'blob media element' : 'media element';
    findings.push(`- ${label}: ${element.tagName || 'media'}${element.resolution ? ` ${element.resolution}` : ''}${element.duration ? `, duration ${Math.round(element.duration)}s` : ''}${element.frameUrl ? `, frame ${getHostname(element.frameUrl) || element.frameUrl}` : ''}`);
  }

  for (const entry of performanceEntries.slice(0, 12)) {
    findings.push(`- Performance resource: ${entry.extension || 'media'} from ${entry.hostname || getHostname(entry.url)} via ${entry.initiatorType || 'resource'}${entry.frameUrl ? `, frame ${getHostname(entry.frameUrl) || entry.frameUrl}` : ''}`);
  }

  for (const hint of literalHints.slice(0, 8)) {
    findings.push(`- Page literal: ${hint.extension || 'media'} from ${hint.hostname || getHostname(hint.url)} in ${hint.context || hint.source || 'page text'}`);
  }

  if (!findings.length) return ['- No extra media/player clues were visible to the scanner.'];
  return Array.from(new Set(findings)).slice(0, 24);
}

function formatPlaylistProbes(probes = []) {
  if (!probes.length) return ['- No playlist/manifest probes were attempted.'];
  return probes.slice(0, 12).map((probe) => {
    if (!probe.ok) return `- ${probe.extension || 'playlist'} from ${probe.hostname || getHostname(probe.url)}: probe failed (${probe.errorCategory || 'unknown'}). ${probe.error || ''}`.trim();
    const parts = [
      `${probe.playlistKind || probe.extension || 'playlist'} from ${probe.hostname || getHostname(probe.url)}`,
      probe.variantCount != null ? `${probe.variantCount} variant(s)` : '',
      probe.segmentCount != null ? `${probe.segmentCount} segment(s)` : '',
      probe.estimatedDurationSeconds ? `estimated ${Math.round(probe.estimatedDurationSeconds)}s` : '',
      probe.encrypted ? 'encrypted markers found' : '',
      probe.hasMap ? 'fMP4 map present' : '',
      probe.hasByteRange ? 'byte ranges present' : ''
    ].filter(Boolean);
    return `- ${parts.join(' • ')}`;
  });
}


function formatRecentRemuxResults(queue = {}, persistedQueue = {}) {
  const current = [...(queue.completed || []), ...(queue.failed || [])];
  const persisted = [...(persistedQueue.completed || []), ...(persistedQueue.failed || [])];
  const tasks = [...current, ...persisted]
    .filter((task, index, arr) => task && arr.findIndex((other) => other?.id === task.id) === index)
    .slice(0, 8);
  if (!tasks.length) return ['- No recent completed or failed HLS/remux tasks were available in this report.'];
  return tasks.map((task) => {
    const result = task.result || {};
    const error = task.lastError || {};
    const facts = [
      task.status || 'unknown',
      task.filename || result.outputFilename || '',
      result.segmentCount ? `${result.segmentCount} segments` : '',
      result.outputBytes ? `${Math.round(result.outputBytes / 1024 / 1024)} MB output` : '',
      result.videoSampleCount ? `${result.videoSampleCount} video samples` : '',
      result.audioSampleCount ? `${result.audioSampleCount} audio samples` : '',
      result.keyFrameCount ? `${result.keyFrameCount} keyframes` : '',
      result.estimatedVideoFps ? `${result.estimatedVideoFps} fps` : '',
      result.videoDurationSeconds ? `video ${Math.round(result.videoDurationSeconds)}s` : '',
      result.audioDurationSeconds ? `audio ${Math.round(result.audioDurationSeconds)}s` : '',
      result.droppedVideoSamples ? `dropped ${result.droppedVideoSamples} pre-keyframe video samples` : '',
      error.message ? `error: ${error.message}` : '',
      Array.isArray(result.remuxWarnings) && result.remuxWarnings.length ? `warnings: ${result.remuxWarnings.join('; ')}` : ''
    ].filter(Boolean);
    return `- ${facts.join(' • ')}`;
  });
}

function formatReasonCounts(rejected) {
  if (!rejected.length) return ['- No rejected basic-scan candidates.'];
  const counts = new Map();
  for (const item of rejected) {
    for (const reason of item.reasons || ['unknown']) counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([reason, count]) => `- ${reason}: ${count}`);
}

function extensionFromPath(pathname = '') {
  const match = String(pathname).toLowerCase().match(/\.([a-z0-9]{2,5})$/i);
  return match ? match[1] : '';
}
