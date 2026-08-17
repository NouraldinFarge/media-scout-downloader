import { DEFAULT_SETTINGS, ERROR_CATEGORIES, HLS_OUTPUT_METHODS, IMPLEMENTED_HLS_OUTPUT_METHODS, MEDIA_TYPES, MESSAGE_TYPES, SOURCES } from '../shared/constants.js';
import { buildFilename, sanitizeFilenamePart } from '../shared/filename-utils.js';
import { getQueueHistory, getSettings } from '../shared/storage-utils.js';
import { createStructuredError, getHostname, makeMediaId, makeTaskId, normalizeUrl, nowISO } from '../shared/utils.js';
import { downloadWithAllowedStrategies } from './download-strategies.js';
import { validateMediaUrl } from '../shared/validators.js';
import { QueueManager } from './queue-manager.js';

export class DownloadManager {
  constructor({ tabMediaStore, diagnostics, broadcast }) {
    this.tabMediaStore = tabMediaStore;
    this.diagnostics = diagnostics;
    this.broadcast = broadcast;
    this.downloadCountsByTab = new Map();
    this.cleanupTabsByTask = new Map();
    this.queue = new QueueManager({
      maxParallel: DEFAULT_SETTINGS.maxParallelDownloads,
      worker: (task) => this._downloadTask(task),
      onChange: (state) => this.broadcast({ type: MESSAGE_TYPES.QUEUE_UPDATED, state }),
      onCancel: (task) => this._cancelActiveTask(task),
      onTaskSettled: (task) => this._cleanupTaskResources(task)
    });
  }

  async initialize() {
    const settings = await getSettings();
    this.queue.setMaxParallel(settings.maxParallelDownloads);
    try {
      this.queue.restoreInterruptedHistory(await getQueueHistory());
    } catch (_error) {
      // Queue history is best-effort only; downloads should still work if it is
      // unavailable or belongs to an older build.
    }
  }

  async updateSettings(settings) {
    this.queue.setMaxParallel(settings.maxParallelDownloads);
  }

  getState() {
    return this.queue.getState();
  }

  async enqueue({ tabId, mediaId, tab, hlsOutputMethod = null, closeTabOnComplete = false }) {
    const media = this.tabMediaStore.getMedia(tabId, mediaId);
    if (!media) throw createStructuredError(ERROR_CATEGORIES.VALIDATION, 'media-not-found', 'The media item is no longer available. Try rescanning the tab.');
    const freshnessError = staleActionError(media);
    if (freshnessError) throw freshnessError;
    const settings = await getSettings();
    const selectedHlsOutputMethod = normalizeHlsOutputMethod(hlsOutputMethod, settings.hlsOutputMethod);
    const taskHlsOutputMethod = media.mediaType === MEDIA_TYPES.HLS ? selectedHlsOutputMethod : '';
    const existing = this.queue.findRunnableDuplicate({ mediaId, hlsOutputMethod: taskHlsOutputMethod });
    if (existing) return { ...existing, duplicateOf: existing.id };
    const index = this._nextFilenameIndex(tabId);
    const filename = buildFilename({ settings, media: mediaForDownloadFilename(media, selectedHlsOutputMethod), tab, index });
    const task = {
      id: makeTaskId(mediaId),
      mediaId,
      tabId,
      media,
      filename,
      hlsOutputMethod: taskHlsOutputMethod,
      attempts: 0,
      maxRetries: 2
    };
    if (closeTabOnComplete && Number.isInteger(tabId)) this.cleanupTabsByTask.set(task.id, tabId);
    return this.queue.enqueue(task);
  }

  /**
   * Adds a user-supplied HLS playlist URL as a synthetic media item and queues
   * the existing non-encrypted HLS merge/remux pipeline. The actual fetching is
   * still performed in the active tab content context and must obey normal
   * browser/site access rules.
   */
  async enqueueManualHls({ tab, playlistUrl, preferredName = '', hlsOutputMethod = null }) {
    if (!Number.isInteger(tab?.id)) throw createStructuredError(ERROR_CATEGORIES.VALIDATION, 'active-tab-required', 'An active tab is required for manual HLS conversion.');
    const normalizedUrl = normalizeUrl(playlistUrl, tab.url);
    if (!normalizedUrl || !/^https?:/i.test(normalizedUrl)) {
      throw createStructuredError(ERROR_CATEGORIES.VALIDATION, 'invalid-m3u8-url', 'Enter a valid http(s) .m3u8 playlist URL.');
    }
    if (!/\.m3u8(?:[?#]|$)/i.test(new URL(normalizedUrl).pathname)) {
      throw createStructuredError(ERROR_CATEGORIES.VALIDATION, 'not-m3u8-url', 'The manual converter currently accepts .m3u8 playlist URLs only.');
    }
    const validationError = validateMediaUrl(normalizedUrl, { allowBlob: false });
    if (validationError) throw validationError;

    const media = {
      id: makeMediaId(tab.id, normalizedUrl, MEDIA_TYPES.HLS),
      tabId: tab.id,
      url: normalizedUrl,
      normalizedUrl,
      source: SOURCES.MANUAL,
      mediaType: MEDIA_TYPES.HLS,
      extension: 'm3u8',
      mime: 'application/vnd.apple.mpegurl',
      hostname: getHostname(normalizedUrl),
      title: preferredName ? sanitizeFilenamePart(preferredName, 'manual-hls') : 'Manual HLS playlist',
      frameId: 0,
      frameUrl: tab.url || '',
      detectionMethods: ['manual-m3u8-url'],
      isProtected: false,
      unsupportedReason: '',
      safetyWarning: 'Manual HLS conversion only works for non-encrypted MPEG-TS HLS that the active tab can normally fetch. It will stop on DRM, encryption, CORS, auth, paywall, or access-control failures.',
      playlist: { kind: 'hls', encrypted: null, inspected: false, manual: true },
      detectedAt: nowISO()
    };
    this.tabMediaStore.addMedia(tab.id, media);
    return this.enqueue({ tabId: tab.id, mediaId: media.id, tab, hlsOutputMethod });
  }

  retry(taskId) {
    return this.queue.retry(taskId);
  }

  cancel(taskId) {
    return this.queue.cancel(taskId);
  }

  pauseQueue() {
    return this.queue.setPaused(true);
  }

  resumeQueue() {
    return this.queue.setPaused(false);
  }

  clearSettledQueue() {
    return this.queue.clearSettled();
  }

  clearPersistedQueueHistory() {
    return this.queue.clearPersistedHistory();
  }

  cancelTasksForTab(tabId, reason = 'Source tab was closed.') {
    this.resetTabDownloadCounter(tabId);
    return this.queue.cancelByTabId(tabId, reason);
  }

  cancelPageContextTasksForTab(tabId, reason = 'The source tab changed before this page-context download finished.') {
    return this.queue.cancelByTabIdWhere(tabId, reason, taskRequiresLivePageContext);
  }

  resetTabDownloadCounter(tabId) {
    this.downloadCountsByTab.delete(tabId);
  }

  updateProgress(taskId, progress, sender = {}) {
    const task = this.queue.getTask(taskId);
    if (!task) return false;
    if (sender?.tab?.id != null && task.tabId !== sender.tab.id) return false;
    if (Number.isInteger(task.media?.frameId) && Number.isInteger(sender?.frameId) && task.media.frameId !== sender.frameId) return false;
    return this.queue.updateProgress(taskId, progress);
  }

  async _downloadTask(task) {
    const settings = await getSettings();
    const result = await downloadWithAllowedStrategies(task, {
      settings,
      diagnostics: this.diagnostics,
      messageTypes: MESSAGE_TYPES,
      taskId: task.id,
      onProgress: (progress) => this.queue.updateProgress(task.id, progress),
      onDownloadStarted: (downloadId) => { task.downloadId = downloadId; },
      isCanceled: () => Boolean(task.cancelRequested)
    });
    task.strategy = result.strategy;
    return result;
  }


  _cancelActiveTask(task) {
    if (!task) return;
    if (Number.isInteger(task.downloadId)) {
      try { chrome.downloads.cancel(task.downloadId, () => void chrome.runtime.lastError); } catch (_error) {}
    }
    if (task.media?.mediaType === MEDIA_TYPES.HLS && Number.isInteger(task.tabId)) {
      try {
        const callback = () => void chrome.runtime.lastError;
        const message = { type: MESSAGE_TYPES.CANCEL_HLS_TASK, taskId: task.id };
        if (Number.isInteger(task.media?.frameId) && task.media.frameId >= 0) chrome.tabs.sendMessage(task.tabId, message, { frameId: task.media.frameId }, callback);
        else chrome.tabs.sendMessage(task.tabId, message, callback);
      } catch (_error) {}
    }
  }

  _cleanupTaskResources(task) {
    const terminalStatuses = new Set(['completed', 'failed', 'canceled', 'verify-uncertain']);
    if (!terminalStatuses.has(task?.status)) return;
    this._notifyTaskSettled(task).catch(() => undefined);
    const tabId = this.cleanupTabsByTask.get(task?.id);
    if (!Number.isInteger(tabId)) return;
    this.cleanupTabsByTask.delete(task.id);
    try { chrome.tabs.remove(tabId, () => void chrome.runtime.lastError); } catch (_error) {}
  }

  async _notifyTaskSettled(task = {}) {
    const notifyStatuses = new Set(['completed', 'failed', 'canceled', 'verify-uncertain']);
    if (!notifyStatuses.has(task.status)) return;
    const settings = await getSettings();
    if (!settings.notifications || !chrome.notifications?.create) return;
    const copyByStatus = {
      completed: { title: 'Media Scout download saved', message: 'Saved or handed off through the browser downloads UI. Open Queue for details.' },
      'verify-uncertain': { title: 'Media Scout download needs verification', message: 'A page-context save was handed to browser Downloads. Open Queue or Downloads to verify the final file.' },
      failed: { title: 'Media Scout download needs attention', message: 'A download needs attention. Open Queue for retry details.' },
      canceled: { title: 'Media Scout download canceled', message: 'A download was canceled. Open Queue for details.' }
    };
    const copy = copyByStatus[task.status];
    if (!copy) return;
    await new Promise((resolve) => {
      try {
        chrome.notifications.create(`media-scout-${task.status}-${Date.now()}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
          title: copy.title,
          message: copy.message,
          priority: task.status === 'failed' || task.status === 'verify-uncertain' ? 1 : 0
        }, () => resolve());
      } catch (_error) {
        resolve();
      }
    });
  }

  _nextFilenameIndex(tabId) {
    const count = this.downloadCountsByTab.get(tabId) || 0;
    this.downloadCountsByTab.set(tabId, count + 1);
    return count;
  }
}


function taskRequiresLivePageContext(task = {}) {
  const media = task.media || {};
  const url = String(media.url || media.normalizedUrl || '');
  return media.mediaType === MEDIA_TYPES.HLS || url.startsWith('blob:') || media.source === SOURCES.BLOB;
}

function staleActionError(media = {}) {
  const timestamp = Date.parse(media.updatedAt || media.detectedAt || '');
  if (!Number.isFinite(timestamp)) return null;
  if (Date.now() - timestamp <= 10 * 60_000) return null;
  return createStructuredError(
    ERROR_CATEGORIES.VALIDATION,
    'stale-media-snapshot',
    'This media evidence belongs to an expired page snapshot. Rescan the current page before starting a download.'
  );
}


function mediaForDownloadFilename(media, hlsOutputMethod = HLS_OUTPUT_METHODS.SMART_MP4) {
  // Detected HLS is treated as a video-conversion target, not as a playlist file.
  // If MP4 remuxing is not possible, the task fails with an explanation instead of
  // silently saving an .m3u8 text playlist or a .ts fallback.
  if (media?.mediaType === MEDIA_TYPES.HLS) {
    const extension = hlsOutputMethod === HLS_OUTPUT_METHODS.TS_CONCAT || hlsOutputMethod === HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS ? 'ts' : hlsOutputMethod === HLS_OUTPUT_METHODS.PLAYLIST_ONLY ? 'm3u8' : hlsOutputMethod === HLS_OUTPUT_METHODS.EXTERNAL_HELPER ? 'txt' : 'mp4';
    return { ...media, extension };
  }
  return media;
}


function normalizeHlsOutputMethod(value, fallback = HLS_OUTPUT_METHODS.SMART_MP4) {
  return IMPLEMENTED_HLS_OUTPUT_METHODS.includes(value) ? value : (IMPLEMENTED_HLS_OUTPUT_METHODS.includes(fallback) ? fallback : HLS_OUTPUT_METHODS.SMART_MP4);
}
