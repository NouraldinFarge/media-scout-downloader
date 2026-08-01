import {
  DEFAULT_SETTINGS,
  ERROR_CATEGORIES,
  MEDIA_EXTENSIONS,
  MESSAGE_TYPES,
  HLS_OUTPUT_METHODS,
  IMPLEMENTED_HLS_OUTPUT_METHODS,
  HLS_VARIANT_PREFERENCES,
  PROTECTED_QUERY_HINTS,
  RETRY_BLOCKED_CATEGORIES
} from './constants.js';
import { createStructuredError, getUrlExtension, normalizeUrl } from './utils.js';

export function isSupportedMediaExtension(extension) {
  return Boolean(MEDIA_EXTENSIONS[String(extension || '').toLowerCase()]);
}

export function isSafeUrlScheme(rawUrl) {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'blob:';
  } catch (_error) {
    return false;
  }
}

export function isHttpUrl(rawUrl) {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

export function isBlobUrl(rawUrl) {
  try {
    return new URL(rawUrl).protocol === 'blob:';
  } catch (_error) {
    return false;
  }
}

export function looksSignedOrExpiring(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const keys = Array.from(url.searchParams.keys()).map((key) => key.toLowerCase());
    return keys.some((key) => PROTECTED_QUERY_HINTS.some((hint) => key === hint || key.includes(hint)));
  } catch (_error) {
    return false;
  }
}

export function validateMediaUrl(rawUrl, { allowBlob = true } = {}) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) {
    return createStructuredError(ERROR_CATEGORIES.VALIDATION, 'invalid-url', 'The media URL is invalid.');
  }
  if (!isSafeUrlScheme(normalized)) {
    return createStructuredError(ERROR_CATEGORIES.ACCESS_CONTROL, 'unsupported-scheme', 'This URL scheme is not supported.');
  }
  if (!allowBlob && isBlobUrl(normalized)) {
    return createStructuredError(ERROR_CATEGORIES.UNSUPPORTED, 'blob-not-allowed', 'Blob URLs require page-local handling.');
  }
  if (looksSignedOrExpiring(normalized)) {
    return createStructuredError(
      ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL,
      'signed-or-expiring-url',
      'This URL appears to use signed, expiring, or tokenized access. Media Scout will not try to bypass or reuse protected links.'
    );
  }
  return null;
}


const CONTENT_SCRIPT_MESSAGE_TYPES = Object.freeze([
  MESSAGE_TYPES.DOM_MEDIA_FOUND,
  MESSAGE_TYPES.DOWNLOAD_PROGRESS
]);

export function isContentScriptMessageType(type) {
  return CONTENT_SCRIPT_MESSAGE_TYPES.includes(type);
}

export function isPrivilegedExtensionMessageType(type) {
  return Object.values(MESSAGE_TYPES).includes(type) && !isContentScriptMessageType(type);
}

export function validateMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (!Object.values(MESSAGE_TYPES).includes(message.type)) return false;

  switch (message.type) {
    case MESSAGE_TYPES.START_DOWNLOAD:
      return isPositiveInteger(message.tabId) && isNonEmptyString(message.mediaId) && isOptionalImplementedHlsMethod(message.hlsOutputMethod);
    case MESSAGE_TYPES.RETRY_DOWNLOAD:
    case MESSAGE_TYPES.CANCEL_DOWNLOAD:
      return isNonEmptyString(message.taskId);
    case MESSAGE_TYPES.DOWNLOAD_PROGRESS:
      return isNonEmptyString(message.taskId) && isSafeProgressMessage(message);
    case MESSAGE_TYPES.DOM_MEDIA_FOUND:
      return Array.isArray(message.items) && message.items.length <= 500 && message.items.every(isSafeScanItem);
    case MESSAGE_TYPES.CONVERT_M3U8_TO_MP4:
      return isNonEmptyString(message.url, 4096) && isOptionalImplementedHlsMethod(message.hlsOutputMethod);
    case MESSAGE_TYPES.SETTINGS_SAVE:
      return !message.settings || isSafeSettingsPayload(message.settings);
    case MESSAGE_TYPES.GENERATE_REPORT:
      return message.includeSensitiveUrls == null || typeof message.includeSensitiveUrls === 'boolean';
    case MESSAGE_TYPES.REQUEST_SITE_ACCESS:
      return !message.origin || /^https?:\/\//i.test(String(message.origin));
    case MESSAGE_TYPES.START_EPISODE_BATCH_DOWNLOADS:
      return (!message.episodes || (Array.isArray(message.episodes) && message.episodes.length <= 120 && message.episodes.every(isSafeEpisodeRequest))) && isOptionalImplementedHlsMethod(message.hlsOutputMethod);
    case MESSAGE_TYPES.HLS_MERGE_DOWNLOAD_REQUEST:
      return isNonEmptyString(message.taskId) && isNonEmptyString(message.playlistUrl, 4096) && isOptionalImplementedHlsMethod(message.hlsOutputMethod) && isOptionalEnum(message.hlsVariantPreference, HLS_VARIANT_PREFERENCES) && isOptionalFiniteNumber(message.bandwidth) && (!message.resolution || String(message.resolution).length <= 32);
    case MESSAGE_TYPES.BLOB_DOWNLOAD_REQUEST:
      return isNonEmptyString(message.url, 4096) && (!message.filename || String(message.filename).length <= 240);
    case MESSAGE_TYPES.CANCEL_HLS_TASK:
      return isNonEmptyString(message.taskId);
    case MESSAGE_TYPES.PAUSE_QUEUE:
    case MESSAGE_TYPES.RESUME_QUEUE:
      return true;
    default:
      return true;
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value, maxLength = 512) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isSafeProgressMessage(message = {}) {
  const percent = Number(message.percent);
  if (message.phase != null && String(message.phase).length > 64) return false;
  if (message.detail != null && String(message.detail).length > 600) return false;
  if (message.loaded != null && !Number.isFinite(Number(message.loaded))) return false;
  if (message.total != null && !Number.isFinite(Number(message.total))) return false;
  return message.percent == null || (Number.isFinite(percent) && percent >= 0 && percent <= 100);
}

export function validateFileTypeSettings(enabledFileTypes = {}) {
  const result = {};
  for (const extension of Object.keys(MEDIA_EXTENSIONS)) {
    result[extension] = enabledFileTypes[extension] !== false;
  }
  return result;
}

export function isExtensionEnabled(extension, settings) {
  if (!extension || extension === 'media') return true;
  return settings?.enabledFileTypes?.[String(extension).toLowerCase()] !== false;
}

export function detectHlsProtection(playlistText = '') {
  const text = String(playlistText);
  const keyLines = text.split(/\r?\n/).filter((line) => line.trim().startsWith('#EXT-X-KEY') || line.trim().startsWith('#EXT-X-SESSION-KEY'));
  const encrypted = keyLines.some((line) => !/METHOD\s*=\s*NONE/i.test(line));
  return {
    encrypted,
    markers: keyLines.slice(0, 5)
  };
}

export function detectDashProtection(manifestText = '') {
  const text = String(manifestText);
  const hasProtection = /<\s*ContentProtection\b/i.test(text) || /cenc:|widevine|playready|clearkey|mspr:/i.test(text);
  return {
    encrypted: hasProtection,
    markers: hasProtection ? ['ContentProtection or DRM marker'] : []
  };
}

export function canRetryCategory(category) {
  return !RETRY_BLOCKED_CATEGORIES.includes(category);
}

export function inferExtensionAllowed(rawUrl, settings) {
  const extension = getUrlExtension(rawUrl);
  return !extension || isSupportedMediaExtension(extension) ? isExtensionEnabled(extension, settings) : false;
}

function isOptionalEnum(value, enumObject) {
  return value == null || value === '' || Object.values(enumObject).includes(value);
}

function isOptionalImplementedHlsMethod(value) {
  return value == null || value === '' || IMPLEMENTED_HLS_OUTPUT_METHODS.includes(value);
}

function isOptionalFiniteNumber(value) {
  return value == null || value === '' || Number.isFinite(Number(value));
}

function isSafeScanItem(item = {}) {
  if (!item || typeof item !== 'object') return false;
  if (!isNonEmptyString(item.url, 4096)) return false;
  const stringLimits = {
    source: 80,
    type: 160,
    mime: 160,
    resolution: 40,
    frameUrl: 4096,
    initiatorType: 80,
    literalContext: 180
  };
  for (const [key, limit] of Object.entries(stringLimits)) {
    if (item[key] != null && String(item[key]).length > limit) return false;
  }
  for (const key of ['transferSize', 'encodedBodySize', 'decodedBodySize', 'mediaDuration', 'performanceStartTime']) {
    if (item[key] != null && !Number.isFinite(Number(item[key]))) return false;
  }
  if (item.frameId != null && !Number.isInteger(Number(item.frameId))) return false;
  return isOptionalSmallObject(item.mediaInfo) && isOptionalSmallObject(item.resourceInfo);
}


function isSafeEnabledFileTypesPayload(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const knownExtensions = new Set(Object.keys(DEFAULT_SETTINGS.enabledFileTypes || MEDIA_EXTENSIONS));
  const keys = Object.keys(value);
  if (keys.length > knownExtensions.size) return false;
  for (const [extension, enabled] of Object.entries(value)) {
    if (!knownExtensions.has(extension)) return false;
    if (typeof enabled !== 'boolean') return false;
  }
  return true;
}

function isOptionalSmallObject(value) {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).length > 16) return false;
  return Object.entries(value).every(([key, itemValue]) => String(key).length <= 80 && (itemValue == null || typeof itemValue === 'number' || typeof itemValue === 'boolean' || String(itemValue).length <= 240));
}

function isSafeEpisodeRequest(item = {}) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.url !== 'string' || item.url.length > 4096) return false;
  try {
    const url = new URL(item.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  } catch (_error) {
    return false;
  }
  if (item.episodeNumber != null && (!Number.isFinite(Number(item.episodeNumber)) || Number(item.episodeNumber) < 0)) return false;
  return item.title == null || String(item.title).length <= 300;
}


function isSafeSettingsPayload(settings = {}) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  if (Object.keys(settings).some((key) => !allowed.has(key))) return false;
  for (const [key, value] of Object.entries(settings)) {
    if (value == null) continue;
    if (key === 'enabledFileTypes') {
      if (!isSafeEnabledFileTypesPayload(value)) return false;
      continue;
    }
    if (key === 'filenameTemplate' && String(value).length > 240) return false;
    if (key === 'preferredSubfolder' && String(value).length > 200) return false;
    if (typeof value === 'object') return false;
  }
  return true;
}
