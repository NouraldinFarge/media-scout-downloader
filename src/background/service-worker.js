import { HLS_OUTPUT_METHODS, MEDIA_TYPES, MESSAGE_TYPES } from '../shared/constants.js';
import { setDebugLogging, warn } from '../shared/logger.js';
import { getQueueHistory, getSettings, saveSettings } from '../shared/storage-utils.js';
import { getActiveTab } from '../shared/utils.js';
import { isContentScriptMessageType, isPrivilegedExtensionMessageType, validateMessage } from '../shared/validators.js';
import { runSelfTests } from '../shared/self-tests.js';
import { buildReportContext, redactReportValue, reportContextsMatch, reportPreviewToken } from '../shared/report-privacy.js';
import { DiagnosticsManager } from './diagnostics-manager.js';
import { DownloadManager } from './download-manager.js';
import { MediaDetector } from './media-detector.js';
import { ReportManager } from './report-manager.js';
import { TabMediaStore } from './tab-media-store.js';

const MAX_AGGREGATED_SCAN_ITEMS = 2000;
const MAX_REPORT_LIST_ITEMS = 600;
const tabMediaStore = new TabMediaStore();
const diagnostics = new DiagnosticsManager();
const broadcast = (message) => chrome.runtime.sendMessage(message).catch?.(() => undefined);
const downloadManager = new DownloadManager({ tabMediaStore, diagnostics, broadcast });
const detector = new MediaDetector({ tabMediaStore, diagnostics, getSettings });
const reportManager = new ReportManager({ getSettings, diagnostics, downloadManager });
const followupScanTimers = new Map();
let initializationError = null;

async function initialize() {
  const settings = await getSettings();
  setDebugLogging(settings.debugLogs);
  await diagnostics.load();
  await downloadManager.initialize();
  await detector.start();
}

const initializationPromise = initialize().catch((error) => {
  initializationError = error;
  warn('Initialization failed', error?.message || error);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const hadMedia = tabMediaStore.getTabState(tabId).mediaItems.length > 0;
  const wasScoped = detector.isScopedTab(tabId);
  cancelFollowupScans(tabId);
  const canceledCount = downloadManager.cancelTasksForTab(tabId, 'The source tab was closed before the download finished.');
  detector.unScopeTab(tabId);
  tabMediaStore.clearTab(tabId);
  if (hadMedia || wasScoped || canceledCount) {
    broadcast({
      type: MESSAGE_TYPES.ACTIVE_TAB_STATE,
      tabId,
      mediaItems: [],
      queue: downloadManager.getState(),
      navigationReset: true,
      scan: {
        ok: false,
        message: 'The source tab was closed. Media Scout cleared its stale detections and stopped source-dependent downloads.'
      }
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo?.url) return;
  handleTabNavigation(tabId, changeInfo.url);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!validateMessage(message)) {
    sendResponse({ ok: false, error: 'Invalid message.' });
    return false;
  }
  if (!isAllowedMessageSource(message, sender)) {
    sendResponse({ ok: false, error: 'Message source is not allowed for this action.' });
    return false;
  }
  handleMessageAfterInitialization(message, sender).then(
    (response) => sendResponse({ ok: true, ...response }),
    (error) => sendResponse(publicErrorResponse(error))
  );
  return true;
});

function publicErrorResponse(error) {
  return {
    ok: false,
    error: redactReportValue(error?.message || 'Request failed.', 'message'),
    details: {
      name: publicErrorField(error?.name || 'Error', 'name', 80),
      code: publicErrorField(error?.code || '', 'code', 96),
      category: publicErrorField(error?.category || '', 'category', 64)
    }
  };
}

function publicErrorField(value, key, maxLength) {
  return String(redactReportValue(String(value || ''), key)).slice(0, maxLength);
}

async function handleMessageAfterInitialization(message, sender) {
  await initializationPromise;
  if (initializationError) throw new Error('Media Scout could not initialize its local state. Reload the extension and try again.');
  return handleMessage(message, sender);
}

function isAllowedMessageSource(message, sender = {}) {
  if (isContentScriptMessageType(message?.type)) return isContentScriptSender(sender);
  if (isPrivilegedExtensionMessageType(message?.type)) return isExtensionPageSender(sender);
  return false;
}

function isContentScriptSender(sender = {}) {
  return sender?.id === chrome.runtime.id && Number.isInteger(sender?.tab?.id) && !isExtensionUrl(sender?.url || '');
}

function isExtensionPageSender(sender = {}) {
  // Extension pages can run as action popups, options pages, side panels, or
  // normal extension tabs used as a fallback. Chrome includes sender.tab for
  // extension pages opened as tabs, so do not reject them solely because a tab
  // exists. Content scripts still fail this check because their sender.url is
  // the page URL, not the chrome-extension:// origin.
  return sender?.id === chrome.runtime.id && isExtensionUrl(sender?.url || '');
}

function isExtensionUrl(rawUrl = '') {
  try {
    return new URL(rawUrl).origin === new URL(chrome.runtime.getURL('')).origin;
  } catch (_error) {
    return false;
  }
}

function handleTabNavigation(tabId, newUrl = '') {
  if (!Number.isInteger(tabId)) return;
  const previousTab = tabMediaStore.getTabState(tabId).tab || {};
  if (isSameDocumentNavigation(previousTab.url, newUrl)) {
    tabMediaStore.setTabInfo({ id: tabId, title: previousTab.title, url: newUrl });
    return;
  }
  cancelFollowupScans(tabId);
  downloadManager.resetTabDownloadCounter(tabId);
  const wasScoped = detector.isScopedTab(tabId);
  detector.unScopeTab(tabId);
  tabMediaStore.clearTab(tabId);
  const canceledCount = downloadManager.cancelPageContextTasksForTab(
    tabId,
    'The source tab navigated before this page-context download finished. Rescan the new page before downloading.'
  );
  if (wasScoped || canceledCount) {
    broadcast({
      type: MESSAGE_TYPES.ACTIVE_TAB_STATE,
      tabId,
      mediaItems: [],
      queue: downloadManager.getState(),
      navigationReset: true,
      scan: {
        ok: false,
        message: 'This tab navigated to a new page. Media Scout cleared stale detections and stopped page-context downloads; scan again to inspect the new page.',
        navigatedUrl: safeNavigationDisplayUrl(newUrl)
      }
    });
  }
}

function isSameDocumentNavigation(previousUrl = '', nextUrl = '') {
  if (!previousUrl || !nextUrl) return false;
  try {
    const previous = new URL(previousUrl);
    const next = new URL(nextUrl);
    previous.hash = '';
    next.hash = '';
    return previous.toString() === next.toString();
  } catch (_error) {
    return false;
  }
}

function safeNavigationDisplayUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`.slice(0, 240);
  } catch (_error) {
    return '';
  }
}

async function handleMessage(message, sender) {
  switch (message.type) {
    case MESSAGE_TYPES.GET_ACTIVE_TAB_STATE:
      return getActiveTabState(message);
    case MESSAGE_TYPES.HARD_RESCAN_ACTIVE_TAB:
      return hardRescanActiveTab(message);
    case MESSAGE_TYPES.RELOAD_EXTENSION_AND_REFRESH_PAGE:
      return reloadExtensionAndRefreshPage(message);
    case MESSAGE_TYPES.DISCOVER_EPISODE_BATCH:
      return discoverEpisodeBatch(message);
    case MESSAGE_TYPES.START_EPISODE_BATCH_DOWNLOADS:
      return startEpisodeBatchDownloads(message);
    case MESSAGE_TYPES.DOM_MEDIA_FOUND:
      return handleDomMediaFound(message, sender);
    case MESSAGE_TYPES.START_DOWNLOAD:
      return startDownload(message);
    case MESSAGE_TYPES.CONVERT_M3U8_TO_MP4:
      return convertM3u8ToMp4(message);
    case MESSAGE_TYPES.RETRY_DOWNLOAD:
      return { task: downloadManager.retry(message.taskId), queue: downloadManager.getState() };
    case MESSAGE_TYPES.DOWNLOAD_PROGRESS:
      return updateDownloadProgress(message, sender);
    case MESSAGE_TYPES.CANCEL_DOWNLOAD:
      return { canceled: downloadManager.cancel(message.taskId), queue: downloadManager.getState() };
    case MESSAGE_TYPES.SETTINGS_GET:
      return { settings: await getSettings(), diagnostics: diagnostics.snapshot() };
    case MESSAGE_TYPES.SETTINGS_SAVE:
      return saveSettingsFromMessage(message);
    case MESSAGE_TYPES.CLEAR_DETECTED_CACHE:
      cancelAllFollowupScans();
      detector.unScopeAll();
      tabMediaStore.clearAll();
      broadcast({ type: MESSAGE_TYPES.ACTIVE_TAB_STATE, cacheCleared: true, mediaItems: [] });
      return { cleared: true };
    case MESSAGE_TYPES.CLEAR_QUEUE_HISTORY:
      return downloadManager.clearPersistedQueueHistory();
    case MESSAGE_TYPES.CLEAR_SETTLED_QUEUE:
      return { cleared: downloadManager.clearSettledQueue(), queue: downloadManager.getState() };
    case MESSAGE_TYPES.PAUSE_QUEUE:
      return { paused: downloadManager.pauseQueue(), queue: downloadManager.getState() };
    case MESSAGE_TYPES.RESUME_QUEUE:
      return { paused: downloadManager.resumeQueue(), queue: downloadManager.getState() };
    case MESSAGE_TYPES.RESET_DIAGNOSTICS:
      return { diagnostics: await diagnostics.reset() };
    case MESSAGE_TYPES.REQUEST_SITE_ACCESS:
      return requestSiteAccess(message.origin, message);
    case MESSAGE_TYPES.REQUEST_ALL_SITE_ACCESS:
      return requestAllSiteAccess();
    case MESSAGE_TYPES.REVOKE_ALL_SITE_ACCESS:
      return revokeAllSiteAccess();
    case MESSAGE_TYPES.RUN_SELF_TESTS:
      return { selfTests: runSelfTests() };
    case MESSAGE_TYPES.GENERATE_REPORT:
      return generateReport(message);
    case MESSAGE_TYPES.VALIDATE_REPORT_PREVIEW:
      return validateReportPreview(message);
    default:
      return { ok: false, error: 'Unsupported message type.' };
  }
}

async function getActiveTabState(message = {}) {
  const tab = await getTargetTab(message);
  if (!Number.isInteger(tab?.id)) return { tab: null, mediaItems: [], queue: downloadManager.getState(), settings: await getSettings(), scan: { ok: false, message: 'No active tab was available.' } };
  detector.scopeTab(tab.id);
  tabMediaStore.setTabInfo(tab);
  if (message.clearFirst) tabMediaStore.clearTab(tab.id);
  tabMediaStore.setTabInfo(tab);
  const injection = await ensureScanner(tab.id, { force: Boolean(message.forceInject) });
  const scan = await requestPageScan(tab);
  scheduleFollowupScans(tab);
  const siteAccess = await hasOriginPermission(tab.url);
  const episodeBatch = await findEpisodeBatchForTab(tab);
  return {
    ...tabMediaStore.getTabState(tab.id),
    episodeBatch,
    queue: downloadManager.getState(),
    settings: await getSettings(),
    diagnostics: diagnostics.snapshot(),
    siteAccess,
    scan: summarizeScanStatus(injection, scan)
  };
}

async function hardRescanActiveTab(message = {}) {
  const tab = await getTargetTab(message);
  if (!Number.isInteger(tab?.id)) return { tab: null, mediaItems: [], queue: downloadManager.getState(), settings: await getSettings(), scan: { ok: false, message: 'No active tab was available.' } };
  detector.scopeTab(tab.id);
  tabMediaStore.clearTab(tab.id);
  tabMediaStore.setTabInfo(tab);
  const injection = await ensureScanner(tab.id, { force: true });
  const passes = [];
  for (const delay of [0, 450, 1200]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    passes.push(await requestPageScan(tab));
  }
  const combinedScan = combineScanStatuses(passes);
  scheduleFollowupScans(tab);
  const siteAccess = await hasOriginPermission(tab.url);
  const episodeBatch = await findEpisodeBatchForTab(tab);
  return {
    ...tabMediaStore.getTabState(tab.id),
    episodeBatch,
    queue: downloadManager.getState(),
    settings: await getSettings(),
    diagnostics: diagnostics.snapshot(),
    siteAccess,
    scan: summarizeScanStatus(injection, combinedScan)
  };
}

async function reloadExtensionAndRefreshPage(message = {}) {
  const tab = await getTargetTab(message);
  let pageRefresh = 'no-active-tab';
  if (Number.isInteger(tab?.id)) {
    try {
      await chromeCallSafe((done) => chrome.tabs.reload(tab.id, { bypassCache: true }, done));
      pageRefresh = 'requested';
    } catch (error) {
      pageRefresh = `failed: ${error?.message || 'unknown error'}`;
    }
  }

  let updateStatus;
  try {
    updateStatus = await requestRuntimeUpdateCheck();
  } catch (error) {
    updateStatus = `unavailable: ${error?.message || 'unknown error'}`;
  }

  setTimeout(() => {
    try { chrome.runtime.reload(); } catch (error) { warn('Extension reload failed safely', error?.message || error); }
  }, 650);

  return { reloading: true, pageRefresh, updateStatus, incognito: Boolean(tab?.incognito) };
}

function combineScanStatuses(statuses = []) {
  return {
    topFrameOk: statuses.some((item) => item?.topFrameOk),
    allFramesOk: statuses.some((item) => item?.allFramesOk),
    usedFallback: statuses.some((item) => item?.usedFallback),
    usedLegacyFallback: statuses.some((item) => item?.usedLegacyFallback),
    stale: statuses.some((item) => item?.stale),
    itemCount: statuses.reduce((sum, item) => sum + (Number(item?.itemCount) || 0), 0),
    errors: statuses.flatMap((item) => item?.errors || []).slice(0, 6)
  };
}

function chromeCallSafe(fn) {
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

function requestRuntimeUpdateCheck() {
  return new Promise((resolve) => {
    if (!chrome.runtime?.requestUpdateCheck) return resolve('unsupported');
    try {
      chrome.runtime.requestUpdateCheck((status) => {
        const error = chrome.runtime.lastError;
        if (error) return resolve(`unavailable: ${error.message}`);
        resolve(status || 'unknown');
      });
    } catch (error) {
      resolve(`unavailable: ${error?.message || 'unknown error'}`);
    }
  });
}


function scheduleFollowupScans(tab) {
  if (!Number.isInteger(tab?.id)) return;
  cancelFollowupScans(tab.id);
  const timers = new Set();
  followupScanTimers.set(tab.id, timers);
  for (const delay of [900, 2500]) {
    const timer = setTimeout(async () => {
      timers.delete(timer);
      if (timers.inProgress) return;
      timers.inProgress = true;
      try {
        if (followupScanTimers.get(tab.id) !== timers) return;
        const sourceTab = await getTabById(tab.id);
        if (followupScanTimers.get(tab.id) !== timers) return;
        if (!Number.isInteger(sourceTab?.id) || isExtensionUrl(sourceTab.url || '')) return;
        if (tab.url && sourceTab.url && !isSameDocumentNavigation(tab.url, sourceTab.url)) return;
        tabMediaStore.setTabInfo(sourceTab);
        const scan = await requestPageScan(sourceTab);
        if (followupScanTimers.get(tab.id) !== timers) return;
        const state = tabMediaStore.getTabState(sourceTab.id);
        broadcast({
          type: MESSAGE_TYPES.ACTIVE_TAB_STATE,
          tabId: sourceTab.id,
          mediaItems: state.mediaItems,
          replaceMediaItems: true,
          scan: summarizeScanStatus({}, scan)
        });
      } catch (error) {
        warn('Follow-up media scan failed safely', error?.message || error);
      } finally {
        timers.inProgress = false;
        if (!timers.size && followupScanTimers.get(tab.id) === timers) followupScanTimers.delete(tab.id);
      }
    }, delay);
    timers.add(timer);
  }
}

function cancelFollowupScans(tabId) {
  const timers = followupScanTimers.get(tabId);
  if (!timers) return;
  for (const timer of timers) clearTimeout(timer);
  followupScanTimers.delete(tabId);
}

function cancelAllFollowupScans() {
  for (const tabId of Array.from(followupScanTimers.keys())) cancelFollowupScans(tabId);
}

async function handleDomMediaFound(message, sender) {
  const senderTab = sender.tab || await getActiveTab();
  if (!Number.isInteger(senderTab?.id)) return { addedCount: 0 };
  const tab = await getTabById(senderTab.id);
  if (!Number.isInteger(tab?.id)) return { addedCount: 0, stale: true };
  if (senderTab.url && tab.url && !isSameDocumentNavigation(senderTab.url, tab.url)) return { addedCount: 0, stale: true };
  const added = await detector.ingestDomScan(tab, message.items || []);
  broadcast({ type: MESSAGE_TYPES.ACTIVE_TAB_STATE, tabId: tab.id, mediaItems: added });
  return { addedCount: added.length };
}

function updateDownloadProgress(message, sender = {}) {
  const updated = downloadManager.updateProgress(message.taskId, message, sender);
  return { updated, queue: downloadManager.getState() };
}

async function startDownload(message) {
  const sourceTab = await getTabById(message.tabId) || await getActiveTab();
  if (!Number.isInteger(sourceTab?.id) || sourceTab.id !== message.tabId) {
    throw new Error('The source tab is no longer available. Rescan the active tab before starting this download.');
  }
  const task = await downloadManager.enqueue({ tabId: message.tabId, mediaId: message.mediaId, tab: sourceTab, hlsOutputMethod: message.hlsOutputMethod });
  return { task, queue: downloadManager.getState() };
}

async function getTabById(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return await chromeCallSafe((done) => chrome.tabs.get(tabId, done));
  } catch (_error) {
    return null;
  }
}

async function getTargetTab(message = {}) {
  const hasHint = message.sourceTabId != null && message.sourceTabId !== '';
  const hinted = Number(message.sourceTabId);
  if (Number.isInteger(hinted) && hinted >= 0) {
    const tab = await getTabById(hinted);
    if (Number.isInteger(tab?.id) && !isExtensionUrl(tab.url || '')) return tab;
    if (hasHint) return null;
  }
  return getActiveTab();
}

async function convertM3u8ToMp4(message) {
  const tab = await getTargetTab(message);
  if (!Number.isInteger(tab?.id)) throw new Error('Active tab unavailable. Open the page that can normally access this playlist, then try again.');
  detector.scopeTab(tab.id);
  tabMediaStore.setTabInfo(tab);
  await ensureScanner(tab.id);
  const task = await downloadManager.enqueueManualHls({
    tab,
    playlistUrl: message.url,
    preferredName: message.filename || '',
    hlsOutputMethod: message.hlsOutputMethod
  });
  return { task, queue: downloadManager.getState(), ...tabMediaStore.getTabState(tab.id) };
}

async function generateReport(message = {}) {
  const tab = await getTargetTab(message);
  if (!Number.isInteger(tab?.id)) throw new Error('Active tab unavailable.');
  detector.scopeTab(tab.id);
  tabMediaStore.setTabInfo(tab);
  const tabRevision = tabMediaStore.getTabRevision(tab.id);
  await ensureScanner(tab.id);
  const scan = await requestPageScan(tab);
  if (scan.stale || !tabMediaStore.isTabRevisionCurrent(tab.id, tabRevision)) {
    throw new Error('The page changed while the report was being built. Rescan the current page and build the report again.');
  }
  const siteAccess = await hasOriginPermission(tab.url);
  const { report: detailedScan, error: scannerError } = await requestDetailedPageScan(tab.id);
  if (!tabMediaStore.isTabRevisionCurrent(tab.id, tabRevision)) {
    throw new Error('The page changed while the report was being built. Stale report evidence was discarded.');
  }
  const probeAnnotation = tabMediaStore.applyPlaylistProbeFindings(tab.id, detailedScan?.playlistProbes || []);
  if (probeAnnotation?.updated) {
    broadcast({ type: MESSAGE_TYPES.ACTIVE_TAB_STATE, tabId: tab.id, mediaItems: tabMediaStore.getTabState(tab.id).mediaItems, replaceMediaItems: true });
  }
  const tabState = tabMediaStore.getTabState(tab.id);
  const report = await reportManager.buildActiveTabReport({
    tab,
    tabRevision,
    siteAccess,
    tabState,
    detailedScan,
    scannerError,
    selfTests: runSelfTests(),
    includeSensitiveUrls: Boolean(message.includeSensitiveUrls)
  });
  return { report };
}

async function validateReportPreview(message = {}) {
  if (reportPreviewToken(message.context, message.previewDigest, message.generatedAt) !== message.previewToken) {
    return { valid: false, reason: 'The preview integrity marker does not match the reviewed files. Build a new preview.' };
  }
  const tab = await getTargetTab(message);
  if (!Number.isInteger(tab?.id) || tab.id !== message.context?.tabId) {
    return { valid: false, reason: 'The source tab is no longer available. Build a new preview from the current page.' };
  }
  const tabRevision = tabMediaStore.getTabRevision(tab.id);
  if (tabRevision !== message.context?.tabRevision) {
    return { valid: false, reason: 'The source page changed after this preview was built.' };
  }

  const settings = await getSettings();
  const siteAccess = await hasOriginPermission(tab.url);
  const diagnosticsSnapshot = diagnostics.snapshot();
  let persistedQueueHistory = null;
  try { persistedQueueHistory = await getQueueHistory(); } catch (_error) {}
  const { report: detailedScan, error: scannerError } = await requestDetailedPageScan(tab.id);
  if (!tabMediaStore.isTabRevisionCurrent(tab.id, tabRevision)) {
    return { valid: false, reason: 'The source page changed during preview validation.' };
  }
  const normalizedScan = detailedScan || { unavailable: true, error: scannerError || 'Detailed page scan unavailable.' };
  const tabState = {
    ...tabMediaStore.getTabState(tab.id),
    queue: downloadManager.getState()
  };
  const currentContext = buildReportContext({
    tab,
    tabRevision,
    state: tabState,
    settings,
    siteAccess,
    diagnostics: diagnosticsSnapshot,
    detailedScan: normalizedScan,
    persistedQueueHistory,
    includeSensitiveUrls: message.context?.sensitivity === 'sensitive-urls'
  });
  if (!reportContextsMatch(message.context, currentContext)) {
    return { valid: false, reason: 'Report inputs changed after this preview was built. Review a fresh preview before exporting.' };
  }
  return { valid: true };
}

async function saveSettingsFromMessage(message) {
  const previousSettings = await getSettings();
  const settings = await saveSettings(message.settings || {});
  setDebugLogging(settings.debugLogs);
  await downloadManager.updateSettings(settings);
  if (settings.queueHistoryRetentionDays < previousSettings.queueHistoryRetentionDays) await downloadManager.clearPersistedQueueHistory();
  return { settings };
}

async function ensureScanner(tabId, { force = false } = {}) {
  const files = ['src/content/page-media-scanner.js', 'src/content/mp4-remuxer.js', 'src/content/content.js'];
  const status = { topFrameOk: false, allFramesOk: false, errors: [] };

  if (force) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          try { globalThis.__mediaScoutCleanup?.('force-reinject'); } catch (_error) {}
          try { delete globalThis.__mediaScoutContentLoaded; } catch (_error) { globalThis.__mediaScoutContentLoaded = false; }
        }
      });
    } catch (error) {
      warn('Force scanner reset skipped safely', error?.message || error);
    }
  }

  // Inject the top frame first so detection starts even when some iframes are
  // cross-origin or otherwise inaccessible. Older builds tried allFrames first,
  // which could fail the whole startup path on iframe-heavy video pages.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
    status.topFrameOk = true;
  } catch (error) {
    const message = error?.message || 'Top-frame scanner injection failed.';
    status.errors.push(message);
    warn('Top-frame scanner injection failed safely', message);
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
    status.allFramesOk = true;
  } catch (error) {
    const message = error?.message || 'All-frame scanner injection failed.';
    status.errors.push(message);
    warn('All-frame scanner injection failed safely; continuing with accessible/top-frame scan', message);
  }

  return status;
}

async function requestPageScan(tabOrTabId) {
  const tabId = typeof tabOrTabId === 'object' ? tabOrTabId?.id : tabOrTabId;
  const tab = typeof tabOrTabId === 'object' ? tabOrTabId : await getTabById(tabId);
  const status = {
    topFrameOk: false,
    allFramesOk: false,
    usedFallback: false,
    usedLegacyFallback: false,
    stale: false,
    itemCount: 0,
    errors: []
  };
  const allItems = [];

  if (!Number.isInteger(tabId) || !Number.isInteger(tab?.id)) {
    status.errors.push('Source tab unavailable for page scan.');
    return status;
  }

  const collectResults = (results = [], scanName = '') => {
    for (const result of results || []) {
      const payload = result.result || {};
      for (const item of payload.items || []) {
        if (allItems.length >= MAX_AGGREGATED_SCAN_ITEMS) return;
        allItems.push({
          ...item,
          frameId: result.frameId,
          frameUrl: item.frameUrl || payload.frameUrl || '',
          scanner: scanName || item.scanner || ''
        });
      }
    }
  };

  // Compatibility fix: v2.7 and earlier successfully used an all-frame scan
  // first on several iframe/player pages. v2.8 switched to top-frame-first and
  // that helped popup startup, but it could miss player-frame performance data
  // on sites that only expose the HLS URL in a frame. Try the broad scan first,
  // but keep every later fallback independent so one blocked frame cannot break
  // detection for the rest of the page.
  try {
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        frameUrl: location.href,
        title: document.title,
        items: globalThis.MediaScoutPageScanner?.scan?.() || []
      })
    });
    status.allFramesOk = true;
    collectResults(frameResults, 'all-frame-scanner');
  } catch (error) {
    const message = error?.message || 'All-frame page scan failed.';
    status.errors.push(message);
    warn('All-frame page scan unavailable; continuing with top-frame and legacy scans', message);
  }

  try {
    const topResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        frameUrl: location.href,
        title: document.title,
        items: globalThis.MediaScoutPageScanner?.scan?.() || []
      })
    });
    status.topFrameOk = true;
    collectResults(topResults, 'top-frame-scanner');
  } catch (error) {
    const message = error?.message || 'Top-frame page scan failed.';
    status.errors.push(message);
    warn('Top-frame page scan unavailable', message);
  }

  // Legacy broad scan does not depend on the bundled scanner being injected.
  // It is intentionally small and read-only: URLs from scripts/attributes and
  // Resource Timing. It restored detection for pages where the full scanner was
  // present but not started in time.
  if (!hasPrimaryMediaCandidate(allItems)) {
    try {
      const legacyResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: legacyBroadMediaScan
      });
      status.usedLegacyFallback = true;
      collectResults(legacyResults, 'legacy-all-frame-scan');
    } catch (error) {
      const message = error?.message || 'Legacy all-frame scan failed.';
      status.errors.push(message);
      warn('Legacy all-frame scan unavailable; trying top-frame legacy scan', message);
      try {
        const legacyTop = await chrome.scripting.executeScript({ target: { tabId }, func: legacyBroadMediaScan });
        status.usedLegacyFallback = true;
        collectResults(legacyTop, 'legacy-top-frame-scan');
      } catch (fallbackError) {
        const fallbackMessage = fallbackError?.message || 'Legacy top-frame scan failed.';
        status.errors.push(fallbackMessage);
        warn('Legacy top-frame scan unavailable', fallbackMessage);
      }
    }
  }

  // Always try the content-script message fallback when no primary video/audio
  // stream candidate has appeared. This prevents a page full of posters/images
  // from making the popup believe detection is complete.
  if (!hasPrimaryMediaCandidate(allItems)) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.SCAN_PAGE_MEDIA });
      if (response?.items?.length) {
        status.usedFallback = true;
        for (const item of response.items) allItems.push(item);
      }
    } catch (fallbackError) {
      const message = fallbackError?.message || 'Content-script message scan failed.';
      status.errors.push(message);
      warn('Page scan message fallback unavailable', message);
    }
  }

  const currentTab = await getTabById(tabId);
  if (!Number.isInteger(currentTab?.id) || (tab.url && currentTab.url && !isSameDocumentNavigation(tab.url, currentTab.url))) {
    status.stale = true;
    status.errors.push('The page changed while the scan was running; stale results were discarded.');
    return status;
  }
  if (allItems.length) {
    const added = await detector.ingestDomScan(currentTab, dedupeScanItems(allItems));
    status.itemCount = added.length;
  }
  return status;
}

function legacyBroadMediaScan() {
  const MEDIA_RE = /(?:(?:https?:)?\/\/|\.{0,2}\/|[A-Za-z0-9_%.-]+\/)[^\s"'<>`]+?\.(?:m3u8|m3u|mpd|mp4|m4v|mov|webm|ogv|ts|m2ts|m4s|cmfv|cmfa|mp3|m4a|aac|wav|ogg|oga|opus|flac|vtt|srt|ttml|dfxp|jpg|jpeg|png|webp|avif|gif)(?:\?[^\s"'<>`]*)?/gi;
  const MEDIA_EXT = /\.(m3u8|m3u|mpd|mp4|m4v|mov|webm|ogv|ts|m2ts|m4s|cmfv|cmfa|mp3|m4a|aac|wav|ogg|oga|opus|flac|vtt|srt|ttml|dfxp|jpg|jpeg|png|webp|avif|gif)(?:[?#]|$)/i;
  const MAX_CANDIDATES = 1200;
  const MAX_SCRIPT_COUNT = 300;
  const MAX_SCRIPT_TEXT_CHARS = 2_000_000;
  const MAX_ATTRIBUTE_ELEMENTS = 2000;
  const MAX_DOM_ELEMENTS_VISITED = 20_000;
  const MAX_RESOURCE_ENTRIES = 2000;
  const items = [];
  const selectBounded = (selector, maxMatches, root = document, maxVisits = MAX_DOM_ELEMENTS_VISITED) => {
    const matches = [];
    const ownerDocument = root?.nodeType === 9 ? root : root?.ownerDocument || document;
    if (!root || !ownerDocument?.createTreeWalker) return matches;
    const walker = ownerDocument.createTreeWalker(root, globalThis.NodeFilter?.SHOW_ELEMENT || 1);
    let element = root.nodeType === 1 ? root : walker.nextNode();
    let visited = 0;
    while (element && visited < maxVisits && matches.length < maxMatches) {
      visited += 1;
      if (element.matches?.(selector)) matches.push(element);
      element = walker.nextNode();
    }
    return matches;
  };
  const push = (raw, source, extra = {}) => {
    if (!raw || items.length >= MAX_CANDIDATES) return;
    try {
      const url = new URL(String(raw).replace(/&amp;/gi, '&').replace(/\\\//g, '/').replace(/\\u002f/gi, '/').replace(/\\x2f/gi, '/'), document.baseURI);
      url.hash = '';
      const normalized = url.toString();
      if (normalized.length > 4096) return;
      if (!MEDIA_EXT.test(normalized) && !normalized.startsWith('blob:')) return;
      items.push({ url: normalized, source, frameUrl: String(location.href || '').slice(0, 4096), ...extra });
    } catch (_error) {
      // Ignore malformed literal candidates.
    }
  };

  let inspectedMediaElements = 0;
  for (const media of selectBounded('video,audio', 240)) {
    if (inspectedMediaElements >= 240 || items.length >= MAX_CANDIDATES) break;
    inspectedMediaElements += 1;
    const source = media.tagName.toLowerCase() === 'video' ? 'dom-video' : 'dom-audio';
    for (const value of [media.currentSrc, media.src, media.getAttribute('src')]) {
      push(value, source, {
        resolution: media.videoWidth && media.videoHeight ? `${media.videoWidth}x${media.videoHeight}` : '',
        probableMseBlob: String(value || '').startsWith('blob:') && media.readyState >= 1,
        mediaDuration: Number.isFinite(media.duration) ? media.duration : null,
        mediaInfo: {
          currentSrc: String(media.currentSrc || '').startsWith('blob:') ? 'blob:' : String(media.currentSrc || '').slice(0, 4096),
          duration: Number.isFinite(media.duration) ? media.duration : null,
          resolution: media.videoWidth && media.videoHeight ? `${media.videoWidth}x${media.videoHeight}` : '',
          readyState: media.readyState,
          networkState: media.networkState,
          likelyMseBlob: String(media.currentSrc || media.src || '').startsWith('blob:')
        }
      });
    }
    for (const sourceElement of selectBounded('source', 50, media, 2000)) {
      push(sourceElement.src || sourceElement.getAttribute('src'), 'dom-source', { type: String(sourceElement.type || sourceElement.getAttribute('type') || '').slice(0, 160) });
    }
  }

  const scripts = document.scripts || [];
  let remainingScriptChars = MAX_SCRIPT_TEXT_CHARS;
  for (let scriptIndex = 0; scriptIndex < Math.min(MAX_SCRIPT_COUNT, scripts.length) && items.length < MAX_CANDIDATES; scriptIndex += 1) {
    const script = scripts[scriptIndex];
    const text = script.src ? script.src : String(script.textContent || '').slice(0, Math.min(900_000, remainingScriptChars));
    if (!script.src) remainingScriptChars -= text.length;
    MEDIA_RE.lastIndex = 0;
    let match;
    let guard = 0;
    while ((match = MEDIA_RE.exec(text)) && guard < 260) {
      guard += 1;
      push(match[0], script.src ? 'script-src-legacy' : 'page-text-literal', { literalContext: script.src ? 'script-src' : 'inline-script' });
    }
    if (remainingScriptChars <= 0) break;
  }

  const mediaAttributes = ['src', 'href', 'srcset', 'poster', 'data-src', 'data-url', 'data-play', 'data-video', 'data-audio', 'data-media', 'data-stream', 'data-file', 'data-original'];
  const walker = document.createTreeWalker(document.documentElement || document, NodeFilter.SHOW_ELEMENT);
  let element = walker.currentNode;
  let visitedElements = 0;
  let inspectedAttributeElements = 0;
  while (element && visitedElements < MAX_DOM_ELEMENTS_VISITED && inspectedAttributeElements < MAX_ATTRIBUTE_ELEMENTS && items.length < MAX_CANDIDATES) {
    visitedElements += 1;
    const hasMediaAttribute = mediaAttributes.some((attribute) => element.hasAttribute?.(attribute));
    if (hasMediaAttribute) inspectedAttributeElements += 1;
    for (const attribute of mediaAttributes) {
      if (items.length >= MAX_CANDIDATES) break;
      if (!element.hasAttribute(attribute)) continue;
      const text = element.getAttribute(attribute) || '';
      MEDIA_RE.lastIndex = 0;
      let match;
      let guard = 0;
      while ((match = MEDIA_RE.exec(text)) && guard < 50) {
        guard += 1;
        push(match[0], `attribute-${attribute}`, { literalContext: attribute });
      }
      if (!text.includes(',')) push(text, `attribute-${attribute}`, { literalContext: attribute });
    }
    element = walker.nextNode();
  }

  const resources = typeof performance?.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
  for (const entry of (resources || []).slice(-MAX_RESOURCE_ENTRIES)) {
    if (items.length >= MAX_CANDIDATES) break;
    push(entry.name, 'performance-resource', {
      initiatorType: entry.initiatorType || '',
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
      decodedBodySize: entry.decodedBodySize || 0,
      performanceStartTime: Math.round(entry.startTime || 0),
      resourceInfo: {
        initiatorType: entry.initiatorType || '',
        transferSize: entry.transferSize || 0,
        encodedBodySize: entry.encodedBodySize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
        duration: Math.round(entry.duration || 0),
        startTime: Math.round(entry.startTime || 0)
      }
    });
  }

  const seen = new Set();
  const priority = (item = {}) => {
    const url = String(item.url || '').toLowerCase();
    const source = String(item.source || '').toLowerCase();
    if (url.startsWith('blob:') || /\.(m3u8|mpd)(?:[?#]|$)/i.test(url)) return 0;
    if (/\.(mp4|m4v|mov|webm|ogv|ts|m2ts|m4s|mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(url)) return 1;
    if (/track|subtitle|caption/.test(source)) return 2;
    if (/image|poster|thumbnail/.test(source) || /\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i.test(url)) return 4;
    return 3;
  };
  const deduped = items.filter((item) => {
    const key = `${item.url}|${item.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item, index) => ({ item, index, priority: priority(item) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, 320)
    .map(({ item }) => item);
  return {
    frameUrl: String(location.href || '').slice(0, 4096),
    title: String(document.title || '').slice(0, 500),
    items: deduped
  };
}

function hasPrimaryMediaCandidate(items = []) {
  return items.some((item) => {
    const url = String(item?.url || '').toLowerCase();
    const type = String(item?.type || item?.mime || '').toLowerCase();
    return url.startsWith('blob:') || /\.(m3u8|mpd|mp4|m4v|mov|webm|ogv|ts|m2ts|m4s|mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(url) || /video\/|audio\/|mpegurl|dash\+xml/i.test(type);
  });
}


function dedupeScanItems(items = []) {
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = [item.url, item.source, item.frameId, item.frameUrl].map((value) => String(value || '')).join('|');
    if (!item?.url || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped
    .map((item, index) => ({ item, index, priority: scanItemPriority(item) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, 500)
    .map(({ item }) => item);
}

function scanItemPriority(item = {}) {
  const url = String(item.url || '').toLowerCase();
  const type = String(item.type || item.mime || '').toLowerCase();
  const source = String(item.source || '').toLowerCase();
  if (url.startsWith('blob:') || /\.(m3u8|mpd)(?:[?#]|$)/i.test(url) || /mpegurl|dash\+xml/.test(type)) return 0;
  if (/\.(mp4|m4v|mov|webm|ogv|ts|m2ts|m4s|mp3|m4a|aac|wav|ogg|opus|flac)(?:[?#]|$)/i.test(url) || /video\/|audio\//.test(type)) return 1;
  if (/track|subtitle|caption/.test(source)) return 2;
  if (/image|poster|thumbnail/.test(source) || /image\//.test(type)) return 4;
  return 3;
}

function summarizeScanStatus(injection = {}, scan = {}) {
  const itemCount = Number(scan.itemCount || 0);
  const usedFallback = Boolean(scan.usedFallback || scan.usedLegacyFallback);
  const stale = Boolean(scan.stale);
  const ok = !stale && Boolean(injection.topFrameOk || scan.topFrameOk || scan.allFramesOk || usedFallback || itemCount > 0);
  const errors = [...(injection.errors || []), ...(scan.errors || [])].filter(Boolean).slice(0, 3);
  return {
    ok,
    topFrameOk: Boolean(injection.topFrameOk || scan.topFrameOk),
    allFramesOk: Boolean(injection.allFramesOk || scan.allFramesOk),
    usedFallback,
    usedLegacyFallback: Boolean(scan.usedLegacyFallback),
    stale,
    itemCount,
    errors,
    message: ok
      ? ''
      : (stale ? 'The page changed while Media Scout was scanning. Stale results were discarded; rescan the current page.' : (errors[0] || 'Scanner could not run on this page. Chrome blocks extensions on some pages and browser-internal URLs.'))
  };
}

async function requestDetailedPageScan(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async () => await Promise.resolve(globalThis.MediaScoutPageScanner?.scanDetailed?.() || { unavailable: true, error: 'Detailed scanner unavailable in this frame.' })
    });
    const reports = (results || []).map((result) => ({
      frameId: result.frameId,
      report: result.result
    })).filter((entry) => entry.report);
    if (!reports.length) return { report: { unavailable: true, error: 'Detailed scan returned no frame data.' }, error: '' };
    return { report: aggregateFrameReports(reports), error: '' };
  } catch (error) {
    warn('All-frame detailed scan unavailable; trying top-frame message scan', error.message);
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.SCAN_PAGE_MEDIA_DETAILED });
      return { report: response?.report || { unavailable: true, error: 'Detailed scan returned no data.' }, error: '' };
    } catch (fallbackError) {
      warn('Detailed page scan unavailable', fallbackError.message);
      return { report: null, error: fallbackError.message || 'Detailed page scan unavailable.' };
    }
  }
}

function aggregateFrameReports(entries) {
  const topEntry = entries.find((entry) => entry.frameId === 0) || entries[0];
  const top = topEntry.report || {};
  const frames = entries.slice(0, 240).map(({ frameId, report }) => ({
    frameId,
    frame: report.frame || {},
    document: report.document || {},
    mediaElementCount: report.mediaElements?.length || 0,
    iframeCount: report.iframes?.length || report.document?.iframeCount || 0,
    literalMediaHintCount: report.literalMediaHints?.length || 0,
    playlistProbeCount: report.playlistProbes?.length || 0,
    mediaLikePerformanceEntryCount: report.performance?.mediaLikeEntries?.length || 0,
    interestingPerformanceEntryCount: report.performance?.interestingEntries?.length || 0,
    unavailable: Boolean(report.unavailable),
    error: report.error || ''
  }));

  return {
    ...top,
    generatedAt: new Date().toISOString(),
    scannedFrameCount: entries.length,
    frames,
    iframes: flattenFrameList(entries, 'iframes'),
    mediaElements: flattenFrameList(entries, 'mediaElements'),
    anchors: flattenFrameList(entries, 'anchors'),
    literalMediaHints: flattenFrameList(entries, 'literalMediaHints'),
    playlistProbes: flattenFrameList(entries, 'playlistProbes'),
    performance: aggregatePerformance(entries),
    decisions: flattenFrameList(entries, 'decisions')
  };
}

function flattenFrameList(entries, key) {
  const result = [];
  for (const { frameId, report } of entries) {
    for (const item of report?.[key] || []) {
      if (result.length >= MAX_REPORT_LIST_ITEMS) return result;
      result.push({
        ...item,
        frameId,
        frameUrl: report?.frame?.url || report?.document?.url || ''
      });
    }
  }
  return result.slice(0, 600);
}

function aggregatePerformance(entries) {
  const initiatorCounts = Object.create(null);
  const hostCounts = Object.create(null);
  const mediaLikeEntries = [];
  const interestingEntries = [];
  let totalResourceEntries = 0;

  for (const { frameId, report } of entries) {
    const performance = report?.performance || {};
    totalResourceEntries += performance.totalResourceEntries || 0;
    for (const [name, count] of Object.entries(performance.initiatorCounts || {})) {
      initiatorCounts[name] = (initiatorCounts[name] || 0) + count;
    }
    for (const host of performance.topHosts || []) {
      hostCounts[host.hostname] = (hostCounts[host.hostname] || 0) + (host.count || 0);
    }
    for (const item of performance.mediaLikeEntries || []) {
      if (mediaLikeEntries.length >= 240) break;
      mediaLikeEntries.push({ ...item, frameId, frameUrl: report?.frame?.url || '' });
    }
    for (const item of performance.interestingEntries || []) {
      if (interestingEntries.length >= 240) break;
      interestingEntries.push({ ...item, frameId, frameUrl: report?.frame?.url || '' });
    }
  }

  return {
    totalResourceEntries,
    initiatorCounts,
    topHosts: Object.entries(hostCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([hostname, count]) => ({ hostname, count })),
    mediaLikeEntries: mediaLikeEntries.slice(0, 240),
    interestingEntries: interestingEntries.slice(0, 240)
  };
}


async function discoverEpisodeBatch(message = {}) {
  const tab = await getTargetTab(message);
  if (!Number.isInteger(tab?.id)) return { episodeBatch: emptyEpisodeBatch('No active tab was available.') };
  const episodeBatch = await findEpisodeBatchForTab(tab);
  return { episodeBatch, queue: downloadManager.getState(), settings: await getSettings() };
}

async function startEpisodeBatchDownloads(message = {}) {
  const activeTab = await getTargetTab(message);
  if (!Number.isInteger(activeTab?.id)) throw new Error('No active tab was available.');
  const sourceEpisodes = Array.isArray(message.episodes) && message.episodes.length
    ? message.episodes
    : (await findEpisodeBatchForTab(activeTab)).episodes;
  const episodes = sanitizeEpisodeList(sourceEpisodes, activeTab.url).slice(0, 48);
  if (!episodes.length) throw new Error('No same-series episode links were found on this page.');

  const access = await hasOriginPermission(activeTab.url);
  if (!access.granted) {
    throw new Error(`Batch episode downloads need site access for ${access.origin || 'this site'} so Media Scout can scan background episode tabs. Open Batch Preview from the side panel and approve the browser permission prompt before starting.`);
  }

  const settings = await getSettings();
  const scanParallel = Math.max(1, Math.min(4, Number(settings.episodeBatchScanParallelism) || 2));
  const hlsOutputMethod = Object.values(HLS_OUTPUT_METHODS).includes(message.hlsOutputMethod)
    ? message.hlsOutputMethod
    : (settings.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4);
  const results = [];
  let next = 0;

  async function worker() {
    while (next < episodes.length) {
      const episode = episodes[next++];
      results.push(await scanEpisodePageAndQueue(activeTab, episode, hlsOutputMethod));
    }
  }

  await Promise.all(Array.from({ length: Math.min(scanParallel, episodes.length) }, () => worker()));
  const batch = await findEpisodeBatchForTab(activeTab);
  return {
    episodeBatch: { ...batch, batchResults: results, queuedCount: results.filter((item) => item.queued).length, failedCount: results.filter((item) => !item.queued).length },
    batchResults: results,
    queue: downloadManager.getState(),
    settings
  };
}

async function scanEpisodePageAndQueue(activeTab, episode, hlsOutputMethod) {
  let tab = null;
  try {
    tab = await chromeCallSafe((done) => chrome.tabs.create({ url: episode.url, active: false, windowId: activeTab.windowId }, done));
    if (!Number.isInteger(tab?.id)) throw new Error('Could not open episode tab.');
    await waitForTabComplete(tab.id, 30_000);
    tab = await chromeCallSafe((done) => chrome.tabs.get(tab.id, done));
    tabMediaStore.setTabInfo(tab);
    detector.scopeTab(tab.id);
    await ensureScanner(tab.id, { force: true });
    for (const delay of [650, 1600, 2800]) {
      await wait(delay);
      await requestPageScan(tab);
      const state = tabMediaStore.getTabState(tab.id);
      if (pickEpisodeMedia(state.mediaItems)) break;
    }
    const tabState = tabMediaStore.getTabState(tab.id);
    const media = pickEpisodeMedia(tabState.mediaItems);
    if (!media) {
      try { await chromeCallSafe((done) => chrome.tabs.remove(tab.id, done)); } catch (_error) {}
      return { episodeNumber: episode.episodeNumber, url: episode.url, queued: false, error: 'No downloadable HLS/video candidate was found after loading this episode page.' };
    }
    const title = episode.title || tab.title || `Episode ${episode.episodeNumber}`;
    const task = await downloadManager.enqueue({ tabId: tab.id, mediaId: media.id, tab: { ...tab, title }, hlsOutputMethod, closeTabOnComplete: true });
    // Keep the background tab open while the queued task runs because HLS fetching
    // is performed in that tab content context and must obey normal page rules.
    return { episodeNumber: episode.episodeNumber, url: episode.url, title, queued: true, mediaType: media.mediaType, mediaId: media.id, taskId: task.id, openedTabId: tab.id };
  } catch (error) {
    if (Number.isInteger(tab?.id)) {
      try { await chromeCallSafe((done) => chrome.tabs.remove(tab.id, done)); } catch (_cleanupError) {}
    }
    return { episodeNumber: episode.episodeNumber, url: episode.url, queued: false, error: error?.message || 'Episode queueing failed.' };
  }
}

function pickEpisodeMedia(mediaItems = []) {
  const usable = (mediaItems || []).filter((item) => item && !item.isProtected);
  return usable.find((item) => item.mediaType === MEDIA_TYPES.HLS) ||
    usable.find((item) => item.mediaType === MEDIA_TYPES.VIDEO) ||
    usable.find((item) => item.mediaType === MEDIA_TYPES.AUDIO) ||
    null;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const removedListener = (removedTabId) => {
      if (removedTabId === tabId) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab?.status === 'complete') finish();
    });
  });
}

async function findEpisodeBatchForTab(tab) {
  if (!Number.isInteger(tab?.id) || !/^https?:/i.test(tab.url || '')) return emptyEpisodeBatch('Episode detection only runs on normal http(s) pages.');
  const pattern = episodePatternFromUrl(tab.url);
  if (!pattern) return emptyEpisodeBatch('The active URL does not end in a numbered episode-like token.');
  const seen = new Map();
  const add = (item) => {
    if (!item?.url || item.episodeNumber == null || seen.size >= 240) return;
    const key = String(item.episodeNumber);
    const previous = seen.get(key);
    if (!previous || (item.title && !previous.title)) seen.set(key, item);
  };
  add({ url: tab.url, episodeNumber: pattern.currentEpisode, title: tab.title || `Episode ${pattern.currentEpisode}`, source: 'active-tab' });
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: collectEpisodeLinksInPage,
      args: [pattern]
    });
    for (const result of results || []) {
      for (const item of result.result?.episodes || []) add(item);
    }
  } catch (error) {
    warn('Episode batch discovery skipped safely', error?.message || error);
  }
  const episodes = Array.from(seen.values())
    .sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber))
    .map((item, index) => ({
      ...item,
      index,
      isCurrent: Number(item.episodeNumber) === Number(pattern.currentEpisode)
    }));
  if (episodes.length < 2) {
    return { ...pattern, detected: false, episodes, count: episodes.length, message: 'Only the current episode URL was found. Open a page that lists episode links, then scan again.' };
  }
  return {
    ...pattern,
    detected: true,
    count: episodes.length,
    episodes,
    message: `Found ${episodes.length} same-series episode link(s) from the page. Batch download uses opened background tabs and the normal HLS/video detector.`
  };
}

function emptyEpisodeBatch(message = '') {
  return { detected: false, count: 0, episodes: [], message };
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeEpisodeList(episodes = [], activeTabUrl = '') {
  const pattern = episodePatternFromUrl(activeTabUrl);
  const seen = new Set();
  const list = [];
  for (let item of episodes) {
    if (typeof item?.url !== 'string' || item.url.length > 4096) continue;
    try {
      const parsed = new URL(item.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      if (pattern && parsed.origin !== pattern.origin) continue;
      if (pattern) {
        const pathRegex = new RegExp(`^${escapeRegex(pattern.prefix)}(\\d+)${escapeRegex(pattern.suffix || '')}$`);
        const match = pathRegex.exec(parsed.pathname);
        if (!match) continue;
        item = { ...item, episodeNumber: Number.parseInt(match[1], 10) };
      }
      parsed.hash = '';
      const url = parsed.toString();
      const episodeNumber = Number.parseInt(item.episodeNumber, 10);
      if (!Number.isFinite(episodeNumber) || episodeNumber < 0 || seen.has(url)) continue;
      seen.add(url);
      list.push({
        url,
        episodeNumber,
        title: String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 180) || `Episode ${episodeNumber}`
      });
    } catch (_error) {}
  }
  return list.sort((a, b) => Number(a.episodeNumber) - Number(b.episodeNumber));
}

function episodePatternFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname;
    const match = /^(.*?)(\d+)(\/?$)/.exec(path);
    if (!match) return null;
    const prefix = match[1];
    const suffix = match[3] || '';
    const currentEpisode = Number.parseInt(match[2], 10);
    if (!prefix || !Number.isFinite(currentEpisode)) return null;
    return {
      origin: url.origin,
      prefix,
      suffix,
      currentEpisode,
      seriesKey: `${url.origin}${prefix}{episode}${suffix}`,
      example: `${url.origin}${prefix}${currentEpisode}${suffix}`
    };
  } catch (_error) {
    return null;
  }
}

function collectEpisodeLinksInPage(pattern) {
  const episodes = [];
  const seen = new Set();
  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathRegex = new RegExp(`^${escapeRegex(pattern.prefix)}(\\d+)${escapeRegex(pattern.suffix || '')}$`);
  const pushUrl = (raw, source, title = '') => {
    if (!raw || episodes.length >= 120) return;
    try {
      const url = new URL(String(raw).replace(/&amp;/g, '&'), document.baseURI);
      if (url.origin !== pattern.origin) return;
      const match = pathRegex.exec(url.pathname);
      if (!match) return;
      url.hash = '';
      const normalized = url.toString();
      if (normalized.length > 4096) return;
      if (seen.has(normalized)) return;
      seen.add(normalized);
      episodes.push({ url: normalized, episodeNumber: Number.parseInt(match[1], 10), title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 300), source, frameUrl: String(location.href || '').slice(0, 4096) });
    } catch (_error) {}
  };

  pushUrl(location.href, 'frame-location', document.title);
  const episodeAttributes = ['href', 'data-href', 'data-url', 'data-link', 'data-play', 'data-episode', 'data-episode-url'];
  const walker = document.createTreeWalker(document.documentElement || document, globalThis.NodeFilter?.SHOW_ELEMENT || 1);
  let element = walker.currentNode;
  let inspectedEpisodeElements = 0;
  let visitedEpisodeElements = 0;
  while (element && episodes.length < 120 && inspectedEpisodeElements < 2000 && visitedEpisodeElements < 20_000) {
    visitedEpisodeElements += 1;
    const hasCandidate = episodeAttributes.some((attribute) => element.hasAttribute?.(attribute)) || element.hasAttribute?.('onclick');
    if (!hasCandidate) {
      element = walker.nextNode();
      continue;
    }
    inspectedEpisodeElements += 1;
    const title = String(element.getAttribute('title') || element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    for (const attr of episodeAttributes) pushUrl(element.getAttribute(attr), `attribute:${attr}`, title);
    const onclick = element.getAttribute('onclick') || '';
    if (onclick && onclick.length < 6000) {
      const urls = onclick.match(/(?:https?:\/\/[^'"\s<>]+|\/[A-Za-z0-9_/%.-]+(?:\?[^'"\s<>]*)?)/g) || [];
      for (const candidate of urls) pushUrl(candidate, 'onclick-url', title);
    }
    element = walker.nextNode();
  }

  const pathProbe = `${pattern.prefix}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const relativeRe = new RegExp(`${pathProbe}\\d+${escapeRegex(pattern.suffix || '')}(?:[?#][^'"\\s<>]*)?`, 'g');
  let remainingScriptChars = 1_200_000;
  for (const script of document.scripts || []) {
    if (remainingScriptChars <= 0 || episodes.length >= 120) break;
    const text = String(script.textContent || '').slice(0, remainingScriptChars);
    remainingScriptChars -= text.length;
    relativeRe.lastIndex = 0;
    let match;
    let guard = 0;
    while ((match = relativeRe.exec(text)) && guard < 400 && episodes.length < 120) {
      guard += 1;
      pushUrl(match[0], 'page-script-literal', '');
    }
  }
  return { episodes: episodes.slice(0, 120), frameUrl: location.href };
}

async function hasOriginPermission(tabUrl) {
  const origin = originPattern(tabUrl);
  if (!origin) return { origin: '', granted: false };
  const granted = await chrome.permissions.contains({ origins: [origin] });
  return { origin, granted };
}

async function requestSiteAccess(origin, message = {}) {
  const activeTab = await getTargetTab(message);
  const expected = originPattern(activeTab?.url);
  if (!expected) return { granted: false, origin: '', reason: 'The active tab is not a normal http(s) page.' };

  const requested = normalizeOriginPattern(origin);
  if (requested !== expected) {
    return {
      granted: false,
      origin: expected,
      siteAccess: { origin: expected, granted: false },
      reason: 'Refused to request site access for an origin that does not match the active tab.'
    };
  }

  const alreadyGranted = await chrome.permissions.contains({ origins: [expected] });
  if (alreadyGranted) return { granted: true, origin: expected, siteAccess: { origin: expected, granted: true } };
  throw new Error('Chrome requires host-access prompts to start from a visible popup, side panel, or options user gesture. Open the current-site permission button again from the UI.');
}

async function requestAllSiteAccess() {
  const origins = ['http://*/*', 'https://*/*'];
  const alreadyGranted = await chrome.permissions.contains({ origins });
  if (alreadyGranted) return { granted: true, origins };
  throw new Error('Chrome requires all-sites permission prompts to start from the Options page user gesture. Open Options → Detection and approve the browser prompt there.');
}

async function revokeAllSiteAccess() {
  const origins = ['http://*/*', 'https://*/*'];
  const removed = await chrome.permissions.remove({ origins });
  return { removed, origins };
}

function originPattern(tabUrl) {
  try {
    const url = new URL(tabUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}/*`;
  } catch (_error) {
    return '';
  }
}

function normalizeOriginPattern(value = '') {
  try {
    const clean = String(value || '').trim().replace(/\/\*$/, '');
    const url = new URL(clean);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.origin}/*`;
  } catch (_error) {
    return '';
  }
}
