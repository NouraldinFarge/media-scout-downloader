import { DEFAULT_SETTINGS, DOWNLOAD_STATUSES, ERROR_CATEGORIES, MAX_PARALLEL_MAX, MAX_PARALLEL_MIN } from '../shared/constants.js';
import { clearQueueHistory as clearStoredQueueHistory, saveQueueHistory, saveQueueSummary } from '../shared/storage-utils.js';
import { canRetryCategory } from '../shared/validators.js';

const MAX_SETTLED_TASKS_PER_BUCKET = 20;

export class QueueManager {
  constructor({ worker, maxParallel = DEFAULT_SETTINGS.maxParallelDownloads, onChange = () => {}, onCancel = () => {}, onTaskSettled = () => {} }) {
    this.worker = worker;
    this.maxParallel = normalizeParallelism(maxParallel);
    this.onChange = onChange;
    this.onCancel = onCancel;
    this.onTaskSettled = onTaskSettled;
    this.pending = [];
    this.active = new Map();
    this.completed = [];
    this.failed = [];
    this.canceled = [];
    this.taskIndex = new Map();
    this.drainScheduled = false;
    this.lastPersistAt = 0;
    this.persistTimer = null;
    this.pendingPersistState = null;
    this.persistChain = Promise.resolve();
    this.hasEverHadTask = false;
    this.paused = false;
  }

  setMaxParallel(maxParallel) {
    this.maxParallel = normalizeParallelism(maxParallel);
    this._changed();
    this._scheduleDrain();
  }

  enqueue(task) {
    this.hasEverHadTask = true;
    const queued = { ...task, status: DOWNLOAD_STATUSES.QUEUED, attempts: task.attempts || 0, maxRetries: task.maxRetries ?? 2 };
    this.pending.push(queued);
    this.taskIndex.set(queued.id, queued);
    this._changed();
    this._scheduleDrain();
    return queued;
  }

  retry(taskId) {
    this.hasEverHadTask = true;
    const fromFailedIndex = this.failed.findIndex((task) => task.id === taskId);
    if (fromFailedIndex < 0) return null;
    const [task] = this.failed[fromFailedIndex] ? [this.failed[fromFailedIndex]] : [null];
    if (!task || !canRetryCategory(task.lastError?.category) || !hasRunnableMedia(task)) return null;
    if (this.findRunnableDuplicate({ mediaId: task.mediaId, hlsOutputMethod: task.hlsOutputMethod })) return null;
    this.failed.splice(fromFailedIndex, 1);
    const retry = { ...task, status: DOWNLOAD_STATUSES.QUEUED, lastError: null, cancelRequested: false };
    this.pending.push(retry);
    this.taskIndex.set(retry.id, retry);
    this._changed();
    this._scheduleDrain();
    return retry;
  }

  updateProgress(taskId, progress = {}) {
    const task = this.active.get(taskId);
    if (!task || task.cancelRequested) return false;
    const nextProgress = normalizeProgress(progress);
    task.progress = { ...(task.progress || {}), ...nextProgress };
    if (nextProgress.phase === 'remuxing') task.status = DOWNLOAD_STATUSES.CONVERTING || DOWNLOAD_STATUSES.ACTIVE;
    else if (task.status === DOWNLOAD_STATUSES.CONVERTING && nextProgress.phase !== 'completed') task.status = DOWNLOAD_STATUSES.ACTIVE;
    // Broadcast progress live, but throttle chrome.storage writes. Frequent
    // storage writes during 1000+ segment HLS jobs can make the browser feel
    // stuttery even when network parallelism is healthy.
    this._changed({ persist: true, forcePersist: false });
    return true;
  }

  cancel(taskId) {
    const pendingIndex = this.pending.findIndex((task) => task.id === taskId);
    if (pendingIndex >= 0) {
      const [task] = this.pending.splice(pendingIndex, 1);
      task.cancelRequested = true;
      task.status = DOWNLOAD_STATUSES.CANCELED;
      this._addSettled('canceled', task);
      try { this.onTaskSettled(task); } catch (_error) {}
      this._changed({ forcePersist: true });
      return true;
    }
    const active = this.active.get(taskId);
    if (active) {
      active.cancelRequested = true;
      active.status = DOWNLOAD_STATUSES.CANCELED;
      try { this.onCancel(active); } catch (_error) {}
      this._changed();
      return true;
    }
    return false;
  }


  setPaused(paused) {
    this.paused = Boolean(paused);
    this._changed({ forcePersist: true });
    if (!this.paused) this._scheduleDrain();
    return this.paused;
  }

  restoreInterruptedHistory(history = null) {
    if (!history || this.hasEverHadTask || this.pending.length || this.active.size) return false;
    const completed = safeHistoryList(history.completed).map((task) => hydrateHistoryTask(task, DOWNLOAD_STATUSES.COMPLETED));
    const failed = safeHistoryList(history.failed).map((task) => hydrateHistoryTask(task, DOWNLOAD_STATUSES.FAILED));
    const canceled = [
      ...safeHistoryList(history.active).map((task) => hydrateInterruptedTask(task)),
      ...safeHistoryList(history.pending).map((task) => hydrateInterruptedTask(task)),
      ...safeHistoryList(history.canceled).map((task) => hydrateHistoryTask(task, DOWNLOAD_STATUSES.CANCELED))
    ];
    if (!(completed.length || failed.length || canceled.length || history.paused)) return false;
    this.completed = completed.slice(0, MAX_SETTLED_TASKS_PER_BUCKET);
    this.failed = failed.slice(0, MAX_SETTLED_TASKS_PER_BUCKET);
    this.canceled = canceled.slice(0, MAX_SETTLED_TASKS_PER_BUCKET);
    this.paused = Boolean(history.paused);
    this.taskIndex = new Map([
      ...this.completed,
      ...this.failed,
      ...this.canceled
    ].filter((task) => task?.id).map((task) => [task.id, task]));
    this.hasEverHadTask = true;
    this._changed({ forcePersist: true });
    return true;
  }

  clearSettled() {
    const cleared = {
      completed: this.completed.length,
      failed: this.failed.length,
      canceled: this.canceled.length
    };
    this.completed = [];
    this.failed = [];
    this.canceled = [];
    // Keep taskIndex entries for active/pending tasks only; settled tasks can be
    // forgotten once the user clears the visible history.
    this.taskIndex = new Map([
      ...this.pending.map((task) => [task.id, task]),
      ...Array.from(this.active.entries())
    ]);
    this._changed({ forcePersist: true });
    return cleared;
  }

  async clearPersistedHistory() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.pendingPersistState = null;

    // Put the explicit clear behind every already-started snapshot write. This
    // prevents an older asynchronous save from landing after the user's clear
    // request and resurrecting stale queue metadata.
    const clearOperation = this.persistChain
      .catch(() => undefined)
      .then(() => clearStoredQueueHistory());
    this.persistChain = clearOperation.catch(() => undefined);
    return clearOperation;
  }

  cancelByTabId(tabId, reason = 'Source tab was closed.') {
    return this.cancelByTabIdWhere(tabId, reason, () => true);
  }

  cancelByTabIdWhere(tabId, reason = 'Source tab was closed.', predicate = () => true) {
    let canceled = 0;
    const shouldCancel = (task) => task?.tabId === tabId && predicate(task);
    const remaining = [];
    for (const task of this.pending) {
      if (shouldCancel(task)) {
        task.cancelRequested = true;
        task.status = DOWNLOAD_STATUSES.CANCELED;
        task.lastError = { category: ERROR_CATEGORIES.USER_CANCELED, code: 'source-tab-unavailable', message: reason, strategy: '' };
        this._addSettled('canceled', task);
        try { this.onTaskSettled(task); } catch (_error) {}
        canceled += 1;
      } else {
        remaining.push(task);
      }
    }
    this.pending = remaining;

    for (const task of this.active.values()) {
      if (!shouldCancel(task)) continue;
      task.cancelRequested = true;
      task.status = DOWNLOAD_STATUSES.CANCELED;
      task.lastError = { category: ERROR_CATEGORIES.USER_CANCELED, code: 'source-tab-unavailable', message: reason, strategy: '' };
      try { this.onCancel(task); } catch (_error) {}
      canceled += 1;
    }

    if (canceled) this._changed({ forcePersist: true });
    return canceled;
  }


  findRunnableDuplicate({ mediaId, hlsOutputMethod = '' } = {}) {
    if (!mediaId) return null;
    const method = hlsOutputMethod || '';
    const matches = (task) => task.mediaId === mediaId && (task.hlsOutputMethod || '') === method;
    return this.pending.find(matches) || Array.from(this.active.values()).find(matches) || null;
  }

  getTask(taskId) {
    return this.active.get(taskId) || this.taskIndex.get(taskId) || null;
  }

  getState() {
    return {
      maxParallel: this.maxParallel,
      activeCount: this.active.size,
      paused: this.paused,
      pending: this.pending.map(publicTask),
      active: Array.from(this.active.values()).map(publicTask),
      completed: this.completed.slice(0, MAX_SETTLED_TASKS_PER_BUCKET).map(publicTask),
      failed: this.failed.slice(0, MAX_SETTLED_TASKS_PER_BUCKET).map(publicTask),
      canceled: this.canceled.slice(0, MAX_SETTLED_TASKS_PER_BUCKET).map(publicTask)
    };
  }

  _scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this._drain();
    });
  }

  _drain() {
    if (this.paused) {
      this._changed();
      return;
    }
    while (this.active.size < this.maxParallel && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task || task.status === DOWNLOAD_STATUSES.CANCELED) continue;
      this._start(task);
    }
    this._changed();
  }

  async _start(task) {
    this.hasEverHadTask = true;
    task.status = DOWNLOAD_STATUSES.ACTIVE;
    task.attempts += 1;
    this.active.set(task.id, task);
    this._changed();
    try {
      if (task.cancelRequested) throw { category: ERROR_CATEGORIES.USER_CANCELED, code: 'canceled', message: 'Canceled before start.' };
      const result = await this.worker(task);
      if (task.cancelRequested) {
        throw task.lastError || { category: ERROR_CATEGORIES.USER_CANCELED, code: 'canceled', message: 'Canceled before completion.' };
      }
      this.active.delete(task.id);
      task.result = result;
      task.status = result?.status === DOWNLOAD_STATUSES.VERIFY_UNCERTAIN ? DOWNLOAD_STATUSES.VERIFY_UNCERTAIN : DOWNLOAD_STATUSES.COMPLETED;
      task.progress = {
        ...(task.progress || {}),
        phase: task.status === DOWNLOAD_STATUSES.VERIFY_UNCERTAIN ? 'verify-uncertain' : 'completed',
        percent: 100,
        detail: task.status === DOWNLOAD_STATUSES.VERIFY_UNCERTAIN
          ? (result?.verifyMessage || 'Browser save was started from the page, but final completion cannot be verified by the service worker. Check browser Downloads if needed.')
          : 'Completed',
        updatedAt: new Date().toISOString()
      };
      this._addSettled('completed', task);
    } catch (error) {
      this.active.delete(task.id);
      task.lastError = normalizeError(error);
      const retryable = canRetryCategory(task.lastError.category) && task.attempts <= task.maxRetries && !task.cancelRequested;
      if (retryable) {
        task.status = DOWNLOAD_STATUSES.RETRIED;
        this.pending.push(task);
      } else {
        task.status = task.cancelRequested ? DOWNLOAD_STATUSES.CANCELED : DOWNLOAD_STATUSES.FAILED;
        if (task.status === DOWNLOAD_STATUSES.CANCELED) this._addSettled('canceled', task);
        else this._addSettled('failed', task);
      }
    } finally {
      try { this.onTaskSettled(task); } catch (_error) {}
      this._changed({ forcePersist: true });
      this._scheduleDrain();
    }
  }

  _changed(options = {}) {
    const { persist = true, forcePersist = false } = options;
    const state = this.getState();
    if (persist) this._persistState(state, forcePersist);
    try { this.onChange(state); } catch (_error) {}
  }

  _addSettled(bucket, task) {
    const list = this[bucket];
    if (!Array.isArray(list)) return;
    list.unshift(task);
    const removed = list.splice(MAX_SETTLED_TASKS_PER_BUCKET);
    for (const staleTask of removed) {
      if (this.taskIndex.get(staleTask?.id) !== staleTask) continue;
      if (this._isTaskRetained(staleTask.id)) continue;
      this.taskIndex.delete(staleTask.id);
    }
  }

  _isTaskRetained(taskId) {
    if (!taskId) return false;
    if (this.active.has(taskId) || this.pending.some((task) => task.id === taskId)) return true;
    return [this.completed, this.failed, this.canceled].some((list) => list.some((task) => task.id === taskId));
  }

  _persistState(state, force = false) {
    if (!this.hasEverHadTask && isEmptyQueueState(state)) return;
    this.pendingPersistState = state;
    const now = Date.now();
    const write = () => {
      const latestState = this.pendingPersistState;
      if (!latestState) return;
      this.pendingPersistState = null;
      this.lastPersistAt = Date.now();
      const summary = {
        activeCount: latestState.activeCount,
        pendingCount: latestState.pending.length,
        completedCount: latestState.completed.length,
        failedCount: latestState.failed.length,
        canceledCount: latestState.canceled.length,
        paused: Boolean(latestState.paused)
      };
      const history = {
        ...summary,
        completed: latestState.completed.slice(0, MAX_SETTLED_TASKS_PER_BUCKET).map(persistedTask),
        failed: latestState.failed.slice(0, MAX_SETTLED_TASKS_PER_BUCKET).map(persistedTask),
        canceled: latestState.canceled.slice(0, MAX_SETTLED_TASKS_PER_BUCKET).map(persistedTask),
        active: latestState.active.slice(0, MAX_SETTLED_TASKS_PER_BUCKET).map(persistedTask),
        pending: latestState.pending.slice(0, MAX_SETTLED_TASKS_PER_BUCKET).map(persistedTask),
        paused: Boolean(latestState.paused)
      };
      // Serialize writes so an older asynchronous storage operation cannot land
      // after a newer queue snapshot and resurrect stale work on restart.
      this.persistChain = this.persistChain
        .catch(() => undefined)
        .then(async () => {
          await saveQueueSummary(summary);
          await saveQueueHistory(history);
        })
        .catch(() => undefined);
    };

    if (force || now - this.lastPersistAt > 2000) {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      write();
      return;
    }
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        write();
      }, Math.max(250, 2000 - (now - this.lastPersistAt)));
    }
  }
}

function normalizeParallelism(value) {
  const numeric = Number(value);
  return Math.min(MAX_PARALLEL_MAX, Math.max(MAX_PARALLEL_MIN, Number.isFinite(numeric) ? Math.round(numeric) : DEFAULT_SETTINGS.maxParallelDownloads));
}


function isEmptyQueueState(state = {}) {
  return !state.activeCount &&
    !(state.pending || []).length &&
    !(state.active || []).length &&
    !(state.completed || []).length &&
    !(state.failed || []).length &&
    !(state.canceled || []).length;
}

function normalizeError(error) {
  return {
    category: error?.category || ERROR_CATEGORIES.UNKNOWN,
    code: error?.code || 'unknown-error',
    message: error?.message || 'Unknown download error.',
    strategy: error?.strategy || ''
  };
}

function publicTask(task) {
  return {
    id: task.id,
    mediaId: task.mediaId,
    tabId: task.tabId,
    status: task.status,
    attempts: task.attempts,
    filename: task.filename,
    downloadId: Number.isInteger(task.downloadId) ? task.downloadId : (Number.isInteger(task.result?.downloadId) ? task.result.downloadId : null),
    hlsOutputMethod: task.hlsOutputMethod || task.result?.hlsOutputMethod || '',
    strategy: task.strategy || task.result?.strategy || '',
    progress: task.progress || null,
    result: task.result ? {
      strategy: task.result.strategy || '',
      outputFilename: task.result.outputFilename || task.result.filename || '',
      remuxedToMp4: Boolean(task.result.remuxedToMp4),
      remuxFallbackReason: task.result.remuxFallbackReason || '',
      segmentCount: task.result.segmentCount || 0,
      totalBytes: task.result.totalBytes || 0,
      segmentRetryCount: task.result.segmentRetryCount || 0,
      peakConcurrency: task.result.peakConcurrency || 0,
      averageBytesPerSecond: task.result.averageBytesPerSecond || 0,
      variantUrl: task.result.variantUrl ? '[redacted]' : '',
      variantUrlRedacted: Boolean(task.result.variantUrl),
      hlsVariantPreference: task.result.hlsVariantPreference || '',
      selectedResolution: task.result.selectedResolution || '',
      selectedBandwidth: task.result.selectedBandwidth || 0,
      hasAudio: Boolean(task.result.hasAudio),
      estimatedVideoFps: task.result.estimatedVideoFps || 0,
      videoSampleCount: task.result.videoSampleCount || 0,
      audioSampleCount: task.result.audioSampleCount || 0,
      outputBytes: task.result.outputBytes || 0,
      videoDurationSeconds: task.result.videoDurationSeconds || 0,
      audioDurationSeconds: task.result.audioDurationSeconds || 0,
      keyFrameCount: task.result.keyFrameCount || 0,
      droppedVideoSamples: task.result.droppedVideoSamples || 0,
      droppedAudioSamples: task.result.droppedAudioSamples || 0,
      remuxWarnings: task.result.remuxWarnings || [],
      hlsOutputMethod: task.result.hlsOutputMethod || '',
      outputExtension: task.result.outputExtension || ''
    } : null,
    mediaType: task.media?.mediaType,
    extension: task.media?.extension,
    hostname: task.media?.hostname,
    lastError: task.lastError || null,
    canRetry: task.status === DOWNLOAD_STATUSES.FAILED && canRetryCategory(task.lastError?.category) && hasRunnableMedia(task)
  };
}

function hasRunnableMedia(task = {}) {
  const media = task.media || {};
  return Boolean(media.url || media.normalizedUrl || media.downloadUrl);
}

function normalizeProgress(progress = {}) {
  const percent = Number(progress.percent);
  const updatedAt = String(progress.updatedAt || '');
  return {
    phase: String(progress.phase || 'working').slice(0, 64),
    loaded: nonNegativeNumber(progress.loaded),
    total: nonNegativeNumber(progress.total),
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    detail: String(progress.detail || '').slice(0, 600),
    bytes: nonNegativeNumber(progress.bytes),
    workers: nonNegativeNumber(progress.workers),
    activeWorkers: nonNegativeNumber(progress.activeWorkers),
    retries: nonNegativeNumber(progress.retries),
    averageBytesPerSecond: nonNegativeNumber(progress.averageBytesPerSecond),
    peakConcurrency: nonNegativeNumber(progress.peakConcurrency),
    updatedAt: /^\d{4}-\d{2}-\d{2}T/.test(updatedAt) ? updatedAt.slice(0, 40) : new Date().toISOString()
  };
}

function nonNegativeNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}


function persistedTask(task = {}) {
  // chrome.storage.local should not retain browsing/media identifiers that can be
  // sensitive outside the current runtime session. Keep enough metadata for a
  // useful queue summary without hostnames, filenames, frame URLs, media URLs,
  // saved-output names, or raw error/progress text.
  return {
    id: safeIdentifier(task.id, 96),
    mediaId: task.mediaId ? `media-${safeIdentifier(String(task.mediaId).split('-').pop() || task.mediaId, 16)}` : '',
    status: safeEnumText(task.status, 40),
    attempts: safeNumber(task.attempts),
    hlsOutputMethod: safeEnumText(task.hlsOutputMethod || '', 48),
    hlsVariantPreference: safeEnumText(task.result?.hlsVariantPreference || '', 48),
    strategy: safeEnumText(task.strategy || task.result?.strategy || '', 64),
    progress: sanitizeProgress(task.progress),
    result: task.result ? sanitizeResult(task.result) : null,
    mediaType: safeEnumText(task.mediaType || task.media?.mediaType || '', 40),
    extension: safeEnumText(task.extension || task.media?.extension || '', 16),
    lastError: sanitizeError(task.lastError)
  };
}

function sanitizeProgress(progress = null) {
  if (!progress) return null;
  return {
    phase: safeEnumText(progress.phase || '', 64),
    loaded: safeNullableNumber(progress.loaded),
    total: safeNullableNumber(progress.total),
    percent: Math.max(0, Math.min(100, safeNumber(progress.percent))),
    detailCode: progress.detail ? safeDetailCode(progress.detail) : '',
    bytes: safeNullableNumber(progress.bytes),
    retries: safeNullableNumber(progress.retries),
    averageBytesPerSecond: safeNullableNumber(progress.averageBytesPerSecond),
    peakConcurrency: safeNullableNumber(progress.peakConcurrency),
    updatedAt: safeTimestamp(progress.updatedAt)
  };
}

function sanitizeError(error = null) {
  if (!error) return null;
  return {
    category: safeEnumText(error.category || ERROR_CATEGORIES.UNKNOWN, 64),
    code: safeEnumText(error.code || 'unknown-error', 96),
    strategy: safeEnumText(error.strategy || '', 64),
    messageCode: safeDetailCode(error.code || error.message || 'unknown-error')
  };
}

function sanitizeResult(result = {}) {
  return {
    strategy: safeEnumText(result.strategy || '', 64),
    remuxedToMp4: Boolean(result.remuxedToMp4),
    remuxFallbackReason: result.remuxFallbackReason ? safeDetailCode(result.remuxFallbackReason) : '',
    segmentCount: safeNumber(result.segmentCount),
    totalBytes: safeNumber(result.totalBytes),
    segmentRetryCount: safeNumber(result.segmentRetryCount),
    peakConcurrency: safeNumber(result.peakConcurrency),
    averageBytesPerSecond: safeNumber(result.averageBytesPerSecond),
    hasAudio: Boolean(result.hasAudio),
    hlsVariantPreference: safeEnumText(result.hlsVariantPreference || '', 48),
    selectedResolution: safeEnumText(result.selectedResolution || '', 32),
    selectedBandwidth: safeNumber(result.selectedBandwidth),
    estimatedVideoFps: safeNumber(result.estimatedVideoFps),
    videoSampleCount: safeNumber(result.videoSampleCount),
    audioSampleCount: safeNumber(result.audioSampleCount),
    outputBytes: safeNumber(result.outputBytes),
    videoDurationSeconds: safeNumber(result.videoDurationSeconds),
    audioDurationSeconds: safeNumber(result.audioDurationSeconds),
    keyFrameCount: safeNumber(result.keyFrameCount),
    droppedVideoSamples: safeNumber(result.droppedVideoSamples),
    droppedAudioSamples: safeNumber(result.droppedAudioSamples),
    remuxWarnings: Array.isArray(result.remuxWarnings) ? result.remuxWarnings.slice(0, 8).map(safeDetailCode) : [],
    hlsOutputMethod: safeEnumText(result.hlsOutputMethod || '', 48),
    outputExtension: safeEnumText(result.outputExtension || '', 16)
  };
}


function safeHistoryList(value) {
  return Array.isArray(value) ? value.slice(0, MAX_SETTLED_TASKS_PER_BUCKET) : [];
}

function hydrateHistoryTask(task = {}, fallbackStatus = DOWNLOAD_STATUSES.CANCELED) {
  return {
    id: safeIdentifier(task.id || `history-${Date.now().toString(36)}`, 96),
    mediaId: safeIdentifier(task.mediaId || '', 96),
    tabId: null,
    status: safeEnumText(task.status || fallbackStatus, 40),
    attempts: safeNumber(task.attempts),
    hlsOutputMethod: safeEnumText(task.hlsOutputMethod || '', 48),
    strategy: safeEnumText(task.strategy || task.result?.strategy || '', 64),
    progress: sanitizeProgress(task.progress),
    result: task.result ? sanitizeResult(task.result) : null,
    media: { mediaType: safeEnumText(task.mediaType || '', 40), extension: safeEnumText(task.extension || '', 16), hostname: '' },
    lastError: sanitizeError(task.lastError)
  };
}

function hydrateInterruptedTask(task = {}) {
  return {
    ...hydrateHistoryTask(task, DOWNLOAD_STATUSES.CANCELED),
    status: DOWNLOAD_STATUSES.CANCELED,
    lastError: {
      category: ERROR_CATEGORIES.USER_CANCELED,
      code: 'service-worker-restarted',
      strategy: '',
      message: 'This task was interrupted when the extension service worker restarted. Queue it again from a fresh scan.'
    },
    progress: {
      ...(sanitizeProgress(task.progress) || {}),
      phase: 'interrupted',
      percent: 0,
      detail: 'Interrupted by extension restart.',
      updatedAt: new Date().toISOString()
    }
  };
}

function safeIdentifier(value = '', maxLength = 96) {
  return String(value || '').replace(/[^a-z0-9_.:-]+/gi, '-').slice(0, maxLength);
}

function safeEnumText(value = '', maxLength = 64) {
  return String(value || '').replace(/[^a-z0-9_.:-]+/gi, '-').slice(0, maxLength);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeNullableNumber(value) {
  return value == null ? null : safeNumber(value, null);
}

function safeTimestamp(value = '') {
  const text = String(value || '');
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 40) : '';
}

function safeDetailCode(text = '') {
  const value = String(text || '').toLowerCase();
  if (/cancel/.test(value)) return 'canceled';
  if (/complete|saved|finish/.test(value)) return 'completed';
  if (/remux/.test(value)) return 'remuxing';
  if (/segment/.test(value)) return 'segments';
  if (/download/.test(value)) return 'downloading';
  if (/timeout|stalled/.test(value)) return 'timeout';
  if (/permission|access/.test(value)) return 'access';
  if (/cors/.test(value)) return 'cors';
  if (/encrypt|drm|protected/.test(value)) return 'protected';
  if (/signed|token|expir/.test(value)) return 'signed-url';
  if (/network|fetch|http/.test(value)) return 'network';
  if (/valid/.test(value)) return 'validation';
  return 'status';
}
