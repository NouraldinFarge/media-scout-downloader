(() => {
  if (globalThis.__mediaScoutContentLoaded) return;
  globalThis.__mediaScoutContentLoaded = true;

  const MESSAGE_TYPES = {
    SCAN_PAGE_MEDIA: 'SCAN_PAGE_MEDIA',
    DOM_MEDIA_FOUND: 'DOM_MEDIA_FOUND',
    BLOB_DOWNLOAD_REQUEST: 'BLOB_DOWNLOAD_REQUEST',
    HLS_MERGE_DOWNLOAD_REQUEST: 'HLS_MERGE_DOWNLOAD_REQUEST',
    CANCEL_HLS_TASK: 'CANCEL_HLS_TASK',
    DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
    SCAN_PAGE_MEDIA_DETAILED: 'SCAN_PAGE_MEDIA_DETAILED'
  };

  const ERROR_CATEGORIES = {
    NETWORK: 'network',
    ENCRYPTED: 'encrypted',
    DRM: 'drm',
    ACCESS_CONTROL: 'access-control',
    PERMISSION: 'permission',
    PAYWALL: 'paywall',
    AUTHENTICATION: 'authentication',
    CORS: 'cors',
    USER_CANCELED: 'user-canceled',
    SIGNED_OR_EXPIRING_URL: 'signed-or-expiring-url',
    UNSUPPORTED: 'unsupported',
    VALIDATION: 'validation',
    UNKNOWN: 'unknown'
  };


  const HLS_OUTPUT_METHODS = {
    SMART_MP4: 'smart-mp4',
    MP4_REMUX: 'mp4-remux',
    TIMESTAMP_FIXED_TS: 'timestamp-fixed-ts',
    TS_CONCAT: 'ts-concat',
    PLAYLIST_ONLY: 'playlist-only',
    EXTERNAL_HELPER: 'external-helper'
  };

  const MAX_HLS_SEGMENTS = 6000;
  const MAX_HLS_VARIANTS = 200;
  const MAX_HLS_AUDIO_RENDITIONS = 100;
  const MAX_HLS_BYTES = 128 * 1024 * 1024; // Experimental Blob-based merge/remux can multiply peak memory; fail closed early.
  const MAX_HLS_ESTIMATED_BYTES = Math.floor(MAX_HLS_BYTES * 0.65);
  const MAX_HLS_PLAYLIST_BYTES = 4 * 1024 * 1024;
  const MAX_HLS_SEGMENT_BYTES = 24 * 1024 * 1024;
  const DEFAULT_SEGMENT_PARALLELISM = 4;
  const MAX_SEGMENT_PARALLELISM = 16;
  const DEFAULT_SEGMENT_RETRY_LIMIT = 2;
  const MAX_SEGMENT_RETRY_LIMIT = 4;
  const PROTECTED_QUERY_HINTS = Object.freeze([
    'signature', 'sig', 'policy', 'expires', 'expiry', 'exp', 'token', 'auth',
    'authorization', 'x-amz-signature', 'x-amz-credential', 'x-amz-expires',
    'x-goog-signature', 'x-goog-credential', 'x-goog-expires', 'key-pair-id'
  ]);
  const AUTO_SCAN_THROTTLE_MS = 1500;
  const activeHlsTasks = new Map();
  let scanTimer = null;
  let loadTimer = null;
  let mutationObserver = null;
  let resourceObserver = null;
  let lastScanAt = 0;

  globalThis.__mediaScoutCleanup = () => {
    try { if (scanTimer) clearTimeout(scanTimer); } catch (_error) {}
    scanTimer = null;
    try { if (loadTimer) clearTimeout(loadTimer); } catch (_error) {}
    loadTimer = null;
    try { window.removeEventListener('load', handleWindowLoad); } catch (_error) {}
    try { document.removeEventListener('visibilitychange', handleVisibilityChange); } catch (_error) {}
    try { document.removeEventListener('DOMContentLoaded', handleDomContentLoaded); } catch (_error) {}
    try { chrome.runtime.onMessage.removeListener(handleRuntimeMessage); } catch (_error) {}
    try {
      for (const task of activeHlsTasks.values()) {
        try { task.controller?.abort?.(); } catch (_error) {}
        try { for (const objectUrl of task.objectUrls || []) URL.revokeObjectURL(objectUrl); } catch (_error) {}
      }
      activeHlsTasks.clear();
    } catch (_error) {}
    try { mutationObserver?.disconnect?.(); } catch (_error) {}
    mutationObserver = null;
    try { resourceObserver?.disconnect?.(); } catch (_error) {}
    resourceObserver = null;
    globalThis.__mediaScoutContentLoaded = false;
    return true;
  };

  function scanAndSend() {
    lastScanAt = Date.now();
    const items = (globalThis.MediaScoutPageScanner?.scan?.() || []).slice(0, 500);
    if (items.length) chrome.runtime.sendMessage({ type: MESSAGE_TYPES.DOM_MEDIA_FOUND, items }).catch(() => undefined);
    return items;
  }
  function debouncedScan() {
    if (scanTimer) return;
    const delay = Math.max(350, AUTO_SCAN_THROTTLE_MS - (Date.now() - lastScanAt));
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanAndSend();
    }, delay);
  }

  function handleWindowLoad() {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
      loadTimer = null;
      debouncedScan();
    }, 700);
  }

  function handleVisibilityChange() {
    if (!document.hidden) debouncedScan();
  }

  function handleDomContentLoaded() {
    debouncedScan();
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === MESSAGE_TYPES.SCAN_PAGE_MEDIA) {
      const items = scanAndSend();
      sendResponse({ items });
      return false;
    }
    if (message?.type === MESSAGE_TYPES.SCAN_PAGE_MEDIA_DETAILED) {
      Promise.resolve(globalThis.MediaScoutPageScanner?.scanDetailed?.() || { unavailable: true, error: 'Detailed scanner unavailable.' })
        .then((report) => sendResponse({ report }))
        .catch((error) => sendResponse({ report: { unavailable: true, error: error?.message || 'Detailed scanner failed.' } }));
      return true;
    }
    if (message?.type === MESSAGE_TYPES.BLOB_DOWNLOAD_REQUEST) {
      handleBlobDownload(message).then(sendResponse);
      return true;
    }
    if (message?.type === MESSAGE_TYPES.HLS_MERGE_DOWNLOAD_REQUEST) {
      handleHlsMergeDownload(message).then(sendResponse);
      return true;
    }
    if (message?.type === MESSAGE_TYPES.CANCEL_HLS_TASK) {
      sendResponse(cancelActiveHlsTask(message));
      return false;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  async function handleBlobDownload(message) {
    try {
      if (!String(message.url || '').startsWith('blob:')) {
        return { ok: false, category: ERROR_CATEGORIES.VALIDATION, code: 'not-blob-url', error: 'Only blob: URLs can use the page-local blob strategy.' };
      }
      triggerBrowserDownload(message.url, String(message.filename || 'media').split('/').pop());
      return { ok: true };
    } catch (error) {
      return { ok: false, category: ERROR_CATEGORIES.UNKNOWN, code: 'blob-download-failed', error: error.message || 'Blob download failed.' };
    }
  }

  async function handleHlsMergeDownload(message) {
    const taskId = String(message.taskId || message.mediaId || 'hls-task');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let handOffObjectUrlsToBrowser = false;
    if (controller) activeHlsTasks.set(taskId, { controller, objectUrls: new Set(), startedAt: Date.now() });
    try {
      const signal = controller?.signal;
      const playlistUrl = normalizeHttpUrl(message.playlistUrl || message.originalPlaylistUrl);
      if (!playlistUrl) {
        return fail(ERROR_CATEGORIES.VALIDATION, 'invalid-hls-url', 'The HLS playlist URL is invalid.');
      }
      const initialProtectedUrl = protectedHlsUriReason(playlistUrl, 'playlist');
      if (initialProtectedUrl) return fail(ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL, initialProtectedUrl.code, initialProtectedUrl.message, initialProtectedUrl.details);

      assertNotCanceled(signal);
      const root = await fetchPlaylist(playlistUrl, signal);
      let selectedPlaylistUrl = playlistUrl;
      let playlist = parseHlsPlaylist(root.text, playlistUrl);
      playlist.selectedBandwidth = Number(message.bandwidth) || 0;
      playlist.selectedResolution = String(message.resolution || '');
      playlist.selectedVariantPreference = normalizeVariantPreference(message.hlsVariantPreference);

      if (playlist.encrypted) return fail(ERROR_CATEGORIES.ENCRYPTED, 'encrypted-hls', 'Encrypted HLS playlists are not merged.');
      const rootStructureLimit = getPlaylistStructureLimitReason(playlist);
      if (rootStructureLimit) return fail(ERROR_CATEGORIES.UNSUPPORTED, rootStructureLimit.code, rootStructureLimit.message, rootStructureLimit.details);
      if (!playlist.variants.length) {
        const mediaPlaylistProtectedUri = protectedPlaylistUriReason(playlist, selectedPlaylistUrl);
        if (mediaPlaylistProtectedUri) return fail(ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL, mediaPlaylistProtectedUri.code, mediaPlaylistProtectedUri.message, mediaPlaylistProtectedUri.details);
      }
      if (playlist.variants.length) {
        if (playlistHasSeparateAudioRequirement(playlist) && !playlist.variants.some(isLikelySelfContainedHlsVariant)) {
          return fail(ERROR_CATEGORIES.UNSUPPORTED, 'hls-separate-audio-unsupported', 'This HLS master playlist requires separate audio renditions. The built-in merger does not align separate audio/video yet.');
        }
        const variant = chooseVariant(playlist.variants, message.hlsVariantPreference);
        selectedPlaylistUrl = variant.url;
        const variantProtectedUrl = protectedHlsUriReason(selectedPlaylistUrl, 'variant-playlist');
        if (variantProtectedUrl) return fail(ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL, variantProtectedUrl.code, variantProtectedUrl.message, variantProtectedUrl.details);
        const variantResponse = await fetchPlaylist(selectedPlaylistUrl, signal);
        playlist = parseHlsPlaylist(variantResponse.text, selectedPlaylistUrl);
        playlist.selectedBandwidth = variant.bandwidth || 0;
        playlist.selectedResolution = variant.resolution || '';
        playlist.selectedVariantPreference = normalizeVariantPreference(message.hlsVariantPreference);
        if (playlist.encrypted) return fail(ERROR_CATEGORIES.ENCRYPTED, 'encrypted-hls-variant', 'The selected HLS variant is encrypted and cannot be merged.');
        const variantStructureLimit = getPlaylistStructureLimitReason(playlist);
        if (variantStructureLimit) return fail(ERROR_CATEGORIES.UNSUPPORTED, variantStructureLimit.code, variantStructureLimit.message, variantStructureLimit.details);
      }

      const protectedUri = protectedPlaylistUriReason(playlist, selectedPlaylistUrl);
      if (protectedUri) return fail(ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL, protectedUri.code, protectedUri.message, protectedUri.details);
      const unsupported = getUnsupportedPlaylistReason(playlist);
      if (unsupported) return fail(ERROR_CATEGORIES.UNSUPPORTED, unsupported.code, unsupported.message, unsupported.details);
      const sizeRisk = estimatePlaylistSizeRisk(playlist);
      if (sizeRisk) return fail(ERROR_CATEGORIES.UNSUPPORTED, sizeRisk.code, sizeRisk.message, sizeRisk.details);
      message.playlistProbe = summarizePlaylistProbe(playlist, selectedPlaylistUrl);

      const segmentParallelism = normalizeSegmentParallelism(message.segmentParallelism);
      const segmentRetryLimit = normalizeSegmentRetryLimit(message.segmentRetryLimit);
      reportProgress(message, {
        phase: 'fetching-playlist',
        loaded: 0,
        total: playlist.segments.length,
        percent: 8,
        detail: `Playlist parsed; fetching ${playlist.segments.length} segment(s)${playlist.durationSeconds ? ` (${Math.round(playlist.durationSeconds)}s)` : ''} with adaptive parallelism up to ${segmentParallelism} request(s).`
      });

      const { parts, totalBytes, retries, peakConcurrency, averageBytesPerSecond } = await fetchSegmentsInParallel(playlist.segments, segmentParallelism, message, { segmentRetryLimit, signal });

      assertNotCanceled(signal);
      const preferredFilename = String(message.filename || 'hls-video.mp4').split('/').pop() || 'hls-video.mp4';
      message.expectedDurationSeconds = playlist.durationSeconds || 0;
      const output = await buildPreferredHlsOutput(parts, preferredFilename, message, playlist, signal);
      assertNotCanceled(signal);
      reportProgress(message, { phase: 'saving', loaded: 1, total: 1, percent: 98, detail: `Saving ${output.extension.toUpperCase()} file.` });
      const objectUrl = URL.createObjectURL(output.blob);
      activeHlsTasks.get(taskId)?.objectUrls?.add?.(objectUrl);
      assertNotCanceled(signal);
      triggerBrowserDownload(objectUrl, output.filename);
      handOffObjectUrlsToBrowser = true;
      activeHlsTasks.get(taskId)?.objectUrls?.delete?.(objectUrl);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      reportProgress(message, { phase: 'completed', loaded: 1, total: 1, percent: 100, detail: `Saved ${output.filename}` });
      return {
        ok: true,
        filename: output.filename,
        segmentCount: playlist.segments.length,
        totalBytes,
        outputBytes: output.blob.size,
        remuxedToMp4: output.remuxedToMp4,
        remuxFallbackReason: output.remuxFallbackReason,
        videoSampleCount: output.videoSampleCount || 0,
        audioSampleCount: output.audioSampleCount || 0,
        hasAudio: Boolean(output.hasAudio),
        estimatedVideoFps: output.estimatedVideoFps || 0,
        videoDurationSeconds: output.videoDurationSeconds || 0,
        audioDurationSeconds: output.audioDurationSeconds || 0,
        keyFrameCount: output.keyFrameCount || 0,
        droppedVideoSamples: output.droppedVideoSamples || 0,
        droppedAudioSamples: output.droppedAudioSamples || 0,
        remuxWarnings: output.remuxWarnings || [],
        hlsOutputMethod: output.hlsOutputMethod || message.hlsOutputMethod || '',
        outputExtension: output.outputExtension || output.extension || '',
        variantUrl: selectedPlaylistUrl,
        hlsVariantPreference: normalizeVariantPreference(message.hlsVariantPreference),
        selectedResolution: playlist.selectedResolution || '',
        selectedBandwidth: playlist.selectedBandwidth || 0,
        segmentRetryCount: retries,
        peakConcurrency,
        averageBytesPerSecond
      };
    } catch (error) {
      return normalizeFetchError(error);
    } finally {
      cleanupHlsTask(taskId, { revokeObjectUrls: !handOffObjectUrlsToBrowser });
    }
  }

  async function fetchPlaylist(url, signal) {
    const response = await fetchWithNormalPageRules(url, 'playlist', { signal });
    const text = await readBoundedResponseText(response, MAX_HLS_PLAYLIST_BYTES, 'HLS playlist');
    if (!/^\s*#EXTM3U/m.test(text)) {
      throw structured(ERROR_CATEGORIES.UNSUPPORTED, 'not-hls-playlist', 'The response was not an HLS playlist.');
    }
    return { text, finalUrl: response.url || url };
  }

  async function fetchBinary(url, label, signal) {
    return fetchWithNormalPageRules(url, label, { signal, cache: 'default' });
  }

  async function readBoundedResponseText(response, maxBytes, label) {
    const contentLength = parseContentLength(response);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw structured(ERROR_CATEGORIES.UNSUPPORTED, 'hls-playlist-too-large', `${label} exceeds the ${formatBytes(maxBytes)} inspection limit.`);
    }
    if (!response.body?.getReader) {
      throw structured(ERROR_CATEGORIES.UNSUPPORTED, 'hls-playlist-stream-unavailable', `${label} cannot be read safely because this browser does not expose a bounded response stream.`);
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
          try { await reader.cancel('hls-playlist-size-limit'); } catch (_error) {}
          throw structured(ERROR_CATEGORIES.UNSUPPORTED, 'hls-playlist-too-large', `${label} exceeds the ${formatBytes(maxBytes)} inspection limit.`);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join('');
    } finally {
      reader.releaseLock?.();
    }
  }

  async function fetchSegmentsInParallel(segments, maxConcurrency, message, options = {}) {
    const parts = new Array(segments.length);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const parentSignal = options.signal || null;
    const signal = controller?.signal || parentSignal;
    const abortFromParent = () => controller?.abort?.(parentSignal?.reason || 'parent-abort');
    if (controller && parentSignal) {
      if (parentSignal.aborted) abortFromParent();
      else parentSignal.addEventListener?.('abort', abortFromParent, { once: true });
    }
    const retryLimit = normalizeSegmentRetryLimit(options.segmentRetryLimit);
    const work = workTuning(message?.hlsWorkMode);
    const targetMax = Math.min(maxConcurrency, work.maxConcurrencyCap, segments.length);
    // Start below the user ceiling to avoid a burst of requests that can stutter
    // the page, then ramp quickly while requests are healthy.
    let targetConcurrency = Math.min(Math.max(work.startConcurrency, Math.ceil(targetMax * work.startRatio)), targetMax);
    let nextIndex = 0;
    let completed = 0;
    let totalBytes = 0;
    let retries = 0;
    let peakConcurrency = 0;
    let lastReportAt = 0;
    let lastReportedCompleted = 0;
    const startedAt = Date.now();
    const inFlight = new Set();
    let fatalError = null;

    const maybeReport = (force = false) => {
      const now = Date.now();
      const completedDelta = completed - lastReportedCompleted;
      if (!force && now - lastReportAt < work.progressIntervalMs && completedDelta < Math.max(4, Math.round(segments.length / 120))) return;
      lastReportAt = now;
      lastReportedCompleted = completed;
      const elapsedSeconds = Math.max(0.001, (now - startedAt) / 1000);
      const averageBytesPerSecond = Math.round(totalBytes / elapsedSeconds);
      reportProgress(message, {
        phase: 'fetching-segments',
        loaded: completed,
        total: segments.length,
        percent: Math.min(74, 8 + Math.round((completed / segments.length) * 66)),
        detail: `Fetched ${completed} of ${segments.length} segment(s) • ${inFlight.size} active / ${targetConcurrency} target / ${targetMax} max • ${retries} retried`,
        bytes: totalBytes,
        workers: targetConcurrency,
        activeWorkers: inFlight.size,
        retries,
        averageBytesPerSecond,
        peakConcurrency
      });
    };

    const launch = (index) => {
      assertNotCanceled(signal);
      const promise = fetchSegmentWithRetry(segments[index], index, retryLimit, signal, work.segmentTimeoutMs, (retryInfo) => {
        retries += 1;
        // Back off the adaptive window after retryable failures. This prevents
        // aggressive parallelism from hammering a CDN or freezing the page when
        // segment fetches begin timing out, while still keeping ordered output.
        targetConcurrency = Math.max(1, Math.floor(targetConcurrency * 0.75));
        reportProgress(message, {
          phase: 'fetching-segments',
          loaded: completed,
          total: segments.length,
          percent: Math.min(74, 8 + Math.round((completed / segments.length) * 66)),
          detail: `Retrying segment ${index + 1} (${retryInfo.attempt}/${retryLimit}); throttled to ${targetConcurrency} concurrent request(s).`,
          bytes: totalBytes,
          retries,
          workers: targetConcurrency,
          activeWorkers: inFlight.size,
          lastSegmentIndex: index + 1
        });
      }).then((bytes) => {
        if (fatalError) return;
        const nextTotalBytes = totalBytes + bytes.byteLength;
        if (nextTotalBytes > MAX_HLS_BYTES) {
          throw structured(
            ERROR_CATEGORIES.UNSUPPORTED,
            'hls-merge-too-large',
            'This HLS stream is too large for the in-browser memory-based merger. Try a shorter/lower-bitrate variant.',
            { maxBytes: MAX_HLS_BYTES, bytesSoFar: totalBytes, rejectedSegmentBytes: bytes.byteLength, segmentIndex: index + 1 }
          );
        }
        parts[index] = bytes;
        totalBytes = nextTotalBytes;
        completed += 1;
        // Ramp up gradually while requests are succeeding; this avoids the popup
        // and the page stuttering from launching the full window immediately.
        if (targetConcurrency < targetMax && completed % Math.max(work.rampEvery, targetConcurrency) === 0) {
          targetConcurrency += 1;
        }
        maybeReport(false);
      }).catch((error) => {
        if (fatalError) return null;
        fatalError = structured(
          error?.category || ERROR_CATEGORIES.NETWORK,
          error?.code || 'segment-fetch-failed',
          `Segment ${index + 1} of ${segments.length} failed. ${error?.message || 'The segment could not be fetched.'}`.trim(),
          { ...(error?.details || {}), segmentIndex: index + 1, completedSegments: completed, totalSegments: segments.length, retries }
        );
        controller?.abort?.('segment-fatal-error');
        return null;
      }).finally(() => {
        inFlight.delete(promise);
      });
      inFlight.add(promise);
      peakConcurrency = Math.max(peakConcurrency, inFlight.size);
    };

    maybeReport(true);
    while (completed < segments.length && !fatalError) {
      assertNotCanceled(signal);
      while (!fatalError && nextIndex < segments.length && inFlight.size < targetConcurrency) {
        assertNotCanceled(signal);
        launch(nextIndex);
        nextIndex += 1;
      }
      if (!inFlight.size) break;
      await Promise.race(inFlight);
      // Yield periodically, not after every segment, to avoid thousands of timer
      // callbacks on long videos while still letting the browser paint.
      if (completed > 0 && completed % work.yieldEvery === 0) {
        await wait(0);
        assertNotCanceled(signal);
      }
    }

    if (fatalError) {
      await Promise.allSettled(Array.from(inFlight));
      parentSignal?.removeEventListener?.('abort', abortFromParent);
      throw fatalError;
    }

    parentSignal?.removeEventListener?.('abort', abortFromParent);
    maybeReport(true);
    const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
    return { parts, totalBytes, retries, peakConcurrency, averageBytesPerSecond: Math.round(totalBytes / elapsedSeconds) };
  }

  async function fetchSegmentWithRetry(segment, index, retryLimit, signal, timeoutMs, onRetry) {
    let lastError = null;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      assertNotCanceled(signal);
      try {
        const response = await fetchBinaryWithTimeout(segment.url, `segment ${index + 1}`, signal, timeoutMs);
        const contentLength = parseContentLength(response);
        if (Number.isFinite(contentLength) && contentLength > MAX_HLS_SEGMENT_BYTES) {
          throw structured(ERROR_CATEGORIES.UNSUPPORTED, 'hls-segment-too-large', `Segment ${index + 1} exceeds the ${formatBytes(MAX_HLS_SEGMENT_BYTES)} per-segment memory limit.`);
        }
        return await readBoundedResponseBytes(response, MAX_HLS_SEGMENT_BYTES, `Segment ${index + 1}`);
      } catch (error) {
        lastError = error;
        if (!isRetryableSegmentError(error) || attempt >= retryLimit) break;
        onRetry?.({ attempt: attempt + 1, error });
        await wait(Math.min(1600, 250 * Math.pow(2, attempt)));
        assertNotCanceled(signal);
      }
    }
    throw lastError || structured(ERROR_CATEGORIES.NETWORK, 'segment-fetch-failed', 'The segment could not be fetched.');
  }

  async function readBoundedResponseBytes(response, maxBytes, label) {
    const contentLength = parseContentLength(response);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw structured(ERROR_CATEGORIES.UNSUPPORTED, 'hls-segment-too-large', `${label} exceeds the ${formatBytes(maxBytes)} per-segment memory limit.`);
    }
    if (!response.body?.getReader) {
      throw structured(ERROR_CATEGORIES.UNSUPPORTED, 'hls-segment-stream-unavailable', `${label} cannot be read safely because this browser does not expose a bounded response stream.`);
    }

    const reader = response.body.getReader();
    const initialCapacity = Number.isFinite(contentLength) ? Math.min(contentLength, 1024 * 1024) : Math.min(maxBytes, 64 * 1024);
    let bytes = new Uint8Array(initialCapacity);
    let bytesRead = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const nextBytesRead = bytesRead + value.byteLength;
        if (nextBytesRead > maxBytes) {
          try { await reader.cancel('hls-segment-size-limit'); } catch (_error) {}
          throw structured(ERROR_CATEGORIES.UNSUPPORTED, 'hls-segment-too-large', `${label} exceeds the ${formatBytes(maxBytes)} per-segment memory limit.`);
        }
        if (nextBytesRead > bytes.byteLength) {
          const nextCapacity = Math.min(maxBytes, Math.max(nextBytesRead, Math.max(64 * 1024, bytes.byteLength * 2)));
          const expanded = new Uint8Array(nextCapacity);
          expanded.set(bytes.subarray(0, bytesRead));
          bytes = expanded;
        }
        bytes.set(value, bytesRead);
        bytesRead = nextBytesRead;
      }
    } finally {
      reader.releaseLock?.();
    }
    return bytes.subarray(0, bytesRead);
  }

  function parseContentLength(response) {
    const header = response.headers?.get?.('content-length');
    if (header == null || header === '') return null;
    const value = Number(header);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function isRetryableSegmentError(error) {
    if (!error) return true;
    if (error.category === ERROR_CATEGORIES.NETWORK) return true;
    // A normal browser fetch may report TypeError/Failed to fetch for transient
    // CDN throttling as well as CORS. We retry it a small number of times, but
    // still stop if the same normal fetch remains blocked.
    return error.category === ERROR_CATEGORIES.CORS && error.code === 'normal-fetch-blocked';
  }

  async function fetchBinaryWithTimeout(url, label, parentSignal, timeoutMs) {
    if (typeof AbortController === 'undefined') return fetchBinary(url, label, parentSignal);
    const controller = new AbortController();
    let timeoutFired = false;
    const timer = setTimeout(() => {
      timeoutFired = true;
      controller.abort('segment-timeout');
    }, timeoutMs);
    const abort = () => controller.abort(parentSignal?.reason || 'parent-abort');
    try {
      if (parentSignal?.aborted) abort();
      else parentSignal?.addEventListener?.('abort', abort, { once: true });
      return await fetchBinary(url, label, controller.signal);
    } catch (error) {
      if (timeoutFired && !error?.category) {
        throw structured(ERROR_CATEGORIES.NETWORK, 'segment-fetch-timeout', `Timed out fetching ${label}.`, { urlHost: safeHostname(url) });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', abort);
    }
  }


  function workTuning(mode) {
    if (mode === 'gentle') return { startConcurrency: 1, startRatio: 0.25, progressIntervalMs: 900, yieldEvery: 6, rampEvery: 12, segmentTimeoutMs: 60_000, remuxYieldMs: 8, maxConcurrencyCap: 4 };
    if (mode === 'fast') return { startConcurrency: 4, startRatio: 0.75, progressIntervalMs: 400, yieldEvery: 32, rampEvery: 3, segmentTimeoutMs: 35_000, remuxYieldMs: 0, maxConcurrencyCap: 16 };
    return { startConcurrency: 2, startRatio: 0.45, progressIntervalMs: 650, yieldEvery: 12, rampEvery: 6, segmentTimeoutMs: 45_000, remuxYieldMs: 2, maxConcurrencyCap: 8 };
  }

  async function yieldToBrowser(mode) {
    const waitMs = workTuning(mode).remuxYieldMs;
    await wait(waitMs);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normalizeSegmentParallelism(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_SEGMENT_PARALLELISM;
    return Math.max(1, Math.min(MAX_SEGMENT_PARALLELISM, Math.round(parsed)));
  }

  function normalizeSegmentRetryLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_SEGMENT_RETRY_LIMIT;
    return Math.max(0, Math.min(MAX_SEGMENT_RETRY_LIMIT, Math.round(parsed)));
  }
  async function buildPreferredHlsOutput(parts, preferredFilename, message, _playlist = null, signal = null) {
    const canRemux = Boolean(globalThis.MediaScoutMp4Remuxer?.remuxToMp4);
    const hlsOutputMethod = message.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4;
    const requireMp4 = hlsOutputMethod === HLS_OUTPUT_METHODS.MP4_REMUX;
    if (hlsOutputMethod === HLS_OUTPUT_METHODS.TS_CONCAT || hlsOutputMethod === HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS) {
      const fixed = hlsOutputMethod === HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS;
      reportProgress(message, {
        phase: fixed ? 'normalizing-ts' : 'assembling-ts',
        loaded: 1,
        total: 1,
        percent: 94,
        detail: fixed
          ? 'Building timestamp-aware MPEG-TS fallback: fixing continuity counters and rebasing obvious timestamp resets where possible.'
          : 'Raw-concatenating MPEG-TS segments. This is fastest but may preserve audio/video drift or timestamp resets.'
      });
      await yieldToBrowser(message?.hlsWorkMode);
      assertNotCanceled(signal);
      const tsOutput = fixed ? await buildTimestampFixedTs(parts, message, signal) : { blob: new Blob(parts, { type: 'video/mp2t' }), stats: { warnings: ['Raw TS concat does not repair PCR/PTS/DTS timing. Use Smart MP4 or Timestamp-fixed TS if audio drifts.'] } };
      return {
        blob: tsOutput.blob,
        extension: 'ts',
        filename: ensureExtension(preferredFilename, 'ts'),
        remuxedToMp4: false,
        outputExtension: 'ts',
        hlsOutputMethod,
        remuxFallbackReason: fixed ? 'Saved as timestamp-aware MPEG-TS fallback.' : 'Saved as raw MPEG-TS concat by selected output method.',
        remuxWarnings: tsOutput.stats?.warnings || [],
        keyFrameCount: tsOutput.stats?.keyFrameCount || 0,
        audioSampleCount: tsOutput.stats?.audioTimestampCount || 0,
        videoSampleCount: tsOutput.stats?.videoTimestampCount || 0,
        hasAudio: Boolean(tsOutput.stats?.audioTimestampCount)
      };
    }
    if (canRemux) {
      try {
        reportProgress(message, { phase: 'remuxing', loaded: 0, total: 100, percent: 76, detail: 'Remuxing MPEG-TS into MP4. The browser will yield between heavy phases to reduce freezing.' });
        await yieldToBrowser(message?.hlsWorkMode);
        assertNotCanceled(signal);
        const remuxed = await globalThis.MediaScoutMp4Remuxer.remuxToMp4(parts, {
          resolution: message.resolution || '',
          expectedDurationSeconds: message.expectedDurationSeconds || 0,
          workMode: message.hlsWorkMode || 'balanced',
          onProgress(progress) {
            assertNotCanceled(signal);
            reportProgress(message, {
              phase: 'remuxing',
              loaded: progress.percent || 0,
              total: 100,
              percent: 76 + Math.round(((progress.percent || 0) / 100) * 20),
              detail: progress.detail || 'Remuxing MPEG-TS into MP4.'
            });
          }
        });
        assertNotCanceled(signal);
        const blob = new Blob([remuxed.bytes], { type: remuxed.mimeType || 'video/mp4' });
        return {
          blob,
          extension: 'mp4',
          filename: ensureExtension(preferredFilename, 'mp4'),
          remuxedToMp4: true,
          outputExtension: 'mp4',
          hlsOutputMethod,
          videoSampleCount: remuxed.videoSampleCount,
          audioSampleCount: remuxed.audioSampleCount,
          hasAudio: Boolean(remuxed.hasAudio),
          estimatedVideoFps: remuxed.estimatedVideoFps || 0,
          videoDurationSeconds: remuxed.videoDurationSeconds || 0,
          audioDurationSeconds: remuxed.audioDurationSeconds || 0,
          keyFrameCount: remuxed.keyFrameCount || 0,
          droppedVideoSamples: remuxed.droppedVideoSamples || 0,
          droppedAudioSamples: remuxed.droppedAudioSamples || 0,
          remuxWarnings: remuxed.remuxWarnings || []
        };
      } catch (error) {
        if (requireMp4) {
          throw structured(
            ERROR_CATEGORIES.UNSUPPORTED,
            error?.code || 'mp4-remux-failed',
            `The HLS segments were fetched, but they could not be remuxed into a playable MP4. ${error?.message || ''}`.trim(),
            { fallbackSuppressed: true, remuxCode: error?.code || '', remuxCategory: error?.category || '' }
          );
        }
        reportProgress(message, {
          phase: 'timestamp-ts-fallback',
          loaded: 1,
          total: 1,
          percent: 95,
          detail: `MP4 remux unavailable; building timestamp-aware TS fallback instead of raw concat. ${error?.message || ''}`.trim()
        });
        const tsOutput = await buildTimestampFixedTs(parts, message, signal);
        return {
          blob: tsOutput.blob,
          extension: 'ts',
          filename: ensureExtension(preferredFilename, 'ts'),
          remuxedToMp4: false,
          outputExtension: 'ts',
          hlsOutputMethod: HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS,
          remuxWarnings: tsOutput.stats?.warnings || [],
          videoSampleCount: tsOutput.stats?.videoTimestampCount || 0,
          audioSampleCount: tsOutput.stats?.audioTimestampCount || 0,
          hasAudio: Boolean(tsOutput.stats?.audioTimestampCount),
          remuxFallbackReason: error?.message || 'MP4 remuxing failed for this stream; timestamp-aware TS fallback was saved.'
        };
      }
    }
    if (requireMp4) {
      throw structured(
        ERROR_CATEGORIES.UNSUPPORTED,
        'mp4-remuxer-unavailable',
        'The MP4 remuxer script was unavailable in this frame, so the .m3u8 item could not be saved as MP4.',
        { fallbackSuppressed: true }
      );
    }
    const tsOutput = await buildTimestampFixedTs(parts, message, signal);
    return {
      blob: tsOutput.blob,
      extension: 'ts',
      filename: ensureExtension(preferredFilename, 'ts'),
      remuxedToMp4: false,
      outputExtension: 'ts',
      hlsOutputMethod: HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS,
      remuxWarnings: tsOutput.stats?.warnings || [],
      videoSampleCount: tsOutput.stats?.videoTimestampCount || 0,
      audioSampleCount: tsOutput.stats?.audioTimestampCount || 0,
      hasAudio: Boolean(tsOutput.stats?.audioTimestampCount),
      remuxFallbackReason: 'The MP4 remuxer script was unavailable; timestamp-aware TS fallback was saved.'
    };
  }

  async function buildTimestampFixedTs(parts, message, signal) {
    const state = { continuity: new Map(), pidTypes: new Map(), segmentOffset90k: 0, globalMaxPts: null, resets: 0, packetCount: 0, videoTimestampCount: 0, audioTimestampCount: 0, warnings: [], keyFrameCount: 0 };
    const fixedParts = [];
    for (let segmentIndex = 0; segmentIndex < parts.length; segmentIndex += 1) {
      assertNotCanceled(signal);
      const input = parts[segmentIndex];
      const firstPts = findSegmentFirstPts(input, state);
      if (Number.isFinite(firstPts)) {
        if (state.globalMaxPts != null && firstPts + state.segmentOffset90k < state.globalMaxPts - 90000) {
          state.segmentOffset90k += state.globalMaxPts + 3000 - (firstPts + state.segmentOffset90k);
          state.resets += 1;
        }
      }
      fixedParts.push(rewriteTsSegment(input, state));
      if (segmentIndex > 0 && segmentIndex % 24 === 0) {
        reportProgress(message, { phase: 'normalizing-ts', loaded: segmentIndex + 1, total: parts.length, percent: 94 + Math.round(((segmentIndex + 1) / parts.length) * 3), detail: `Timestamp-normalized ${segmentIndex + 1} of ${parts.length} segment(s).` });
        await yieldToBrowser(message?.hlsWorkMode);
        assertNotCanceled(signal);
      }
    }
    if (state.resets) state.warnings.push(`Detected and rebased ${state.resets} apparent timestamp reset(s).`);
    if (!state.videoTimestampCount) state.warnings.push('No H.264/video timestamps were detected while normalizing TS.');
    if (!state.audioTimestampCount) state.warnings.push('No AAC/audio timestamps were detected while normalizing TS; the stream may be video-only or use unsupported audio.');
    if (state.packetCount > 0) state.warnings.push('Continuity counters were rewritten per PID. PCR/PTS/DTS were rebased for obvious resets only; for difficult streams, use a native remuxer/export helper.');
    return { blob: new Blob(fixedParts, { type: 'video/mp2t' }), stats: state };
  }

  function findSegmentFirstPts(bytes, state) {
    let earliest = Infinity;
    forEachTsPacket(bytes, (packet, offset) => {
      const info = readTsPacket(packet, offset);
      if (!info.payloadStart || info.payloadOffset < 0) return;
      updateStreamTypesFromPsi(packet, info, state);
      const pts = readPesTimestampAt(packet, info.payloadOffset, 'pts');
      if (Number.isFinite(pts)) earliest = Math.min(earliest, pts);
    });
    return earliest === Infinity ? NaN : earliest;
  }

  function rewriteTsSegment(bytes, state) {
    const out = new Uint8Array(bytes.byteLength);
    out.set(bytes);
    forEachTsPacket(out, (packet, offset) => {
      const info = readTsPacket(packet, offset);
      if (!info.valid) return;
      state.packetCount += 1;
      const hasPayload = (packet[offset + 3] & 0x10) !== 0;
      if (hasPayload) {
        const nextCc = state.continuity.get(info.pid);
        if (nextCc == null) state.continuity.set(info.pid, ((packet[offset + 3] & 0x0f) + 1) & 0x0f);
        else {
          packet[offset + 3] = (packet[offset + 3] & 0xf0) | (nextCc & 0x0f);
          state.continuity.set(info.pid, (nextCc + 1) & 0x0f);
        }
      }
      updateStreamTypesFromPsi(packet, info, state);
      const streamKind = state.pidTypes.get(info.pid) || 'unknown';
      if (info.adaptationOffset >= 0) rewritePcrIfPresent(packet, info.adaptationOffset, state.segmentOffset90k);
      if (info.payloadStart && info.payloadOffset >= 0) {
        const ptsBefore = readPesTimestampAt(packet, info.payloadOffset, 'pts');
        if (Number.isFinite(ptsBefore)) {
          rewritePesTimestamps(packet, info.payloadOffset, state.segmentOffset90k);
          const rebased = (ptsBefore + state.segmentOffset90k) % 8589934592;
          state.globalMaxPts = state.globalMaxPts == null ? rebased : Math.max(state.globalMaxPts, rebased);
          if (streamKind === 'audio') state.audioTimestampCount += 1;
          else if (streamKind === 'video') state.videoTimestampCount += 1;
        }
      }
    });
    return out;
  }

  function forEachTsPacket(bytes, callback) {
    for (let offset = 0; offset + 188 <= bytes.byteLength; offset += 188) {
      if (bytes[offset] !== 0x47) continue;
      callback(bytes, offset);
    }
  }

  function readTsPacket(packet, offset) {
    if (packet[offset] !== 0x47) return { valid: false };
    const pid = ((packet[offset + 1] & 0x1f) << 8) | packet[offset + 2];
    const payloadStart = Boolean(packet[offset + 1] & 0x40);
    const adaptationControl = (packet[offset + 3] >> 4) & 0x03;
    let cursor = offset + 4;
    let adaptationOffset = -1;
    if (adaptationControl === 2 || adaptationControl === 3) {
      adaptationOffset = cursor;
      cursor += 1 + packet[cursor];
    }
    const hasPayload = adaptationControl === 1 || adaptationControl === 3;
    return { valid: true, pid, payloadStart, payloadOffset: hasPayload && cursor < offset + 188 ? cursor : -1, adaptationOffset };
  }

  function updateStreamTypesFromPsi(packet, info, state) {
    if (!info.payloadStart || info.payloadOffset < 0) return;
    if (info.pid === 0) {
      const pointer = packet[info.payloadOffset] || 0;
      const table = info.payloadOffset + 1 + pointer;
      if (packet[table] !== 0x00) return;
      const sectionLength = ((packet[table + 1] & 0x0f) << 8) | packet[table + 2];
      for (let cursor = table + 8; cursor + 4 < table + 3 + sectionLength - 4; cursor += 4) {
        const programNumber = (packet[cursor] << 8) | packet[cursor + 1];
        if (programNumber) state.pmtPid = ((packet[cursor + 2] & 0x1f) << 8) | packet[cursor + 3];
      }
      return;
    }
    if (info.pid !== state.pmtPid) return;
    const pointer = packet[info.payloadOffset] || 0;
    const table = info.payloadOffset + 1 + pointer;
    if (packet[table] !== 0x02) return;
    const sectionLength = ((packet[table + 1] & 0x0f) << 8) | packet[table + 2];
    const programInfoLength = ((packet[table + 10] & 0x0f) << 8) | packet[table + 11];
    let cursor = table + 12 + programInfoLength;
    const end = table + 3 + sectionLength - 4;
    while (cursor + 5 <= end) {
      const streamType = packet[cursor];
      const elementaryPid = ((packet[cursor + 1] & 0x1f) << 8) | packet[cursor + 2];
      const esInfoLength = ((packet[cursor + 3] & 0x0f) << 8) | packet[cursor + 4];
      if (streamType === 0x1b || streamType === 0x24 || streamType === 0x02) state.pidTypes.set(elementaryPid, 'video');
      if (streamType === 0x0f || streamType === 0x11 || streamType === 0x03 || streamType === 0x04) state.pidTypes.set(elementaryPid, 'audio');
      cursor += 5 + esInfoLength;
    }
  }

  function rewritePcrIfPresent(packet, adaptationOffset, offset90k) {
    const length = packet[adaptationOffset];
    if (length < 7) return;
    const flags = packet[adaptationOffset + 1];
    if (!(flags & 0x10)) return;
    const pcrOffset = adaptationOffset + 2;
    const base = (BigInt(packet[pcrOffset]) << 25n) | (BigInt(packet[pcrOffset + 1]) << 17n) | (BigInt(packet[pcrOffset + 2]) << 9n) | (BigInt(packet[pcrOffset + 3]) << 1n) | (BigInt(packet[pcrOffset + 4]) >> 7n);
    const next = (base + BigInt(Math.max(0, Math.round(offset90k)))) % 8589934592n;
    packet[pcrOffset] = Number((next >> 25n) & 0xffn);
    packet[pcrOffset + 1] = Number((next >> 17n) & 0xffn);
    packet[pcrOffset + 2] = Number((next >> 9n) & 0xffn);
    packet[pcrOffset + 3] = Number((next >> 1n) & 0xffn);
    packet[pcrOffset + 4] = (packet[pcrOffset + 4] & 0x7e) | Number((next & 0x01n) << 7n);
  }

  function readPesTimestampAt(packet, payloadOffset, which) {
    if (packet[payloadOffset] !== 0 || packet[payloadOffset + 1] !== 0 || packet[payloadOffset + 2] !== 1) return NaN;
    const flags = packet[payloadOffset + 7] || 0;
    const hasPts = (flags & 0x80) !== 0;
    const hasDts = (flags & 0x40) !== 0;
    const ptsOffset = payloadOffset + 9;
    if (which === 'dts') {
      if (!hasPts || !hasDts) return NaN;
      return readPesTimestamp(packet, ptsOffset + 5);
    }
    if (!hasPts) return NaN;
    return readPesTimestamp(packet, ptsOffset);
  }

  function rewritePesTimestamps(packet, payloadOffset, offset90k) {
    if (packet[payloadOffset] !== 0 || packet[payloadOffset + 1] !== 0 || packet[payloadOffset + 2] !== 1) return;
    const flags = packet[payloadOffset + 7] || 0;
    const hasPts = (flags & 0x80) !== 0;
    const hasDts = (flags & 0x40) !== 0;
    const ptsOffset = payloadOffset + 9;
    if (hasPts) writePesTimestamp(packet, ptsOffset, readPesTimestamp(packet, ptsOffset) + offset90k);
    if (hasPts && hasDts) writePesTimestamp(packet, ptsOffset + 5, readPesTimestamp(packet, ptsOffset + 5) + offset90k);
  }

  function readPesTimestamp(packet, offset) {
    return (((packet[offset] & 0x0e) * 536870912) + (packet[offset + 1] << 22) + ((packet[offset + 2] & 0xfe) << 14) + (packet[offset + 3] << 7) + ((packet[offset + 4] & 0xfe) >> 1));
  }

  function writePesTimestamp(packet, offset, value) {
    const next = ((Math.round(value) % 8589934592) + 8589934592) % 8589934592;
    const prefix = packet[offset] & 0xf0;
    packet[offset] = prefix | ((((Math.floor(next / 1073741824) & 0x07) << 1) & 0x0e) | 1);
    packet[offset + 1] = Math.floor(next / 4194304) & 0xff;
    packet[offset + 2] = (((Math.floor(next / 16384) & 0x7f) << 1) | 1) & 0xff;
    packet[offset + 3] = Math.floor(next / 128) & 0xff;
    packet[offset + 4] = (((Math.floor(next % 128) & 0x7f) << 1) | 1) & 0xff;
  }

  function reportProgress(message, progress) {
    if (!message?.taskId) return;
    const payload = {
      type: MESSAGE_TYPES.DOWNLOAD_PROGRESS,
      taskId: message.taskId,
      mediaId: message.mediaId || '',
      phase: progress.phase || 'working',
      loaded: progress.loaded ?? null,
      total: progress.total ?? null,
      percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
      detail: String(progress.detail || ''),
      bytes: progress.bytes ?? null,
      workers: progress.workers ?? null,
      lastSegmentIndex: progress.lastSegmentIndex ?? null,
      workerIndex: progress.workerIndex ?? null,
      activeWorkers: progress.activeWorkers ?? null,
      retries: progress.retries ?? null,
      averageBytesPerSecond: progress.averageBytesPerSecond ?? null,
      peakConcurrency: progress.peakConcurrency ?? null,
      updatedAt: new Date().toISOString()
    };
    chrome.runtime.sendMessage(payload).catch(() => undefined);
  }


  function cancelActiveHlsTask(message = {}) {
    const taskId = String(message.taskId || '');
    const task = activeHlsTasks.get(taskId);
    if (!task) return { ok: true, canceled: false, reason: 'No active HLS task matched this id.' };
    try { task.controller?.abort?.('user-canceled'); } catch (_error) {}
    for (const objectUrl of task.objectUrls || []) {
      try { URL.revokeObjectURL(objectUrl); } catch (_error) {}
    }
    return { ok: true, canceled: true };
  }

  function cleanupHlsTask(taskId, { revokeObjectUrls = true } = {}) {
    const task = activeHlsTasks.get(String(taskId || ''));
    if (!task) return;
    if (revokeObjectUrls) {
      for (const objectUrl of task.objectUrls || []) {
        try { URL.revokeObjectURL(objectUrl); } catch (_error) {}
      }
    }
    activeHlsTasks.delete(String(taskId || ''));
  }

  function assertNotCanceled(signal) {
    if (!signal?.aborted) return;
    throw structured(ERROR_CATEGORIES.USER_CANCELED || 'user-canceled', 'hls-download-canceled', 'HLS download was canceled by the user.');
  }

  function protectedPlaylistUriReason(playlist = {}, playlistUrl = '') {
    const candidates = [
      { url: playlistUrl, kind: 'playlist' },
      ...(playlist.variants || []).map((variant) => ({ url: variant.url, kind: 'variant-playlist' })),
      ...(playlist.segments || []).map((segment) => ({ url: segment.url, kind: 'segment' })),
      ...(playlist.audioRenditions || []).filter((rendition) => rendition.uri).map((rendition) => ({ url: rendition.uri, kind: 'audio-rendition' }))
    ];
    for (const candidate of candidates) {
      const reason = protectedHlsUriReason(candidate.url, candidate.kind);
      if (reason) return reason;
    }
    return null;
  }

  function protectedHlsUriReason(rawUrl = '', kind = 'hls-uri') {
    if (!looksSignedOrExpiringUrl(rawUrl)) return null;
    return {
      code: 'hls-signed-or-expiring-component',
      message: `This HLS ${kind} URL appears signed, expiring, or tokenized. Media Scout will not reuse protected HLS component URLs.`,
      details: { kind, urlHost: safeHostname(rawUrl), queryParameterCount: safeQueryParameterCount(rawUrl) }
    };
  }

  function looksSignedOrExpiringUrl(rawUrl = '') {
    try {
      const url = new URL(String(rawUrl || ''), location.href);
      const keys = Array.from(url.searchParams.keys()).map((key) => key.toLowerCase());
      return keys.some((key) => PROTECTED_QUERY_HINTS.some((hint) => key === hint || key.includes(hint)));
    } catch (_error) {
      return false;
    }
  }

  function safeQueryParameterCount(rawUrl = '') {
    try {
      return Math.min(100, Array.from(new URL(String(rawUrl || ''), location.href).searchParams.keys()).length);
    } catch (_error) {
      return 0;
    }
  }

  function estimatePlaylistSizeRisk(playlist = {}) {
    const durationSeconds = Number(playlist.durationSeconds) || 0;
    const bandwidth = Number(playlist.selectedBandwidth) || 0;
    if (!durationSeconds || !bandwidth) return null;
    const estimatedBytes = Math.ceil((durationSeconds * bandwidth) / 8);
    if (estimatedBytes <= MAX_HLS_ESTIMATED_BYTES) return null;
    return {
      code: 'hls-estimated-too-large',
      message: `This HLS stream is estimated at ${formatBytes(estimatedBytes)}, above the safer in-browser merge limit of ${formatBytes(MAX_HLS_ESTIMATED_BYTES)}. Try a shorter or lower-bitrate variant.`,
      details: { estimatedBytes, maxEstimatedBytes: MAX_HLS_ESTIMATED_BYTES, durationSeconds, bandwidth }
    };
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
    if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))} MiB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
    return `${value} bytes`;
  }


  async function fetchWithNormalPageRules(url, label, options = {}) {
    let response;
    try {
      response = await fetch(url, {
        credentials: 'same-origin',
        cache: options.cache || 'default',
        redirect: 'follow',
        referrerPolicy: 'strict-origin-when-cross-origin',
        signal: options.signal
      });
    } catch (error) {
      const message = error?.message || String(error);
      const aborted = error?.name === 'AbortError' || /abort|timeout/i.test(message);
      const userCanceled = options.signal?.aborted && /user-canceled|abort/i.test(String(options.signal.reason || message));
      throw structured(
        userCanceled ? (ERROR_CATEGORIES.USER_CANCELED || 'user-canceled') : (aborted ? ERROR_CATEGORIES.NETWORK : ERROR_CATEGORIES.CORS),
        userCanceled ? 'hls-download-canceled' : (aborted ? 'segment-fetch-timeout' : 'normal-fetch-blocked'),
        userCanceled
          ? 'HLS download was canceled by the user.'
          : aborted
          ? `Timed out fetching ${label}. The request was stopped so the rest of the browser stays responsive.`
          : `Could not fetch ${label} with normal page fetch rules. This is usually CORS, network blocking, or an access-control boundary.`,
        { rawError: message, urlHost: safeHostname(url) }
      );
    }
    if (!response.ok) {
      throw structured(classifyHttpStatus(response.status), 'http-fetch-failed', `Could not fetch ${label}: HTTP ${response.status}.`, { status: response.status, urlHost: safeHostname(url) });
    }
    return response;
  }

  function parseHlsPlaylist(text, baseUrl) {
    const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const keyLines = [];
    let encrypted = false;
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-KEY') && !line.startsWith('#EXT-X-SESSION-KEY')) continue;
      if (keyLines.length < 3) keyLines.push(line);
      if (!/METHOD\s*=\s*NONE/i.test(line)) encrypted = true;
    }
    const playlistTypeLine = lines.find((line) => line.startsWith('#EXT-X-PLAYLIST-TYPE:')) || '';
    const playlistType = playlistTypeLine.split(':')[1]?.trim().toLowerCase() || '';
    const variants = [];
    const segments = [];
    let variantCount = 0;
    let segmentCount = 0;
    let durationSeconds = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.startsWith('#EXTINF')) {
        const match = /^#EXTINF:([0-9.]+)/i.exec(line);
        if (match) durationSeconds += Number(match[1]) || 0;
        continue;
      }
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const next = nextUriLine(lines, index + 1);
        if (next) {
          variantCount += 1;
          if (variants.length < MAX_HLS_VARIANTS) {
            variants.push({
              url: new URL(next.value, baseUrl).toString(),
              bandwidth: readNumberAttr(line, 'BANDWIDTH'),
              resolution: readStringAttr(line, 'RESOLUTION'),
              audioGroupId: readStringAttr(line, 'AUDIO'),
              codecs: readStringAttr(line, 'CODECS')
            });
          }
        }
        continue;
      }
      if (!line.startsWith('#')) {
        const segmentUrl = new URL(line, baseUrl).toString();
        if (!/\.m3u8(?:[?#]|$)/i.test(new URL(segmentUrl).pathname)) {
          segmentCount += 1;
          if (segments.length < MAX_HLS_SEGMENTS) segments.push({ url: segmentUrl });
        }
      }
    }
    const discontinuityCount = lines.reduce((count, line) => count + (line === '#EXT-X-DISCONTINUITY' ? 1 : 0), 0);
    const audioRenditionResult = parseHlsAudioRenditions(lines, baseUrl);
    return {
      encrypted,
      keyMarkers: keyLines,
      variants,
      variantCount,
      tooManyVariants: variantCount > MAX_HLS_VARIANTS,
      audioRenditions: audioRenditionResult.renditions,
      audioRenditionCount: audioRenditionResult.count,
      tooManyAudioRenditions: audioRenditionResult.count > MAX_HLS_AUDIO_RENDITIONS,
      segments,
      segmentCount,
      tooManySegments: segmentCount > MAX_HLS_SEGMENTS,
      durationSeconds,
      discontinuityCount,
      hasDiscontinuity: discontinuityCount > 0,
      discontinuitySequence: lines.find((line) => line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) || '',
      hasMap: lines.some((line) => line.startsWith('#EXT-X-MAP')),
      hasFmp4Segments: segments.some((segment) => /\.(m4s|mp4|m4v|cmfv|cmfa)(?:[?#]|$)/i.test(new URL(segment.url).pathname)),
      hasByteRange: lines.some((line) => line.startsWith('#EXT-X-BYTERANGE')),
      hasPartialSegments: lines.some((line) => line.startsWith('#EXT-X-PART')),
      hasPreloadHint: lines.some((line) => line.startsWith('#EXT-X-PRELOAD-HINT')),
      iframeOnly: lines.some((line) => line.startsWith('#EXT-X-I-FRAMES-ONLY')),
      hasEndList: lines.some((line) => line.startsWith('#EXT-X-ENDLIST')),
      playlistType
    };
  }


  function summarizePlaylistProbe(playlist, url) {
    return {
      urlHost: safeHostname(url),
      segmentCount: playlist.segmentCount ?? playlist.segments?.length ?? 0,
      durationSeconds: playlist.durationSeconds || 0,
      variantCount: playlist.variantCount ?? playlist.variants?.length ?? 0,
      audioRenditionCount: playlist.audioRenditionCount ?? playlist.audioRenditions?.length ?? 0,
      hasSeparateAudio: playlistHasSeparateAudioRequirement(playlist),
      hasDiscontinuity: Boolean(playlist.hasDiscontinuity),
      discontinuityCount: playlist.discontinuityCount || 0,
      hasMap: Boolean(playlist.hasMap),
      hasFmp4Segments: Boolean(playlist.hasFmp4Segments),
      hasByteRange: Boolean(playlist.hasByteRange),
      hasPartialSegments: Boolean(playlist.hasPartialSegments),
      hasPreloadHint: Boolean(playlist.hasPreloadHint),
      iframeOnly: Boolean(playlist.iframeOnly),
      hasEndList: Boolean(playlist.hasEndList),
      playlistType: playlist.playlistType || ''
    };
  }

  function parseHlsAudioRenditions(lines, baseUrl) {
    const renditions = [];
    let count = 0;
    for (const line of lines) {
      if (!line.startsWith('#EXT-X-MEDIA') || !/TYPE=AUDIO/i.test(line)) continue;
      count += 1;
      if (renditions.length >= MAX_HLS_AUDIO_RENDITIONS) continue;
      const uri = readStringAttr(line, 'URI');
      renditions.push({
        groupId: readStringAttr(line, 'GROUP-ID'),
        name: readStringAttr(line, 'NAME'),
        language: readStringAttr(line, 'LANGUAGE'),
        isDefault: /DEFAULT=YES/i.test(line),
        autoselect: /AUTOSELECT=YES/i.test(line),
        uri: uri ? new URL(uri, baseUrl).toString() : ''
      });
    }
    return { renditions, count };
  }

  function getPlaylistStructureLimitReason(playlist = {}) {
    if (playlist.tooManyVariants) {
      return { code: 'hls-too-many-variants', message: `This master playlist exposes more than ${MAX_HLS_VARIANTS} variants, above the safe in-page inspection limit.`, details: { maxVariants: MAX_HLS_VARIANTS } };
    }
    if (playlist.tooManyAudioRenditions) {
      return { code: 'hls-too-many-audio-renditions', message: `This playlist exposes more than ${MAX_HLS_AUDIO_RENDITIONS} audio renditions, above the safe in-page inspection limit.`, details: { maxAudioRenditions: MAX_HLS_AUDIO_RENDITIONS } };
    }
    if (playlist.tooManySegments) {
      return { code: 'hls-too-many-segments', message: `This playlist has more than ${MAX_HLS_SEGMENTS} segments, above the safe in-browser merge limit.`, details: { maxSegments: MAX_HLS_SEGMENTS } };
    }
    return null;
  }

  function getUnsupportedPlaylistReason(playlist) {
    if (playlist.variants.length && !playlist.segments.length) {
      return { code: 'hls-master-without-media', message: 'This HLS master playlist did not expose a mergeable media playlist.' };
    }
    if (!playlist.segments.length) {
      return { code: 'hls-no-segments', message: 'No media segments were found in the HLS playlist.' };
    }
    const structureLimit = getPlaylistStructureLimitReason(playlist);
    if (structureLimit) return structureLimit;
    if (playlist.hasMap || playlist.hasFmp4Segments) {
      return { code: 'hls-fmp4-map-unsupported', message: 'This HLS playlist uses fMP4/CMAF init maps or fMP4-like segment files. Media Scout only concatenates MPEG-TS-style HLS segments.' };
    }
    if (playlist.hasByteRange) {
      return { code: 'hls-byte-range-unsupported', message: 'This HLS playlist uses byte-range addressing, which is not supported by the simple safe merger.' };
    }
    if (playlist.iframeOnly) {
      return { code: 'hls-iframe-only-unsupported', message: 'I-frame-only HLS playlists are not mergeable as normal video.' };
    }
    if (playlist.hasPartialSegments || playlist.hasPreloadHint) {
      return { code: 'low-latency-hls-unsupported', message: 'Low-latency HLS partial/preload segments are not supported by the finite-file merger.' };
    }
    if (playlist.hasEndList === false && String(playlist.playlistType || '').toLowerCase() !== 'vod') {
      return { code: 'live-hls-unsupported', message: 'This HLS playlist has no EXT-X-ENDLIST marker and is not explicitly marked VOD, so it is treated as live/event media rather than a finite downloadable file.' };
    }
    if (playlistHasSeparateAudioRequirement(playlist)) {
      return { code: 'hls-separate-audio-unsupported', message: 'This HLS playlist uses separate audio renditions. The built-in merger does not align separate audio/video yet.' };
    }
    const fmp4Like = playlist.segments.find((segment) => /\.(m4s|mp4|m4v|cmfv|cmfa)(?:[?#]|$)/i.test(new URL(segment.url).pathname));
    if (fmp4Like) {
      return { code: 'hls-fmp4-segments-unsupported', message: 'This HLS playlist appears to use fMP4 segments. Media Scout only merges MPEG-TS-style HLS segments.', details: { segmentHost: safeHostname(fmp4Like.url) } };
    }
    return null;
  }

  function normalizeVariantPreference(value) {
    return value === 'lowest' ? 'lowest' : 'highest';
  }

  function chooseVariant(variants, preference = 'highest') {
    const usable = [...variants].filter((variant) => variant?.url);
    const selfContained = usable.filter(isLikelySelfContainedHlsVariant);
    const pool = selfContained.length ? selfContained : usable;
    const sorted = pool.sort((a, b) => (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0));
    if (!sorted.length) return variants[0];
    return normalizeVariantPreference(preference) === 'lowest' ? sorted[sorted.length - 1] : sorted[0];
  }

  function playlistHasSeparateAudioRequirement(playlist = {}) {
    const audioRenditions = Array.isArray(playlist.audioRenditions) ? playlist.audioRenditions : [];
    const variants = Array.isArray(playlist.variants) ? playlist.variants : [];
    return Boolean(playlist.audioRenditionCount || audioRenditions.length || variants.some((variant) => variant?.audioGroupId));
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

  function nextUriLine(lines, startIndex) {
    for (let index = startIndex; index < lines.length; index += 1) {
      const value = lines[index];
      if (!value || value.startsWith('#')) continue;
      return { value, index };
    }
    return null;
  }

  function readNumberAttr(line, name) {
    const match = new RegExp(`${name}=([0-9]+)`, 'i').exec(line);
    return match ? Number(match[1]) : undefined;
  }

  function readStringAttr(line, name) {
    const match = new RegExp(`${name}=(?:"([^"]*)"|([^,]*))`, 'i').exec(line);
    return match ? (match[1] ?? match[2] ?? '').trim() : '';
  }

  function normalizeHttpUrl(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ''), location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      url.hash = '';
      return url.toString();
    } catch (_error) {
      return '';
    }
  }

  function triggerBrowserDownload(url, filename) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.documentElement.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function ensureExtension(filename, extension) {
    const clean = String(extension || 'ts').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'ts';
    return /\.[a-z0-9]{2,5}$/i.test(filename) ? filename.replace(/\.[^.]+$/, `.${clean}`) : `${filename}.${clean}`;
  }

  function fail(category, code, error, details = undefined) {
    return { ok: false, category, code, error, details };
  }

  function structured(category, code, message, details = undefined) {
    const error = new Error(message);
    error.category = category;
    error.code = code;
    error.details = details;
    return error;
  }

  function normalizeFetchError(error) {
    if (error?.category) return fail(error.category, error.code || 'hls-merge-failed', error.message || 'HLS merge failed.', error.details);
    return fail(ERROR_CATEGORIES.UNKNOWN, 'hls-merge-failed', error?.message || 'HLS merge failed.');
  }

  function classifyHttpStatus(status) {
    if (status === 401) return ERROR_CATEGORIES.AUTHENTICATION;
    if (status === 402) return ERROR_CATEGORIES.PAYWALL;
    if (status === 403) return ERROR_CATEGORIES.PERMISSION;
    if (status === 404 || status === 410) return ERROR_CATEGORIES.NETWORK;
    if (status >= 400 && status < 500) return ERROR_CATEGORIES.ACCESS_CONTROL;
    return ERROR_CATEGORIES.NETWORK;
  }

  function safeHostname(rawUrl) {
    try {
      return new URL(rawUrl).hostname;
    } catch (_error) {
      return '';
    }
  }

  mutationObserver = new MutationObserver(debouncedScan);
  mutationObserver.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'srcset', 'poster', 'data-src', 'data-url', 'data-play', 'data-video', 'data-audio', 'data-media', 'data-stream', 'data-file', 'data-original']
  });

  // HLS/MSE players often fetch playlists and segments without changing the
  // visible DOM. Watching Resource Timing lets detection wake up when a late
  // .m3u8/.mpd/.ts/.m4s resource appears after the popup was opened or after
  // playback starts. It is read-only and still subject to normal browser limits.
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      resourceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() || []) {
          const name = String(entry?.name || '').toLowerCase();
          if (/\.(m3u8|mpd|mp4|m4v|mov|webm|ts|m2ts|m4s|mp3|m4a|aac|wav|ogg|opus|flac|vtt|srt)(?:[?#]|$)/i.test(name) || /(video|audio|media|playlist|manifest|hls|dash|m3u8|mpd)/i.test(name)) {
            debouncedScan();
            break;
          }
        }
      });
      resourceObserver.observe({ type: 'resource', buffered: true });
    } catch (_error) {
      // PerformanceObserver can be unavailable or restricted; manual scans and
      // MutationObserver still work.
    }
  }

  window.addEventListener('load', handleWindowLoad, { once: true });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handleDomContentLoaded, { once: true });
  else debouncedScan();
})();
