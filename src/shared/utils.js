import { EXTENSION_MIME_HINTS, MEDIA_EXTENSIONS, MEDIA_TYPES } from './constants.js';
import { registryEntryForExtension, registryEntryForMime } from './media-type-registry.js';

export function nowISO() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(value, min, max) {
  const number = Number(value);
  if (Number.isNaN(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return fallback;
  }
}

export function normalizeUrl(rawUrl, baseUrl = undefined) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const url = new URL(rawUrl, baseUrl);
    url.hash = '';
    return url.toString();
  } catch (_error) {
    return '';
  }
}

export function getHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch (_error) {
    return '';
  }
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch (_error) {
    return false;
  }
}

export function getUrlExtension(rawUrl) {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    return match ? match[1].toLowerCase() : '';
  } catch (_error) {
    return '';
  }
}

export function contentTypeToExtension(contentType = '') {
  const entry = registryEntryForMime(contentType);
  if (entry?.extensions?.length) return entry.extensions[0];
  const normalized = String(contentType).split(';')[0].trim().toLowerCase();
  if (normalized.includes('mpegurl')) return 'm3u8';
  if (normalized.includes('dash+xml')) return 'mpd';
  if (normalized.startsWith('video/')) return 'media';
  if (normalized.startsWith('audio/')) return 'media';
  if (normalized.startsWith('image/')) return 'media';
  return '';
}

export function inferMediaType({ url = '', mime = '', declaredType = '' } = {}) {
  const extension = getUrlExtension(url);
  const entry = registryEntryForExtension(extension) || registryEntryForMime(mime) || registryEntryForMime(declaredType);
  if (entry?.group) return entry.group;
  const type = String(mime || declaredType).toLowerCase();
  if (type.includes('mpegurl')) return MEDIA_TYPES.HLS;
  if (type.includes('dash+xml')) return MEDIA_TYPES.DASH;
  if (type.startsWith('video/')) return MEDIA_TYPES.VIDEO;
  if (type.startsWith('audio/')) return MEDIA_TYPES.AUDIO;
  if (type.startsWith('image/')) return MEDIA_TYPES.IMAGE;
  return MEDIA_TYPES.UNKNOWN;
}

export function inferExtension({ url = '', mime = '', declaredType = '' } = {}) {
  const fromUrl = getUrlExtension(url);
  if (fromUrl && MEDIA_EXTENSIONS[fromUrl]) return fromUrl;
  const entry = registryEntryForMime(mime) || registryEntryForMime(declaredType);
  if (entry?.extensions?.length) return entry.extensions[0];
  return contentTypeToExtension(mime) || contentTypeToExtension(declaredType) || 'media';
}

export function isLikelyMediaUrl(rawUrl = '', contentType = '') {
  const extension = getUrlExtension(rawUrl);
  if (extension && MEDIA_EXTENSIONS[extension]) return true;
  return Boolean(contentTypeToExtension(contentType));
}

export function stableHash(input) {
  const text = String(input);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(index);
    hash &= 0xffffffff;
  }
  return Math.abs(hash).toString(36);
}

export function makeMediaId(tabId, normalizedUrl, mediaType) {
  return `media-${tabId}-${mediaType}-${stableHash(normalizedUrl)}`;
}

export function makeTaskId(mediaId) {
  return `task-${mediaId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getHeaderValue(headers = [], headerName) {
  const lower = headerName.toLowerCase();
  const match = headers.find((header) => String(header.name).toLowerCase() === lower);
  return match ? match.value : '';
}

export function parseContentLength(headers = []) {
  const value = getHeaderValue(headers, 'content-length');
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export async function chromeCall(fn) {
  return new Promise((resolve, reject) => {
    try {
      fn((result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export async function getActiveTab() {
  const tabs = await chromeCall((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
  return tabs && tabs.length ? tabs[0] : null;
}

export function createStructuredError(category, code, message, extra = {}) {
  return { category, code, message, ...extra };
}
