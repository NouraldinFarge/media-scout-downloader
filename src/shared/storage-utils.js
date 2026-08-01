import { DEFAULT_SETTINGS, STORAGE_KEYS, SEGMENT_PARALLELISM_MAX, SEGMENT_PARALLELISM_MIN, SEGMENT_RETRY_LIMIT_MAX, SEGMENT_RETRY_LIMIT_MIN, HLS_OUTPUT_METHODS, IMPLEMENTED_HLS_OUTPUT_METHODS, HLS_WORK_MODES, HLS_VARIANT_PREFERENCES } from './constants.js';
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
  merged.maxParallelDownloads = Math.min(6, Math.max(1, Number(merged.maxParallelDownloads) || DEFAULT_SETTINGS.maxParallelDownloads));
  merged.segmentParallelism = Math.min(SEGMENT_PARALLELISM_MAX, Math.max(SEGMENT_PARALLELISM_MIN, Number(merged.segmentParallelism) || DEFAULT_SETTINGS.segmentParallelism));
  merged.segmentRetryLimit = Math.min(SEGMENT_RETRY_LIMIT_MAX, Math.max(SEGMENT_RETRY_LIMIT_MIN, Number.isFinite(Number(merged.segmentRetryLimit)) ? Number(merged.segmentRetryLimit) : DEFAULT_SETTINGS.segmentRetryLimit));
  merged.episodeBatchScanParallelism = Math.min(4, Math.max(1, Number.isFinite(Number(merged.episodeBatchScanParallelism)) ? Number(merged.episodeBatchScanParallelism) : DEFAULT_SETTINGS.episodeBatchScanParallelism));
  merged.confirmLargeEpisodeBatchThreshold = Math.min(48, Math.max(2, Number.isFinite(Number(merged.confirmLargeEpisodeBatchThreshold)) ? Number(merged.confirmLargeEpisodeBatchThreshold) : DEFAULT_SETTINGS.confirmLargeEpisodeBatchThreshold));
  if (!IMPLEMENTED_HLS_OUTPUT_METHODS.includes(merged.hlsOutputMethod)) merged.hlsOutputMethod = DEFAULT_SETTINGS.hlsOutputMethod;
  if (!Object.values(HLS_WORK_MODES).includes(merged.hlsWorkMode)) merged.hlsWorkMode = DEFAULT_SETTINGS.hlsWorkMode;
  if (!Object.values(HLS_VARIANT_PREFERENCES).includes(merged.hlsVariantPreference)) merged.hlsVariantPreference = DEFAULT_SETTINGS.hlsVariantPreference;
  merged.showManualM3u8Converter = Boolean(merged.showManualM3u8Converter);
  merged.includeSensitiveUrlsInReports = Boolean(merged.includeSensitiveUrlsInReports);
  merged.queueHistoryRetentionDays = Math.min(30, Math.max(0, Number.isFinite(Number(merged.queueHistoryRetentionDays)) ? Number(merged.queueHistoryRetentionDays) : DEFAULT_SETTINGS.queueHistoryRetentionDays));
  merged.filenameTemplate = sanitizeSettingText(merged.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate, 180);
  merged.preferredSubfolder = sanitizeSettingText(merged.preferredSubfolder, DEFAULT_SETTINGS.preferredSubfolder, 160);
  merged.notifications = Boolean(merged.notifications);
  merged.debugLogs = Boolean(merged.debugLogs);
  return merged;
}

function sanitizeSettingText(value, fallback = '', maxLength = 180) {
  const text = String(value == null ? fallback : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, maxLength);
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

export async function resetSettings() {
  await storageSet({ [STORAGE_KEYS.SETTINGS]: mergeSettings(DEFAULT_SETTINGS) });
  return getSettings();
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

export async function getQueueSummary() {
  const result = await storageGet([STORAGE_KEYS.QUEUE_SUMMARY]);
  return result[STORAGE_KEYS.QUEUE_SUMMARY] || null;
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
