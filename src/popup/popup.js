import { HLS_OUTPUT_METHODS, MEDIA_TYPES, MESSAGE_TYPES } from '../shared/constants.js';
import { getHostname } from '../shared/utils.js';
import { warn } from '../shared/logger.js';
import {
  buildPopupModel,
  classifyCandidate,
  downloadDecisionFor,
  freshnessLabel,
  newestMediaTimestamp,
  normalizeQueue,
  queueCounts,
  redactedUrl,
  summarizeCandidate
} from '../shared/frontend-model.js';

const BUSY = new Set();
const SIDE_PANEL_ROUTE_KEY = 'mediaScout.sidePanelRouteIntent';
const SIDE_PANEL_ROUTES = new Set(['home', 'inspector', 'queue', 'batch', 'reports', 'diagnostics', 'help']);


const state = {
  tab: null,
  mediaItems: [],
  queue: normalizeQueue(),
  settings: null,
  siteAccess: null,
  diagnostics: null,
  episodeBatch: null,
  lastScan: null,
  renderScheduled: false,
  loadToken: 0,
  currentModel: null
};

const els = {
  openHome: byId('openHome'),
  optionsButton: byId('optionsButton'),
  domainTrust: byId('domainTrust'),
  queueMini: byId('queueMini'),
  pageDomain: byId('pageDomain'),
  pageTitle: byId('pageTitle'),
  pageState: byId('pageState'),
  scanAge: byId('scanAge'),
  permissionChip: byId('permissionChip'),
  recommendationCard: byId('recommendationCard'),
  capabilityBadge: byId('capabilityBadge'),
  confidenceBadge: byId('confidenceBadge'),
  recommendationTitle: byId('recommendationTitle'),
  recommendationBody: byId('recommendationBody'),
  candidatePreview: byId('candidatePreview'),
  blockerText: byId('blockerText'),
  primaryAction: byId('primaryAction'),
  secondaryAction: byId('secondaryAction'),
  queueSummary: byId('queueSummary'),
  queueButton: byId('queueButton'),
  privacyButton: byId('privacyButton'),
  reportButton: byId('reportButton'),
  sidePanelButton: byId('sidePanelButton'),
  liveStatus: byId('liveStatus')
};

wireControls();
loadState(MESSAGE_TYPES.GET_ACTIVE_TAB_STATE, { reason: 'startup' }, 'Preparing active-tab detection…');

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === MESSAGE_TYPES.QUEUE_UPDATED) {
    state.queue = normalizeQueue(message.state || state.queue);
    scheduleRender();
  }
  if (message.type === MESSAGE_TYPES.ACTIVE_TAB_STATE) {
    if (!Number.isInteger(state.tab?.id) || !Number.isInteger(message.tabId) || message.tabId === state.tab.id) {
      if (message.navigationReset || message.cacheCleared) resetDetectedState();
      else if (message.replaceMediaItems && Array.isArray(message.mediaItems)) state.mediaItems = message.mediaItems;
      else if (Array.isArray(message.mediaItems)) mergeMediaItems(message.mediaItems);
      if (message.queue) state.queue = normalizeQueue(message.queue);
      if (message.scan) state.lastScan = message.scan;
      scheduleRender();
    }
  }
});

function wireControls() {
  bindButton(els.openHome, () => openRoute('home'), 'route-home');
  bindButton(els.optionsButton, () => openOptions(), 'options');
  bindButton(els.primaryAction, handlePrimaryAction, 'primary');
  bindButton(els.secondaryAction, handleSecondaryAction, 'secondary');
  bindButton(els.queueButton, () => openRoute('queue'), 'route-queue');
  bindButton(els.privacyButton, () => openOptions('privacy'), 'route-privacy');
  bindButton(els.reportButton, () => openRoute('reports'), 'route-reports');
  bindButton(els.sidePanelButton, () => openRoute('home'), 'route-sidepanel');
}

function bindButton(element, handler, key) {
  if (!element) return;
  element.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (BUSY.has(key)) return;
    BUSY.add(key);
    updateBusy();
    try {
      await handler(event);
    } catch (error) {
      setStatus(error?.message || 'Action failed.', 'error');
    } finally {
      BUSY.delete(key);
      updateBusy();
    }
  });
}

async function loadState(type, payload = {}, label = 'Scanning…') {
  const token = ++state.loadToken;
  setStatus(label, 'info');
  try {
    const response = await sendMessage({ type, ...payload });
    if (token !== state.loadToken) return;
    applyState(response);
    setStatus(scanText(response), scanTone(response));
  } catch (error) {
    if (token !== state.loadToken) return;
    setStatus(error?.message || 'Detection failed. Open Help for limits and recovery steps.', 'error');
  } finally {
    if (token === state.loadToken) scheduleRender();
  }
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || 'The extension did not return a usable response.');
  return response;
}

function applyState(response = {}) {
  state.tab = response.tab || state.tab || null;
  state.mediaItems = Array.isArray(response.mediaItems) ? response.mediaItems : state.mediaItems;
  state.queue = normalizeQueue(response.queue || state.queue);
  state.settings = response.settings || state.settings;
  state.siteAccess = response.siteAccess || state.siteAccess;
  state.diagnostics = response.diagnostics || state.diagnostics;
  state.episodeBatch = response.episodeBatch || state.episodeBatch;
  state.lastScan = response.scan || state.lastScan;
}

function mergeMediaItems(items = []) {
  const map = new Map((state.mediaItems || []).map((item) => [item.id || item.normalizedUrl || item.url, item]));
  for (const item of items || []) {
    const key = item?.id || item?.normalizedUrl || item?.url;
    if (!key) continue;
    map.set(key, { ...(map.get(key) || {}), ...item });
  }
  state.mediaItems = Array.from(map.values());
}

function resetDetectedState() {
  state.mediaItems = [];
  state.episodeBatch = null;
}

function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    render();
  });
}

function render() {
  const model = buildPopupModel(state);
  state.currentModel = model;
  const items = Array.isArray(state.mediaItems) ? state.mediaItems : [];
  const queue = normalizeQueue(state.queue);
  const counts = queueCounts(queue);

  const tabUrl = state.tab?.url || '';
  const domain = getHostname(tabUrl) || 'Active tab';
  els.pageDomain.textContent = domain;
  els.pageTitle.textContent = state.tab?.title || 'Active tab unavailable';
  els.pageState.textContent = pageStateText(items, state.lastScan);
  els.scanAge.textContent = freshnessLabel(newestMediaTimestamp(items));
  els.domainTrust.textContent = 'Local only';
  els.permissionChip.textContent = state.siteAccess?.granted ? 'Site access on' : 'Basic scan';
  els.permissionChip.className = `chip ${state.siteAccess?.granted ? 'success' : ''}`.trim();

  els.recommendationCard.className = `recommendation-card ${model.tone || 'neutral'}`.trim();
  els.capabilityBadge.textContent = model.capability?.label || labelForKind(model.kind);
  els.capabilityBadge.className = `capability-badge ${badgeTone(model)}`.trim();
  els.confidenceBadge.textContent = confidenceText(model, items);
  els.recommendationTitle.textContent = model.title;
  els.recommendationBody.textContent = model.body;

  renderCandidatePreview(model);
  els.blockerText.textContent = model.blocker || '';
  els.blockerText.classList.toggle('hidden', !model.blocker);

  els.primaryAction.textContent = model.primary || 'Scan';
  els.secondaryAction.textContent = model.secondary || 'Open Inspector';
  els.queueSummary.textContent = queueSummaryText(queue, counts);
  els.queueMini?.classList.toggle('hidden', !(queue.paused || counts.active || counts.queued || counts.failed));
  updateBusy();
}

function renderCandidatePreview(model = {}) {
  els.candidatePreview.replaceChildren();
  const item = model.candidate;
  if (!item) {
    els.candidatePreview.classList.add('hidden');
    return;
  }
  const capability = model.capability || classifyCandidate(item, state.settings || {});
  const decision = downloadDecisionFor(item, state.settings || {}, item.mediaType === MEDIA_TYPES.HLS ? hlsMethodForPrimary(item) : '');
  els.candidatePreview.append(
    node('strong', { text: summarizeCandidate(item) }),
    node('span', { text: `Capability: ${capability.label}. ${capability.reason || decision.reason || 'Ready for review.'}` }),
    node('span', { text: redactedUrl(item.url || item.normalizedUrl || '') })
  );
  els.candidatePreview.classList.remove('hidden');
}

async function handlePrimaryAction() {
  const model = state.currentModel || buildPopupModel(state);
  if (model.kind === 'permission') return requestCurrentSiteAccess();
  if (model.kind === 'restricted') return openRoute('help');
  if (model.kind === 'needs-playback') return loadState(MESSAGE_TYPES.HARD_RESCAN_ACTIVE_TAB, { reason: 'needs-playback' }, 'Rescanning the current page…');
  if (model.kind === 'ready-direct' && model.candidate) return startDownload(model.candidate);
  if (model.kind === 'ready-hls' && model.candidate) return startDownload(model.candidate, hlsMethodForPrimary(model.candidate));
  if (model.kind === 'queue-active') return openRoute('queue');
  return openRoute('inspector');
}

async function handleSecondaryAction() {
  const model = state.currentModel || buildPopupModel(state);
  if (model.kind === 'permission') return loadState(MESSAGE_TYPES.GET_ACTIVE_TAB_STATE, { reason: 'basic-scan' }, 'Continuing with active-tab scan…');
  if (model.kind === 'needs-playback' && /^Allow on this site/i.test(model.secondary || '')) return requestCurrentSiteAccess();
  if (model.kind === 'restricted') return openOptions();
  if (model.kind === 'unsupported') return openRoute('reports');
  if (model.kind === 'queue-active' && model.secondary === 'Rescan current page') return loadState(MESSAGE_TYPES.GET_ACTIVE_TAB_STATE, { reason: 'rescan-from-queue' }, 'Rescanning active tab…');
  return openRoute('inspector');
}

async function requestCurrentSiteAccess() {
  const origin = state.siteAccess?.origin;
  if (!origin) {
    setStatus('No current-site origin is available for permission request.', 'warning');
    return;
  }
  setStatus(`Asking Chrome for access to ${origin}…`, 'info');
  let granted = false;
  try {
    if (chrome.permissions?.request) {
      granted = await chrome.permissions.request({ origins: [origin] });
    } else {
      const response = await sendMessage({ type: MESSAGE_TYPES.REQUEST_SITE_ACCESS, origin });
      granted = Boolean(response.granted);
    }
  } catch (error) {
    setStatus(error?.message || 'Chrome could not show the site-access prompt.', 'error');
    scheduleRender();
    return;
  }
  state.siteAccess = { origin, granted };
  if (!granted) {
    setStatus('Site access was not granted. Basic active-tab scan remains available.', 'warning');
    scheduleRender();
    return;
  }
  await loadState(MESSAGE_TYPES.GET_ACTIVE_TAB_STATE, { forceInject: true, reason: 'site-access-granted' }, 'Site access granted. Refreshing evidence…');
}


function hlsMethodForPrimary(item = {}) {
  const preferred = state.settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4;
  if (downloadDecisionFor(item, state.settings || {}, preferred).allowed) return preferred;
  if (downloadDecisionFor(item, state.settings || {}, HLS_OUTPUT_METHODS.SMART_MP4).allowed) return HLS_OUTPUT_METHODS.SMART_MP4;
  return preferred;
}

async function startDownload(item, hlsOutputMethod = '') {
  const method = hlsOutputMethod || (item?.mediaType === MEDIA_TYPES.HLS ? state.settings?.hlsOutputMethod || '' : '');
  const capability = classifyCandidate(item, state.settings || {});
  if (capability.key === 'stale' || capability.key === 'expired') {
    setStatus(capability.reason || 'Rescan this page before starting the download.', 'warning');
    scheduleRender();
    return;
  }
  const decision = downloadDecisionFor(item, state.settings || {}, method);
  if (!decision.allowed) {
    setStatus(decision.reason || 'This candidate is not available for a safe action.', 'warning');
    scheduleRender();
    return;
  }
  if (method === HLS_OUTPUT_METHODS.EXTERNAL_HELPER) {
    const confirmed = confirm('Create external-helper notes? The text file includes the playlist URL so a separate local tool can use it. Do not export it if the URL is private.');
    if (!confirmed) return setStatus('External-helper notes canceled.', 'warning');
  }
  const tabId = Number.isInteger(item?.tabId) ? item.tabId : state.tab?.id;
  const response = await sendMessage({ type: MESSAGE_TYPES.START_DOWNLOAD, tabId, mediaId: item.id, hlsOutputMethod: method });
  state.queue = normalizeQueue(response.queue || state.queue);
  setStatus(response.task?.duplicateOf ? 'That media is already active or queued with the same method.' : 'Download queued. Open Queue for progress.', response.task?.duplicateOf ? 'warning' : 'success');
  scheduleRender();
}

async function openRoute(route = 'home') {
  const safeRoute = SIDE_PANEL_ROUTES.has(route) ? route : 'home';
  const sourceTabId = Number.isInteger(state.tab?.id) ? state.tab.id : null;
  const sourceParam = sourceTabId != null ? `?sourceTabId=${encodeURIComponent(String(sourceTabId))}` : '';
  const fallbackUrl = chrome.runtime.getURL(`src/sidepanel/sidepanel.html#/${encodeURIComponent(safeRoute)}${sourceParam}`);
  setStatus(`Opening ${routeLabel(safeRoute)}…`, 'info');

  // Persist the route before opening, but do not await it. sidePanel.open must
  // be invoked immediately from the user's click gesture in Chrome. Awaiting
  // setOptions/storage first can make every popup route button appear dead.
  persistSidePanelIntent(safeRoute, sourceTabId);

  try {
    if (chrome.sidePanel?.open && sourceTabId != null) {
      const openPromise = chrome.sidePanel.open({ tabId: sourceTabId });
      await openPromise;
      window.close();
      return;
    }
  } catch (error) {
    warn('Side panel open fell back to extension tab', error?.message || error);
  }

  try {
    await chrome.tabs.create({ url: fallbackUrl, active: true });
    window.close();
  } catch (error) {
    throw new Error(error?.message || 'Could not open the side panel or fallback workspace tab.');
  }
}

function persistSidePanelIntent(route, sourceTabId = null) {
  try {
    const intent = {
      route,
      sourceTabId,
      createdAt: Date.now()
    };
    chrome.storage?.session?.set?.({ [SIDE_PANEL_ROUTE_KEY]: intent }).catch?.(() => undefined);
  } catch (_error) {
    // Route intent is an enhancement. The hash-based fallback below still works.
  }
}

async function openOptions(section = '') {
  const hash = section ? `#${encodeURIComponent(section)}` : '';
  if (section) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/options.html${hash}`), active: true });
    return;
  }
  if (chrome.runtime.openOptionsPage) await chrome.runtime.openOptionsPage();
  else await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html'), active: true });
}

function routeLabel(route) {
  return {
    home: 'Side Panel Home',
    inspector: 'Inspector',
    queue: 'Queue',
    batch: 'Batch Preview',
    reports: 'Report Preview',
    diagnostics: 'Diagnostics',
    help: 'Help'
  }[route] || 'Side Panel';
}

function updateBusy() {
  const primaryBusy = BUSY.has('primary');
  const secondaryBusy = BUSY.has('secondary');
  for (const [button, busy] of [[els.primaryAction, primaryBusy], [els.secondaryAction, secondaryBusy]]) {
    if (!button) continue;
    button.disabled = busy;
    button.classList.toggle('loading', busy);
    button.setAttribute('aria-busy', String(busy));
  }
}

function pageStateText(items = [], scan = {}) {
  if (scan?.ok === false && /source tab.*closed/i.test(String(scan.message || ''))) return 'Source closed';
  if (scan?.ok === false && /navigated|navigation|cleared stale|previous page/i.test(String(scan.message || ''))) return 'Page changed';
  if (scan?.ok === false) return 'Blocked page';
  if (items.length) return `${items.length} candidate${items.length === 1 ? '' : 's'} found`;
  if (scan?.ok) return 'No media request yet';
  return 'Scanner ready';
}

function queueSummaryText(queue = {}, counts = queueCounts(queue)) {
  if (queue.paused) return counts.queued ? `Paused • ${counts.queued} waiting` : 'Paused';
  if (counts.active) return `${counts.active} active${counts.queued ? ` • ${counts.queued} waiting` : ''}`;
  if (counts.queued) return `${counts.queued} waiting`;
  if (counts.failed) return `${counts.failed} needs attention`;
  if (counts.completed) return `${counts.completed} recently saved`;
  return 'Idle';
}

function scanText(response = {}) {
  const scan = response.scan || {};
  const count = Array.isArray(response.mediaItems) ? response.mediaItems.length : (state.mediaItems || []).length;
  if (scan.ok === false) return scan.message || 'Scanner could not run on this page.';
  if (count) return `${count} candidate${count === 1 ? '' : 's'} found. Recommendation updated.`;
  return 'No media request yet. Play the media, then rescan.';
}

function scanTone(response = {}) {
  if (response.scan?.ok === false) return 'error';
  if (Array.isArray(response.mediaItems) && response.mediaItems.length) return 'success';
  return 'warning';
}

function confidenceText(model = {}, items = []) {
  if (model.kind === 'permission') return 'Permission limited';
  if (model.kind === 'restricted') return 'Browser rule';
  if (model.kind === 'queue-active') return 'Queue state';
  if (!items.length) return 'Needs playback';
  if (model.candidate?.variants?.length) return `${model.candidate.variants.length} variants`;
  return 'Stable rank';
}

function badgeTone(model = {}) {
  if (model.tone === 'success') return 'success';
  if (model.tone === 'danger') return 'danger';
  if (model.tone === 'warning') return 'warning';
  return 'info';
}

function labelForKind(kind = '') {
  return {
    'ready-direct': 'Downloadable',
    'ready-hls': 'Convertible',
    permission: 'Needs permission',
    restricted: 'Unsupported',
    'needs-playback': 'Needs playback',
    unsupported: 'Unsupported',
    'queue-active': 'Queue active'
  }[kind] || 'Scanning';
}

function setStatus(message, tone = '') {
  els.liveStatus.textContent = message || '';
  els.liveStatus.dataset.tone = tone || '';
}

function byId(id) { return document.getElementById(id); }
function node(tag, options = {}) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text != null) element.textContent = options.text;
  return element;
}
