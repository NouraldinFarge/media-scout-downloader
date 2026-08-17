import {
  DEFAULT_SETTINGS,
  DOWNLOAD_STATUSES,
  ERROR_CATEGORIES,
  HLS_OUTPUT_METHODS,
  HLS_VARIANT_PREFERENCES,
  IMPLEMENTED_HLS_OUTPUT_METHODS,
  MEDIA_TYPES,
  SOURCES,
  STRATEGY_NAMES
} from './constants.js';
import { registryEntryForExtension, registryEntryForMime } from './media-type-registry.js';
import { createStructuredError } from './utils.js';
import { isBlobUrl, isExtensionEnabled, isHttpUrl, isSafeUrlScheme, looksSignedOrExpiring } from './validators.js';

const ALLOW = true;
const DENY = false;
const STANDALONE_TRANSPORT_STREAM_MIN_BYTES = 8 * 1024 * 1024;
const TRANSPORT_STREAM_EXTENSIONS = new Set(['ts', 'm2ts', 'mts']);
const FINAL_FILE_EVIDENCE_MIN_BYTES = 2 * 1024 * 1024;
const STRONG_FINAL_FILE_EVIDENCE_MIN_BYTES = 8 * 1024 * 1024;
const RANGE_FINAL_FILE_EVIDENCE_MIN_BYTES = 2 * 1024 * 1024;
const GENERIC_BINARY_MIME_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/download']);
const HARD_NON_MEDIA_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const STRUCTURED_NON_MEDIA_MIME_TYPES = new Set(['application/json', 'text/json', 'application/xml', 'text/xml', 'application/javascript', 'text/javascript']);

const ACTION_LABELS = Object.freeze({
  'save-final-media': 'Save final media file',
  'save-transport-stream-file': 'Save standalone MPEG-TS file',
  'save-page-blob': 'Save page-local blob file',
  'merge-hls': 'Merge/remux HLS to media file',
  'save-hls-playlist': 'Save HLS playlist file',
  'save-dash-manifest': 'Save DASH manifest file',
  'save-manifest-file': 'Save manifest/playlist file',
  'save-raw-segment': 'Save raw stream segment',
  'save-companion-file': 'Save image/subtitle companion file',
  'save-metadata-file': 'Save media metadata file',
  'hls-helper-notes': 'Create HLS helper notes',
  unsupported: 'Unsupported action'
});

export function getDownloadAllowDecision(media = {}, options = {}) {
  if (!media || typeof media !== 'object') return deny('missing-media', 'No media item was supplied.', ERROR_CATEGORIES.VALIDATION);
  const method = normalizeHlsMethod(options.hlsOutputMethod || media.hlsOutputMethod || options.settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4);
  const url = String(media.url || media.normalizedUrl || '').trim();
  const declaredMediaType = effectiveMediaType(media);
  const mediaType = resolveAllowListMediaType(media, declaredMediaType);

  if (!url) return deny('missing-url', 'This item does not expose a downloadable URL.', ERROR_CATEGORIES.VALIDATION);
  const unavailablePerformanceResource = performanceResourceFailureDecision(media);
  if (unavailablePerformanceResource) return unavailablePerformanceResource;

  if (mediaType === MEDIA_TYPES.HLS) return hlsDecision(media, method, options);
  if (mediaType === MEDIA_TYPES.DASH) return dashManifestDecision(media, options);
  if (mediaType === MEDIA_TYPES.STREAM || mediaType === MEDIA_TYPES.PLAYLIST) return manifestFileDecision(media, options);
  if (mediaType === MEDIA_TYPES.SEGMENT && hasFinalFileEvidenceForSegment(media)) return finalFileSegmentOverrideDecision(media, options);
  if (mediaType === MEDIA_TYPES.SEGMENT) return segmentDecision(media, options);
  if (mediaType === MEDIA_TYPES.VIDEO || mediaType === MEDIA_TYPES.AUDIO) return progressiveMediaDecision(media, options);
  if (mediaType === MEDIA_TYPES.SUBTITLE || mediaType === MEDIA_TYPES.IMAGE) return companionFileDecision({ ...media, mediaType }, options);
  if (mediaType === MEDIA_TYPES.METADATA) return metadataFileDecision({ ...media, mediaType }, options);
  return deny('media-type-not-allowed', 'This detected item is not on the download allow list.', ERROR_CATEGORIES.UNSUPPORTED, { action: 'unsupported' });
}

function performanceResourceFailureDecision(media = {}) {
  if (media.source !== SOURCES.PERFORMANCE || !/^(?:fetch|xmlhttprequest)$/i.test(String(media.initiatorType || media.resourceInfo?.initiatorType || ''))) return null;
  const info = media.resourceInfo;
  const responseStatus = Number(info?.responseStatus);
  if (Number.isInteger(responseStatus) && responseStatus >= 400 && responseStatus <= 599) {
    const authenticationRequired = responseStatus === 401 || responseStatus === 407;
    const accessDenied = responseStatus === 403;
    const code = authenticationRequired
      ? 'performance-resource-authentication-response'
      : accessDenied
        ? 'performance-resource-access-denied-response'
        : 'performance-resource-http-error-response';
    const category = authenticationRequired
      ? ERROR_CATEGORIES.AUTHENTICATION
      : accessDenied
        ? ERROR_CATEGORIES.ACCESS_CONTROL
        : ERROR_CATEGORIES.NETWORK;
    return deny(code, `The page fetch returned HTTP ${responseStatus} instead of a successful media response, so Media Scout will not hand this URL to Chrome Downloads.`, category, { action: 'save-final-media', confidence: 'high', riskFlags: ['http-error-response', `http-status-${responseStatus}`] });
  }
  if (!info || info.encodedBodySize == null || info.decodedBodySize == null || !Number.isFinite(Number(info.encodedBodySize)) || !Number.isFinite(Number(info.decodedBodySize))) return null;
  if (Number(info.encodedBodySize) !== 0 || Number(info.decodedBodySize) !== 0) return null;
  const transferSize = Number(info.transferSize);
  const nextHopProtocol = String(info.nextHopProtocol || '').trim();
  if (Number.isFinite(transferSize) && transferSize === 0 && !nextHopProtocol) {
    return deny('browser-blocked-performance-resource', 'The page fetch produced no browser-readable response. CORS, network, or access-control policy may have blocked it, so Media Scout will not hand this URL to Chrome Downloads.', ERROR_CATEGORIES.CORS, { action: 'save-final-media', confidence: 'high', riskFlags: ['zero-body-performance-resource', 'browser-blocked-fetch'] });
  }
  return deny('empty-performance-resource', 'The page fetch completed with an empty response body, so Media Scout will not present it as a downloadable media file.', ERROR_CATEGORIES.NETWORK, { action: 'save-final-media', confidence: 'high', riskFlags: ['zero-body-performance-resource', 'empty-response'] });
}

export function buildDownloadAllowSummary(media = {}, settings = {}) {
  if (media?.mediaType === MEDIA_TYPES.HLS) {
    const methods = Object.fromEntries(IMPLEMENTED_HLS_OUTPUT_METHODS.map((method) => [method, getDownloadAllowDecision(media, { settings, hlsOutputMethod: method })]));
    const primaryMethod = normalizeHlsMethod(settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4);
    const primary = methods[primaryMethod] || methods[HLS_OUTPUT_METHODS.SMART_MP4] || Object.values(methods)[0];
    const decisions = Object.entries(methods).map(([method, decision]) => ({ method, ...publicDecision(decision) }));
    const allowed = decisions.some((decision) => decision.allowed);
    return {
      allowed,
      primaryMethod,
      primaryAllowed: Boolean(primary?.allowed),
      code: primary?.code || (allowed ? 'some-hls-method-allowed' : 'hls-not-allowed'),
      reason: primary?.reason || (allowed ? 'At least one HLS action is allowed.' : 'No HLS action is allowed.'),
      limited: decisions.some((decision) => decision.allowed && decision.limited),
      allowedActionCount: decisions.filter((decision) => decision.allowed).length,
      blockedActionCount: decisions.filter((decision) => !decision.allowed).length,
      methods,
      decisions
    };
  }
  const direct = getDownloadAllowDecision(media, { settings });
  return {
    allowed: direct.allowed,
    primaryAllowed: direct.allowed,
    code: direct.code,
    reason: direct.reason,
    limited: Boolean(direct.limited),
    allowedActionCount: direct.allowed ? 1 : 0,
    blockedActionCount: direct.allowed ? 0 : 1,
    methods: { direct },
    decisions: [{ method: 'direct', ...publicDecision(direct) }]
  };
}

export function createDownloadPolicyError(decision = {}) {
  return createStructuredError(
    decision.category || ERROR_CATEGORIES.UNSUPPORTED,
    decision.code || 'download-not-allowed',
    decision.reason || 'This item is not allowed by the download policy.',
    { allowRule: decision.ruleId || '', strategy: decision.strategy || '', hlsOutputMethod: decision.hlsOutputMethod || '', action: decision.action || '' }
  );
}



function resolveAllowListMediaType(media = {}, declared = MEDIA_TYPES.UNKNOWN) {
  if ([MEDIA_TYPES.HLS, MEDIA_TYPES.DASH, MEDIA_TYPES.STREAM, MEDIA_TYPES.PLAYLIST].includes(declared)) return declared;
  const inferredFinal = inferFinalMediaType(media);
  if (!inferredFinal) return declared;
  if (declared === MEDIA_TYPES.SEGMENT) return declared;
  if ([MEDIA_TYPES.UNKNOWN, MEDIA_TYPES.IMAGE, MEDIA_TYPES.SUBTITLE, MEDIA_TYPES.METADATA].includes(declared)) {
    if (hasFinalFileResponseEvidence(media) || hasClearFinalMediaMime(media) || hasFilenameFinalMediaHint(media)) return inferredFinal;
  }
  return declared;
}

function effectiveMediaType(media = {}) {
  const declared = media.mediaType || MEDIA_TYPES.UNKNOWN;
  if (declared && declared !== MEDIA_TYPES.UNKNOWN) return declared;
  const extension = String(media.extension || '').toLowerCase().replace(/^\./, '');
  const registry = extension && extension !== 'media' ? registryEntryForExtension(extension) : null;
  if (registry?.group) return registry.group;
  const filenameRegistry = registryEntryFromFilenameHints(media);
  if (filenameRegistry?.group) return filenameRegistry.group;
  const mimeRegistry = registryEntryForMime(media.mime || media.type || media.declaredType || '');
  return mimeRegistry?.group || MEDIA_TYPES.UNKNOWN;
}

function registryEntryFromFilenameHints(media = {}) {
  const extension = filenameHintExtension(media);
  return extension ? registryEntryForExtension(extension) : null;
}

function filenameHintExtension(media = {}) {
  const candidates = [
    filenameFromContentDisposition(media.contentDisposition || ''),
    media.filename,
    media.fileName,
    media.outputFilename
  ];
  for (const candidate of candidates) {
    const extension = extensionFromFilename(candidate);
    if (extension) return extension;
  }
  return '';
}

function filenameFromContentDisposition(disposition = '') {
  const value = String(disposition || '');
  if (!value) return '';
  const star = /filename\*\s*=\s*(?:UTF-8''|)([^;]+)/i.exec(value);
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(value);
  const raw = (star?.[1] || plain?.[1] || plain?.[2] || '').trim();
  if (!raw) return '';
  const stripped = raw.replace(/^['"]|['"]$/g, '');
  try {
    return decodeURIComponent(stripped);
  } catch (_error) {
    return stripped;
  }
}

function extensionFromFilename(filename = '') {
  const clean = String(filename || '').split(/[?#]/)[0].trim();
  const base = clean.split(/[\\/]/).pop() || '';
  const match = /\.([a-z0-9]{1,8})$/i.exec(base);
  return match ? match[1].toLowerCase() : '';
}

function progressiveMediaDecision(media, options) {
  const blobDecision = blobMediaDecision(media);
  if (blobDecision) return blobDecision;
  const base = safeDirectUrlDecision(media, options, {
    requireEnabledExtension: true,
    allowSignedTopLevel: true,
    expectedGroups: [MEDIA_TYPES.VIDEO, MEDIA_TYPES.AUDIO],
    action: 'save-final-media'
  });
  if (!base.allowed) return base;
  if (hasHardProtectionMarker(media, { allowSignedOnly: true })) {
    return deny('protected-final-media', protectionReason(media) || 'This media file is marked encrypted, DRM-restricted, authentication-gated, paywalled, or access-controlled.', ERROR_CATEGORIES.ACCESS_CONTROL, { action: 'save-final-media' });
  }
  if (base.topLevelSigned || isSignedOnlyProtectionMarker(media)) {
    return allow('signed-top-level-final-media', 'Top-level signed/tokenized final media file is allowed as a direct Chrome download. Media Scout will pass the URL through unchanged and will not reuse it as a stream component.', STRATEGY_NAMES.DIRECT_FILE, { ruleId: 'progressive-final-media', action: 'save-final-media', fileRole: 'final-media', outputKind: 'final-media', limited: true, topLevelSigned: true, confidence: 'medium', evidenceLevel: base.evidenceLevel, evidenceFlags: base.evidenceFlags, inferredExtension: base.inferredExtension || '', riskFlags: buildRiskFlags(media, { topLevelSigned: true }) });
  }
  return allow('progressive-media-file', 'Progressive audio/video file is on the allow list for direct browser download.', STRATEGY_NAMES.DIRECT_FILE, { ruleId: 'progressive-final-media', action: 'save-final-media', fileRole: 'final-media', outputKind: 'final-media', confidence: base.evidenceLevel || 'high', evidenceLevel: base.evidenceLevel, evidenceFlags: base.evidenceFlags, inferredExtension: base.inferredExtension || '', riskFlags: buildRiskFlags(media) });
}

function metadataFileDecision(media, options) {
  const base = safeDirectUrlDecision(media, options, {
    requireEnabledExtension: true,
    allowSignedTopLevel: true,
    expectedGroups: [MEDIA_TYPES.METADATA],
    action: 'save-metadata-file'
  });
  if (!base.allowed) return base;
  if (hasHardProtectionMarker(media, { allowSignedOnly: true })) {
    return deny('protected-metadata-file', protectionReason(media) || 'This metadata file is marked authentication-gated, paywalled, or access-controlled.', ERROR_CATEGORIES.ACCESS_CONTROL, { action: 'save-metadata-file' });
  }
  return allow(
    base.topLevelSigned || isSignedOnlyProtectionMarker(media) ? 'signed-top-level-metadata-file' : 'metadata-file',
    base.topLevelSigned || isSignedOnlyProtectionMarker(media)
      ? 'Top-level signed/tokenized metadata file is allowed as a direct Chrome download. Media Scout will pass the URL through unchanged.'
      : 'User-enabled media metadata file is on the allow list for direct browser download.',
    STRATEGY_NAMES.DIRECT_FILE,
    { ruleId: 'metadata-file', action: 'save-metadata-file', fileRole: 'metadata-file', outputKind: 'metadata-file', limited: Boolean(base.topLevelSigned || isSignedOnlyProtectionMarker(media)), topLevelSigned: Boolean(base.topLevelSigned), confidence: base.topLevelSigned ? 'medium' : 'high', riskFlags: buildRiskFlags(media, { topLevelSigned: Boolean(base.topLevelSigned) }) }
  );
}

function companionFileDecision(media, options) {
  const base = safeDirectUrlDecision(media, options, {
    requireEnabledExtension: true,
    allowSignedTopLevel: true,
    expectedGroups: [MEDIA_TYPES.SUBTITLE, MEDIA_TYPES.IMAGE],
    action: 'save-companion-file'
  });
  if (!base.allowed) return base;
  if (hasHardProtectionMarker(media, { allowSignedOnly: true })) {
    return deny('protected-companion-file', protectionReason(media) || 'This companion file is marked authentication-gated, paywalled, or access-controlled.', ERROR_CATEGORIES.ACCESS_CONTROL, { action: 'save-companion-file' });
  }
  if (base.topLevelSigned || isSignedOnlyProtectionMarker(media)) {
    return allow('signed-top-level-companion-file', 'Top-level signed/tokenized image or subtitle file is allowed as a direct Chrome download. Media Scout will pass the URL through unchanged.', STRATEGY_NAMES.DIRECT_FILE, { ruleId: 'companion-file', action: 'save-companion-file', fileRole: 'companion-file', outputKind: 'companion-file', limited: true, topLevelSigned: true, confidence: 'medium', riskFlags: buildRiskFlags(media, { topLevelSigned: true }) });
  }
  return allow('companion-file', 'Image/subtitle companion file is on the allow list for direct browser download.', STRATEGY_NAMES.DIRECT_FILE, { action: 'save-companion-file', fileRole: 'companion-file', outputKind: 'companion-file', confidence: 'high', riskFlags: buildRiskFlags(media) });
}


function finalFileSegmentOverrideDecision(media, options = {}) {
  const inferredType = inferFinalMediaType(media) || MEDIA_TYPES.VIDEO;
  const decision = progressiveMediaDecision({ ...media, mediaType: inferredType, extension: 'media', segmentFinalFileOverride: true }, options);
  if (!decision.allowed) return segmentDecision(media, options);
  const signed = Boolean(decision.topLevelSigned || isSignedOnlyProtectionMarker(media));
  return {
    ...decision,
    code: signed ? 'signed-final-file-evidence-override' : 'final-file-evidence-override',
    reason: signed
      ? 'This item looked like a stream segment by URL, but response evidence points to a standalone top-level media file. The signed URL is passed unchanged to Chrome Downloads and is not reused as a stream component.'
      : 'This item looked like a stream segment by URL, but response evidence points to a standalone top-level media file, so it is allowed as a normal direct media download.',
    ruleId: 'progressive-final-media',
    action: 'save-final-media',
    fileRole: 'final-media',
    outputKind: 'final-media',
    limited: Boolean(decision.limited || signed),
    confidence: signed ? 'medium' : 'conditional',
    evidenceLevel: decision.evidenceLevel || (signed ? 'medium' : 'conditional'),
    evidenceFlags: Array.isArray(decision.evidenceFlags) ? decision.evidenceFlags.concat(['segment-final-file-override']).slice(0, 10) : ['segment-final-file-override'],
    riskFlags: buildRiskFlags(media, { topLevelSigned: signed }).concat(['segment-final-file-override']).slice(0, 8)
  };
}

function hasFinalFileEvidenceForSegment(media = {}) {
  const extension = String(media.extension || '').toLowerCase().replace(/^\./, '');
  if (extension === 'part') return false;
  if (media.playlist || media.playlistProbe || /hls|m3u8|segment-host|encrypted|playlist/i.test(protectionReason(media))) return false;
  if (hasHardProtectionMarker(media, { allowSignedOnly: true }) && !isSignedOnlyProtectionMarker(media)) return false;
  const finalType = inferFinalMediaType(media);
  if (!finalType) return false;
  if (media.hasAttachmentDisposition || /\battachment\b/i.test(String(media.contentDisposition || ''))) return true;
  if ([SOURCES.DOM_VIDEO, SOURCES.DOM_AUDIO, SOURCES.DOM_SOURCE].includes(media.source)) return true;
  if (Array.isArray(media.detectionMethods) && media.detectionMethods.some((method) => /dom-(video|audio|source)|html-media/i.test(String(method)))) return true;
  const sizeBytes = Number(media.sizeBytes || media.resourceInfo?.transferSize || media.resourceInfo?.encodedBodySize || 0);
  const duration = Number(media.mediaDuration || media.mediaInfo?.duration || 0);
  const rangeTotal = Number(media.responseHeaders?.contentRangeTotal || 0);
  const acceptRanges = /bytes/i.test(String(media.responseHeaders?.acceptRanges || ''));
  if (rangeTotal >= RANGE_FINAL_FILE_EVIDENCE_MIN_BYTES && (acceptRanges || /bytes\s+\d+\s*-\s*\d+\s*\//i.test(String(media.responseHeaders?.contentRange || '')))) return true;
  return sizeBytes >= FINAL_FILE_EVIDENCE_MIN_BYTES || duration >= 30;
}

function inferFinalMediaType(media = {}) {
  const mimeRegistry = registryEntryForMime(media.mime || media.type || media.declaredType || '');
  if ([MEDIA_TYPES.VIDEO, MEDIA_TYPES.AUDIO].includes(mimeRegistry?.group)) return mimeRegistry.group;
  const filenameRegistry = registryEntryFromFilenameHints(media);
  if ([MEDIA_TYPES.VIDEO, MEDIA_TYPES.AUDIO].includes(filenameRegistry?.group)) return filenameRegistry.group;
  return null;
}

function segmentDecision(media, options) {
  const standaloneTs = isProbableStandaloneTransportStream(media);
  const base = safeDirectUrlDecision(media, options, {
    requireEnabledExtension: true,
    allowSignedTopLevel: standaloneTs,
    expectedGroups: [MEDIA_TYPES.SEGMENT],
    action: standaloneTs ? 'save-transport-stream-file' : 'save-raw-segment'
  });
  if (!base.allowed) return base;
  if (hasHardProtectionMarker(media, { allowSignedOnly: standaloneTs })) return deny('protected-segment', protectionReason(media) || 'This segment is associated with an encrypted/protected stream and is not downloaded separately.', ERROR_CATEGORIES.ACCESS_CONTROL, { action: standaloneTs ? 'save-transport-stream-file' : 'save-raw-segment', confidence: 'high', riskFlags: streamAssociationRiskFlags(media) });
  if (standaloneTs) {
    return allow(
      base.topLevelSigned || isSignedOnlyProtectionMarker(media) ? 'signed-standalone-transport-stream-file' : 'standalone-transport-stream-file',
      base.topLevelSigned || isSignedOnlyProtectionMarker(media)
        ? 'This MPEG-TS item has strong standalone-file hints, so the signed top-level URL can be passed unchanged to Chrome Downloads. It is not treated as an HLS segment for merging.'
        : 'This MPEG-TS item has strong standalone-file hints and is allowed as an original transport-stream file.',
      STRATEGY_NAMES.DIRECT_FILE,
      { ruleId: 'standalone-transport-stream-file', action: 'save-transport-stream-file', fileRole: 'final-media', outputKind: 'transport-stream-file', limited: Boolean(base.topLevelSigned || isSignedOnlyProtectionMarker(media)), topLevelSigned: Boolean(base.topLevelSigned), confidence: base.topLevelSigned ? 'medium' : 'high', riskFlags: buildRiskFlags(media, { topLevelSigned: Boolean(base.topLevelSigned), standaloneTs: true }) }
    );
  }
  if (String(media.extension || '').toLowerCase() === 'part') return deny('low-latency-part-segment', 'Low-latency HLS .part fragments are not useful standalone downloads and are not on the allow list.', ERROR_CATEGORIES.UNSUPPORTED, { action: 'save-raw-segment', confidence: 'high', fallbackAction: 'save-hls-playlist' });
  return allow('raw-segment-file', 'Raw segment URL is downloadable as a file, but it is not treated as an assembled video.', STRATEGY_NAMES.DIRECT_FILE, { ruleId: 'standalone-segment-fragment', action: 'save-raw-segment', fileRole: 'stream-component', outputKind: 'raw-segment', confidence: 'medium', riskFlags: buildRiskFlags(media, { streamComponent: true }) });
}

function manifestFileDecision(media, options) {
  const manifestMimeConflict = manifestMimeConflictDecision(media, 'save-manifest-file', 'manifest/playlist');
  if (manifestMimeConflict) return manifestMimeConflict;
  const base = safeDirectUrlDecision(media, options, {
    requireEnabledExtension: true,
    allowSignedTopLevel: true,
    expectedGroups: [MEDIA_TYPES.STREAM, MEDIA_TYPES.PLAYLIST],
    action: 'save-manifest-file'
  });
  if (!base.allowed) return base;
  if (hasHardProtectionMarker(media, { allowSignedOnly: true })) return deny('protected-manifest-file', protectionReason(media) || 'This manifest is marked encrypted, authentication-gated, paywalled, or access-controlled.', ERROR_CATEGORIES.ACCESS_CONTROL, { action: 'save-manifest-file' });
  if (base.topLevelSigned || isSignedOnlyProtectionMarker(media)) {
    return allow('signed-top-level-manifest-file', 'Top-level signed/tokenized manifest URL is allowed for manifest-file saving only. Media Scout will not fetch or reuse component URLs from it.', STRATEGY_NAMES.DIRECT_FILE, { ruleId: 'other-stream-manifest-file', action: 'save-manifest-file', fileRole: 'manifest-file', outputKind: 'manifest-file', limited: true, topLevelSigned: true, confidence: 'medium', riskFlags: buildRiskFlags(media, { topLevelSigned: true }) });
  }
  return allow('manifest-file', 'Streaming manifest/playlist file is on the allow list for direct saving only.', STRATEGY_NAMES.DIRECT_FILE, { ruleId: 'other-stream-manifest-file', action: 'save-manifest-file', fileRole: 'manifest-file', outputKind: 'manifest-file', confidence: 'high', riskFlags: buildRiskFlags(media) });
}

function dashManifestDecision(media, options) {
  const base = safeDirectUrlDecision(media, options, {
    requireEnabledExtension: true,
    allowSignedTopLevel: true,
    expectedGroups: [MEDIA_TYPES.DASH],
    action: 'save-dash-manifest'
  });
  if (!base.allowed) return base;
  const limited = Boolean(media.manifest?.encrypted || media.isProtected || base.topLevelSigned || isSignedOnlyProtectionMarker(media));
  return allow(
    limited ? 'dash-manifest-only-limited' : 'dash-manifest-file',
    limited
      ? 'DASH media may be protected or signed, but the top-level MPD manifest file itself can be saved. Media Scout will not fetch segments, decrypt, or merge it.'
      : 'DASH MPD manifest is on the allow list for direct saving only.',
    STRATEGY_NAMES.DASH_MANIFEST,
    { ruleId: 'dash-manifest-file', action: 'save-dash-manifest', fileRole: 'manifest-file', outputKind: 'manifest-file', limited, topLevelSigned: Boolean(base.topLevelSigned), confidence: base.topLevelSigned || limited ? 'medium' : 'high', riskFlags: buildRiskFlags(media, { topLevelSigned: Boolean(base.topLevelSigned) }) }
  );
}

function hlsDecision(media, method, options) {
  const playlistSaveMethod = method === HLS_OUTPUT_METHODS.PLAYLIST_ONLY;
  const helperMethod = method === HLS_OUTPUT_METHODS.EXTERNAL_HELPER;
  const base = safeTopLevelHttpUrlDecision(media, { allowBlob: false, allowSignedTopLevel: playlistSaveMethod, action: playlistSaveMethod ? 'save-hls-playlist' : 'merge-hls' });
  if (!base.allowed) return withHlsMethod(base, method);
  const manifestMimeConflict = manifestMimeConflictDecision(media, playlistSaveMethod ? 'save-hls-playlist' : 'merge-hls', 'HLS playlist');
  if (manifestMimeConflict) return withHlsMethod(manifestMimeConflict, method);

  if (playlistSaveMethod) {
    return allow(
      media.playlist?.encrypted || media.isProtected || base.topLevelSigned ? 'hls-playlist-file-only-limited' : 'hls-playlist-file',
      media.playlist?.encrypted || media.isProtected || base.topLevelSigned
        ? 'Video conversion may be blocked, protected, or signed, but saving the top-level .m3u8 playlist text is allowed because it does not fetch, decrypt, or merge segments.'
        : 'HLS playlist file is on the allow list for direct saving.',
      STRATEGY_NAMES.HLS_PLAYLIST,
      { ruleId: 'hls-playlist-file', hlsOutputMethod: method, action: 'save-hls-playlist', fileRole: 'manifest-file', outputKind: 'manifest-file', limited: Boolean(media.playlist?.encrypted || media.isProtected || base.topLevelSigned), topLevelSigned: Boolean(base.topLevelSigned), confidence: base.topLevelSigned ? 'medium' : 'high', riskFlags: buildRiskFlags(media, { topLevelSigned: Boolean(base.topLevelSigned) }) }
    );
  }

  if (base.topLevelSigned || topLevelUrlLooksProtected(media) || isSignedOnlyProtectionMarker(media)) {
    return deny('protected-hls-playlist-url-for-merge', 'The HLS playlist URL is signed, expiring, or tokenized. Saving the M3U8 file may be allowed, but Media Scout will not fetch or merge its segments.', ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL, { hlsOutputMethod: method, action: helperMethod ? 'hls-helper-notes' : 'merge-hls' });
  }

  if (helperMethod) {
    if (hasKnownHlsProtection(media)) return deny('hls-helper-protected', protectionReason(media) || 'External helper notes are not generated for encrypted/protected HLS.', ERROR_CATEGORIES.ACCESS_CONTROL, { hlsOutputMethod: method, action: 'hls-helper-notes' });
    return allow('hls-external-helper-notes', 'External helper notes are allowed for non-protected HLS only.', STRATEGY_NAMES.HLS_EXTERNAL_HELPER, { ruleId: 'hls-external-helper-notes', hlsOutputMethod: method, action: 'hls-helper-notes', fileRole: 'helper-notes', outputKind: 'helper-notes' });
  }

  if (media.playlist?.encrypted || media.status === DOWNLOAD_STATUSES.ENCRYPTED) return deny('encrypted-hls-merge', 'Encrypted HLS is not eligible for video download or segment merge. Use M3U8 only to save playlist text.', ERROR_CATEGORIES.ENCRYPTED, { hlsOutputMethod: method, action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY });
  if (media.playlist?.iframeOnly) return deny('hls-iframe-only-merge', 'I-frame-only HLS playlists are trick-play indexes, not complete video/audio streams. Use M3U8 only to save playlist text.', ERROR_CATEGORIES.UNSUPPORTED, { hlsOutputMethod: method, action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY });
  if (media.playlist?.hasPartialSegments || media.playlist?.hasPreloadHint) return deny('low-latency-hls-merge', 'Low-latency HLS partial segments/preload hints are not on the built-in merge allow list yet. Use M3U8 only to save playlist text.', ERROR_CATEGORIES.UNSUPPORTED, { hlsOutputMethod: method, action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY });
  if (media.playlist?.inspected && media.playlist?.hasEndList === false && String(media.playlist?.playlistType || '').toLowerCase() !== 'vod') return deny('live-hls-merge', 'Live/event HLS without #EXT-X-ENDLIST is not a finite file download. Use M3U8 only to save playlist text, or retry after the stream has ended.', ERROR_CATEGORIES.UNSUPPORTED, { hlsOutputMethod: method, action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY });
  if (media.playlist?.hasMap || media.playlist?.hasFmp4Segments) return deny('hls-fmp4-map-merge', 'HLS fMP4/CMAF (#EXT-X-MAP or fMP4 segment files) is not on the built-in merge allow list yet. Use M3U8 only to save playlist text.', ERROR_CATEGORIES.UNSUPPORTED, { hlsOutputMethod: method, action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY });
  if (media.playlist?.hasByteRange) return deny('hls-byte-range-merge', 'HLS byte-range media is not on the built-in merge allow list yet. Use M3U8 only to save playlist text.', ERROR_CATEGORIES.UNSUPPORTED, { hlsOutputMethod: method, action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY });
  if (media.playlist?.protectedUriKind) return deny('protected-hls-component', `The HLS ${media.playlist.protectedUriKind} URL appears signed, expiring, or tokenized. Use M3U8 only to save playlist text if the top-level playlist URL is safe.`, ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL, { hlsOutputMethod: method, action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY, segmentCount: getHlsSegmentCount(media), segmentCountScope: getHlsSegmentCountScope(media) });
  if (hasHardProtectionMarker(media, { allowSignedOnly: false })) return deny('protected-hls-merge', protectionReason(media) || 'This HLS item is marked protected and is not eligible for merging.', ERROR_CATEGORIES.ACCESS_CONTROL, { hlsOutputMethod: method, action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY, segmentCount: getHlsSegmentCount(media), segmentCountScope: getHlsSegmentCountScope(media) });
  const separateAudioDecision = hlsSeparateAudioDecision(media, options);
  if (separateAudioDecision) return withHlsMethod(separateAudioDecision, method);
  const codecDecision = hlsCodecCompatibilityDecision(media, method, options);
  if (codecDecision) return withHlsMethod(codecDecision, method);
  const segmentCountDecision = hlsSegmentCountDecision(media);
  if (segmentCountDecision) return withHlsMethod(segmentCountDecision, method);
  return allow('safe-hls-mpegts-merge', hlsMergeReason(media), STRATEGY_NAMES.HLS_SEGMENT_MERGE, { hlsOutputMethod: method, ruleId: 'safe-hls-mpegts-merge', action: 'merge-hls', fileRole: 'assembled-media', outputKind: 'assembled-media', confidence: hlsMergeConfidence(media), segmentCount: getHlsSegmentCount(media), segmentCountScope: getHlsSegmentCountScope(media), estimatedDurationSeconds: getHlsDurationSeconds(media), recommendedHlsMethod: recommendedHlsMethod(media, method), recommendedAction: 'merge-hls', riskFlags: buildRiskFlags(media, { hlsMerge: true }) });
}


function hlsCodecCompatibilityDecision(media = {}, method = HLS_OUTPUT_METHODS.SMART_MP4, options = {}) {
  const profile = getHlsSelectedCodecProfile(media, options?.settings?.hlsVariantPreference);
  if (!profile.explicit) return null;
  if (profile.mp4RemuxCompatible) return null;
  const reason = profile.reason || 'The selected HLS variant advertises codecs outside the built-in H.264 + AAC MP4 remuxer allow list.';
  if (method === HLS_OUTPUT_METHODS.MP4_REMUX) {
    return deny('hls-codecs-not-mp4-remux-compatible', `${reason} Choose Smart MP4 or Timestamp-fixed TS so Media Scout can save a safer MPEG-TS fallback instead of forcing MP4 remux.`, ERROR_CATEGORIES.UNSUPPORTED, {
      action: 'merge-hls',
      confidence: 'high',
      fallbackAction: 'merge-hls',
      safeFallbackMethod: HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS,
      recommendedHlsMethod: HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS,
      segmentCount: getHlsSegmentCount(media),
      segmentCountScope: getHlsSegmentCountScope(media),
      riskFlags: buildRiskFlags(media, { hlsMerge: true }).concat(profile.riskFlags || []).slice(0, 8)
    });
  }
  if (method === HLS_OUTPUT_METHODS.SMART_MP4) {
    return allow('hls-smart-mp4-ts-fallback-recommended', `${reason} Smart MP4 remains allowed because it can fall back to timestamp-fixed MPEG-TS when MP4 remux is not compatible.`, STRATEGY_NAMES.HLS_SEGMENT_MERGE, {
      hlsOutputMethod: method,
      ruleId: 'safe-hls-mpegts-merge',
      action: 'merge-hls',
      fileRole: 'assembled-media',
      outputKind: 'assembled-media',
      limited: true,
      confidence: 'conditional',
      fallbackAction: 'merge-hls',
      safeFallbackMethod: HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS,
      recommendedHlsMethod: HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS,
      recommendedAction: 'merge-hls',
      segmentCount: getHlsSegmentCount(media),
      segmentCountScope: getHlsSegmentCountScope(media),
      estimatedDurationSeconds: getHlsDurationSeconds(media),
      riskFlags: buildRiskFlags(media, { hlsMerge: true }).concat(profile.riskFlags || []).slice(0, 8)
    });
  }
  return null;
}

function getHlsSelectedCodecProfile(media = {}, preference = HLS_VARIANT_PREFERENCES.HIGHEST) {
  const variants = Array.isArray(media.variants) ? media.variants.filter((variant) => variant?.url) : [];
  const selectedVariant = variants.length ? selectPolicyHlsVariant(variants, preference) : null;
  const candidates = [selectedVariant?.codecs, media.selectedVariant?.codecs, media.playlist?.codecs, media.codecs].filter(Boolean);
  const codecs = String(candidates[0] || '').toLowerCase();
  if (!codecs) return { explicit: false, mp4RemuxCompatible: true, riskFlags: [] };
  const parts = codecs.split(',').map((part) => part.trim()).filter(Boolean);
  const hasVideo = parts.some((part) => /^(avc1|avc3)/.test(part) || /^(hvc1|hev1|dvhe|dvh1|vp09|vp9|av01|mp4v|theora)/.test(part));
  const hasAudio = parts.some((part) => /^(mp4a|aac)/.test(part) || /^(ac-3|ec-3|opus|vorbis|flac|mp3|mp4a\.69|mp4a\.6b)/.test(part));
  const unsupportedVideo = parts.find((part) => /^(hvc1|hev1|dvhe|dvh1|vp09|vp9|av01|mp4v|theora)/.test(part));
  const unsupportedAudio = parts.find((part) => /^(ac-3|ec-3|opus|vorbis|flac|mp3|mp4a\.69|mp4a\.6b)/.test(part));
  const hasH264 = parts.some((part) => /^(avc1|avc3)/.test(part));
  const hasAac = parts.some((part) => /^(mp4a|aac)/.test(part) && !/^(mp4a\.69|mp4a\.6b)/.test(part));
  const videoOk = !hasVideo || hasH264;
  const audioOk = !hasAudio || hasAac;
  const compatible = videoOk && audioOk && !unsupportedVideo && !unsupportedAudio;
  const riskFlags = ['codec-declared'];
  if (unsupportedVideo) riskFlags.push('unsupported-video-codec');
  if (unsupportedAudio) riskFlags.push('unsupported-audio-codec');
  if (!hasH264 && hasVideo) riskFlags.push('no-h264-codec');
  if (!hasAac && hasAudio) riskFlags.push('no-aac-codec');
  let reason = '';
  if (!compatible) {
    const named = [unsupportedVideo ? `video codec ${unsupportedVideo}` : '', unsupportedAudio ? `audio codec ${unsupportedAudio}` : ''].filter(Boolean).join(' and ');
    reason = named
      ? `The selected HLS variant advertises ${named}, while the built-in MP4 remuxer only supports MPEG-TS with H.264 video and AAC audio.`
      : 'The selected HLS variant does not clearly advertise H.264 video plus AAC audio, while the built-in MP4 remuxer only supports that MPEG-TS profile.';
  }
  return { explicit: true, codecs, mp4RemuxCompatible: compatible, riskFlags, reason };
}


function hlsSegmentCountDecision(media = {}) {
  if (!media.playlist?.inspected) return null;
  const count = getHlsSegmentCount(media);
  const scope = getHlsSegmentCountScope(media);
  if (scope === 'master-playlist' && !Number(count)) {
    return allow('hls-master-playlist-variant-count-pending', 'This is a master playlist. The selected variant segment count was not available during the background probe, so Media Scout will verify the selected media playlist at runtime before fetching segments.', STRATEGY_NAMES.HLS_SEGMENT_MERGE, { action: 'merge-hls', fileRole: 'assembled-media', outputKind: 'assembled-media', confidence: 'conditional', segmentCount: 0, segmentCountScope: scope, fallbackAction: 'runtime-selected-variant-probe', riskFlags: buildRiskFlags(media, { hlsMerge: true }).concat(['segment-count-runtime-only']).slice(0, 8) });
  }
  if (scope === 'selected-variant-unavailable') {
    return allow('hls-selected-variant-count-unavailable', 'The selected variant segment count could not be verified in the background. Media Scout will count and validate the media playlist at runtime before fetching segments.', STRATEGY_NAMES.HLS_SEGMENT_MERGE, { action: 'merge-hls', fileRole: 'assembled-media', outputKind: 'assembled-media', confidence: 'conditional', segmentCount: 0, segmentCountScope: scope, fallbackAction: 'runtime-selected-variant-probe', riskFlags: buildRiskFlags(media, { hlsMerge: true }).concat(['segment-count-runtime-only']).slice(0, 8) });
  }
  if (Number.isFinite(count) && count === 0 && media.playlist?.playlistKind === 'media') {
    return deny('hls-empty-media-playlist', 'This HLS media playlist did not expose any full media segments. Media Scout can save the M3U8 text, but there is no finite segment list to merge.', ERROR_CATEGORIES.UNSUPPORTED, { action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY, segmentCount: 0, segmentCountScope: scope });
  }
  return null;
}

function getHlsSegmentCount(media = {}) {
  const values = [media.playlist?.segmentCount, media.selectedVariant?.segmentCount, media.playlistProbe?.segmentCount];
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function getHlsSegmentCountScope(media = {}) {
  return media.playlist?.segmentCountScope || (media.selectedVariant?.segmentCount != null ? 'selected-variant' : (media.playlistProbe?.segmentCount != null ? 'detailed-page-scan' : 'unknown'));
}

function getHlsDurationSeconds(media = {}) {
  const values = [media.playlist?.durationSeconds, media.playlist?.estimatedDurationSeconds, media.selectedVariant?.durationSeconds, media.selectedVariant?.estimatedDurationSeconds, media.playlistProbe?.estimatedDurationSeconds];
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function hlsSeparateAudioDecision(media = {}, options = {}) {
  if (!media.playlist?.hasSeparateAudio) return null;
  const variants = Array.isArray(media.variants) ? media.variants.filter((variant) => variant?.url) : [];
  if (!variants.length) {
    return deny('hls-separate-audio-not-merged', 'This HLS item advertises separate audio renditions, and no self-contained video/audio variant was visible. The built-in merger does not align separate audio/video yet. Use M3U8 only to save playlist text.', ERROR_CATEGORIES.UNSUPPORTED, { action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY, riskFlags: buildRiskFlags(media) });
  }
  const selfContained = variants.filter(isLikelySelfContainedHlsVariant);
  if (!selfContained.length) {
    return deny('hls-separate-audio-not-merged', 'The selected HLS variants require separate audio renditions. The built-in merger does not align separate audio/video yet. Use M3U8 only to save playlist text.', ERROR_CATEGORIES.UNSUPPORTED, { action: 'merge-hls', confidence: 'high', fallbackAction: 'save-hls-playlist', safeFallbackMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY, riskFlags: buildRiskFlags(media) });
  }
  const selected = selectPolicyHlsVariant(variants, options?.settings?.hlsVariantPreference);
  if (selected && !isLikelySelfContainedHlsVariant(selected)) {
    return allow('hls-self-contained-variant-fallback', 'The preferred HLS variant appears to require separate audio, but a self-contained variant is available. Media Scout will choose the closest self-contained variant instead of attempting unsupported separate-audio merging.', STRATEGY_NAMES.HLS_SEGMENT_MERGE, { action: 'merge-hls', fileRole: 'assembled-media', outputKind: 'assembled-media', limited: true, confidence: 'conditional', fallbackAction: 'merge-self-contained-hls-variant', riskFlags: buildRiskFlags(media) });
  }
  return null;
}

function hasSelfContainedHlsVariant(media = {}) {
  return Array.isArray(media.variants) && media.variants.some(isLikelySelfContainedHlsVariant);
}

function isLikelySelfContainedHlsVariant(variant = {}) {
  if (!variant || !variant.url) return false;
  if (variant.audioGroupId) return false;
  const codecs = String(variant.codecs || '').toLowerCase();
  if (!codecs) return true;
  const hasVideoCodec = /avc|hvc|hev|vp0?9|av01|theora|dvhe|dvh1|mp4v/.test(codecs);
  const hasAudioCodec = /mp4a|aac|ac-3|ec-3|opus|vorbis|flac|mp3/.test(codecs);
  return hasVideoCodec && hasAudioCodec;
}

function selectPolicyHlsVariant(variants = [], preference = HLS_VARIANT_PREFERENCES.HIGHEST) {
  const usable = variants.filter((variant) => variant?.url);
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
  return preference === HLS_VARIANT_PREFERENCES.LOWEST ? sorted[sorted.length - 1] : sorted[0];
}


function segmentCountScopeLabel(scope = '') {
  const clean = String(scope || '').toLowerCase();
  if (clean === 'selected-variant') return 'selected variant playlist';
  if (clean === 'media-playlist') return 'media playlist';
  if (clean === 'detailed-page-scan') return 'detailed page scan';
  if (clean === 'master-playlist') return 'master playlist only; selected variant checked at runtime';
  if (clean === 'selected-variant-unavailable') return 'runtime verification needed';
  return clean || 'playlist';
}


function recommendedHlsMethod(media = {}, currentMethod = HLS_OUTPUT_METHODS.SMART_MP4) {
  if (media.playlist?.hasDiscontinuity) return HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS;
  if (media.playlist?.hasEndList === false && String(media.playlist?.playlistType || '').toLowerCase() === 'vod') return HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS;
  if (currentMethod === HLS_OUTPUT_METHODS.MP4_REMUX && media.playlist?.hasDiscontinuity) return HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS;
  return currentMethod || HLS_OUTPUT_METHODS.SMART_MP4;
}

function hlsMergeConfidence(media = {}) {
  const count = getHlsSegmentCount(media);
  if (media.playlist?.crossOrigin || media.playlist?.inspected === false) return 'conditional';
  if (media.playlist?.segmentCountScope === 'selected-variant-unavailable' || media.playlist?.segmentCountScope === 'master-playlist') return 'conditional';
  if (Number.isFinite(count) && count > 1500) return 'conditional';
  if (media.playlist?.hasSeparateAudio && hasSelfContainedHlsVariant(media)) return 'conditional';
  if (Number.isFinite(count) && count > 500) return 'medium';
  if (media.playlist?.hasEndList === false && String(media.playlist?.playlistType || '').toLowerCase() === 'vod') return 'medium';
  if (media.playlist?.hasDiscontinuity) return 'medium';
  return 'high';
}

function hlsMergeReason(media = {}) {
  const count = getHlsSegmentCount(media);
  const countText = Number.isFinite(count) && count > 0 ? ` Segment count: ${count} (${segmentCountScopeLabel(getHlsSegmentCountScope(media))}).` : '';
  if (media.playlist?.hasSeparateAudio && hasSelfContainedHlsVariant(media)) {
    return `This HLS master advertises separate audio renditions, but at least one self-contained variant is available. Media Scout will prefer a self-contained variant and will not attempt unsupported separate-audio merging.${countText}`;
  }
  if (media.playlist?.hasEndList === false && String(media.playlist?.playlistType || '').toLowerCase() === 'vod') {
    return `This HLS media playlist is marked VOD but does not include #EXT-X-ENDLIST. Media Scout treats it as a bounded finite playlist after runtime checks rather than blocking it as live media.${countText}`;
  }
  if (media.playlist?.crossOrigin || media.playlist?.inspected === false) {
    return `HLS appears structurally eligible, but the playlist was not fully inspected in the background. Runtime page-context checks must still verify encryption, component URLs, segment count, and fetch access before merging.${countText}`;
  }
  if (media.playlist?.hasDiscontinuity) {
    return `Non-encrypted finite MPEG-TS HLS is allowed, with discontinuities noted. Timestamp-fixed TS is safer than MP4 remux for discontinuous playlists.${countText}`;
  }
  return `Non-encrypted finite HTTP(S) MPEG-TS HLS is on the allow list for normal page-context merge/download.${countText}`;
}

function isProbableStandaloneTransportStream(media = {}) {
  const extension = String(media.extension || '').toLowerCase().replace(/^\./, '');
  if (!TRANSPORT_STREAM_EXTENSIONS.has(extension)) return false;
  if (media.playlistProbe || media.playlist || /hls|m3u8|segment-host|encrypted/i.test(protectionReason(media))) return false;
  if (media.source === SOURCES.DOM_VIDEO || media.source === SOURCES.DOM_SOURCE) return true;
  if (media.hasAttachmentDisposition || /\battachment\b/i.test(String(media.contentDisposition || ''))) return true;
  if (Array.isArray(media.detectionMethods) && media.detectionMethods.some((method) => /dom-(video|source)|html-media/i.test(String(method)))) return true;
  const sizeBytes = Number(media.sizeBytes || media.resourceInfo?.transferSize || media.resourceInfo?.encodedBodySize || 0);
  const duration = Number(media.mediaDuration || media.mediaInfo?.duration || 0);
  const mime = String(media.mime || media.type || media.declaredType || '').toLowerCase();
  return mime.includes('video/mp2t') && (sizeBytes >= STANDALONE_TRANSPORT_STREAM_MIN_BYTES || duration >= 60);
}

function streamAssociationRiskFlags(media = {}) {
  return buildRiskFlags(media, { streamComponent: true, playlistAssociated: Boolean(media.playlistProbe || media.playlist) });
}

function buildRiskFlags(media = {}, context = {}) {
  const flags = new Set();
  if (context.topLevelSigned || topLevelUrlLooksProtected(media) || isSignedOnlyProtectionMarker(media)) flags.add('signed-top-level-url');
  if (context.attachmentFilename) flags.add('attachment-filename-inferred');
  if (context.mimeInferred) flags.add('mime-inferred');
  if (media.responseHeaders?.contentRange) flags.add('range-response');
  if (/bytes/i.test(String(media.responseHeaders?.acceptRanges || ''))) flags.add('accept-ranges');
  if (media.responseHeaders?.contentEncoding && !/identity/i.test(String(media.responseHeaders.contentEncoding))) flags.add('content-encoded');
  if (normalizedMime(media) && registryEntryForExtension(String(media.extension || '').toLowerCase().replace(/^\./, ''))?.group && registryEntryForMime(normalizedMime(media))?.group && registryEntryForExtension(String(media.extension || '').toLowerCase().replace(/^\./, ''))?.group !== registryEntryForMime(normalizedMime(media))?.group) flags.add('extension-mime-conflict');
  if (context.streamComponent || media.mediaType === MEDIA_TYPES.SEGMENT) flags.add('stream-component');
  if (context.standaloneTs) flags.add('standalone-transport-stream');
  if (context.hlsMerge) flags.add('page-context-fetch');
  if (media.playlist?.crossOrigin) flags.add('cross-origin-playlist');
  if (media.playlist?.inspected === false) flags.add('not-fully-inspected');
  if (media.playlist?.hasDiscontinuity) flags.add('hls-discontinuity');
  if (media.playlist?.hasSeparateAudio) flags.add(hasSelfContainedHlsVariant(media) ? 'separate-audio-variant-available' : 'separate-audio-rendition');
  if (media.playlist?.hasEndList === false) flags.add(String(media.playlist?.playlistType || '').toLowerCase() === 'vod' ? 'vod-missing-endlist' : 'live-or-event-playlist');
  if (media.playlist?.hasPartialSegments || media.playlist?.hasPreloadHint) flags.add('low-latency-hls');
  if (media.playlist?.hasMap || media.playlist?.hasFmp4Segments) flags.add('fmp4-cmaf');
  if (media.playlist?.hasByteRange) flags.add('byte-range-media');
  if (media.playlist?.playlistType) flags.add(`playlist-type-${String(media.playlist.playlistType).toLowerCase()}`);
  const hlsCount = getHlsSegmentCount(media);
  if (Number.isFinite(hlsCount)) {
    if (hlsCount === 0) flags.add('zero-hls-segments');
    else if (hlsCount > 1500) flags.add('very-large-hls-segment-count');
    else if (hlsCount > 500) flags.add('large-hls-segment-count');
  }
  if (media.playlist?.segmentCountScope) flags.add(`segment-count-${String(media.playlist.segmentCountScope).toLowerCase()}`);
  if (media.isProtected || media.status === DOWNLOAD_STATUSES.ENCRYPTED || media.manifest?.encrypted || media.playlist?.encrypted) flags.add('protected-marker');
  return Array.from(flags).slice(0, 8);
}

function blobMediaDecision(media = {}) {
  const url = String(media.url || media.normalizedUrl || '');
  if (!isBlobUrl(url)) return null;
  if (media.probableMseBlob || /mse|media source/i.test(String(media.unsupportedReason || '') + ' ' + String(media.safetyWarning || ''))) {
    return deny('mse-blob-not-downloadable', 'This blob URL appears to be a Media Source Extensions player buffer, not a standalone downloadable file.', ERROR_CATEGORIES.UNSUPPORTED, { action: 'save-page-blob' });
  }
  return allow('page-local-blob', 'Page-local blob file is on the allow list when saved from the same page context.', STRATEGY_NAMES.BLOB_PAGE_DOWNLOAD, { action: 'save-page-blob', fileRole: 'page-local-file' });
}



function normalizedMime(media = {}) {
  return String(media.mime || media.type || media.declaredType || '').split(';')[0].trim().toLowerCase();
}

function isGenericBinaryMime(mime = '') {
  return GENERIC_BINARY_MIME_TYPES.has(String(mime || '').toLowerCase());
}

function hasClearFinalMediaMime(media = {}) {
  const group = registryEntryForMime(normalizedMime(media))?.group;
  return group === MEDIA_TYPES.VIDEO || group === MEDIA_TYPES.AUDIO;
}

function hasFilenameFinalMediaHint(media = {}) {
  const group = registryEntryFromFilenameHints(media)?.group;
  return group === MEDIA_TYPES.VIDEO || group === MEDIA_TYPES.AUDIO;
}

function hasFinalFileResponseEvidence(media = {}) {
  if (media.hasAttachmentDisposition || /\battachment\b/i.test(String(media.contentDisposition || ''))) return true;
  if ([SOURCES.DOM_VIDEO, SOURCES.DOM_AUDIO, SOURCES.DOM_SOURCE].includes(media.source)) return true;
  const sizeBytes = Number(media.sizeBytes || media.resourceInfo?.transferSize || media.resourceInfo?.encodedBodySize || 0);
  const duration = Number(media.mediaDuration || media.mediaInfo?.duration || 0);
  const rangeTotal = Number(media.responseHeaders?.contentRangeTotal || 0);
  const hasRangeHeader = /bytes\s+\d+\s*-\s*\d+\s*\//i.test(String(media.responseHeaders?.contentRange || ''));
  return sizeBytes >= FINAL_FILE_EVIDENCE_MIN_BYTES || duration >= 30 || (rangeTotal >= RANGE_FINAL_FILE_EVIDENCE_MIN_BYTES && hasRangeHeader);
}

function selectEffectiveRegistryForPolicy(media = {}, { registry = null, filenameRegistry = null, mimeRegistry = null, expectedGroups = [] } = {}) {
  if (filenameRegistry && (!expectedGroups.length || expectedGroups.includes(filenameRegistry.group))) return filenameRegistry;
  const mimeHasExpectedGroup = mimeRegistry && (!expectedGroups.length || expectedGroups.includes(mimeRegistry.group));
  const extensionHasExpectedGroup = registry && (!expectedGroups.length || expectedGroups.includes(registry.group));
  if (mimeHasExpectedGroup && (!extensionHasExpectedGroup || hasFinalFileResponseEvidence(media) || hasClearFinalMediaMime(media))) return mimeRegistry;
  return registry || filenameRegistry || mimeRegistry;
}


function inferredExtensionForPolicy({ effectiveRegistry = null, registry = null, filenameRegistry = null, mimeRegistry = null, filenameExtension = '' } = {}) {
  if (!effectiveRegistry) return '';
  if (effectiveRegistry === filenameRegistry && filenameRegistry !== registry) return filenameExtension || filenameRegistry.extensions?.[0] || '';
  if (effectiveRegistry === mimeRegistry && mimeRegistry !== registry) return mimeRegistry.extensions?.[0] || '';
  return '';
}

function responseMimeConflictDecision(media = {}, expectedGroups = [], action = 'direct-download') {
  const mime = normalizedMime(media);
  if (!mime || isGenericBinaryMime(mime)) return null;
  const registry = registryEntryForMime(mime);
  if (registry) {
    if (expectedGroups.length && !expectedGroups.includes(registry.group)) {
      const hasExpectedFilename = expectedGroups.includes(registryEntryFromFilenameHints(media)?.group);
      if (!hasExpectedFilename) {
        return deny('response-mime-type-mismatch', `The server response is ${mime}, which belongs to ${registry.group}, not the requested ${expectedGroups.join('/')} download action.`, ERROR_CATEGORIES.UNSUPPORTED, { action, confidence: 'high', riskFlags: ['response-mime-conflict'] });
      }
    }
    return null;
  }
  if (HARD_NON_MEDIA_MIME_TYPES.has(mime)) {
    return deny('response-mime-not-media', `The server responded with ${mime}, which usually means a web page, login page, or error page rather than a downloadable media file.`, ERROR_CATEGORIES.ACCESS_CONTROL, { action, confidence: 'high', riskFlags: ['non-media-response-mime'] });
  }
  if ((expectedGroups.includes(MEDIA_TYPES.VIDEO) || expectedGroups.includes(MEDIA_TYPES.AUDIO) || expectedGroups.includes(MEDIA_TYPES.IMAGE) || expectedGroups.includes(MEDIA_TYPES.SUBTITLE)) && STRUCTURED_NON_MEDIA_MIME_TYPES.has(mime)) {
    return deny('response-mime-not-requested-media', `The server responded with ${mime}, which is not a ${expectedGroups.join('/')} media file for this action.`, ERROR_CATEGORIES.UNSUPPORTED, { action, confidence: 'high', riskFlags: ['non-media-response-mime'] });
  }
  return null;
}

function manifestMimeConflictDecision(media = {}, action = 'save-manifest-file', label = 'manifest') {
  const mime = normalizedMime(media);
  if (!mime || isGenericBinaryMime(mime)) return null;
  if (HARD_NON_MEDIA_MIME_TYPES.has(mime)) {
    return deny('manifest-response-mime-not-manifest', `The ${label} URL responded with ${mime}, which is likely a web page, login page, or error page rather than a manifest file.`, ERROR_CATEGORIES.ACCESS_CONTROL, { action, confidence: 'high', fallbackAction: '', riskFlags: ['non-manifest-response-mime'] });
  }
  const registry = registryEntryForMime(mime);
  if (registry && ![MEDIA_TYPES.HLS, MEDIA_TYPES.DASH, MEDIA_TYPES.STREAM, MEDIA_TYPES.PLAYLIST, MEDIA_TYPES.METADATA].includes(registry.group)) {
    return deny('manifest-response-mime-type-mismatch', `The ${label} URL responded as ${registry.group} (${mime}), not as a manifest/playlist file.`, ERROR_CATEGORIES.UNSUPPORTED, { action, confidence: 'high', riskFlags: ['manifest-mime-conflict'] });
  }
  return null;
}

function buildDownloadEvidence(media = {}, context = {}) {
  const flags = new Set();
  if (context.registry) flags.add('url-extension');
  if (context.mimeRegistry) flags.add('response-mime');
  if (context.filenameRegistry) flags.add('attachment-filename');
  if (context.registry && context.mimeRegistry && context.registry.group !== context.mimeRegistry.group) flags.add('extension-mime-conflict');
  if (media.hasAttachmentDisposition || /\battachment\b/i.test(String(media.contentDisposition || ''))) flags.add('content-disposition-attachment');
  if (media.responseHeaders?.contentRange) flags.add('content-range');
  if (/bytes/i.test(String(media.responseHeaders?.acceptRanges || ''))) flags.add('accept-ranges');
  if (media.responseHeaders?.contentRangeTotal >= RANGE_FINAL_FILE_EVIDENCE_MIN_BYTES) flags.add('range-total-media-sized');
  if (String(media.responseHeaders?.contentEncoding || '').trim() && !/identity/i.test(String(media.responseHeaders.contentEncoding))) flags.add('content-encoded-response');
  if ([SOURCES.DOM_VIDEO, SOURCES.DOM_AUDIO, SOURCES.DOM_SOURCE].includes(media.source)) flags.add('dom-media-source');
  if (Array.isArray(media.detectionMethods) && media.detectionMethods.some((method) => /dom-(video|audio|source)|html-media/i.test(String(method)))) flags.add('dom-media-detection');
  const sizeBytes = Number(media.sizeBytes || media.resourceInfo?.transferSize || media.resourceInfo?.encodedBodySize || 0);
  const duration = Number(media.mediaDuration || media.mediaInfo?.duration || 0);
  if (sizeBytes >= STRONG_FINAL_FILE_EVIDENCE_MIN_BYTES) flags.add('large-response');
  else if (sizeBytes >= FINAL_FILE_EVIDENCE_MIN_BYTES) flags.add('medium-response');
  if (duration >= 60) flags.add('media-duration');
  if (context.topLevelSigned) flags.add('signed-top-level-url');
  const strong = flags.has('content-disposition-attachment') || flags.has('dom-media-source') || (flags.has('response-mime') && flags.has('large-response')) || (flags.has('attachment-filename') && flags.has('medium-response')) || (flags.has('response-mime') && flags.has('content-range') && flags.has('range-total-media-sized'));
  const medium = strong || flags.has('response-mime') || flags.has('attachment-filename') || flags.has('url-extension') || flags.has('dom-media-detection') || flags.has('media-duration');
  return {
    level: strong ? 'high' : (medium ? 'medium' : 'conditional'),
    flags: Array.from(flags).slice(0, 10)
  };
}

function safeDirectUrlDecision(media, options = {}, policy = {}) {
  const settings = options.settings || DEFAULT_SETTINGS;
  const url = String(media.url || media.normalizedUrl || '');
  if (isBlobUrl(url)) return blobMediaDecision(media) || deny('blob-not-direct', 'Blob URLs require page-local handling.', ERROR_CATEGORIES.UNSUPPORTED, { action: policy.action || 'direct-download' });
  const base = safeTopLevelHttpUrlDecision(media, { allowBlob: false, allowSignedTopLevel: Boolean(policy.allowSignedTopLevel), action: policy.action || 'direct-download' });
  if (!base.allowed) return base;

  const extension = String(media.extension || '').toLowerCase().replace(/^\./, '');
  const mime = String(media.mime || media.type || media.declaredType || '');
  const registry = extension && extension !== 'media' ? registryEntryForExtension(extension) : null;
  const filenameExtension = filenameHintExtension(media);
  const filenameRegistry = filenameExtension ? registryEntryForExtension(filenameExtension) : null;
  const mimeRegistry = registryEntryForMime(mime);
  const expectedGroups = Array.isArray(policy.expectedGroups) ? policy.expectedGroups : [];
  const mimeConflict = responseMimeConflictDecision(media, expectedGroups, policy.action || 'direct-download');
  if (mimeConflict) return mimeConflict;
  const effectiveRegistry = selectEffectiveRegistryForPolicy(media, { registry, filenameRegistry, mimeRegistry, expectedGroups });

  if (policy.requireEnabledExtension && registry && effectiveRegistry === registry && extension && extension !== 'media' && !isExtensionEnabled(extension, settings)) {
    return deny('file-type-disabled', `.${extension} is disabled in file type settings.`, ERROR_CATEGORIES.UNSUPPORTED, { action: policy.action || 'direct-download' });
  }
  if (policy.requireEnabledExtension && filenameRegistry && effectiveRegistry === filenameRegistry && filenameExtension && !isExtensionEnabled(filenameExtension, settings)) {
    return deny('file-type-disabled-by-attachment-name', `.${filenameExtension} from the attachment filename is disabled in file type settings.`, ERROR_CATEGORIES.UNSUPPORTED, { action: policy.action || 'direct-download' });
  }
  if (policy.requireEnabledExtension && extension && extension !== 'media' && !registry) {
    if (!mimeRegistry && !filenameRegistry) return deny('extension-not-allow-listed', `.${extension} is not on the media download allow list.`, ERROR_CATEGORIES.UNSUPPORTED, { action: policy.action || 'direct-download' });
  }
  if (mimeRegistry && effectiveRegistry === mimeRegistry && policy.requireEnabledExtension && !mimeRegistry.extensions.some((candidate) => isExtensionEnabled(candidate, settings))) {
    return deny('file-type-disabled-by-mime', `${mimeRegistry.label || mimeRegistry.id} is disabled in file type settings.`, ERROR_CATEGORIES.UNSUPPORTED, { action: policy.action || 'direct-download' });
  }
  if (expectedGroups.length && effectiveRegistry?.group && !expectedGroups.includes(effectiveRegistry.group)) {
    return deny('media-type-mismatch', `${effectiveRegistry.label || effectiveRegistry.id} is not valid for this download action.`, ERROR_CATEGORIES.UNSUPPORTED, { action: policy.action || 'direct-download' });
  }
  if (policy.requireEnabledExtension && !effectiveRegistry && extension !== 'media') {
    return deny('type-not-allow-listed', 'This file does not have an allow-listed media extension, attachment filename, or MIME type for this action.', ERROR_CATEGORIES.UNSUPPORTED, { action: policy.action || 'direct-download' });
  }

  const evidence = buildDownloadEvidence(media, { registry, filenameRegistry, mimeRegistry, topLevelSigned: Boolean(base.topLevelSigned) });
  return allow(
    base.topLevelSigned ? 'safe-signed-top-level-http-url' : 'safe-http-url',
    base.topLevelSigned ? 'HTTP(S) URL passed top-level checks and is signed/tokenized only at the top-level file-save scope.' : 'HTTP(S) URL passed top-level safety checks.',
    STRATEGY_NAMES.DIRECT_FILE,
    {
      action: policy.action || 'direct-download',
      topLevelSigned: Boolean(base.topLevelSigned),
      limited: Boolean(base.topLevelSigned),
      registryId: effectiveRegistry?.id || '',
      inferredExtension: inferredExtensionForPolicy({ effectiveRegistry, registry, filenameRegistry, mimeRegistry, filenameExtension }),
      fileRole: policy.fileRole || '',
      outputKind: policy.fileRole || '',
      confidence: base.topLevelSigned ? 'medium' : evidence.level,
      evidenceLevel: evidence.level,
      evidenceFlags: evidence.flags,
      riskFlags: buildRiskFlags(media, { topLevelSigned: Boolean(base.topLevelSigned), attachmentFilename: Boolean(filenameRegistry && effectiveRegistry === filenameRegistry && registry !== filenameRegistry), mimeInferred: Boolean(mimeRegistry && effectiveRegistry === mimeRegistry && registry !== mimeRegistry) })
    }
  );
}

function safeTopLevelHttpUrlDecision(media = {}, options = {}) {
  const url = String(media.url || media.normalizedUrl || '');
  if (!url) return deny('invalid-url', 'The media URL is invalid.', ERROR_CATEGORIES.VALIDATION, { action: options.action || 'download' });
  if (!isSafeUrlScheme(url)) return deny('unsupported-scheme', 'This URL scheme is not supported.', ERROR_CATEGORIES.ACCESS_CONTROL, { action: options.action || 'download' });
  if (!options.allowBlob && isBlobUrl(url)) return deny('blob-not-allowed', 'Blob URLs require page-local handling.', ERROR_CATEGORIES.UNSUPPORTED, { action: options.action || 'download' });
  if (!isHttpUrl(url)) return deny('not-http-url', 'Download allow list only permits HTTP(S) URLs for this action.', ERROR_CATEGORIES.UNSUPPORTED, { action: options.action || 'download' });
  const topLevelSigned = topLevelUrlLooksProtected(media);
  if (topLevelSigned && !options.allowSignedTopLevel) {
    return deny('signed-or-expiring-url', 'This URL appears signed, expiring, or tokenized and is not allowed for this action.', ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL, { action: options.action || 'download', topLevelSigned: true });
  }
  return allow(topLevelSigned ? 'safe-signed-top-level-http-url' : 'safe-http-url', topLevelSigned ? 'Signed/tokenized top-level HTTP(S) URL is allowed for this file-save action only.' : 'HTTP(S) URL passed top-level safety checks.', STRATEGY_NAMES.DIRECT_FILE, { action: options.action || 'download', topLevelSigned, limited: topLevelSigned });
}

function hasKnownHlsProtection(media = {}) {
  return Boolean(media.playlist?.encrypted || media.status === DOWNLOAD_STATUSES.ENCRYPTED || media.playlist?.protectedUriKind || hasHardProtectionMarker(media, { allowSignedOnly: false }));
}

function hasHardProtectionMarker(media = {}, { allowSignedOnly = false } = {}) {
  if (!media.isProtected && media.status !== DOWNLOAD_STATUSES.ENCRYPTED && !media.manifest?.encrypted && !media.playlist?.encrypted) return false;
  if (media.status === DOWNLOAD_STATUSES.ENCRYPTED || media.manifest?.encrypted || media.playlist?.encrypted) return true;
  if (allowSignedOnly && isSignedOnlyProtectionMarker(media)) return false;
  return true;
}

function isSignedOnlyProtectionMarker(media = {}) {
  const reason = protectionReason(media).toLowerCase();
  const inspectionWasDeferred = Boolean(media.playlist?.inspectionDeferred || media.manifest?.inspectionDeferred);
  const hasSignedHint = Boolean(
    media.signedOrExpiringHint
    || topLevelUrlLooksProtected(media)
    || (!inspectionWasDeferred && /signed|signature|token|expir|x-amz|x-goog|key-pair-id/.test(reason))
  );
  if (!hasSignedHint) return false;
  return !/(encrypted|#ext-x-key|contentprotection|drm|widevine|playready|clearkey|mspr|paywall|cors|forbidden|unauthori[sz]ed|authentication|access-control|login|required)/i.test(reason);
}

function topLevelUrlLooksProtected(media = {}) {
  return looksSignedOrExpiring(String(media.url || media.normalizedUrl || '')) || Boolean(media.signedOrExpiringHint);
}

function protectionReason(media = {}) {
  return String(media.unsupportedReason || media.safetyWarning || media.playlistProbe?.reasonCode || media.status || '').trim();
}

function withHlsMethod(decision, method) {
  return { ...decision, hlsOutputMethod: method };
}

function normalizeHlsMethod(value) {
  return IMPLEMENTED_HLS_OUTPUT_METHODS.includes(value) ? value : HLS_OUTPUT_METHODS.SMART_MP4;
}

function publicDecision(decision = {}) {
  return {
    allowed: Boolean(decision.allowed),
    code: decision.code || '',
    reason: decision.reason || '',
    category: decision.category || '',
    strategy: decision.strategy || '',
    ruleId: decision.ruleId || '',
    action: decision.action || '',
    fileRole: decision.fileRole || '',
    limited: Boolean(decision.limited),
    topLevelSigned: Boolean(decision.topLevelSigned),
    confidence: decision.confidence || '',
    outputKind: decision.outputKind || decision.fileRole || '',
    fallbackAction: decision.fallbackAction || '',
    safeFallbackMethod: decision.safeFallbackMethod || '',
    segmentCount: decision.segmentCount ?? null,
    segmentCountScope: decision.segmentCountScope || '',
    estimatedDurationSeconds: decision.estimatedDurationSeconds || 0,
    actionLabel: decision.actionLabel || ACTION_LABELS[decision.action] || decision.action || '',
    recommendedAction: decision.recommendedAction || decision.fallbackAction || '',
    recommendedHlsMethod: decision.recommendedHlsMethod || decision.safeFallbackMethod || '',
    evidenceLevel: decision.evidenceLevel || '',
    evidenceFlags: Array.isArray(decision.evidenceFlags) ? decision.evidenceFlags.slice(0, 10) : [],
    inferredExtension: decision.inferredExtension || '',
    riskFlags: Array.isArray(decision.riskFlags) ? decision.riskFlags.slice(0, 8) : []
  };
}

function allow(code, reason, strategy, extra = {}) {
  return { allowed: ALLOW, code, reason, strategy, ruleId: extra.ruleId || code, category: '', confidence: extra.confidence || 'high', actionLabel: ACTION_LABELS[extra.action] || extra.action || '', ...extra };
}

function deny(code, reason, category = ERROR_CATEGORIES.UNSUPPORTED, extra = {}) {
  return { allowed: DENY, code, reason, category, ruleId: extra.ruleId || code, confidence: extra.confidence || 'high', actionLabel: ACTION_LABELS[extra.action] || extra.action || '', ...extra };
}
