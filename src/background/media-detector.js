import { DOWNLOAD_STATUSES, ERROR_CATEGORIES, HLS_VARIANT_PREFERENCES, MEDIA_TYPES, SOURCES } from '../shared/constants.js';
import { registryEntryForExtension } from '../shared/media-type-registry.js';
import { buildDownloadAllowSummary } from '../shared/download-allow-list.js';
import { debug, warn } from '../shared/logger.js';
import {
  getHeaderValue,
  getHostname,
  inferExtension,
  inferMediaType,
  isLikelyMediaUrl,
  makeMediaId,
  normalizeUrl,
  parseContentLength,
  sameOrigin,
  nowISO,
  createStructuredError
} from '../shared/utils.js';
import {
  detectDashProtection,
  detectHlsProtection,
  inferExtensionAllowed,
  isHttpUrl,
  looksSignedOrExpiring,
  validateMediaUrl
} from '../shared/validators.js';

const MAX_MANIFEST_INSPECTIONS_PER_SCAN = 8;
const MAX_MANIFEST_TEXT_BYTES = 4 * 1024 * 1024;
const MANIFEST_FETCH_TIMEOUT_MS = 8000;
const MAX_PARSED_HLS_VARIANTS = 200;
const MAX_PARSED_HLS_AUDIO_RENDITIONS = 100;
const MAX_PARSED_HLS_SEGMENTS = 6000;
const MAX_PARSED_DASH_REPRESENTATIONS = 500;

export class MediaDetector {
  constructor({ tabMediaStore, diagnostics, getSettings }) {
    this.tabMediaStore = tabMediaStore;
    this.diagnostics = diagnostics;
    this.getSettings = getSettings;
    this.scopedTabs = new Set();
    this.boundHeaderHandler = this._handleHeaders.bind(this);
    this.boundCompletedHandler = this._handleCompleted.bind(this);
  }

  start() {
    const filter = { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] };
    if (!chrome.webRequest.onHeadersReceived.hasListener(this.boundHeaderHandler)) {
      chrome.webRequest.onHeadersReceived.addListener(this.boundHeaderHandler, filter, ['responseHeaders']);
    }
    if (!chrome.webRequest.onCompleted.hasListener(this.boundCompletedHandler)) {
      chrome.webRequest.onCompleted.addListener(this.boundCompletedHandler, filter);
    }
  }

  scopeTab(tabId) {
    if (Number.isInteger(tabId) && tabId >= 0) this.scopedTabs.add(tabId);
  }

  unScopeTab(tabId) {
    this.scopedTabs.delete(tabId);
  }

  unScopeAll() {
    this.scopedTabs.clear();
  }

  isScopedTab(tabId) {
    return this.scopedTabs.has(tabId);
  }

  async ingestDomScan(tab, scanResults = []) {
    if (!Number.isInteger(tab?.id)) return [];
    this.scopeTab(tab.id);
    this.tabMediaStore.setTabInfo(tab);
    const tabRevision = this.tabMediaStore.getTabRevision(tab.id);
    const settings = await this.getSettings();
    let manifestInspections = 0;
    const inputs = dedupeSanitizedScanResults(scanResults.slice(0, 500).map(sanitizeScanResult).filter(Boolean));
    const items = await mapWithConcurrency(inputs, 4, async (raw) => {
      const manifestLike = isManifestScanResult(raw);
      const inspectManifest = !manifestLike || manifestInspections++ < MAX_MANIFEST_INSPECTIONS_PER_SCAN;
      return this._buildMediaItem({
        tab,
        url: raw.url,
        source: raw.source || SOURCES.DOM_SOURCE,
        declaredType: raw.type || '',
        mime: raw.mime || raw.type || '',
        resolution: raw.resolution || '',
        sizeBytes: raw.transferSize || raw.encodedBodySize || raw.decodedBodySize || undefined,
        frameId: raw.frameId,
        frameUrl: raw.frameUrl || '',
        initiatorType: raw.initiatorType || '',
        literalContext: raw.literalContext || '',
        probableMseBlob: Boolean(raw.probableMseBlob),
        mediaDuration: raw.mediaDuration ?? null,
        mediaInfo: raw.mediaInfo || null,
        resourceInfo: raw.resourceInfo || null,
        performanceStartTime: raw.performanceStartTime || undefined,
        signedOrExpiringHint: Boolean(raw.signedOrExpiringHint),
        detectionMethods: ['dom-scan']
      }, settings, { inspectManifest });
    });
    if (!this.scopedTabs.has(tab.id) || !this.tabMediaStore.isTabRevisionCurrent(tab.id, tabRevision)) return [];
    return this.tabMediaStore.addMany(tab.id, items.filter(Boolean));
  }

  async _handleHeaders(details) {
    if (!this._shouldInspect(details)) return;
    const tabRevision = this.tabMediaStore.getTabRevision(details.tabId);
    const headers = details.responseHeaders || [];
    const contentType = getHeaderValue(headers, 'content-type');
    const disposition = getHeaderValue(headers, 'content-disposition');
    if (!isLikelyMediaUrl(details.url, contentType) && !/filename=.*\.(mp4|m4v|mov|webm|ogv|mpeg|mpg|ts|m2ts|mkv|avi|3gp|flv|f4v|wmv|asf|mxf|mp3|m4a|aac|wav|ogg|opus|flac|m3u8|m3u|mpd|f4m|vtt|srt|ttml|dfxp|ass|ssa|jpg|jpeg|png|webp|avif|gif|svg|bmp|ico|tif|tiff)/i.test(disposition)) return;
    const storedTab = this.tabMediaStore.getTabState(details.tabId).tab;
    const tab = { ...storedTab, id: details.tabId };
    const settings = await this.getSettings();
    const item = await this._buildMediaItem({
      tab,
      url: details.url,
      source: contentType ? SOURCES.HEADER : SOURCES.NETWORK,
      mime: contentType,
      sizeBytes: parseContentLength(headers),
      contentDisposition: disposition,
      responseHeaders: buildSafeResponseHeaderHints(headers),
      detectionMethods: ['webRequest-headers']
    }, settings);
    if (item && this._shouldInspect(details) && this.tabMediaStore.isTabRevisionCurrent(details.tabId, tabRevision)) {
      this.tabMediaStore.addMedia(details.tabId, item);
    }
  }

  async _handleCompleted(details) {
    if (!this._shouldInspect(details)) return;
    const tabRevision = this.tabMediaStore.getTabRevision(details.tabId);
    if (!isLikelyMediaUrl(details.url, '')) return;
    const storedTab = this.tabMediaStore.getTabState(details.tabId).tab;
    const tab = { ...storedTab, id: details.tabId };
    const settings = await this.getSettings();
    const item = await this._buildMediaItem({
      tab,
      url: details.url,
      source: SOURCES.NETWORK,
      detectionMethods: ['webRequest-completed']
    }, settings);
    if (item && this._shouldInspect(details) && this.tabMediaStore.isTabRevisionCurrent(details.tabId, tabRevision)) {
      this.tabMediaStore.addMedia(details.tabId, item);
    }
  }

  _shouldInspect(details) {
    return details?.tabId >= 0 && this.scopedTabs.has(details.tabId);
  }

  async _buildMediaItem(input, settings, { inspectManifest = true } = {}) {
    const normalizedUrl = normalizeUrl(input.url, input.tab?.url);
    if (!normalizedUrl) return null;
    const blobUrl = normalizedUrl.startsWith('blob:');
    let mediaType = inferMediaType({ url: normalizedUrl, mime: input.mime, declaredType: input.declaredType });
    let extension = inferExtension({ url: normalizedUrl, mime: input.mime, declaredType: input.declaredType });
    if (mediaType === MEDIA_TYPES.UNKNOWN && blobUrl) {
      mediaType = input.source === SOURCES.DOM_AUDIO ? MEDIA_TYPES.AUDIO : MEDIA_TYPES.VIDEO;
      extension = 'media';
    }
    if (mediaType === MEDIA_TYPES.UNKNOWN) return null;
    if (extension !== 'media' && settings?.enabledFileTypes?.[extension] === false) return null;
    if (!inferExtensionAllowed(normalizedUrl, settings) && extension !== 'media') return null;

    let validationError = validateMediaUrl(normalizedUrl);
    if (blobUrl && input.probableMseBlob) {
      validationError = createStructuredError(
        ERROR_CATEGORIES.UNSUPPORTED,
        'mse-blob-url',
        'The visible media element uses a page-local blob URL, usually created by Media Source Extensions. The original media segments or file URL are not exposed as a normal downloadable file.'
      );
    }
    const item = {
      id: makeMediaId(input.tab?.id ?? input.tabId ?? -1, normalizedUrl, mediaType),
      tabId: input.tab?.id ?? input.tabId,
      url: normalizedUrl,
      normalizedUrl,
      source: input.source,
      mediaType,
      extension,
      mediaLabel: registryEntryForExtension(extension)?.label || mediaType,
      mediaGroup: mediaType,
      mime: input.mime || input.declaredType || '',
      sizeBytes: input.sizeBytes,
      hostname: getHostname(normalizedUrl),
      resolution: input.resolution || '',
      frameId: input.frameId,
      frameUrl: input.frameUrl || '',
      initiatorType: input.initiatorType || '',
      literalContext: input.literalContext || '',
      mediaDuration: input.mediaDuration ?? null,
      mediaInfo: input.mediaInfo || null,
      resourceInfo: input.resourceInfo || null,
      performanceStartTime: input.performanceStartTime || undefined,
      signedOrExpiringHint: Boolean(input.signedOrExpiringHint),
      contentDisposition: input.contentDisposition || '',
      responseHeaders: sanitizeResponseHeaderHints(input.responseHeaders),
      hasAttachmentDisposition: /\battachment\b/i.test(String(input.contentDisposition || '')),
      detectionMethods: input.detectionMethods || [],
      isProtected: Boolean(validationError),
      unsupportedReason: validationError?.message || '',
      safetyWarning: '',
      status: validationError ? DOWNLOAD_STATUSES.UNSUPPORTED : DOWNLOAD_STATUSES.DETECTED,
      detectedAt: nowISO()
    };

    if (!validationError && mediaType === MEDIA_TYPES.HLS) {
      if (inspectManifest) await this._annotateHls(item, input.tab?.url || '', settings);
      else markManifestInspectionDeferred(item, 'hls');
    }
    if (!validationError && mediaType === MEDIA_TYPES.DASH) {
      if (inspectManifest) await this._annotateDash(item, input.tab?.url || '');
      else markManifestInspectionDeferred(item, 'dash');
    }
    if (!validationError && [MEDIA_TYPES.STREAM, MEDIA_TYPES.PLAYLIST].includes(mediaType)) {
      item.safetyWarning = 'Streaming manifest/playlist detected. Media Scout can save the manifest file directly, but conversion is currently limited to non-encrypted MPEG-TS HLS (.m3u8).';
    }
    if (!validationError && mediaType === MEDIA_TYPES.SEGMENT) {
      item.safetyWarning = 'Segment or fragment detected. Segments are usually stream internals; Media Scout can save this accessible file directly, but final video assembly is handled from the playlist when supported.';
    }
    applyDownloadAllowSummary(item, settings);
    return item;
  }

  async _annotateHls(item, tabUrl, settings = {}) {
    if (!isHttpUrl(item.url)) return;
    if (!sameOrigin(item.url, tabUrl)) {
      item.playlist = { kind: 'hls', encrypted: null, inspected: false, crossOrigin: true };
      item.safetyWarning = 'Cross-origin HLS playlist detected. Media Scout can attempt a normal page-context fetch and merge for non-encrypted MPEG-TS segments when browser CORS/access rules allow it; otherwise it may save only the playlist and will not decrypt or bypass restrictions.';
      return;
    }
    try {
      const text = await fetchTextWithTimeout(item.url, MANIFEST_FETCH_TIMEOUT_MS);
      const protection = detectHlsProtection(text);
      const hlsInfo = parseHlsInspection(text, item.url);
      item.playlist = { kind: 'hls', encrypted: protection.encrypted, ...hlsInfo.playlist };
      item.variants = hlsInfo.variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      item.audioRenditions = hlsInfo.audioRenditions;
      await annotateSelectedHlsVariant(item, settings);
      const protectedHlsUri = findProtectedHlsUri(hlsInfo, item.url) || item.selectedVariant?.protectedHlsUri || null;
      const structureLimit = hlsStructureLimitReason(item.playlist);
      const requiresSeparateAudioMerge = Boolean(item.playlist?.hasSeparateAudio && item.variants?.length && !item.variants.some(isLikelySelfContainedHlsVariant));
      if (protection.encrypted || item.selectedVariant?.encrypted) {
        item.isProtected = true;
        item.status = DOWNLOAD_STATUSES.ENCRYPTED;
        item.unsupportedReason = item.selectedVariant?.encrypted ? 'The selected HLS variant playlist contains encryption markers (#EXT-X-KEY/#EXT-X-SESSION-KEY). Decryption and merging are not supported.' : 'Encrypted HLS playlist detected (#EXT-X-KEY/#EXT-X-SESSION-KEY). Decryption and merging are not supported.';
      } else if (protectedHlsUri) {
        item.isProtected = true;
        item.status = DOWNLOAD_STATUSES.UNSUPPORTED;
        item.unsupportedReason = `The HLS ${protectedHlsUri.kind} URL appears signed, expiring, or tokenized. Media Scout will not reuse protected HLS component URLs.`;
        item.playlist.protectedUriKind = protectedHlsUri.kind;
      } else if (structureLimit) {
        item.isProtected = true;
        item.status = DOWNLOAD_STATUSES.UNSUPPORTED;
        item.unsupportedReason = structureLimit;
      } else if (requiresSeparateAudioMerge) {
        item.isProtected = true;
        item.status = DOWNLOAD_STATUSES.UNSUPPORTED;
        item.unsupportedReason = 'This HLS master playlist requires separate audio renditions. The built-in merger does not align separate audio/video yet.';
        item.playlist.requiresSeparateAudioMerge = true;
        item.playlist.segmentCountScope = 'separate-audio-unsupported';
        item.playlist.exactSegmentCount = false;
      }
    } catch (error) {
      warn('HLS playlist inspection failed safely', error.message);
      item.playlist = { kind: 'hls', encrypted: null, inspected: false, inspectionError: error.message || 'inspection-failed' };
      item.safetyWarning = 'HLS playlist inspection failed in the background. On download, Media Scout can still try a page-context non-encrypted MPEG-TS segment merge using normal browser fetch rules, then fall back safely when blocked.';
    }
  }

  async _annotateDash(item, tabUrl) {
    if (!isHttpUrl(item.url)) return;
    if (!sameOrigin(item.url, tabUrl)) {
      item.manifest = { kind: 'dash', encrypted: null, inspected: false, crossOrigin: true };
      item.safetyWarning = 'Cross-origin DASH manifest detected. Media Scout can save the manifest URL as a normal browser download, but it will not fetch segments, merge streams, decrypt content, or bypass browser/site restrictions.';
      return;
    }
    try {
      const text = await fetchTextWithTimeout(item.url, MANIFEST_FETCH_TIMEOUT_MS);
      const protection = detectDashProtection(text);
      item.manifest = { kind: 'dash', encrypted: protection.encrypted };
      const representationResult = parseDashRepresentations(text);
      item.representations = representationResult.items;
      item.manifest.representationCount = representationResult.count;
      item.manifest.representationsTruncated = representationResult.count > representationResult.items.length;
      if (protection.encrypted) {
        item.isProtected = true;
        item.status = DOWNLOAD_STATUSES.ENCRYPTED;
        item.unsupportedReason = 'DASH ContentProtection or DRM markers were detected. DRM/encrypted streams are not supported.';
      }
    } catch (error) {
      warn('DASH manifest inspection failed safely', error.message);
      item.manifest = { kind: 'dash', encrypted: null, inspected: false, inspectionError: error.message || 'inspection-failed' };
      item.safetyWarning = 'DASH manifest inspection failed with normal browser access. Media Scout may still save the manifest file directly, but it will not fetch segments, merge streams, decrypt content, or bypass restrictions.';
    }
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()));
  return results;
}

function dedupeSanitizedScanResults(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.url}|${item.frameId ?? ''}|${item.frameUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isManifestScanResult(item = {}) {
  return /\.(?:m3u8|m3u|mpd)(?:[?#]|$)/i.test(item.url || '') || /mpegurl|dash\+xml/i.test(`${item.type || ''} ${item.mime || ''}`);
}

function markManifestInspectionDeferred(item, kind) {
  const detail = { kind, encrypted: null, inspected: false, inspectionDeferred: 'per-scan-limit' };
  if (kind === 'hls') item.playlist = detail;
  else item.manifest = detail;
  item.safetyWarning = kind === 'hls'
    ? 'Playlist inspection was deferred because this scan exposed many manifests. Any conversion still validates encryption, signed components, layout, and size before fetching segments.'
    : 'Manifest inspection was deferred because this scan exposed many manifests. Media Scout can save the MPD file only; it will not fetch or assemble DASH segments.';
}


export function parseHlsInspection(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variantResult = parseHlsVariants(text, baseUrl);
  const variants = variantResult.items;
  const audioRenditions = [];
  let audioRenditionCount = 0;
  for (const line of lines) {
    if (!line.startsWith('#EXT-X-MEDIA') || !/TYPE=AUDIO/i.test(line)) continue;
    audioRenditionCount += 1;
    if (audioRenditions.length >= MAX_PARSED_HLS_AUDIO_RENDITIONS) continue;
    const uri = readStringAttr(line, 'URI');
    audioRenditions.push({
      groupId: readStringAttr(line, 'GROUP-ID'),
      name: readStringAttr(line, 'NAME'),
      language: readStringAttr(line, 'LANGUAGE'),
      isDefault: /DEFAULT=YES/i.test(line),
      uri: uri ? normalizeUrl(uri, baseUrl) : ''
    });
  }
  const discontinuityCount = lines.reduce((count, line) => count + (line === '#EXT-X-DISCONTINUITY' ? 1 : 0), 0);
  const playlistTypeLine = lines.find((line) => line.startsWith('#EXT-X-PLAYLIST-TYPE:')) || '';
  const playlistType = playlistTypeLine.split(':')[1]?.trim().toLowerCase() || '';
  const targetDurationLine = lines.find((line) => line.startsWith('#EXT-X-TARGETDURATION:')) || '';
  const targetDuration = Number(targetDurationLine.split(':')[1]) || 0;
  const mediaSequenceLine = lines.find((line) => line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) || '';
  const mediaSequence = Number(mediaSequenceLine.split(':')[1]) || 0;
  const segmentUris = [];
  let segmentCount = 0;
  let partialSegmentCount = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-PART')) {
      if (normalizeUrl(readStringAttr(line, 'URI'), baseUrl)) partialSegmentCount += 1;
      continue;
    }
    if (!line || line.startsWith('#') || /\.m3u8(?:[?#]|$)/i.test(line)) continue;
    const segmentUrl = normalizeUrl(line, baseUrl);
    if (!segmentUrl) continue;
    segmentCount += 1;
    if (segmentUris.length < MAX_PARSED_HLS_SEGMENTS) segmentUris.push(segmentUrl);
  }
  const durationSeconds = lines.reduce((sum, line) => {
    const match = /^#EXTINF:([0-9.]+)/i.exec(line);
    return sum + (match ? Number(match[1]) || 0 : 0);
  }, 0);
  const estimatedDurationSeconds = durationSeconds || (targetDuration && segmentCount ? targetDuration * segmentCount : 0);
  return {
    variants,
    audioRenditions,
    segmentUris,
    playlist: {
      inspected: true,
      segmentCount,
      segmentCountScope: variants.length ? 'master-playlist' : 'media-playlist',
      exactSegmentCount: !variants.length,
      durationSeconds,
      estimatedDurationSeconds,
      targetDuration,
      mediaSequence,
      partialSegmentCount,
      discontinuityCount,
      hasDiscontinuity: discontinuityCount > 0,
      hasSeparateAudio: audioRenditionCount > 0 || variants.some((variant) => variant.audioGroupId),
      audioRenditionCount,
      variantCount: variantResult.count,
      tooManyVariants: variantResult.count > MAX_PARSED_HLS_VARIANTS,
      tooManyAudioRenditions: audioRenditionCount > MAX_PARSED_HLS_AUDIO_RENDITIONS,
      tooManySegments: segmentCount > MAX_PARSED_HLS_SEGMENTS,
      playlistType,
      hasMap: lines.some((line) => line.startsWith('#EXT-X-MAP')),
      hasFmp4Segments: segmentUris.some((url) => /\.(m4s|mp4|m4v|cmfv|cmfa)(?:[?#]|$)/i.test(url)),
      hasPartialSegments: partialSegmentCount > 0,
      hasPreloadHint: lines.some((line) => line.startsWith('#EXT-X-PRELOAD-HINT')),
      iframeOnly: lines.some((line) => line.startsWith('#EXT-X-I-FRAMES-ONLY')),
      hasIndependentSegments: lines.some((line) => line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')),
      playlistKind: variants.length ? 'master' : 'media',
      hasByteRange: lines.some((line) => line.startsWith('#EXT-X-BYTERANGE')),
      hasEndList: lines.some((line) => line.startsWith('#EXT-X-ENDLIST'))
    }
  };
}

async function annotateSelectedHlsVariant(item, settings = {}) {
  if (!Array.isArray(item.variants) || !item.variants.length) {
    if (item.playlist) {
      item.playlist.segmentCountScope = 'media-playlist';
      item.playlist.exactSegmentCount = true;
    }
    return;
  }
  const selected = selectInspectableHlsVariant(item.variants, settings?.hlsVariantPreference);
  if (!selected?.url) {
    if (item.playlist) {
      item.playlist.segmentCountScope = 'selected-variant-unavailable';
      item.playlist.exactSegmentCount = false;
      item.playlist.requiresSeparateAudioMerge = Boolean(item.playlist.hasSeparateAudio);
    }
    return;
  }
  item.selectedVariant = publicVariantInfo(selected, { selfContained: isLikelySelfContainedHlsVariant(selected), inspected: false });
  if (!sameOrigin(selected.url, item.url)) {
    item.selectedVariant.inspectionError = 'selected-variant-cross-origin';
    if (item.playlist) {
      item.playlist.segmentCountScope = 'selected-variant-unavailable';
      item.playlist.exactSegmentCount = false;
    }
    return;
  }
  try {
    const text = await fetchTextWithTimeout(selected.url, 7000);
    const protection = detectHlsProtection(text);
    const variantInfo = parseHlsInspection(text, selected.url);
    item.selectedVariant = {
      ...item.selectedVariant,
      ...publicVariantInfo(selected, { selfContained: isLikelySelfContainedHlsVariant(selected), inspected: true }),
      encrypted: protection.encrypted,
      segmentCount: variantInfo.playlist.segmentCount,
      durationSeconds: variantInfo.playlist.durationSeconds,
      estimatedDurationSeconds: variantInfo.playlist.estimatedDurationSeconds,
      targetDuration: variantInfo.playlist.targetDuration,
      playlistType: variantInfo.playlist.playlistType,
      hasEndList: variantInfo.playlist.hasEndList,
      hasMap: variantInfo.playlist.hasMap,
      hasFmp4Segments: variantInfo.playlist.hasFmp4Segments,
      hasByteRange: variantInfo.playlist.hasByteRange,
      hasPartialSegments: variantInfo.playlist.hasPartialSegments,
      partialSegmentCount: variantInfo.playlist.partialSegmentCount,
      hasPreloadHint: variantInfo.playlist.hasPreloadHint,
      iframeOnly: variantInfo.playlist.iframeOnly,
      hasDiscontinuity: variantInfo.playlist.hasDiscontinuity,
      discontinuityCount: variantInfo.playlist.discontinuityCount,
      protectedHlsUri: findProtectedHlsUri(variantInfo, selected.url)
    };
    if (item.playlist) {
      const inherited = ['hasMap', 'hasFmp4Segments', 'hasByteRange', 'hasPartialSegments', 'hasPreloadHint', 'iframeOnly', 'hasDiscontinuity'];
      for (const key of inherited) item.playlist[key] = Boolean(item.playlist[key] || variantInfo.playlist[key]);
      item.playlist.segmentCount = variantInfo.playlist.segmentCount;
      item.playlist.segmentCountScope = 'selected-variant';
      item.playlist.exactSegmentCount = true;
      item.playlist.durationSeconds = variantInfo.playlist.durationSeconds;
      item.playlist.estimatedDurationSeconds = variantInfo.playlist.estimatedDurationSeconds;
      item.playlist.targetDuration = variantInfo.playlist.targetDuration;
      item.playlist.partialSegmentCount = variantInfo.playlist.partialSegmentCount;
      item.playlist.tooManySegments = Boolean(variantInfo.playlist.tooManySegments);
      item.playlist.tooManyVariants = Boolean(item.playlist.tooManyVariants || variantInfo.playlist.tooManyVariants);
      item.playlist.tooManyAudioRenditions = Boolean(item.playlist.tooManyAudioRenditions || variantInfo.playlist.tooManyAudioRenditions);
      item.playlist.discontinuityCount = Math.max(Number(item.playlist.discontinuityCount || 0), Number(variantInfo.playlist.discontinuityCount || 0));
      item.playlist.hasEndList = variantInfo.playlist.hasEndList;
      item.playlist.playlistType = variantInfo.playlist.playlistType || item.playlist.playlistType || '';
      item.playlist.selectedVariantUrlHost = getHostname(selected.url);
      item.playlist.selectedVariantResolution = selected.resolution || '';
      item.playlist.selectedVariantBandwidth = selected.bandwidth || 0;
      item.playlist.selectedVariantSelfContained = isLikelySelfContainedHlsVariant(selected);
      if (protection.encrypted) item.playlist.encrypted = true;
      if (item.selectedVariant.protectedHlsUri) item.playlist.protectedUriKind = item.selectedVariant.protectedHlsUri.kind;
    }
  } catch (error) {
    item.selectedVariant = {
      ...item.selectedVariant,
      inspected: false,
      inspectionError: error?.message || 'selected-variant-inspection-failed'
    };
    if (item.playlist) {
      item.playlist.segmentCountScope = 'selected-variant-unavailable';
      item.playlist.exactSegmentCount = false;
      item.playlist.selectedVariantResolution = selected.resolution || '';
      item.playlist.selectedVariantBandwidth = selected.bandwidth || 0;
    }
  }
}

async function fetchTextWithTimeout(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('manifest-fetch-timeout'), timeoutMs);
  try {
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await readBoundedResponseText(response, MAX_MANIFEST_TEXT_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedResponseText(response, maxBytes) {
  const contentLengthHeader = response.headers?.get?.('content-length');
  const contentLength = contentLengthHeader == null || contentLengthHeader === '' ? null : Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Manifest exceeds the ${maxBytes}-byte inspection limit.`);
  }
  if (!response.body?.getReader) {
    throw new Error('Manifest cannot be inspected safely because the browser did not expose a bounded response stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try { await reader.cancel('manifest-inspection-limit'); } catch (_error) {}
        throw new Error(`Manifest exceeds the ${maxBytes}-byte inspection limit.`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock?.();
  }
}

function selectInspectableHlsVariant(variants = [], preference = HLS_VARIANT_PREFERENCES.HIGHEST) {
  const usable = variants.filter((variant) => variant?.url);
  if (!usable.length) return null;
  const selfContained = usable.filter(isLikelySelfContainedHlsVariant);
  if (!selfContained.length && usable.some((variant) => variant.audioGroupId)) return null;
  const candidates = selfContained.length ? selfContained : usable;
  const sorted = [...candidates].sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
  return preference === HLS_VARIANT_PREFERENCES.LOWEST ? sorted[sorted.length - 1] : sorted[0];
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

function publicVariantInfo(variant = {}, extra = {}) {
  return {
    urlHost: getHostname(variant.url || ''),
    bandwidth: variant.bandwidth || 0,
    resolution: variant.resolution || '',
    audioGroupId: variant.audioGroupId || '',
    codecs: variant.codecs || '',
    ...extra
  };
}

function readStringAttr(line, name) {
  const match = new RegExp(`${name}=(?:"([^"]*)"|([^,]*))`, 'i').exec(line);
  return match ? (match[1] ?? match[2] ?? '').trim() : '';
}


export function findProtectedHlsUri(hlsInfo = {}, playlistUrl = '') {
  const candidates = [
    { url: playlistUrl, kind: 'playlist' },
    ...(hlsInfo.variants || []).map((variant) => ({ url: variant.url, kind: 'variant-playlist' })),
    ...(hlsInfo.segmentUris || []).map((url) => ({ url, kind: 'segment' })),
    ...(hlsInfo.audioRenditions || []).filter((rendition) => rendition.uri).map((rendition) => ({ url: rendition.uri, kind: 'audio-rendition' }))
  ];
  return candidates.find((candidate) => candidate.url && looksSignedOrExpiring(candidate.url)) || null;
}

function parseHlsVariants(text, baseUrl) {
  const lines = String(text).split(/\r?\n/);
  const items = [];
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const next = (lines[index + 1] || '').trim();
    if (!next || next.startsWith('#')) continue;
    const bandwidth = /BANDWIDTH=(\d+)/i.exec(line)?.[1];
    const resolution = /RESOLUTION=(\d+x\d+)/i.exec(line)?.[1] || '';
    const url = normalizeUrl(next, baseUrl);
    if (url) {
      count += 1;
      if (items.length < MAX_PARSED_HLS_VARIANTS) {
        items.push({
          url,
          bandwidth: bandwidth ? Number(bandwidth) : undefined,
          resolution,
          audioGroupId: readStringAttr(line, 'AUDIO'),
          codecs: readStringAttr(line, 'CODECS')
        });
      }
    }
  }
  debug('Parsed HLS variants', count);
  return { items, count };
}

function parseDashRepresentations(text) {
  const items = [];
  let count = 0;
  const regex = /<Representation\b([^>]*)>/gi;
  let match;
  while ((match = regex.exec(String(text)))) {
    count += 1;
    if (items.length >= MAX_PARSED_DASH_REPRESENTATIONS) continue;
    const attrs = match[1];
    const id = /\bid=["']([^"']+)["']/i.exec(attrs)?.[1] || '';
    const bandwidth = /\bbandwidth=["'](\d+)["']/i.exec(attrs)?.[1];
    const width = /\bwidth=["'](\d+)["']/i.exec(attrs)?.[1];
    const height = /\bheight=["'](\d+)["']/i.exec(attrs)?.[1];
    const mimeType = /\bmimeType=["']([^"']+)["']/i.exec(attrs)?.[1] || '';
    items.push({
      id,
      bandwidth: bandwidth ? Number(bandwidth) : undefined,
      resolution: width && height ? `${width}x${height}` : '',
      mimeType
    });
  }
  return { items, count };
}

function hlsStructureLimitReason(playlist = {}) {
  if (playlist.tooManyVariants) return `This HLS master exposes more than ${MAX_PARSED_HLS_VARIANTS} variants, above the safe inspection limit.`;
  if (playlist.tooManyAudioRenditions) return `This HLS playlist exposes more than ${MAX_PARSED_HLS_AUDIO_RENDITIONS} audio renditions, above the safe inspection limit.`;
  if (playlist.tooManySegments) return `This HLS playlist exposes more than ${MAX_PARSED_HLS_SEGMENTS} segments, above the safe in-browser merge limit.`;
  return '';
}


function sanitizeScanResult(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const url = clipString(raw.url, 4096);
  if (!url) return null;
  return {
    url,
    source: clipString(raw.source, 80),
    type: clipString(raw.type, 160),
    mime: clipString(raw.mime, 160),
    resolution: clipString(raw.resolution, 40),
    transferSize: finiteNumber(raw.transferSize),
    encodedBodySize: finiteNumber(raw.encodedBodySize),
    decodedBodySize: finiteNumber(raw.decodedBodySize),
    frameId: Number.isInteger(raw.frameId) ? raw.frameId : undefined,
    frameUrl: clipString(raw.frameUrl, 4096),
    initiatorType: clipString(raw.initiatorType, 80),
    literalContext: clipString(raw.literalContext, 180),
    probableMseBlob: Boolean(raw.probableMseBlob),
    mediaDuration: finiteNumber(raw.mediaDuration),
    mediaInfo: sanitizeSmallObject(raw.mediaInfo),
    resourceInfo: sanitizeSmallObject(raw.resourceInfo),
    performanceStartTime: finiteNumber(raw.performanceStartTime),
    signedOrExpiringHint: Boolean(raw.signedOrExpiringHint)
  };
}

function clipString(value, maxLength = 512) {
  if (value == null) return '';
  return String(value).slice(0, maxLength);
}

function buildSafeResponseHeaderHints(headers = []) {
  const contentRange = getHeaderValue(headers, 'content-range');
  const acceptRanges = getHeaderValue(headers, 'accept-ranges');
  const contentEncoding = getHeaderValue(headers, 'content-encoding');
  const contentLength = parseContentLength(headers);
  return sanitizeResponseHeaderHints({
    contentRange,
    acceptRanges,
    contentEncoding,
    contentLength,
    contentRangeTotal: parseContentRangeTotal(contentRange)
  });
}

function parseContentRangeTotal(value = '') {
  const match = /bytes\s+\d+\s*-\s*\d+\s*\/\s*(\d+|\*)/i.exec(String(value || ''));
  if (!match || match[1] === '*') return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function sanitizeResponseHeaderHints(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  const contentRange = clipString(value.contentRange, 160);
  const acceptRanges = clipString(value.acceptRanges, 80);
  const contentEncoding = clipString(value.contentEncoding, 80);
  const contentLength = finiteNumber(value.contentLength);
  const contentRangeTotal = finiteNumber(value.contentRangeTotal);
  if (contentRange) result.contentRange = contentRange;
  if (acceptRanges) result.acceptRanges = acceptRanges;
  if (contentEncoding) result.contentEncoding = contentEncoding;
  if (contentLength != null) result.contentLength = contentLength;
  if (contentRangeTotal != null) result.contentRangeTotal = contentRangeTotal;
  return Object.keys(result).length ? result : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function sanitizeSmallObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = Object.create(null);
  for (const [key, itemValue] of Object.entries(value).slice(0, 16)) {
    const cleanKey = clipString(key, 80);
    if (!cleanKey || /^(?:__proto__|prototype|constructor)$/i.test(cleanKey)) continue;
    if (typeof itemValue === 'number' || typeof itemValue === 'boolean') result[cleanKey] = itemValue;
    else if (itemValue == null) result[cleanKey] = itemValue;
    else result[cleanKey] = clipString(itemValue, 240);
  }
  return result;
}

function applyDownloadAllowSummary(item, settings) {
  const policy = buildDownloadAllowSummary(item, settings);
  item.downloadPolicy = policy;
  item.downloadAllowed = Boolean(policy.allowed);
  item.downloadPrimaryAllowed = Boolean(policy.primaryAllowed);
  item.downloadAllowReason = policy.reason || '';
  if (policy.primaryAllowed && policy.limited && item.status === DOWNLOAD_STATUSES.UNSUPPORTED) {
    // Some items are "limited but downloadable", for example a top-level signed
    // MP4 URL that can be handed directly to Chrome Downloads. Keep the limited
    // marker for transparency, but do not present the item as unavailable.
    item.status = DOWNLOAD_STATUSES.DETECTED;
    if (item.unsupportedReason && /signed|token|expir/i.test(item.unsupportedReason)) item.unsupportedReason = '';
    if (!item.safetyWarning) item.safetyWarning = policy.reason || 'This item is allowed only for direct file saving.';
  }
  if (!policy.allowed && !item.isProtected) {
    item.isProtected = true;
    item.status = DOWNLOAD_STATUSES.UNSUPPORTED;
    item.unsupportedReason = policy.reason || 'This item is not on the download allow list.';
  }
}
