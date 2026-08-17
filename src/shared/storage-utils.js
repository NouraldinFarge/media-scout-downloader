import {
  DEFAULT_SETTINGS,
  DUPLICATE_BEHAVIORS,
  HLS_VARIANT_PREFERENCES,
  HLS_WORK_MODES,
  IMPLEMENTED_HLS_OUTPUT_METHODS,
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  SEGMENT_PARALLELISM_MAX,
  SEGMENT_PARALLELISM_MIN,
  SEGMENT_RETRY_LIMIT_MAX,
  SEGMENT_RETRY_LIMIT_MIN,
  STORAGE_KEYS
} from './constants.js';
import { validateFileTypeSettings } from './validators.js';

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result || {});
    });
  });
}

function storageSet(value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(value, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

export function mergeSettings(partial = {}) {
  const safePartial = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.prototype.hasOwnProperty.call(partial || {}, key)) safePartial[key] = partial[key];
  }
  const merged = {
    ...DEFAULT_SETTINGS,
    ...safePartial,
    enabledFileTypes: validateFileTypeSettings({
      ...DEFAULT_SETTINGS.enabledFileTypes,
      ...(safePartial.enabledFileTypes || {})
    })
  };
  merged.maxParallelDownloads = boundedInteger(merged.maxParallelDownloads, MAX_PARALLEL_MIN, MAX_PARALLEL_MAX, DEFAULT_SETTINGS.maxParallelDownloads);
  merged.segmentParallelism = boundedInteger(merged.segmentParallelism, SEGMENT_PARALLELISM_MIN, SEGMENT_PARALLELISM_MAX, DEFAULT_SETTINGS.segmentParallelism);
  merged.segmentRetryLimit = boundedInteger(merged.segmentRetryLimit, SEGMENT_RETRY_LIMIT_MIN, SEGMENT_RETRY_LIMIT_MAX, DEFAULT_SETTINGS.segmentRetryLimit);
  merged.episodeBatchScanParallelism = boundedInteger(merged.episodeBatchScanParallelism, 1, 4, DEFAULT_SETTINGS.episodeBatchScanParallelism);
  merged.confirmLargeEpisodeBatchThreshold = boundedInteger(merged.confirmLargeEpisodeBatchThreshold, 2, 48, DEFAULT_SETTINGS.confirmLargeEpisodeBatchThreshold);
  if (!IMPLEMENTED_HLS_OUTPUT_METHODS.includes(merged.hlsOutputMethod)) merged.hlsOutputMethod = DEFAULT_SETTINGS.hlsOutputMethod;
  if (!Object.values(HLS_WORK_MODES).includes(merged.hlsWorkMode)) merged.hlsWorkMode = DEFAULT_SETTINGS.hlsWorkMode;
  if (!Object.values(HLS_VARIANT_PREFERENCES).includes(merged.hlsVariantPreference)) merged.hlsVariantPreference = DEFAULT_SETTINGS.hlsVariantPreference;
  if (!Object.values(DUPLICATE_BEHAVIORS).includes(merged.duplicateBehavior)) merged.duplicateBehavior = DEFAULT_SETTINGS.duplicateBehavior;
  merged.showManualM3u8Converter = safeBoolean(merged.showManualM3u8Converter, DEFAULT_SETTINGS.showManualM3u8Converter);
  merged.includeSensitiveUrlsInReports = safeBoolean(merged.includeSensitiveUrlsInReports, DEFAULT_SETTINGS.includeSensitiveUrlsInReports);
  merged.queueHistoryRetentionDays = boundedInteger(merged.queueHistoryRetentionDays, 0, 30, DEFAULT_SETTINGS.queueHistoryRetentionDays);
  merged.filenameTemplate = sanitizeSettingText(merged.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate, 180);
  merged.preferredSubfolder = sanitizeSettingText(merged.preferredSubfolder, DEFAULT_SETTINGS.preferredSubfolder, 160, { allowEmpty: true });
  merged.notifications = safeBoolean(merged.notifications, DEFAULT_SETTINGS.notifications);
  merged.debugLogs = safeBoolean(merged.debugLogs, DEFAULT_SETTINGS.debugLogs);
  return merged;
}

function sanitizeSettingText(value, fallback = '', maxLength = 180, { allowEmpty = false } = {}) {
  const text = String(value == null ? fallback : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || (allowEmpty ? '' : fallback)).slice(0, maxLength);
}

function boundedInteger(value, minimum, maximum, fallback) {
  const numeric = value == null || value === '' ? Number.NaN : Number(value);
  const normalized = Number.isFinite(numeric) ? Math.round(numeric) : fallback;
  return Math.min(maximum, Math.max(minimum, normalized));
}

function safeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

export async function getSettings() {
  const result = await storageGet([STORAGE_KEYS.SETTINGS]);
  return mergeSettings(result[STORAGE_KEYS.SETTINGS] || {});
}

export async function saveSettings(nextSettings) {
  const current = await getSettings();
  const merged = mergeSettings({ ...current, ...nextSettings });
  await storageSet({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

export async function getDiagnostics() {
  const result = await storageGet([STORAGE_KEYS.DIAGNOSTICS]);
  return result[STORAGE_KEYS.DIAGNOSTICS] || { strategies: {}, errors: {}, updatedAt: null };
}

export async function saveDiagnostics(diagnostics) {
  await storageSet({ [STORAGE_KEYS.DIAGNOSTICS]: diagnostics });
}

export async function resetDiagnostics() {
  await storageRemove([STORAGE_KEYS.DIAGNOSTICS]);
  return getDiagnostics();
}

export async function saveQueueSummary(summary) {
  // Queue summary persistence deliberately stores counts only. Runtime state holds
  // task URLs and filenames only while they are needed for the current session.
  await storageSet({ [STORAGE_KEYS.QUEUE_SUMMARY]: { ...summary, savedAt: new Date().toISOString() } });
}

export async function saveQueueHistory(history) {
  // Persist only privacy-safe queue metadata. Do not retain raw media URLs,
  // page URLs, hostnames, or filenames across MV3 service-worker restarts.
  const settings = await getSettings();
  if (Number(settings.queueHistoryRetentionDays) <= 0) {
    await clearQueueHistory();
    return;
  }
  await storageSet({ [STORAGE_KEYS.QUEUE_HISTORY]: { ...(history || {}), savedAt: new Date().toISOString(), expiresAt: queueHistoryExpiry(settings.queueHistoryRetentionDays) } });
}

export async function clearQueueHistory() {
  await storageRemove([STORAGE_KEYS.QUEUE_SUMMARY, STORAGE_KEYS.QUEUE_HISTORY]);
  return { cleared: true };
}

export async function getQueueHistory() {
  const result = await storageGet([STORAGE_KEYS.QUEUE_HISTORY]);
  const history = result[STORAGE_KEYS.QUEUE_HISTORY] || null;
  if (!history) return null;
  if (history.expiresAt && Date.parse(history.expiresAt) <= Date.now()) {
    await clearQueueHistory();
    return null;
  }
  return history;
}

function queueHistoryExpiry(days) {
  const ttlDays = Math.min(30, Math.max(0, Number(days) || 0));
  if (ttlDays <= 0) return new Date().toISOString();
  return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
}
