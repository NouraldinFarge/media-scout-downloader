import { DOWNLOAD_STATUSES, HLS_OUTPUT_METHODS, MEDIA_TYPES } from './constants.js';
import { getDownloadAllowDecision } from './download-allow-list.js';
import { formatBytes, getHostname } from './utils.js';

export const HLS_ACTIONS = Object.freeze([
  { method: HLS_OUTPUT_METHODS.SMART_MP4, label: 'Smart MP4', shortLabel: 'Smart', help: 'Recommended: MP4 when safe; timestamp-fixed TS fallback when MP4 is not safe.' },
  { method: HLS_OUTPUT_METHODS.MP4_REMUX, label: 'MP4 remux', shortLabel: 'MP4', help: 'Strict MP4 remux for compatible TS/H.264/AAC streams.' },
  { method: HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS, label: 'Timestamp-fixed TS', shortLabel: 'Fixed TS', help: 'Timestamp/continuity-aware TS fallback.' },
  { method: HLS_OUTPUT_METHODS.TS_CONCAT, label: 'Raw TS concat', shortLabel: 'Raw TS', help: 'Fast byte concat. Risk of audio desync.' },
  { method: HLS_OUTPUT_METHODS.PLAYLIST_ONLY, label: 'Save playlist', shortLabel: 'M3U8', help: 'Save playlist text only.' },
  { method: HLS_OUTPUT_METHODS.EXTERNAL_HELPER, label: 'Helper handoff', shortLabel: 'Helper', help: 'Save local helper instructions.' }
]);

export const CAPABILITY_LABELS = Object.freeze({
  downloadable: 'Downloadable',
  convertible: 'Convertible',
  manifest: 'Manifest only',
  playback: 'Needs playback',
  expired: 'Expired',
  unsupported: 'Unsupported',
  permission: 'Needs permission',
  stale: 'Stale'
});

export function normalizeQueue(queue = {}) {
  return {
    paused: Boolean(queue.paused),
    active: asArray(queue.active),
    pending: asArray(queue.pending),
    completed: asArray(queue.completed),
    failed: asArray(queue.failed),
    canceled: asArray(queue.canceled)
  };
}

export function queueCounts(queue = {}) {
  const q = normalizeQueue(queue);
  return {
    active: q.active.length,
    queued: q.pending.length,
    completed: q.completed.length,
    failed: q.failed.length,
    canceled: q.canceled.length,
    total: q.active.length + q.pending.length + q.completed.length + q.failed.length + q.canceled.length
  };
}

export function queueTaskList(queue = {}) {
  const q = normalizeQueue(queue);
  return [
    ...q.active.map((task) => ({ ...task, bucket: 'active' })),
    ...q.pending.map((task) => ({ ...task, bucket: 'pending' })),
    ...q.failed.map((task) => ({ ...task, bucket: 'failed' })),
    ...q.canceled.map((task) => ({ ...task, bucket: 'canceled' })),
    ...q.completed.map((task) => ({ ...task, bucket: 'completed' }))
  ];
}

export function activeQueueTask(queue = {}) {
  const q = normalizeQueue(queue);
  return q.active[0] || q.pending[0] || q.failed[0] || null;
}

export function downloadDecisionFor(item = {}, settings = {}, hlsOutputMethod = '') {
  // Recompute the allow-list decision with the current settings instead of
  // trusting the detector's cached policy. The cached policy is useful evidence,
  // but Options can disable file types or change the HLS method after detection.
  // CTA state must reflect the latest settings so buttons do not look usable and
  // then fail in the service worker.
  const method = item.mediaType === MEDIA_TYPES.HLS
    ? (hlsOutputMethod || settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4)
    : hlsOutputMethod;
  try {
    const liveDecision = getDownloadAllowDecision(item, { settings, hlsOutputMethod: method });
    return normalizeDecision(liveDecision, item, { explicitPolicy: true });
  } catch (_error) {
    // Fall through to the cached detector policy for partially hydrated legacy
    // tasks or fixture data that cannot be fully evaluated in the current UI.
  }

  const policy = item.downloadPolicy || {};
  if (item.mediaType === MEDIA_TYPES.HLS) {
    const decision = policy.methods?.[method];
    if (decision) return normalizeDecision(decision, item, { explicitPolicy: true });
  }
  const direct = policy.methods?.direct;
  if (direct) return normalizeDecision(direct, item, { explicitPolicy: true });
  if (policy.allowed != null) return normalizeDecision({ allowed: Boolean(policy.allowed), reason: policy.reason || item.unsupportedReason || '' }, item, { explicitPolicy: true });
  return normalizeDecision({ allowed: !item.isProtected, reason: item.unsupportedReason || item.safetyWarning || '' }, item, { explicitPolicy: false });
}

function normalizeDecision(decision = {}, item = {}, options = {}) {
  const protectedReason = item.unsupportedReason || item.safetyWarning || '';
  const explicitlyAllowedByPolicy = Boolean(options.explicitPolicy && decision.allowed);
  return {
    ...decision,
    // The allow-list is the source of truth for intentionally limited actions
    // such as saving a protected DASH MPD as a manifest-only evidence file.
    // Fallback decisions still fail closed on known protected media.
    allowed: explicitlyAllowedByPolicy ? true : (Boolean(decision.allowed) && !isKnownProtected(item)),
    reason: decision.reason || protectedReason || ''
  };
}

export function classifyCandidate(item = {}, settings = {}, options = {}) {
  if (!item || !item.id) return { key: 'playback', label: CAPABILITY_LABELS.playback, action: 'rescan', reason: 'Page has not exposed media requests yet.' };
  if (options.stale || isOlderThan(item, 10 * 60_000)) return { key: 'stale', label: CAPABILITY_LABELS.stale, action: 'rescan', reason: 'This recommendation belongs to an expired page snapshot. Rescan before starting a download.' };

  const expiring = isExpiringUrl(item);
  const tooOldForSignedAction = expiring && isOlderThan(item, 2 * 60_000);

  if (item.mediaType === MEDIA_TYPES.DASH) {
    const decision = downloadDecisionFor(item, settings);
    if (decision.allowed) return { key: 'manifest', label: CAPABILITY_LABELS.manifest, action: 'inspect', reason: decision.reason || 'DASH is manifest-only. Media Scout does not fetch segments, decrypt, or merge it.' };
    return { key: 'unsupported', label: CAPABILITY_LABELS.unsupported, action: 'inspect', reason: decision.reason || item.unsupportedReason || 'This DASH manifest cannot be safely saved.' };
  }

  if ([MEDIA_TYPES.STREAM, MEDIA_TYPES.PLAYLIST].includes(item.mediaType)) {
    const decision = downloadDecisionFor(item, settings);
    if (decision.allowed) return { key: 'manifest', label: CAPABILITY_LABELS.manifest, action: 'inspect', reason: decision.reason || 'This is a manifest or stream hint. Inspect evidence before saving anything.' };
    return { key: 'unsupported', label: CAPABILITY_LABELS.unsupported, action: 'inspect', reason: decision.reason || item.unsupportedReason || 'No safe supported manifest action is available.' };
  }

  if (item.mediaType === MEDIA_TYPES.HLS) {
    if (isKnownProtected(item)) return { key: 'unsupported', label: CAPABILITY_LABELS.unsupported, action: 'inspect', reason: item.unsupportedReason || item.safetyWarning || 'This stream is encrypted, DRM-protected, expired, or browser-blocked.' };
    if (expiring || tooOldForSignedAction) return { key: 'expired', label: CAPABILITY_LABELS.expired, action: 'rescan', reason: 'This HLS URL appears signed or short-lived. Rescan before queueing; segment reuse is not allowed for protected links.' };
    const decision = downloadDecisionFor(item, settings, settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4);
    if (decision.allowed) return { key: 'convertible', label: CAPABILITY_LABELS.convertible, action: 'convert', reason: decision.reason || 'HLS playlist can use the safe conversion pipeline.' };
    return { key: 'manifest', label: CAPABILITY_LABELS.manifest, action: 'inspect', reason: decision.reason || item.unsupportedReason || 'Manifest evidence is available, but no safe final-file action is available.' };
  }

  const decision = downloadDecisionFor(item, settings);
  if (tooOldForSignedAction && decision.limited) return { key: 'expired', label: CAPABILITY_LABELS.expired, action: 'rescan', reason: 'This signed or tokenized direct-file URL is no longer fresh. Rescan before queueing.' };
  if (decision.allowed) return { key: 'downloadable', label: CAPABILITY_LABELS.downloadable, action: 'download', reason: decision.reason || (expiring ? 'Top-level signed final media can be passed unchanged to Chrome Downloads while fresh.' : 'Direct browser-visible media file.') };
  if (isKnownProtected(item)) return { key: 'unsupported', label: CAPABILITY_LABELS.unsupported, action: 'inspect', reason: item.unsupportedReason || item.safetyWarning || 'This stream is encrypted, DRM-protected, expired, or browser-blocked.' };
  return { key: 'unsupported', label: CAPABILITY_LABELS.unsupported, action: 'inspect', reason: decision.reason || item.unsupportedReason || 'No safe supported download action is available.' };
}

export function chooseBestCandidate(items = [], settings = {}, options = {}) {
  const list = asArray(items).filter(Boolean);
  if (!list.length) return null;
  const scored = list.map((item, index) => {
    const capability = classifyCandidate(item, settings, options);
    return { item, capability, index, score: candidateScore(item, capability) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return scored[0] || null;
}

function candidateScore(item = {}, capability = {}) {
  let score = 0;
  if (capability.key === 'downloadable') score += 120;
  if (capability.key === 'convertible') score += 110;
  if (capability.key === 'manifest') score += 45;
  if (capability.key === 'unsupported') score -= 80;
  if (item.mediaType === MEDIA_TYPES.HLS) score += 25;
  if (item.mediaType === MEDIA_TYPES.VIDEO) score += 20;
  if (item.mediaType === MEDIA_TYPES.AUDIO) score += 10;
  if (item.mediaType === MEDIA_TYPES.IMAGE) score -= 20;
  if (item.mediaType === MEDIA_TYPES.SEGMENT || item.mediaType === MEDIA_TYPES.METADATA) score -= 60;
  if (item.variants?.length) score += Math.min(20, item.variants.length * 2);
  if (item.resolution) score += 8;
  if (Number(item.sizeBytes) > 0 || Number(item.resourceInfo?.transferSize) > 0) score += 4;
  if (item.downloadAllowed === false) score -= 60;
  if (item.isProtected && !['downloadable', 'manifest'].includes(capability.key)) score -= 100;
  if (isBlobLike(item)) score -= 25;
  return score;
}

export function buildPopupModel(state = {}) {
  const queue = normalizeQueue(state.queue);
  const items = asArray(state.mediaItems);
  const counts = queueCounts(queue);
  const scanBlocked = state.lastScan?.ok === false && !isNavigationResetScan(state.lastScan);
  const navigationReset = state.lastScan?.ok === false && isNavigationResetScan(state.lastScan);
  const hasPermissionOrigin = Boolean(state.siteAccess?.origin);
  const needsPermission = hasPermissionOrigin && state.siteAccess?.granted === false;
  const staleSnapshot = isStaleMedia(items);
  const best = chooseBestCandidate(items, state.settings || {}, { stale: staleSnapshot });
  const queueFocus = activeQueueTask(queue);

  if (counts.active || counts.queued) {
    return {
      kind: 'queue-active',
      tone: 'info',
      title: counts.active ? 'Download in progress' : 'Download waiting in queue',
      body: queueFocus?.displayName || queueFocus?.filename || queueFocus?.mediaTitle || 'A Media Scout download is active.',
      primary: 'Open Queue',
      secondary: counts.active ? 'Inspect all' : 'Rescan current page',
      candidate: best?.item || null,
      capability: best?.capability || null,
      task: queueFocus
    };
  }

  if (scanBlocked) {
    return {
      kind: 'restricted',
      tone: 'danger',
      title: 'Browser page cannot be scanned',
      body: state.lastScan?.message || 'Chrome does not allow extension scanning on this page.',
      primary: 'Open Help',
      secondary: 'Open Options',
      blocker: 'Chrome does not allow extension scanning on this page.'
    };
  }

  if (navigationReset) {
    return {
      kind: 'needs-playback',
      tone: 'warning',
      title: 'Page changed — rescan current tab',
      body: state.lastScan?.message || 'This tab changed. Old detections were cleared so actions cannot use stale media evidence.',
      primary: 'Rescan current page',
      secondary: 'Open Inspector',
      blocker: 'This recommendation belongs to a previous page snapshot.',
      capability: { key: 'stale', label: CAPABILITY_LABELS.stale }
    };
  }

  if (staleSnapshot) {
    return {
      kind: 'needs-playback',
      tone: 'warning',
      title: 'Snapshot expired — rescan current tab',
      body: 'Media evidence is old enough that actions are disabled until the current page is scanned again.',
      primary: 'Rescan current page',
      secondary: 'Open Inspector',
      blocker: 'This recommendation belongs to an expired page snapshot.',
      candidate: best?.item || null,
      capability: { key: 'stale', label: CAPABILITY_LABELS.stale }
    };
  }

  if (!items.length) {
    return {
      kind: 'needs-playback',
      tone: 'neutral',
      title: 'Play the media, then rescan',
      body: needsPermission ? 'The page has not exposed a browser-visible media request yet. Site access may improve network detection if playback does not surface candidates.' : 'The page has not exposed a browser-visible media request yet.',
      primary: 'Play video then rescan',
      secondary: needsPermission ? 'Allow on this site' : 'Open Inspector',
      blocker: 'Page has not exposed media requests yet.',
      capability: { key: 'playback', label: CAPABILITY_LABELS.playback }
    };
  }

  if (best?.capability?.key === 'downloadable') {
    return {
      kind: 'ready-direct',
      tone: 'success',
      title: 'Best candidate is ready',
      body: summarizeCandidate(best.item),
      primary: 'Download',
      secondary: 'Inspect all',
      candidate: best.item,
      capability: best.capability
    };
  }

  if (best?.capability?.key === 'convertible') {
    return {
      kind: 'ready-hls',
      tone: 'success',
      title: 'Safe HLS conversion available',
      body: summarizeCandidate(best.item),
      primary: 'Convert',
      secondary: 'Open Inspector',
      candidate: best.item,
      capability: best.capability
    };
  }

  return {
    kind: 'unsupported',
    tone: 'warning',
    title: 'No safe final-file action yet',
    body: best?.capability?.reason || 'Media was found, but the safe action is limited to evidence review.',
    primary: 'Open Inspector',
    secondary: 'Save redacted report',
    blocker: 'This stream is encrypted, DRM-protected, expired, or browser-blocked.',
    candidate: best?.item || null,
    capability: best?.capability || { key: 'unsupported', label: CAPABILITY_LABELS.unsupported }
  };
}


function isNavigationResetScan(scan = {}) {
  return /navigated|navigation|cleared stale|previous page/i.test(String(scan.message || ''));
}

export function summarizeCandidate(item = {}) {
  const parts = [];
  const type = mediaTypeLabel(item.mediaType);
  if (type) parts.push(type);
  if (item.resolution) parts.push(item.resolution);
  const selected = item.playlist?.selectedVariantResolution || item.variants?.[0]?.resolution;
  if (selected && selected !== item.resolution) parts.push(selected);
  const segmentCount = item.playlist?.segmentCount;
  if (Number.isFinite(Number(segmentCount))) parts.push(`${segmentCount} segment${Number(segmentCount) === 1 ? '' : 's'}`);
  const size = item.sizeBytes || item.resourceInfo?.transferSize;
  if (Number(size) > 0) parts.push(formatBytes(Number(size)));
  const host = item.hostname || getHostname(item.url);
  if (host) parts.push(redactHost(host));
  return parts.join(' • ') || 'browser-visible media candidate';
}

export function mediaTypeLabel(type = '') {
  return {
    [MEDIA_TYPES.HLS]: 'HLS playlist',
    [MEDIA_TYPES.VIDEO]: 'Video file',
    [MEDIA_TYPES.AUDIO]: 'Audio file',
    [MEDIA_TYPES.DASH]: 'DASH manifest',
    [MEDIA_TYPES.STREAM]: 'Stream hint',
    [MEDIA_TYPES.SEGMENT]: 'Segment',
    [MEDIA_TYPES.SUBTITLE]: 'Subtitle',
    [MEDIA_TYPES.IMAGE]: 'Image',
    [MEDIA_TYPES.PLAYLIST]: 'Playlist',
    [MEDIA_TYPES.METADATA]: 'Metadata hint'
  }[type] || 'Media candidate';
}

export function statusLabel(status = '') {
  return String(status || 'detected').replace(/-/g, ' ');
}

export function statusTone(status = '', item = {}) {
  if (status === DOWNLOAD_STATUSES.COMPLETED) return 'success';
  if (status === DOWNLOAD_STATUSES.VERIFY_UNCERTAIN) return 'warning';
  if (status === DOWNLOAD_STATUSES.FAILED || status === DOWNLOAD_STATUSES.ENCRYPTED || (item.isProtected && !item.downloadAllowed)) return 'danger';
  if ([DOWNLOAD_STATUSES.ACTIVE, DOWNLOAD_STATUSES.QUEUED, DOWNLOAD_STATUSES.CONVERTING, DOWNLOAD_STATUSES.RETRIED].includes(status)) return 'warning';
  if (status === DOWNLOAD_STATUSES.CANCELED) return 'muted';
  return 'info';
}

export function redactedUrl(rawUrl = '') {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    const filename = url.pathname.split('/').filter(Boolean).pop() || '';
    const path = filename ? `/…/${filename.slice(0, 72)}` : '/…';
    return `${url.protocol}//${url.hostname}${path}${url.search ? '?…' : ''}`;
  } catch (_error) {
    if (String(rawUrl).startsWith('blob:')) return 'blob: page-local stream';
    return String(rawUrl).slice(0, 88);
  }
}

export function redactHost(host = '') {
  return String(host || '').replace(/^(www\.)/i, '');
}

export function freshnessLabel(timestamp) {
  const date = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(date)) return 'Now';
  const ageMs = Math.max(0, Date.now() - date);
  if (ageMs < 10_000) return 'Now';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 10 * 60_000) return `${Math.round(ageMs / 60_000)}m ago`;
  return 'Expired';
}

export function newestMediaTimestamp(items = []) {
  const times = asArray(items).map((item) => Date.parse(item.updatedAt || item.detectedAt || '')).filter(Number.isFinite);
  if (!times.length) return '';
  return new Date(Math.max(...times)).toISOString();
}

export function isStaleMedia(items = []) {
  const timestamp = newestMediaTimestamp(items);
  if (!timestamp) return false;
  const ageMs = Date.now() - Date.parse(timestamp);
  return ageMs > 10 * 60_000;
}

export function groupCandidates(items = [], settings = {}) {
  const order = [MEDIA_TYPES.HLS, MEDIA_TYPES.VIDEO, MEDIA_TYPES.AUDIO, MEDIA_TYPES.DASH, MEDIA_TYPES.STREAM, MEDIA_TYPES.PLAYLIST, MEDIA_TYPES.SUBTITLE, MEDIA_TYPES.IMAGE, MEDIA_TYPES.SEGMENT, MEDIA_TYPES.METADATA, MEDIA_TYPES.UNKNOWN];
  const groups = new Map();
  for (const item of asArray(items)) {
    const key = item.mediaType || MEDIA_TYPES.UNKNOWN;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return Array.from(groups.entries())
    .sort((a, b) => orderIndex(order, a[0]) - orderIndex(order, b[0]))
    .map(([key, groupItems]) => ({ key, label: mediaGroupLabel(key), items: groupItems.sort((a, b) => sortCandidates(a, b, settings)) }));
}

export function mediaGroupLabel(group) {
  return {
    [MEDIA_TYPES.HLS]: 'HLS playlists',
    [MEDIA_TYPES.VIDEO]: 'Video files',
    [MEDIA_TYPES.AUDIO]: 'Audio files',
    [MEDIA_TYPES.DASH]: 'DASH manifests',
    [MEDIA_TYPES.STREAM]: 'Other stream hints',
    [MEDIA_TYPES.PLAYLIST]: 'Playlists',
    [MEDIA_TYPES.SEGMENT]: 'Segments and internals',
    [MEDIA_TYPES.SUBTITLE]: 'Subtitles and tracks',
    [MEDIA_TYPES.IMAGE]: 'Images and posters',
    [MEDIA_TYPES.METADATA]: 'Metadata hints',
    [MEDIA_TYPES.UNKNOWN]: 'Other media'
  }[group] || 'Other media';
}

export function candidateFacts(item = {}) {
  const rows = [];
  if (item.resolution) rows.push(['Resolution', item.resolution]);
  if (item.mediaInfo?.resolution && item.mediaInfo.resolution !== item.resolution) rows.push(['Player size', item.mediaInfo.resolution]);
  if (item.mediaDuration) rows.push(['Duration', formatDuration(item.mediaDuration)]);
  if (item.sizeBytes) rows.push(['Size', formatBytes(item.sizeBytes)]);
  if (item.resourceInfo?.transferSize) rows.push(['Transfer', formatBytes(item.resourceInfo.transferSize)]);
  if (item.source) rows.push(['Detected by', sourceLabel(item.source)]);
  if (item.frameId != null) rows.push(['Frame', item.frameId]);
  if (item.frameUrl) rows.push(['Frame host', getHostname(item.frameUrl) || 'frame']);
  if (item.variants?.length) rows.push(['Variants', item.variants.length]);
  if (item.representations?.length) rows.push(['Representations', item.representations.length]);
  if (item.playlist?.selectedVariantResolution) rows.push(['Selected variant', item.playlist.selectedVariantResolution]);
  if (item.playlist?.segmentCount != null) rows.push(['Segments', `${item.playlist.segmentCount}${item.playlist.exactSegmentCount === false ? ' (unverified)' : ''}`]);
  if (item.mime) rows.push(['MIME', item.mime]);
  return rows.filter(([, value]) => value != null && value !== '');
}

export function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '';
  const rounded = Math.round(value);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function sourceLabel(source = '') {
  return String(source || '').replace('dom-', 'page ').replace('response-header', 'headers').replace(/-/g, ' ');
}

export function taskVisibleCopy(task = {}) {
  const status = task.status || 'queued';
  const copy = {
    queued: 'Waiting in queue',
    active: 'Downloading',
    converting: 'Converting',
    completed: 'Saved',
    failed: 'Needs attention',
    canceled: 'Canceled',
    'verify-uncertain': 'Verify uncertain',
    retried: 'Retrying',
    interrupted: 'Interrupted',
    detected: 'Detected'
  }[status] || statusLabel(status);
  return task.phase ? `${copy} • ${String(task.phase).replace(/-/g, ' ')}` : copy;
}

export function filenamePreview(item = {}, settings = {}) {
  const extension = outputExtensionForPreview(item, settings);
  const tabTitle = cleanFilename(settings?.tabTitle || item.mediaTitle || item.title || 'media');
  const host = cleanFilename(item.hostname || getHostname(item.url) || 'site');
  const template = settings?.filenameTemplate || '{tabTitle}{indexSuffix}.{extension}';
  const preview = template
    .replaceAll('{tabTitle}', tabTitle)
    .replaceAll('{rawTabTitle}', tabTitle)
    .replaceAll('{hostname}', host)
    .replaceAll('{resolution}', cleanFilename(item.resolution || ''))
    .replaceAll('{date}', new Date().toISOString().slice(0, 10))
    .replaceAll('{index}', '1')
    .replaceAll('{indexSuffix}', '')
    .replaceAll('{extension}', extension);
  return cleanFilename(preview || `media.${extension}`);
}

function outputExtensionForPreview(item = {}, settings = {}) {
  if (item.extension && item.mediaType !== MEDIA_TYPES.HLS) return item.extension;
  if (item.mediaType !== MEDIA_TYPES.HLS) return item.extension || 'media';
  const method = settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4;
  if ([HLS_OUTPUT_METHODS.TS_CONCAT, HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS].includes(method)) return 'ts';
  if (method === HLS_OUTPUT_METHODS.PLAYLIST_ONLY) return 'm3u8';
  if (method === HLS_OUTPUT_METHODS.EXTERNAL_HELPER) return 'txt';
  return 'mp4';
}

function cleanFilename(value = '') {
  return String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'media';
}

function sortCandidates(a = {}, b = {}, settings = {}) {
  const ac = classifyCandidate(a, settings).key;
  const bc = classifyCandidate(b, settings).key;
  const ar = ac === 'downloadable' || ac === 'convertible' ? 0 : ac === 'manifest' ? 1 : 2;
  const br = bc === 'downloadable' || bc === 'convertible' ? 0 : bc === 'manifest' ? 1 : 2;
  return ar - br || String(a.hostname || '').localeCompare(String(b.hostname || '')) || String(a.url || '').localeCompare(String(b.url || ''));
}

function isKnownProtected(item = {}) {
  return Boolean(item.isProtected && !item.downloadAllowed) || [DOWNLOAD_STATUSES.ENCRYPTED, DOWNLOAD_STATUSES.UNSUPPORTED].includes(item.status) || /encrypted|drm|paywall|auth|cors|protected|access-control/i.test(`${item.unsupportedReason || ''} ${item.safetyWarning || ''}`);
}

function isExpiringUrl(item = {}) {
  const text = `${item.url || ''} ${item.normalizedUrl || ''}`;
  return /([?&](expires|expiry|exp|signature|sig|token|policy|x-amz|x-goog|key-pair-id)=)/i.test(text);
}

function isBlobLike(item = {}) {
  return String(item.url || '').startsWith('blob:') || Boolean(item.probableMseBlob) || Boolean(item.mediaInfo?.likelyMseBlob);
}

function isOlderThan(item = {}, maxAgeMs = 0) {
  const timestamp = Date.parse(item.updatedAt || item.detectedAt || '');
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp > maxAgeMs;
}

function asArray(value) { return Array.isArray(value) ? value : []; }
function orderIndex(order, key) { const index = order.indexOf(key); return index < 0 ? 999 : index; }
