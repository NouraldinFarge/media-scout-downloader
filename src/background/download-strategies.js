import { DOWNLOAD_STATUSES, ERROR_CATEGORIES, HLS_OUTPUT_METHODS, IMPLEMENTED_HLS_OUTPUT_METHODS, HLS_VARIANT_PREFERENCES, MEDIA_TYPES, SOURCES, STRATEGY_NAMES } from '../shared/constants.js';
import { duplicateBehaviorToConflictAction } from '../shared/filename-utils.js';
import { createStructuredError } from '../shared/utils.js';
import { createDownloadPolicyError, getDownloadAllowDecision } from '../shared/download-allow-list.js';
import { canRetryCategory, isBlobUrl, isHttpUrl } from '../shared/validators.js';

export function orderedStrategiesForMedia(media, diagnostics, task = {}) {
  if (media.mediaType === MEDIA_TYPES.HLS) {
    const hlsOutputMethod = normalizeHlsOutputMethod(task.hlsOutputMethod || task.settings?.hlsOutputMethod);
    if (hlsOutputMethod === HLS_OUTPUT_METHODS.PLAYLIST_ONLY) return [STRATEGY_NAMES.HLS_PLAYLIST];
    if (hlsOutputMethod === HLS_OUTPUT_METHODS.EXTERNAL_HELPER) return [STRATEGY_NAMES.HLS_EXTERNAL_HELPER];
    // User-facing HLS behavior is intentionally strict: Convert means "fetch
    // non-encrypted segments using normal page access and emit the selected
    // supported output". We do not fall back to saving .m3u8 text as a fake MP4.
    return [STRATEGY_NAMES.HLS_SEGMENT_MERGE];
  }

  // Strategy ordering is part of the safety model, not only a performance hint.
  // Diagnostics may reorder equivalent direct HTTP strategies, but it must not
  // move a generic direct-file attempt ahead of a required capability-specific
  // strategy. Blob URLs have to be resolved in the page context, and DASH is a
  // manifest-only save path in this build. If either fell through to
  // DIRECT_FILE first, the non-retryable UNSUPPORTED result could stop the chain
  // before the useful strategy ran.
  if (isBlobUrl(media.url)) return [STRATEGY_NAMES.BLOB_PAGE_DOWNLOAD];
  if (media.mediaType === MEDIA_TYPES.DASH) return [STRATEGY_NAMES.DASH_MANIFEST];

  const candidates = [];
  if (media.source === SOURCES.DOM_AUDIO || media.source === SOURCES.DOM_VIDEO || media.source === SOURCES.DOM_SOURCE) {
    candidates.push(STRATEGY_NAMES.HTML_MEDIA_SOURCE);
  }
  candidates.push(STRATEGY_NAMES.DIRECT_FILE);
  return diagnostics.prioritize(Array.from(new Set(candidates)));
}

export async function downloadWithAllowedStrategies(task, context) {
  const { media } = task;
  const policyDecision = getDownloadAllowDecision(media, {
    settings: context.settings,
    hlsOutputMethod: task.hlsOutputMethod || context.settings?.hlsOutputMethod
  });
  if (!policyDecision.allowed) throw createDownloadPolicyError(policyDecision);

  const strategies = orderedStrategiesForMedia(media, context.diagnostics, { ...task, settings: context.settings });
  const failures = [];
  for (const strategyName of strategies) {
    try {
      const result = await runStrategy(strategyName, task, context);
      await context.diagnostics.recordStrategySuccess(strategyName);
      return { ...result, strategy: strategyName };
    } catch (error) {
      const structured = normalizeStrategyError(error, strategyName);
      await context.diagnostics.recordStrategyFailure(strategyName, structured.category);
      failures.push(structured);
      if (!canRetryCategory(structured.category)) throw structured;
    }
  }
  const last = failures[failures.length - 1];
  throw last || createStructuredError(ERROR_CATEGORIES.UNKNOWN, 'download-failed', 'No allowed download strategy succeeded.');
}

async function runStrategy(strategyName, task, context) {
  switch (strategyName) {
    case STRATEGY_NAMES.HLS_SEGMENT_MERGE:
      return hlsSegmentMergeStrategy(task, context);
    case STRATEGY_NAMES.HLS_PLAYLIST:
      return hlsPlaylistStrategy(task, context);
    case STRATEGY_NAMES.HLS_EXTERNAL_HELPER:
      return hlsExternalHelperStrategy(task, context);
    case STRATEGY_NAMES.DASH_MANIFEST:
      return dashManifestStrategy(task, context);
    case STRATEGY_NAMES.BLOB_PAGE_DOWNLOAD:
      return blobPageDownloadStrategy(task, context);
    case STRATEGY_NAMES.HTML_MEDIA_SOURCE:
      return htmlMediaSourceStrategy(task, context);
    case STRATEGY_NAMES.DIRECT_FILE:
      return directFileStrategy(task, context);
    default:
      throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'unknown-strategy', 'Unknown download strategy.');
  }
}

async function hlsSegmentMergeStrategy(task, context) {
  const media = task.media;
  if (media.mediaType !== MEDIA_TYPES.HLS) throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'not-hls', 'Not an HLS playlist.');
  if (!isHttpUrl(media.url)) throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'hls-url-not-http', 'HLS merging requires an HTTP(S) playlist URL.');

  const hlsOutputMethod = normalizeHlsOutputMethod(task.hlsOutputMethod || context.settings?.hlsOutputMethod);
  const methodDecision = getDownloadAllowDecision(media, { settings: context.settings, hlsOutputMethod });
  if (!methodDecision.allowed) throw createDownloadPolicyError(methodDecision);
  if (hlsOutputMethod === HLS_OUTPUT_METHODS.PLAYLIST_ONLY) return hlsPlaylistStrategy(task, context);
  if (hlsOutputMethod === HLS_OUTPUT_METHODS.EXTERNAL_HELPER) return hlsExternalHelperStrategy(task, context);
  const planned = plannedHlsMethodError(hlsOutputMethod);
  if (planned) throw planned;

  const outputExtension = hlsOutputMethod === HLS_OUTPUT_METHODS.TS_CONCAT || hlsOutputMethod === HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS ? 'ts' : 'mp4';

  // HLS segment merging runs in the page/frame content script so fetch() obeys
  // normal page/browser CORS, credential, and access rules. The extension does
  // not use host permissions or background fetch to bypass site restrictions.
  const selectedVariant = selectHlsVariant(media.variants, context.settings?.hlsVariantPreference, { preferSelfContained: media.playlist?.hasSeparateAudio });
  const response = await sendTabFrameMessage(task.tabId, {
    type: context.messageTypes.HLS_MERGE_DOWNLOAD_REQUEST,
    playlistUrl: selectedVariant?.url || media.url,
    originalPlaylistUrl: media.url,
    filename: replaceFilenameExtension(task.filename, outputExtension),
    mediaId: media.id,
    taskId: task.id,
    resolution: selectedVariant?.resolution || media.resolution || '',
    bandwidth: selectedVariant?.bandwidth || 0,
    requireMp4: hlsOutputMethod === HLS_OUTPUT_METHODS.MP4_REMUX || hlsOutputMethod === HLS_OUTPUT_METHODS.SMART_MP4,
    hlsOutputMethod,
    hlsVariantPreference: normalizeHlsVariantPreference(context.settings?.hlsVariantPreference),
    hlsWorkMode: context.settings?.hlsWorkMode || 'balanced',
    segmentParallelism: context.settings?.segmentParallelism || 4,
    segmentRetryLimit: Number.isFinite(Number(context.settings?.segmentRetryLimit)) ? Number(context.settings.segmentRetryLimit) : 2
  }, media.frameId);

  if (!response?.ok) {
    throw createStructuredError(
      response?.category || ERROR_CATEGORIES.UNKNOWN,
      response?.code || 'hls-merge-failed',
      response?.error || 'HLS segment merge failed with normal browser access.',
      { details: response?.details || null }
    );
  }

  return {
    downloadId: null,
    status: DOWNLOAD_STATUSES.VERIFY_UNCERTAIN,
    verifyMessage: 'The HLS file was handed to the page/browser download UI. Media Scout cannot verify final Save As completion from the service worker.',
    segmentCount: response.segmentCount,
    totalBytes: response.totalBytes,
    outputFilename: response.filename,
    remuxedToMp4: Boolean(response.remuxedToMp4),
    remuxFallbackReason: response.remuxFallbackReason || '',
    segmentRetryCount: response.segmentRetryCount || 0,
    peakConcurrency: response.peakConcurrency || 0,
    averageBytesPerSecond: response.averageBytesPerSecond || 0,
    variantUrl: response.variantUrl || '',
    hlsVariantPreference: response.hlsVariantPreference || normalizeHlsVariantPreference(context.settings?.hlsVariantPreference),
    selectedResolution: response.selectedResolution || selectedVariant?.resolution || '',
    selectedBandwidth: response.selectedBandwidth || selectedVariant?.bandwidth || 0,
    hasAudio: Boolean(response.hasAudio),
    estimatedVideoFps: response.estimatedVideoFps || 0,
    videoSampleCount: response.videoSampleCount || 0,
    audioSampleCount: response.audioSampleCount || 0,
    outputBytes: response.outputBytes || 0,
    videoDurationSeconds: response.videoDurationSeconds || 0,
    audioDurationSeconds: response.audioDurationSeconds || 0,
    keyFrameCount: response.keyFrameCount || 0,
    droppedVideoSamples: response.droppedVideoSamples || 0,
    droppedAudioSamples: response.droppedAudioSamples || 0,
    remuxWarnings: response.remuxWarnings || [],
    hlsOutputMethod: response.hlsOutputMethod || task.hlsOutputMethod || context.settings?.hlsOutputMethod || '',
    outputExtension: response.outputExtension || ''
  };
}



function normalizeHlsVariantPreference(value) {
  return Object.values(HLS_VARIANT_PREFERENCES).includes(value) ? value : HLS_VARIANT_PREFERENCES.HIGHEST;
}

function selectHlsVariant(variants = [], preference = HLS_VARIANT_PREFERENCES.HIGHEST, options = {}) {
  const usable = Array.isArray(variants) ? variants.filter((variant) => variant?.url) : [];
  if (!usable.length) return null;
  const candidatePool = options.preferSelfContained ? usable.filter(isLikelySelfContainedHlsVariant) : [];
  if (options.preferSelfContained && !candidatePool.length) return null;
  const pool = candidatePool.length ? candidatePool : usable;
  const sorted = [...pool].sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
  return normalizeHlsVariantPreference(preference) === HLS_VARIANT_PREFERENCES.LOWEST ? sorted[sorted.length - 1] : sorted[0];
}

function isLikelySelfContainedHlsVariant(variant = {}) {
  if (!variant?.url) return false;
  if (variant.audioGroupId) return false;
  const codecs = String(variant.codecs || '').toLowerCase();
  if (!codecs) return true;
  const hasVideoCodec = /avc|hvc|hev|vp0?9|av01|theora|dvhe|dvh1|mp4v/.test(codecs);
  const hasAudioCodec = /mp4a|aac|ac-3|ec-3|opus|vorbis|flac|mp3/.test(codecs);
  return hasVideoCodec && hasAudioCodec;
}

function normalizeHlsOutputMethod(value) {
  return IMPLEMENTED_HLS_OUTPUT_METHODS.includes(value) ? value : HLS_OUTPUT_METHODS.SMART_MP4;
}

function plannedHlsMethodError(method) {
  const messages = {
    [HLS_OUTPUT_METHODS.FMP4_ASSEMBLY]: 'fMP4/CMAF HLS assembly needs #EXT-X-MAP/init-fragment handling and is tracked as a planned mode, but this build does not assemble it yet.',
    [HLS_OUTPUT_METHODS.SEPARATE_AUDIO_MERGE]: 'Separate audio/video HLS merge needs EXT-X-MEDIA audio selection and timeline alignment and is tracked as a planned mode, but this build does not merge separate renditions yet.',
    [HLS_OUTPUT_METHODS.VISIBLE_RECORDING]: 'Visible-player recording is a separate real-time recorder mode, not a source download. This build lists it for planning but does not record the tab/player yet.',

  };
  if (!messages[method]) return null;
  return createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, `hls-method-${method}-not-implemented`, messages[method], { hlsOutputMethod: method });
}


async function hlsExternalHelperStrategy(task, context) {
  const media = task.media;
  if (media.mediaType !== MEDIA_TYPES.HLS) throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'not-hls', 'Not an HLS playlist.');
  if (media.playlist?.encrypted || media.isProtected) {
    throw createStructuredError(ERROR_CATEGORIES.ENCRYPTED, 'encrypted-hls', 'Encrypted HLS streams are unsupported.');
  }
  const selectedVariant = selectHlsVariant(media.variants, context.settings?.hlsVariantPreference, { preferSelfContained: media.playlist?.hasSeparateAudio });
  const playlistUrl = selectedVariant?.url || media.url;
  const outputName = replaceFilenameExtension(task.filename, 'mp4').split('/').pop();
  const command = `ffmpeg -protocol_whitelist file,http,https,tcp,tls,crypto -i ${shellQuote(playlistUrl)} -c copy ${shellQuote(outputName)}`;
  const body = [
    'Media Scout Downloader external helper notes',
    '',
    'This file was generated locally by the extension. It does not include cookies, credentials, decryption keys, or bypass instructions.',
    'Use only for media you are legally allowed to access and that is normally accessible to your own tools.',
    '',
    `Playlist URL: ${playlistUrl}`,
    `Suggested output: ${outputName}`,
    '',
    'Example command for a trusted local tool such as FFmpeg:',
    command,
    '',
    'If this fails with 401/403/CORS/token errors, Media Scout will not help bypass those restrictions.',
    'If audio is desynced in raw TS concat, a real muxer/remuxer is usually required.'
  ].join('\n');
  const filename = replaceFilenameExtension(task.filename, 'txt');
  return chromeDownload(`data:text/plain;charset=utf-8,${encodeURIComponent(body)}`, filename, context.settings, context.onProgress, context.onDownloadStarted, { isCanceled: context.isCanceled });
}

async function hlsPlaylistStrategy(task, context) {
  const media = task.media;
  if (media.mediaType !== MEDIA_TYPES.HLS) throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'not-hls', 'Not an HLS playlist.');
  const decision = getDownloadAllowDecision(media, { settings: context.settings, hlsOutputMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY });
  if (!decision.allowed) throw createDownloadPolicyError(decision);
  // Save the top-level playlist text. If variant/segment URLs are protected,
  // saving the original .m3u8 is still harmless and avoids blocking a file that
  // Chrome can normally download. It is not treated as a video download.
  return chromeDownload(media.url, task.filename, context.settings, context.onProgress, context.onDownloadStarted, { isCanceled: context.isCanceled });
}

async function dashManifestStrategy(task, context) {
  const media = task.media;
  if (media.mediaType !== MEDIA_TYPES.DASH) throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'not-dash', 'Not a DASH manifest.');
  const decision = getDownloadAllowDecision(media, { settings: context.settings });
  if (!decision.allowed) throw createDownloadPolicyError(decision);
  return chromeDownload(media.url, task.filename, context.settings, context.onProgress, context.onDownloadStarted, { isCanceled: context.isCanceled });
}

async function blobPageDownloadStrategy(task, context) {
  if (!isBlobUrl(task.media.url)) throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'not-blob', 'Not a blob URL.');
  const response = await sendTabFrameMessage(task.tabId, {
    type: context.messageTypes.BLOB_DOWNLOAD_REQUEST,
    url: task.media.url,
    filename: task.filename
  }, task.media.frameId);
  if (!response?.ok) {
    throw createStructuredError(ERROR_CATEGORIES.ACCESS_CONTROL, 'blob-download-failed', response?.error || 'The page could not download this blob URL.');
  }
  return {
    downloadId: null,
    status: DOWNLOAD_STATUSES.VERIFY_UNCERTAIN,
    verifyMessage: 'The blob URL was handed to the page/browser download UI. Media Scout cannot verify final Save As completion from the service worker.'
  };
}

async function htmlMediaSourceStrategy(task, context) {
  if (!isHttpUrl(task.media.url)) throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'not-http-media', 'HTML media source is not an HTTP(S) URL.');
  const decision = getDownloadAllowDecision(task.media, { settings: context.settings });
  if (!decision.allowed) throw createDownloadPolicyError(decision);
  return chromeDownload(task.media.url, task.filename, context.settings, context.onProgress, context.onDownloadStarted, { isCanceled: context.isCanceled });
}

async function directFileStrategy(task, context) {
  if (!isHttpUrl(task.media.url)) throw createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'not-direct-url', 'Direct downloads require an HTTP(S) URL.');
  const decision = getDownloadAllowDecision(task.media, { settings: context.settings });
  if (!decision.allowed) throw createDownloadPolicyError(decision);
  return chromeDownload(task.media.url, task.filename, context.settings, context.onProgress, context.onDownloadStarted, { isCanceled: context.isCanceled });
}

async function chromeDownload(url, filename, settings, onProgress = () => {}, onDownloadStarted = () => {}, options = {}) {
  const conflictAction = duplicateBehaviorToConflictAction(settings.duplicateBehavior);
  try { onProgress({ phase: 'starting', percent: 1, detail: 'Starting Chrome download.' }); } catch (_error) {}
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction, saveAs: conflictAction === 'prompt' }, (id) => {
      const error = chrome.runtime.lastError;
      if (error) reject(createStructuredError(classifyChromeDownloadError(error.message), 'chrome-download-error', error.message));
      else if (!Number.isInteger(id) || id < 0) reject(createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'chrome-download-id-missing', 'Chrome started no monitorable download. Check browser Downloads before trying again.'));
      else resolve(id);
    });
  });
  try { onDownloadStarted(downloadId); } catch (_error) {}
  await waitForDownloadCompletion(downloadId, onProgress, options);
  return { downloadId, status: DOWNLOAD_STATUSES.COMPLETED };
}

function waitForDownloadCompletion(downloadId, onProgress = () => {}, options = {}) {
  const isCanceled = typeof options.isCanceled === 'function' ? options.isCanceled : () => false;
  const idleTimeoutMs = Math.max(60_000, Number(options.idleTimeoutMs) || 5 * 60_000);
  const hardTimeoutMs = Math.max(idleTimeoutMs, Number(options.hardTimeoutMs) || 6 * 60 * 60_000);
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastBytes = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let listenerRegistered = false;
    const cleanup = () => {
      if (settled) return false;
      settled = true;
      clearInterval(watchdog);
      if (listenerRegistered) {
        try { chrome.downloads.onChanged.removeListener(listener); } catch (_error) {}
        listenerRegistered = false;
      }
      return true;
    };
    const fail = (error) => {
      if (!cleanup()) return;
      reject(error);
    };
    const cancelAndFail = (error) => {
      try { chrome.downloads.cancel(downloadId, () => void chrome.runtime.lastError); } catch (_error) {}
      fail(error);
    };
    const done = () => {
      if (!cleanup()) return;
      try { onProgress({ phase: 'completed', percent: 100, detail: 'Chrome download completed.' }); } catch (_error) {}
      resolve();
    };
    const inspectCurrentState = () => {
      try {
        chrome.downloads.search({ id: downloadId }, (items) => {
          if (settled) return;
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) return;
          const item = items?.[0];
          if (!item) return;
          const bytes = Number(item.bytesReceived) || 0;
          if (bytes > lastBytes) {
            lastBytes = bytes;
            lastProgressAt = Date.now();
            reportChromeDownloadProgress(downloadId, onProgress);
          }
          if (item.state === 'complete') done();
          else if (item.state === 'interrupted') {
            const category = isCanceled() ? ERROR_CATEGORIES.USER_CANCELED : classifyChromeDownloadError(item.error || 'download-interrupted');
            fail(createStructuredError(category, category === ERROR_CATEGORIES.USER_CANCELED ? 'download-canceled' : 'download-interrupted', item.error || 'Download was interrupted.'));
          }
        });
      } catch (_error) {}
    };
    const listener = (delta) => {
      if (delta.id !== downloadId || settled) return;
      if (delta.bytesReceived || delta.totalBytes) {
        lastProgressAt = Date.now();
        reportChromeDownloadProgress(downloadId, onProgress);
      }
      if (delta.error?.current) fail(createStructuredError(classifyChromeDownloadError(delta.error.current), 'download-error', delta.error.current));
      if (delta.state?.current === 'complete') done();
      if (delta.state?.current === 'interrupted') fail(createStructuredError(isCanceled() ? ERROR_CATEGORIES.USER_CANCELED : ERROR_CATEGORIES.NETWORK, isCanceled() ? 'download-canceled' : 'download-interrupted', isCanceled() ? 'Download was canceled by the user.' : 'Download was interrupted.'));
    };
    const watchdog = setInterval(() => {
      if (settled) return;
      if (isCanceled()) {
        cancelAndFail(createStructuredError(ERROR_CATEGORIES.USER_CANCELED, 'download-canceled', 'Download was canceled by the user.'));
        return;
      }
      const now = Date.now();
      if (now - startedAt > hardTimeoutMs) {
        cancelAndFail(createStructuredError(ERROR_CATEGORIES.NETWORK, 'download-hard-timeout', 'Chrome download did not complete before the safety timeout and was canceled.'));
        return;
      }
      if (now - lastProgressAt > idleTimeoutMs) {
        cancelAndFail(createStructuredError(ERROR_CATEGORIES.NETWORK, 'download-idle-timeout', 'Chrome download stopped making progress and was canceled after the idle timeout.'));
        return;
      }
      inspectCurrentState();
    }, 5_000);

    try {
      chrome.downloads.onChanged.addListener(listener);
      listenerRegistered = true;
      inspectCurrentState();
    } catch (error) {
      fail(createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'chrome-download-listener-failed', `${error?.message || 'Chrome download monitoring could not start.'} Check browser Downloads before trying again.`));
    }
  });
}


function reportChromeDownloadProgress(downloadId, onProgress) {
  try {
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError) return;
      const item = items?.[0];
      if (!item) return;
      const total = Number(item.totalBytes) || 0;
      const loaded = Number(item.bytesReceived) || 0;
      const percent = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 5;
      try { onProgress({ phase: 'downloading', loaded, total: total || null, percent, detail: total > 0 ? `Downloaded ${loaded} of ${total} bytes.` : `Downloaded ${loaded} bytes.` }); } catch (_error) {}
    });
  } catch (_error) {
    // The watchdog's primary status lookup owns failure handling.
  }
}

function sendTabFrameMessage(tabId, message, frameId) {
  return new Promise((resolve, reject) => {
    const callback = (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'content-script-unavailable', error.message));
      else resolve(response);
    };
    if (Number.isInteger(frameId) && frameId >= 0) chrome.tabs.sendMessage(tabId, message, { frameId }, callback);
    else chrome.tabs.sendMessage(tabId, message, callback);
  });
}

function replaceFilenameExtension(filename, extension) {
  const cleanExtension = String(extension || 'ts').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'ts';
  const parts = String(filename || `media.${cleanExtension}`).split('/');
  const base = parts.pop() || `media.${cleanExtension}`;
  const replaced = base.includes('.') ? base.replace(/\.[^.]+$/, `.${cleanExtension}`) : `${base}.${cleanExtension}`;
  return [...parts, replaced].filter(Boolean).join('/');
}

export function shellQuote(value = '') {
  // External-helper notes are copied into a local shell at the user's discretion.
  // Single-quote escaping prevents shell interpolation of $, backticks, and
  // whitespace in signed playlist URLs or suggested filenames.
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function classifyChromeDownloadError(message = '') {
  const text = String(message).toLowerCase();
  if (/user[_ -]?(?:canceled|cancelled)|user[_ -]?shutdown|\bcancel(?:ed|led)?\b/.test(text)) return ERROR_CATEGORIES.USER_CANCELED;
  if (/auth|login|unauthorized/.test(text)) return ERROR_CATEGORIES.AUTHENTICATION;
  if (/permission|forbidden|denied|file[_ -]?(?:blocked|virus|security)/.test(text)) return ERROR_CATEGORIES.PERMISSION;
  if (/file[_ -]?(?:name[_ -]?too[_ -]?long|no[_ -]?space)/.test(text)) return ERROR_CATEGORIES.VALIDATION;
  if (/file[_ -]?too[_ -]?large/.test(text)) return ERROR_CATEGORIES.UNSUPPORTED;
  if (/network|timeout|server|interrupted/.test(text)) return ERROR_CATEGORIES.NETWORK;
  return ERROR_CATEGORIES.UNKNOWN;
}

function normalizeStrategyError(error, strategyName) {
  if (error?.category && error?.message) return { ...error, strategy: strategyName, retryable: canRetryCategory(error.category) };
  return createStructuredError(ERROR_CATEGORIES.UNKNOWN, 'strategy-error', error?.message || 'Download strategy failed.', {
    strategy: strategyName,
    retryable: true
  });
}
