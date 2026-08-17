import { DOWNLOAD_STATUSES, HLS_OUTPUT_METHODS, MESSAGE_TYPES, MEDIA_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import { formatBytes, getHostname } from '../shared/utils.js';
import { reportFileByteLength, reportFilesDigest } from '../shared/report-privacy.js';
import { createZipBlob, normalizeZipEntries } from '../shared/zip-utils.js';
import {
  HLS_ACTIONS,
  buildPopupModel,
  candidateFacts,
  classifyCandidate,
  downloadDecisionFor,
  filenamePreview,
  freshnessLabel,
  groupCandidates,
  newestMediaTimestamp,
  normalizeQueue,
  queueCounts,
  queueTaskList,
  redactedUrl,
  statusLabel,
  statusTone,
  summarizeCandidate,
  taskVisibleCopy
} from '../shared/frontend-model.js';

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
  route: routeFromHash(),
  sourceTabId: sourceTabIdFromLocation(),
  rawReveals: new Set(),
  filter: '',
  capabilityFilter: 'all',
  report: null,
  reportInvalidationReason: '',
  reportSearch: '',
  reportIncludeSensitive: false,
  reportIncludeSensitiveTouched: false,
  manualUrl: '',
  manualName: '',
  manualMethod: '',
  manualStatus: '',
  renderScheduled: false,
  loadToken: 0
};

const els = {
  refreshState: byId('refreshState'),
  openOptions: byId('openOptions'),
  workspaceStatus: byId('workspaceStatus'),
  routes: Object.fromEntries(['home', 'inspector', 'queue', 'batch', 'reports', 'diagnostics', 'help'].map((id) => [id, byId(id)])),
  countHome: byId('countHome'),
  countInspector: byId('countInspector'),
  countQueue: byId('countQueue'),
  countBatch: byId('countBatch')
};

initialize();

async function initialize() {
  wireShell();
  await hydrateLaunchIntent();
  loadState(MESSAGE_TYPES.GET_ACTIVE_TAB_STATE, { reason: 'sidepanel-startup' }, 'Loading active-tab evidence…');
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === MESSAGE_TYPES.QUEUE_UPDATED) {
    invalidateReportPreview('The download queue changed after the preview was built.');
    state.queue = normalizeQueue(message.state || state.queue);
    scheduleRender();
  }
  if (message.type === MESSAGE_TYPES.ACTIVE_TAB_STATE) {
    if (!Number.isInteger(state.tab?.id) || !Number.isInteger(message.tabId) || message.tabId === state.tab.id) {
      invalidateReportPreview(message.navigationReset ? 'The source page changed after the preview was built.' : 'Detected page evidence changed after the preview was built.');
      if (message.navigationReset || message.cacheCleared) resetDetectedState();
      else if (message.replaceMediaItems && Array.isArray(message.mediaItems)) state.mediaItems = message.mediaItems;
      else if (Array.isArray(message.mediaItems)) mergeMediaItems(message.mediaItems);
      if (message.queue) state.queue = normalizeQueue(message.queue);
      if (message.scan) state.lastScan = message.scan;
      scheduleRender();
    }
  }
});

chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
  if (areaName === 'local' && [STORAGE_KEYS.SETTINGS, STORAGE_KEYS.DIAGNOSTICS, STORAGE_KEYS.QUEUE_SUMMARY, STORAGE_KEYS.QUEUE_HISTORY].some((key) => changes[key])) {
    invalidateReportPreview('Local settings, diagnostics, or retained queue evidence changed after the preview was built.');
    scheduleRender();
  }
  if (areaName !== 'session' || !changes[SIDE_PANEL_ROUTE_KEY]?.newValue) return;
  const changed = applyLaunchIntent(changes[SIDE_PANEL_ROUTE_KEY].newValue);
  // Route intent is a one-shot handoff. Remove it even when this panel was
  // already on the requested route so session storage never retains stale UI
  // coordination data for the rest of the browser session.
  chrome.storage?.session?.remove?.(SIDE_PANEL_ROUTE_KEY).catch?.(() => {});
  if (changed) loadState(MESSAGE_TYPES.GET_ACTIVE_TAB_STATE, { reason: 'sidepanel-route-intent' }, `Opening ${routeLabel(state.route)}…`);
});

function wireShell() {
  document.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.route));
  });
  window.addEventListener('hashchange', () => {
    state.route = routeFromHash();
    scheduleRender();
  });
  els.refreshState?.addEventListener('click', () => loadState(MESSAGE_TYPES.HARD_RESCAN_ACTIVE_TAB, { reason: 'sidepanel-rescan' }, 'Running a fresh scan…'));
  els.openOptions?.addEventListener('click', openOptions);
}

async function loadState(type, payload = {}, label = 'Loading…') {
  const token = ++state.loadToken;
  setStatus(label);
  try {
    const response = await sendMessage({ type, ...payload });
    if (token !== state.loadToken) return;
    applyState(response);
    setStatus(statusFromScan(response));
  } catch (error) {
    if (token !== state.loadToken) return;
    setStatus(error?.message || 'Could not load workspace state.');
  } finally {
    if (token === state.loadToken) scheduleRender();
  }
}

async function sendMessage(message) {
  const payload = state.sourceTabId != null ? { sourceTabId: state.sourceTabId, ...message } : message;
  const response = await chrome.runtime.sendMessage(payload);
  if (!response?.ok) throw new Error(response?.error || 'The extension did not return a usable response.');
  return response;
}

function applyState(response = {}) {
  invalidateReportPreview('Workspace evidence was refreshed after the preview was built.');
  state.tab = response.tab || state.tab || null;
  if (Number.isInteger(response.tab?.id) && !isExtensionPageUrl(response.tab?.url || '')) state.sourceTabId = response.tab.id;
  state.mediaItems = Array.isArray(response.mediaItems) ? response.mediaItems : state.mediaItems;
  state.queue = normalizeQueue(response.queue || state.queue);
  state.settings = response.settings || state.settings;
  if (!state.reportIncludeSensitiveTouched && !state.report && state.settings && Object.prototype.hasOwnProperty.call(state.settings, 'includeSensitiveUrlsInReports')) {
    state.reportIncludeSensitive = Boolean(state.settings.includeSensitiveUrlsInReports);
  }
  state.siteAccess = response.siteAccess || state.siteAccess;
  state.diagnostics = response.diagnostics || state.diagnostics;
  state.episodeBatch = response.episodeBatch || state.episodeBatch;
  state.lastScan = response.scan || state.lastScan;
  if (!state.manualMethod && state.settings?.hlsOutputMethod) state.manualMethod = state.settings.hlsOutputMethod;
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
  invalidateReportPreview('Detected evidence was cleared after the preview was built.');
  state.rawReveals.clear();
}

function invalidateReportPreview(reason = 'Report inputs changed after the preview was built.') {
  if (!state.report) return false;
  state.report = null;
  state.reportSearch = '';
  state.reportInvalidationReason = reason;
  return true;
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
  const focusState = captureFocusState();
  const route = state.route || 'home';
  document.title = `Media Scout — ${routeLabel(route)}`;
  Object.entries(els.routes).forEach(([key, section]) => section?.classList.toggle('hidden', key !== route));
  document.querySelectorAll('[data-route]').forEach((button) => button.setAttribute('aria-current', button.dataset.route === route ? 'page' : 'false'));
  updateCounts();
  const renderer = {
    home: renderHome,
    inspector: renderInspector,
    queue: renderQueue,
    batch: renderBatch,
    reports: renderReports,
    diagnostics: renderDiagnostics,
    help: renderHelp
  }[route] || renderHome;
  renderer(els.routes[route] || els.routes.home);
  restoreFocusState(focusState);
}

function captureFocusState() {
  const active = document.activeElement;
  if (!active?.dataset?.focusKey) return null;
  return {
    key: active.dataset.focusKey,
    start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
  };
}

function restoreFocusState(focusState) {
  if (!focusState?.key) return;
  const target = Array.from(document.querySelectorAll('[data-focus-key]')).find((element) => element.dataset.focusKey === focusState.key);
  if (!target) return;
  target.focus({ preventScroll: true });
  if (typeof target.setSelectionRange === 'function' && focusState.start != null && focusState.end != null) {
    try { target.setSelectionRange(focusState.start, focusState.end); } catch (_error) {}
  }
}

function updateCounts() {
  const counts = queueCounts(state.queue);
  if (els.countHome) els.countHome.textContent = String(state.mediaItems.length);
  if (els.countInspector) els.countInspector.textContent = String(state.mediaItems.length);
  if (els.countQueue) els.countQueue.textContent = String(counts.active + counts.queued + counts.failed);
  if (els.countBatch) els.countBatch.textContent = String(state.episodeBatch?.episodes?.length || 0);
}

function renderHome(root) {
  const model = buildPopupModel(state);
  const counts = queueCounts(state.queue);
  root.replaceChildren(
    pageCard(),
    recommendationCard(model),
    metricsCard([
      ['Candidates', state.mediaItems.length],
      ['Active jobs', counts.active],
      ['Need attention', counts.failed],
      ['Episodes', state.episodeBatch?.episodes?.length || 0]
    ]),
    routeCards(),
    privacyCard()
  );
}

function pageCard() {
  const domain = getHostname(state.tab?.url || '') || 'Active tab';
  const scanAge = freshnessLabel(newestMediaTimestamp(state.mediaItems));
  const permission = state.siteAccess?.granted ? 'Site access granted' : 'Basic active-tab scan';
  return el('section', { className: 'page-card' }, [
    el('p', { className: 'eyebrow', text: domain }),
    el('h2', { text: state.tab?.title || 'Active tab unavailable' }),
    el('p', { text: `${state.mediaItems.length} candidate(s) • ${scanAge} • ${permission}` }),
    chipRow([
      ['Local only', 'success'],
      [state.siteAccess?.granted ? 'Advanced detection on' : 'Site access not granted', state.siteAccess?.granted ? 'success' : 'warning'],
      [state.lastScan?.ok === false ? 'Scan blocked' : 'Scanner ready', state.lastScan?.ok === false ? 'danger' : 'info']
    ])
  ]);
}

function recommendationCard(model) {
  const card = el('section', { className: `recommendation-card ${model.tone || ''}`.trim() });
  card.append(
    chipRow([[model.capability?.label || model.kind, model.tone === 'danger' ? 'danger' : model.tone === 'warning' ? 'warning' : model.tone === 'success' ? 'success' : 'info']]),
    el('h2', { text: model.title }),
    el('p', { text: model.body })
  );
  if (model.candidate) {
    card.append(infoGrid([
      ['Candidate', summarizeCandidate(model.candidate)],
      ['Filename preview', filenamePreview(model.candidate, { ...(state.settings || {}), tabTitle: state.tab?.title || '' })],
      ['Source', redactedUrl(model.candidate.url || model.candidate.normalizedUrl || '')]
    ]));
  }
  const actions = el('div', { className: 'action-row' });
  const primary = button(model.primary || 'Open Inspector', 'primary', () => runModelPrimary(model));
  const secondary = button(model.secondary || 'Inspect all', 'ghost', () => runModelSecondary(model));
  actions.append(primary, secondary);
  card.append(actions);
  return card;
}

function routeCards() {
  const counts = queueCounts(state.queue);
  const cards = [
    ['inspector', 'Open Inspector', `${state.mediaItems.length} candidate(s), raw reveal gated, compatibility evidence.`],
    ['queue', 'Open Queue', `${counts.active} active, ${counts.queued} waiting, ${counts.failed} needs attention.`],
    ['batch', 'Open Batch Preview', `${state.episodeBatch?.episodes?.length || 0} same-series episode link(s).`],
    ['reports', 'Open Report Preview', 'Redacted local evidence bundle with include toggles.'],
    ['diagnostics', 'Open Diagnostics', 'Self-tests, storage health, permission drift, repairs.'],
    ['help', 'Open Help', 'Plain-language limits and safe-use policy.']
  ];
  return el('section', { className: 'card' }, [
    heading('Workspace routes', 'Every advanced workflow has a named side-panel route.'),
    el('div', { className: 'route-card-grid' }, cards.map(([route, title, copy]) => {
      const item = el('button', { className: 'route-card' }, [el('strong', { text: title }), el('span', { text: copy })]);
      item.type = 'button';
      item.addEventListener('click', () => navigate(route));
      return item;
    }))
  ]);
}

function privacyCard() {
  return el('section', { className: 'notice success' }, [
    el('strong', { text: 'Privacy evidence: local-only by default.' }),
    el('p', { text: 'Raw URLs, request headers, cookies, tokens, and screenshots stay out of default UI and default reports. Use Reports to preview exactly what will be exported.' })
  ]);
}

function renderInspector(root) {
  const filtered = filteredCandidates();
  const filterInput = input('search', state.filter, 'Filter host, type, source, or evidence…', (value) => { state.filter = value; scheduleRender(); }, 'inspector-filter');
  filterInput.setAttribute('aria-label', 'Filter media candidates');
  const capabilitySelect = select(state.capabilityFilter, [
    ['all', 'All capabilities'],
    ['downloadable', 'Downloadable'],
    ['convertible', 'Convertible'],
    ['manifest', 'Manifest only'],
    ['unsupported', 'Unsupported'],
    ['playback', 'Needs playback']
  ], (value) => { state.capabilityFilter = value; scheduleRender(); }, 'inspector-capability');
  capabilitySelect.setAttribute('aria-label', 'Filter candidates by capability');
  root.replaceChildren(
    el('section', { className: 'card' }, [
      heading('Inspector', 'All candidates, compatibility details, redacted evidence, and gated raw reveal.'),
      toolbar([
        filterInput,
        capabilitySelect
      ])
    ]),
    filtered.length ? candidateGroups(filtered) : emptyNotice('No matching candidates. Play the page media, rescan, or clear filters.'),
    compatibilityPanel(filtered),
    manualHlsPanel()
  );
}

function filteredCandidates() {
  const query = state.filter.trim().toLowerCase();
  return state.mediaItems.filter((item) => {
    const capability = classifyCandidate(item, state.settings || {});
    if (state.capabilityFilter !== 'all' && capability.key !== state.capabilityFilter) return false;
    if (!query) return true;
    const haystack = [item.hostname, item.url, item.mediaType, item.extension, item.mime, item.source, item.unsupportedReason, item.safetyWarning].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function candidateGroups(items = []) {
  const wrap = el('section', { className: 'candidate-list' });
  for (const group of groupCandidates(items, state.settings || {})) {
    const details = el('details', { className: 'candidate-group' });
    details.open = ['hls', 'video', 'audio'].includes(group.key);
    details.append(el('summary', {}, [el('span', { text: group.label }), el('span', { className: 'badge', text: String(group.items.length) })]));
    const body = el('div', { className: 'candidate-group-body' });
    for (const item of group.items) body.append(candidateCard(item));
    details.append(body);
    wrap.append(details);
  }
  return wrap;
}

function candidateCard(item = {}) {
  const capability = classifyCandidate(item, state.settings || {});
  const decision = downloadDecisionFor(item, state.settings || {}, item.mediaType === MEDIA_TYPES.HLS ? hlsMethodForPrimary(item) : '');
  const card = el('article', { className: 'candidate-card' });
  card.append(
    el('div', { className: 'queue-topline' }, [
      el('div', {}, [
        el('h3', { text: summarizeCandidate(item) }),
        el('p', { className: 'subtitle', text: redactedUrl(item.url || item.normalizedUrl || '') })
      ]),
      el('span', { className: `badge ${capabilityTone(capability.key)}`, text: capability.label })
    ]),
    chipRow(candidateChips(item, capability)),
    infoGrid(candidateFacts(item).slice(0, 8))
  );
  if (capability.reason || decision.reason) card.append(el('p', { className: 'subtitle', text: capability.reason || decision.reason }));

  const actions = el('div', { className: 'action-row' });
  if (item.mediaType === MEDIA_TYPES.HLS) {
    for (const action of HLS_ACTIONS) {
      const methodDecision = downloadDecisionFor(item, state.settings || {}, action.method);
      actions.append(button(action.shortLabel, action.method === hlsMethodForPrimary(item) ? 'primary' : 'ghost', () => startDownload(item, action.method), !methodDecision.allowed));
    }
  } else {
    actions.append(button(capability.key === 'manifest' ? 'Save manifest' : 'Download', 'primary', () => startDownload(item), !decision.allowed));
  }
  actions.append(button(state.rawReveals.has(item.id) ? 'Hide raw URL' : 'Reveal raw URL', 'ghost', () => toggleRaw(item.id)));
  card.append(actions);
  if (state.rawReveals.has(item.id)) card.append(el('div', { className: 'raw-url', text: item.url || item.normalizedUrl || 'No raw URL available.' }));
  return card;
}

function candidateChips(item, capability) {
  const chips = [[item.mediaType || 'media', 'info']];
  if (item.extension) chips.push([`.${item.extension}`, '']);
  if (item.variants?.length) chips.push([`${item.variants.length} variants`, 'success']);
  if (item.representations?.length) chips.push([`${item.representations.length} reps`, 'success']);
  if (item.isProtected) chips.push(['limitation', 'danger']);
  if (capability.key === 'downloadable' || capability.key === 'convertible') chips.push(['safe action', 'success']);
  return chips;
}

function compatibilityPanel(items = []) {
  const counts = items.reduce((acc, item) => {
    const key = classifyCandidate(item, state.settings || {}).key;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return el('section', { className: 'card' }, [
    heading('Compatibility summary', 'Actions are disabled unless freshness, capability, permission, source availability, and browser download state are safe.'),
    infoGrid([
      ['Downloadable', counts.downloadable || 0],
      ['Convertible', counts.convertible || 0],
      ['Manifest only', counts.manifest || 0],
      ['Unsupported', counts.unsupported || 0]
    ])
  ]);
}

function manualHlsPanel() {
  if (!state.settings?.showManualM3u8Converter) {
    return el('section', { className: 'notice' }, [
      el('strong', { text: 'Manual HLS converter hidden by setting.' }),
      el('p', { text: 'Enable it in Options > General only when you need to validate a user-supplied .m3u8 URL. Detected candidates remain safer and preferred.' })
    ]);
  }
  const method = state.manualMethod || state.settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4;
  let validateButton = null;
  const urlInput = input('url', state.manualUrl, 'https://example.com/video/index.m3u8', (value) => {
    state.manualUrl = value;
    if (validateButton) validateButton.disabled = !String(value || '').trim();
  }, 'manual-hls-url');
  urlInput.setAttribute('aria-label', 'Manual HLS playlist URL');
  const nameInput = input('text', state.manualName, 'Optional filename label', (value) => { state.manualName = value; }, 'manual-hls-name');
  nameInput.setAttribute('aria-label', 'Optional manual HLS filename label');
  const methodSelect = select(method, HLS_ACTIONS.map((action) => [action.method, action.label]), (value) => { state.manualMethod = value; }, 'manual-hls-method');
  methodSelect.setAttribute('aria-label', 'Manual HLS output method');
  validateButton = button('Validate and queue manual HLS', 'primary', startManualHls, !String(state.manualUrl || '').trim());
  return el('section', { className: 'card manual-hls-panel' }, [
    heading('Manual HLS validation', 'Advanced route for a user-supplied .m3u8 URL. It does not probe hidden pages and it stops on encryption, auth, CORS, signed/expiring links, or unsupported layouts.'),
    el('div', { className: 'manual-grid' }, [
      el('label', {}, [el('span', { text: 'Playlist URL' }), urlInput]),
      el('label', {}, [el('span', { text: 'Filename label' }), nameInput]),
      el('label', {}, [el('span', { text: 'Output method' }), methodSelect])
    ]),
    state.manualStatus ? el('p', { className: 'notice', text: state.manualStatus }) : null,
    el('div', { className: 'action-row' }, [
      validateButton,
      button('Clear manual fields', 'ghost', clearManualHls, !state.manualUrl && !state.manualName)
    ])
  ].filter(Boolean));
}

function renderQueue(root) {
  const queue = normalizeQueue(state.queue);
  const tasks = queueTaskList(queue);
  root.replaceChildren(
    el('section', { className: 'card' }, [
      heading('Queue', 'Active and recent jobs across tabs with browser-state reconciliation.'),
      chipRow([[queue.paused ? 'Paused' : 'Running', queue.paused ? 'warning' : 'success'], [`${tasks.length} visible task(s)`, 'info']]),
      el('div', { className: 'action-row' }, [
        button(queue.paused ? 'Resume queue' : 'Pause queue', 'ghost', toggleQueuePaused),
        button('Clear finished', 'ghost', clearSettledQueue, !hasSettled(queue))
      ])
    ]),
    tasks.length ? el('section', { className: 'queue-list' }, tasks.map(queueCard)) : emptyNotice('Queue is idle. Downloads started from Popup, Inspector, or Batch appear here.')
  );
}

function queueCard(task = {}) {
  const tone = statusTone(task.status);
  const card = el('article', { className: 'queue-card' });
  const pct = Math.max(0, Math.min(100, Number(task.progress?.percent) || 0));
  card.append(
    el('div', { className: 'queue-topline' }, [
      el('div', {}, [
        el('h3', { text: task.displayName || task.filename || task.mediaTitle || 'Download task' }),
        el('p', { className: 'subtitle', text: taskVisibleCopy(task) })
      ]),
      el('span', { className: `badge ${tone}`, text: statusLabel(task.status) })
    ])
  );
  if (task.progress) card.append(el('div', { className: 'progress-track', attrs: { role: 'progressbar', 'aria-label': `Download progress for ${task.displayName || task.filename || task.mediaTitle || 'media'}`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)), 'aria-valuetext': `${Math.round(pct)} percent` } }, [el('div', { className: 'progress-bar', style: { width: `${pct}%` } })]));
  if (task.progress?.detail) card.append(el('p', { className: 'subtitle', text: task.progress.detail }));
  if (task.lastError?.message) card.append(el('p', { className: 'notice danger', text: task.lastError.message }));
  card.append(el('ol', { className: 'timeline' }, [
    el('li', { text: `State: ${taskVisibleCopy(task)}` }),
    el('li', { text: task.sourceLost ? 'Source tab lost; rescan before retry.' : 'Source page evidence retained while available.' }),
    el('li', { text: task.status === DOWNLOAD_STATUSES.VERIFY_UNCERTAIN ? 'Browser save was handed off; verify the final file in browser Downloads.' : (task.downloadId ? `Browser download id available.` : 'Browser download state pending or unavailable.') })
  ]));
  const actions = el('div', { className: 'action-row' });
  if ([DOWNLOAD_STATUSES.ACTIVE, DOWNLOAD_STATUSES.QUEUED, DOWNLOAD_STATUSES.CONVERTING, DOWNLOAD_STATUSES.RETRIED].includes(task.status)) actions.append(button('Cancel', 'danger', () => cancelDownload(task.id)));
  if (task.status === DOWNLOAD_STATUSES.FAILED && task.canRetry !== false) actions.append(button('Retry', 'primary', () => retryDownload(task.id)));
  if (task.status === DOWNLOAD_STATUSES.VERIFY_UNCERTAIN || (task.status === DOWNLOAD_STATUSES.COMPLETED && !task.downloadId && task.result)) actions.append(button('Open browser downloads', 'ghost', openBrowserDownloads));
  if (actions.childNodes.length) card.append(actions);
  return card;
}

function renderBatch(root) {
  const batch = state.episodeBatch || { episodes: [] };
  const episodes = Array.isArray(batch.episodes) ? batch.episodes : [];
  const ready = Math.max(0, episodes.length);
  root.replaceChildren(
    el('section', { className: 'card' }, [
      heading('Batch preview', 'Dry-run same-series episode links before any background tab is opened.'),
      el('p', { text: batch.message || 'No same-series episode links have been discovered for this tab yet.' }),
      infoGrid([
        ['Ready to scan', ready],
        ['Will skip unsupported', batch.failedCount || 0],
        ['Needs confirmation', ready > Number(state.settings?.confirmLargeEpisodeBatchThreshold || 8) ? 1 : 0],
        ['Filename changes', 'Previewed after each episode scan']
      ]),
      el('div', { className: 'action-row' }, [
        button('Refresh episode list', 'ghost', refreshEpisodeBatch),
        button(`Download ${ready} ready item${ready === 1 ? '' : 's'}`, 'primary', startEpisodeBatch, ready < 2),
        button('Inspect skipped', 'ghost', () => navigate('inspector'))
      ])
    ]),
    episodes.length ? el('ul', { className: 'batch-list' }, episodes.slice(0, 80).map((episode) => el('li', {}, [
      el('strong', { text: `Episode ${episode.episodeNumber}` }),
      el('p', { text: `${episode.title || 'Untitled'} • ${redactedUrl(episode.url)}` })
    ]))) : emptyNotice('Batch requires visible same-series links. It does not brute-force hidden episode numbers.')
  );
}

function renderReports(root) {
  const report = state.report;
  root.replaceChildren(
    el('section', { className: 'card' }, [
      heading('Report preview', 'Every export is local, reviewable, and redacted by default.'),
      el('p', { className: 'notice warning', text: 'Page titles, hostnames, filenames, and URLs can identify private activity. Build the preview, inspect the exposure table and literal contents, then export only if the bundle is appropriate to share.' }),
      el('ul', { className: 'checklist' }, [
        checklistItem('Default', 'Titles and filenames omitted; hostnames and URL paths replaced by correlation hashes; query names and values omitted.'),
        checklistItem('Always redacted', 'URL credentials, local paths, blob identifiers, and secret-shaped fields or query parameters.'),
        checklistItem('Included', 'Candidate/queue evidence, diagnostics, permissions, extension/browser/platform details, and retention notes.'),
        checklistItem('Never included', 'Screenshots.'),
        checklistItem('Sensitive URL mode', 'Exact titles, hostnames, filenames, URL paths, and non-secret query values after a separate confirmation.')
      ]),
      checkbox('includeSensitive', state.reportIncludeSensitive, 'Use sensitive URL mode after confirmation', (checked) => {
        state.reportIncludeSensitiveTouched = true;
        state.reportIncludeSensitive = checked;
        invalidateReportPreview('The report sensitivity option changed after the preview was built.');
        scheduleRender();
      }),
      el('div', { className: 'action-row' }, [
        button('Build preview', 'primary', buildReportPreview),
        button('Export ZIP', 'ghost', exportReport, !report?.files?.length)
      ])
    ]),
    report ? reportPreview(report) : emptyNotice(state.reportInvalidationReason || 'Build a preview before exporting. Export stays disabled until the exposure table and literal file contents are available for review.')
  );
}

function checklistItem(label, text) {
  return el('li', {}, [el('strong', { text: `${label}: ` }), el('span', { text })]);
}

function reportPreview(report = {}) {
  const summary = report.summary || {};
  const files = report.files || [];
  const query = String(state.reportSearch || '').trim().toLowerCase();
  const matchingFiles = query
    ? files.filter((file) => `${file.path || ''}\n${String(file.content ?? '')}`.toLowerCase().includes(query))
    : files;
  return el('section', { className: 'card' }, [
    heading('Preview ready', `${summary.redacted ? 'Default redacted' : 'Sensitive URL'} report • ${summary.fileCount ?? files.length} files • ${formatBytes(summary.totalBytes ?? files.reduce((sum, file) => sum + reportFileByteLength(file.content), 0))}.`),
    chipRow([
      [summary.redacted ? 'Redacted' : 'Sensitive URLs', summary.redacted ? 'success' : 'warning'],
      [`${summary.detectedMediaCount ?? 0} candidates`, 'info'],
      [`${summary.decisionCount ?? 0} decisions`, 'info'],
      ['No screenshots', 'success']
    ]),
    exposureTable(report.exposure || []),
    el('div', { className: 'report-retention notice' }, [
      el('strong', { text: 'Retention and cleanup' }),
      el('p', { text: 'This preview remains only in this open extension page and is invalidated when report inputs change. Media Scout does not retain an exported ZIP; after download, delete the file manually when it is no longer needed. Queue history follows the configured local retention period and can be cleared from Diagnostics.' })
    ]),
    el('label', { className: 'report-search-label' }, [
      el('span', { text: 'Search preview contents' }),
      input('search', state.reportSearch, 'Search filenames and exact text…', (value) => {
        state.reportSearch = value;
        scheduleRender();
      }, 'report-search')
    ]),
    el('p', { className: 'report-match-count', text: query ? `${matchingFiles.length} of ${files.length} files match. Clear the search to inspect every file.` : `${files.length} files. Text below is selectable and is rendered as literal text, never as HTML.` }),
    matchingFiles.length
      ? el('div', { className: 'report-file-list' }, matchingFiles.map((file, index) => reportFileDisclosure(file, index, Boolean(query))))
      : el('p', { className: 'notice warning', text: 'No preview file contains that search text.' })
  ]);
}

function exposureTable(exposure = []) {
  return el('div', { className: 'report-exposure-wrap' }, [
    el('h3', { text: 'Data exposure for this exact preview' }),
    el('table', { className: 'report-exposure' }, [
      el('thead', {}, [el('tr', {}, [el('th', { attrs: { scope: 'col' }, text: 'Field' }), el('th', { attrs: { scope: 'col' }, text: 'Handling' }), el('th', { attrs: { scope: 'col' }, text: 'What that means' })])]),
      el('tbody', {}, exposure.map((item) => el('tr', {}, [
        el('th', { attrs: { scope: 'row' }, text: item.label || item.id || 'Field' }),
        el('td', {}, [el('span', { className: `badge ${exposureTone(item.handling)}`, text: exposureHandlingLabel(item.handling) })]),
        el('td', { text: item.detail || '' })
      ])))
    ])
  ]);
}

function reportFileDisclosure(file = {}, index = 0, searchActive = false) {
  const path = file.path || file.name || `report-file-${index + 1}.txt`;
  return el('details', { className: 'report-file', attrs: { open: searchActive || index === 0 } }, [
    el('summary', {}, [
      el('strong', { text: path }),
      el('span', { className: 'badge info', text: `${formatBytes(reportFileByteLength(file.content))} • literal text` })
    ]),
    el('pre', { className: 'report-file-content', text: String(file.content ?? ''), attrs: { tabindex: '0', 'aria-label': `${path} preview content` } })
  ]);
}

function exposureHandlingLabel(handling = '') {
  return String(handling || 'unknown').replace(/-/g, ' ');
}

function exposureTone(handling = '') {
  if (['omitted', 'redacted', 'hashed'].includes(handling)) return 'success';
  if (String(handling).includes('sensitive') || handling === 'included') return 'warning';
  return 'info';
}

function renderDiagnostics(root) {
  const diagnostics = state.diagnostics || {};
  root.replaceChildren(
    el('section', { className: 'card' }, [
      heading('Diagnostics', 'Repair and evidence actions live here, away from the routine popup.'),
      infoGrid([
        ['Extension version', chrome.runtime.getManifest()?.version || 'unknown'],
        ['Strategies learned', Object.keys(diagnostics.strategies || {}).length],
        ['Error categories', Object.keys(diagnostics.errors || {}).length],
        ['Permission', state.siteAccess?.granted ? 'site granted' : 'basic only']
      ]),
      el('div', { className: 'action-row' }, [
        button('Run self-tests', 'primary', runSelfTests),
        button('Clear detected cache', 'ghost', () => action(MESSAGE_TYPES.CLEAR_DETECTED_CACHE, 'Detected media cache cleared.')),
        button('Clear queue history', 'ghost', () => action(MESSAGE_TYPES.CLEAR_QUEUE_HISTORY, 'Queue history cleared.')),
        button('Reset learning data', 'ghost', () => action(MESSAGE_TYPES.RESET_DIAGNOSTICS, 'Local learning data reset.')),
        button('Refresh + reload extension', 'danger', refreshPageAndReloadExtension)
      ])
    ]),
    el('section', { id: 'diagnosticOutput', className: 'card' }, [heading('Output', 'Run a diagnostic action to see local results.'), el('pre', { text: '' })])
  );
}

function renderHelp(root) {
  root.replaceChildren(
    el('section', { className: 'card' }, [
      heading('Help and limitations', 'Media Scout uses normal browser access only.'),
      el('p', { text: 'Download and conversion actions are only shown when a candidate is fresh, supported, permission-satisfied, source-available, not expired, not a duplicate suppression, and allowed by the browser download state.' }),
      el('p', { text: 'Encrypted HLS, DRM-protected streams, authenticated or signed short-lived links, browser-blocked pages, unsupported fMP4/CMAF layouts, and blocked CORS/auth requests are explained as limitations. Media Scout does not attempt bypass behavior.' }),
      el('p', { text: 'Raw URLs can contain private tokens. The popup never shows them, Inspector reveals them only after an explicit action, and reports are redacted by default.' })
    ]),
    el('section', { className: 'card' }, [
      heading('Restricted pages', 'Chrome blocks extension scanning on browser pages.'),
      el('p', { text: 'chrome://, Web Store pages, some PDFs, file:// without access, data/blob pages, and pages with inaccessible frames can limit scanning. Use Help, Options, or Report Preview to collect redacted evidence.' })
    ])
  );
}

async function runModelPrimary(model) {
  if (model.kind === 'permission') return requestCurrentSiteAccess();
  if (model.kind === 'ready-direct' && model.candidate) return startDownload(model.candidate);
  if (model.kind === 'ready-hls' && model.candidate) return startDownload(model.candidate, hlsMethodForPrimary(model.candidate));
  if (model.kind === 'needs-playback') return loadState(MESSAGE_TYPES.HARD_RESCAN_ACTIVE_TAB, { reason: 'needs-playback' }, 'Rescanning the current page…');
  if (model.kind === 'queue-active') return navigate('queue');
  if (model.kind === 'restricted') return navigate('help');
  return navigate('inspector');
}

async function runModelSecondary(model) {
  if (model.kind === 'needs-playback' && /^Allow on this site/i.test(model.secondary || '')) return requestCurrentSiteAccess();
  if (model.kind === 'restricted') return openOptions();
  if (model.kind === 'unsupported') return navigate('reports');
  return navigate('inspector');
}

async function requestCurrentSiteAccess() {
  const origin = state.siteAccess?.origin;
  if (!origin) return setStatus('No current-site origin is available for permission request.');
  let granted = false;
  try {
    if (chrome.permissions?.request) {
      granted = await chrome.permissions.request({ origins: [origin] });
    } else {
      const response = await sendMessage({ type: MESSAGE_TYPES.REQUEST_SITE_ACCESS, origin });
      granted = Boolean(response.granted);
    }
  } catch (error) {
    setStatus(error?.message || 'Chrome could not show the site-access prompt.');
    scheduleRender();
    return false;
  }
  state.siteAccess = { origin, granted };
  setStatus(granted ? 'Site access granted. Refreshing evidence…' : 'Site access was not granted. Basic active-tab scan remains available.');
  if (granted) await loadState(MESSAGE_TYPES.GET_ACTIVE_TAB_STATE, { forceInject: true, reason: 'site-access-granted' }, 'Refreshing evidence…');
  else scheduleRender();
  return granted;
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
  if (capability.key === 'stale' || capability.key === 'expired') return setStatus(capability.reason || 'Rescan this page before starting the download.');
  const decision = downloadDecisionFor(item, state.settings || {}, method);
  if (!decision.allowed) return setStatus(decision.reason || 'This candidate is not available for a safe action.');
  if (method === HLS_OUTPUT_METHODS.EXTERNAL_HELPER) {
    const confirmed = confirm('Create external-helper notes? The text file includes the playlist URL so a separate local tool can use it. Do not export it if the URL is private.');
    if (!confirmed) return setStatus('External-helper notes canceled.');
  }
  const tabId = Number.isInteger(item?.tabId) ? item.tabId : state.tab?.id;
  const response = await sendMessage({ type: MESSAGE_TYPES.START_DOWNLOAD, tabId, mediaId: item.id, hlsOutputMethod: method });
  state.queue = normalizeQueue(response.queue || state.queue);
  setStatus(response.task?.duplicateOf ? 'That media is already active or queued with the same method.' : 'Download queued.');
  scheduleRender();
}

async function cancelDownload(taskId) {
  const response = await sendMessage({ type: MESSAGE_TYPES.CANCEL_DOWNLOAD, taskId });
  state.queue = normalizeQueue(response.queue || state.queue);
  setStatus(response.canceled ? 'Download canceled.' : 'No matching task was found.');
  scheduleRender();
}

async function retryDownload(taskId) {
  const response = await sendMessage({ type: MESSAGE_TYPES.RETRY_DOWNLOAD, taskId });
  state.queue = normalizeQueue(response.queue || state.queue);
  setStatus(response.task ? 'Retry queued.' : 'Retry is unavailable for this restored or unsafe task. Rescan and queue from fresh evidence.');
  scheduleRender();
}

async function toggleQueuePaused() {
  const queue = normalizeQueue(state.queue);
  const response = await sendMessage({ type: queue.paused ? MESSAGE_TYPES.RESUME_QUEUE : MESSAGE_TYPES.PAUSE_QUEUE });
  state.queue = normalizeQueue(response.queue || state.queue);
  setStatus(state.queue.paused ? 'Queue paused.' : 'Queue resumed.');
  scheduleRender();
}

async function clearSettledQueue() {
  const response = await sendMessage({ type: MESSAGE_TYPES.CLEAR_SETTLED_QUEUE });
  state.queue = normalizeQueue(response.queue || state.queue);
  setStatus('Finished queue items cleared.');
  scheduleRender();
}

async function refreshEpisodeBatch() {
  const response = await sendMessage({ type: MESSAGE_TYPES.DISCOVER_EPISODE_BATCH });
  state.episodeBatch = response.episodeBatch || state.episodeBatch;
  if (response.settings) state.settings = response.settings;
  setStatus(state.episodeBatch?.message || 'Episode list refreshed.');
  scheduleRender();
}

async function startEpisodeBatch() {
  const episodes = state.episodeBatch?.episodes || [];
  if (episodes.length < 2) return setStatus('No same-series episode list is available.');
  if (state.siteAccess?.origin && state.siteAccess.granted === false) {
    const granted = await requestCurrentSiteAccess();
    if (!granted) return setStatus('Batch download needs site access so background episode tabs can be scanned.');
  }
  const threshold = Number(state.settings?.confirmLargeEpisodeBatchThreshold) || 8;
  if (episodes.length > threshold && !confirm(`Download all ${episodes.length} detected episode page(s)? Media Scout will open background tabs in small batches after this preview.`)) {
    return setStatus('Batch canceled before opening background tabs.');
  }
  const method = state.settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4;
  if (method === HLS_OUTPUT_METHODS.EXTERNAL_HELPER && !confirm('Create external-helper notes for each ready batch item? These text files include playlist URLs. Do not export them if the URLs are private.')) {
    return setStatus('Batch external-helper handoff canceled.');
  }
  const response = await sendMessage({ type: MESSAGE_TYPES.START_EPISODE_BATCH_DOWNLOADS, episodes, hlsOutputMethod: method });
  state.episodeBatch = response.episodeBatch || state.episodeBatch;
  state.queue = normalizeQueue(response.queue || state.queue);
  setStatus(`${response.episodeBatch?.queuedCount || 0} episode download(s) queued.`);
  scheduleRender();
}

async function startManualHls() {
  const url = String(state.manualUrl || '').trim();
  if (!url) return setStatus('Enter a .m3u8 playlist URL first.');
  const method = state.manualMethod || state.settings?.hlsOutputMethod || HLS_OUTPUT_METHODS.SMART_MP4;
  if (method === HLS_OUTPUT_METHODS.EXTERNAL_HELPER && !confirm('Create external-helper notes? The text file includes the playlist URL so a separate local tool can use it. Do not export it if the URL is private.')) {
    return setStatus('External-helper notes canceled.');
  }
  state.manualStatus = 'Validating manual HLS URL through the source tab context…';
  scheduleRender();
  const response = await sendMessage({
    type: MESSAGE_TYPES.CONVERT_M3U8_TO_MP4,
    url,
    filename: String(state.manualName || '').trim(),
    hlsOutputMethod: method
  });
  state.queue = normalizeQueue(response.queue || state.queue);
  if (Array.isArray(response.mediaItems)) mergeMediaItems(response.mediaItems);
  state.manualStatus = response.task?.duplicateOf ? 'That manual HLS job is already active or queued.' : 'Manual HLS job queued. Open Queue for progress.';
  setStatus(state.manualStatus);
  scheduleRender();
}

function clearManualHls() {
  state.manualUrl = '';
  state.manualName = '';
  state.manualStatus = '';
  scheduleRender();
}

async function buildReportPreview() {
  if (state.reportIncludeSensitive && !confirm('Build a sensitive URL report? Exact page titles, hostnames, filenames, URL paths, and non-secret query values may appear. URL credentials and secret-shaped fields remain redacted.')) {
    state.reportIncludeSensitive = false;
  }
  setStatus('Building local report preview…');
  const response = await sendMessage({ type: MESSAGE_TYPES.GENERATE_REPORT, includeSensitiveUrls: Boolean(state.reportIncludeSensitive) });
  if (!response.report?.files?.length) throw new Error('Report generation returned no files.');
  state.report = response.report;
  state.reportSearch = '';
  state.reportInvalidationReason = '';
  state.reportIncludeSensitive = response.report.summary?.mode === 'sensitive-urls';
  setStatus(`${response.report.summary?.redacted ? 'Default redacted' : 'Sensitive URL'} preview ready. Inspect the exposure table and literal contents before exporting.`);
  scheduleRender();
}

async function exportReport() {
  if (!state.report?.files?.length) return setStatus('Build a report preview first.');
  const preview = state.report;
  const files = normalizeZipEntries(preview.files);
  const currentDigest = reportFilesDigest(files);
  if (!preview.previewDigest || currentDigest !== preview.previewDigest) {
    invalidateReportPreview('The previewed file set changed before export. Build and review a new preview.');
    scheduleRender();
    return setStatus('Export blocked because the preview no longer matches the file set.');
  }
  const validation = await sendMessage({
    type: MESSAGE_TYPES.VALIDATE_REPORT_PREVIEW,
    context: preview.context,
    previewDigest: currentDigest,
    previewToken: preview.previewToken,
    generatedAt: preview.generatedAt
  });
  if (!validation.valid) {
    invalidateReportPreview(validation.reason || 'Report inputs changed after the preview was built.');
    scheduleRender();
    return setStatus(validation.reason || 'Export blocked. Build and review a fresh preview.');
  }
  if (state.report !== preview || reportFilesDigest(normalizeZipEntries(preview.files)) !== currentDigest) {
    invalidateReportPreview('Report inputs changed during export validation. Build and review a fresh preview.');
    scheduleRender();
    return setStatus('Export blocked because the preview changed during validation.');
  }
  const blob = createZipBlob(files);
  await saveBlob(blob, preview.filename || 'media-scout-redacted-report.zip');
  setStatus('Report ZIP export requested through the browser downloads UI.');
}

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename, saveAs: true, conflictAction: 'uniquify' }, (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(downloadId);
      });
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

async function runSelfTests() {
  const response = await sendMessage({ type: MESSAGE_TYPES.RUN_SELF_TESTS });
  const output = byId('diagnosticOutput')?.querySelector('pre');
  if (output) output.textContent = JSON.stringify(response.selfTests || response, null, 2);
  setStatus(response.selfTests?.passed === true ? 'Self-tests passed.' : 'Self-tests returned failures.');
}

async function action(type, successText) {
  const response = await sendMessage({ type });
  setStatus(response?.ok === false ? response.error || 'Action failed.' : successText);
  if (type === MESSAGE_TYPES.RESET_DIAGNOSTICS && response.diagnostics) state.diagnostics = response.diagnostics;
  if ([MESSAGE_TYPES.CLEAR_DETECTED_CACHE, MESSAGE_TYPES.CLEAR_QUEUE_HISTORY, MESSAGE_TYPES.RESET_DIAGNOSTICS].includes(type)) {
    invalidateReportPreview('Local report evidence was cleared or reset after the preview was built.');
  }
  scheduleRender();
}

async function refreshPageAndReloadExtension() {
  const phrase = prompt('Type RELOAD to refresh the active page and reload the extension. This is a diagnostics-only repair action.');
  if (phrase !== 'RELOAD') return setStatus('Reload action canceled.');
  const response = await sendMessage({ type: MESSAGE_TYPES.RELOAD_EXTENSION_AND_REFRESH_PAGE });
  setStatus(`Refresh requested. Update check: ${response.updateStatus || 'unknown'}.`);
}

function toggleRaw(id) {
  if (!id) return;
  if (state.rawReveals.has(id)) state.rawReveals.delete(id);
  else {
    const confirmed = confirm('Reveal raw URL? Media URLs may contain signatures, tokens, or private page context. Copy redacted evidence by default.');
    if (!confirmed) return;
    state.rawReveals.add(id);
  }
  scheduleRender();
}

function openBrowserDownloads() {
  chrome.tabs?.create?.({ url: 'chrome://downloads/' });
}

function navigate(route) {
  state.route = SIDE_PANEL_ROUTES.has(route) ? route : 'home';
  const sourceParam = state.sourceTabId != null ? `?sourceTabId=${encodeURIComponent(String(state.sourceTabId))}` : '';
  history.replaceState(null, '', `#/${state.route}${sourceParam}`);
  scheduleRender();
}

function routeFromHash() {
  const route = String(location.hash || '').replace(/^#\/?/, '').split(/[?&]/)[0] || 'home';
  return SIDE_PANEL_ROUTES.has(route) ? route : 'home';
}

async function hydrateLaunchIntent() {
  try {
    const stored = await chrome.storage?.session?.get?.(SIDE_PANEL_ROUTE_KEY);
    const intent = stored?.[SIDE_PANEL_ROUTE_KEY];
    applyLaunchIntent(intent);
    if (intent) await chrome.storage?.session?.remove?.(SIDE_PANEL_ROUTE_KEY);
  } catch (_error) {
    // Hash-based context still works when storage.session is unavailable.
  }
}

function applyLaunchIntent(intent = {}) {
  if (!intent || typeof intent !== 'object') return false;
  const recent = !intent.createdAt || Math.abs(Date.now() - Number(intent.createdAt)) < 10 * 60_000;
  if (!recent) return false;
  let changed = false;
  if (SIDE_PANEL_ROUTES.has(intent.route) && intent.route !== state.route) {
    state.route = intent.route;
    changed = true;
  }
  const id = Number.parseInt(intent.sourceTabId, 10);
  if (Number.isInteger(id) && id >= 0 && id !== state.sourceTabId) {
    state.sourceTabId = id;
    changed = true;
  }
  if (changed) navigate(state.route);
  return changed;
}

function sourceTabIdFromLocation() {
  const text = `${location.hash || ''}${location.search || ''}`;
  const match = /[?&]sourceTabId=(\d+)/.exec(text);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function isExtensionPageUrl(rawUrl = '') {
  try {
    return new URL(rawUrl).origin === new URL(chrome.runtime.getURL('')).origin;
  } catch (_error) {
    return false;
  }
}

function routeLabel(route) {
  return {
    home: 'Home',
    inspector: 'Inspector',
    queue: 'Queue',
    batch: 'Batch Preview',
    reports: 'Report Preview',
    diagnostics: 'Diagnostics',
    help: 'Help'
  }[route] || 'Workspace';
}

async function openOptions() {
  if (chrome.runtime.openOptionsPage) await chrome.runtime.openOptionsPage();
  else await chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
}

function statusFromScan(response = {}) {
  const count = Array.isArray(response.mediaItems) ? response.mediaItems.length : state.mediaItems.length;
  if (response.scan?.ok === false) return response.scan.message || 'Scanner could not run on this page.';
  if (count) return `${count} candidate${count === 1 ? '' : 's'} available. Workspace updated.`;
  return 'No media request yet. Play the page media, then rescan.';
}

function toolbar(children = []) { return el('div', { className: 'toolbar' }, children); }
function heading(title, copy = '') {
  return el('div', { className: 'card-heading' }, [
    el('div', {}, [el('h2', { text: title }), copy ? el('p', { text: copy }) : null].filter(Boolean))
  ]);
}
function metricsCard(rows = []) { return el('section', { className: 'card' }, [heading('Snapshot', 'Current truth model across candidates, queue, and batch.'), el('div', { className: 'metric-grid' }, rows.map(([label, value]) => el('div', {}, [el('strong', { text: String(value) }), el('span', { text: label })]))) ]); }
function chipRow(items = []) { return el('div', { className: 'chip-row' }, items.map(([text, tone]) => el('span', { className: `chip ${tone || ''}`.trim(), text }))); }
function infoGrid(rows = []) { return el('dl', { className: 'info-grid' }, rows.filter(([, value]) => value != null && value !== '').map(([label, value]) => el('div', {}, [el('dt', { text: label }), el('dd', { text: String(value) })]))); }
function emptyNotice(text) { return el('section', { className: 'notice warning' }, [el('p', { text })]); }
function button(text, style = '', handler = () => undefined, disabled = false) {
  const btn = el('button', { className: `button ${style || ''}`.trim(), text });
  btn.type = 'button';
  btn.disabled = Boolean(disabled);
  btn.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (btn.disabled) return;
    btn.disabled = true;
    try { await handler(event); }
    catch (error) { setStatus(error?.message || 'Action failed.'); }
    finally { btn.disabled = Boolean(disabled); }
  });
  return btn;
}
function input(type, value, placeholder, onInput, focusKey = '') {
  const element = el('input', { attrs: { type, placeholder, value } });
  if (focusKey) element.dataset.focusKey = focusKey;
  element.addEventListener('input', () => onInput(element.value, element));
  return element;
}
function select(value, options, onChange, focusKey = '') {
  const element = el('select');
  if (focusKey) element.dataset.focusKey = focusKey;
  for (const [val, label] of options) element.append(el('option', { text: label, attrs: { value: val, selected: val === value } }));
  element.addEventListener('change', () => onChange(element.value, element));
  return element;
}
function checkbox(id, checked, labelText, onChange) {
  const inputEl = el('input', { attrs: { id, type: 'checkbox' } });
  inputEl.checked = Boolean(checked);
  inputEl.addEventListener('change', () => onChange(inputEl.checked));
  return el('label', { className: 'notice' }, [inputEl, el('span', { text: ` ${labelText}` })]);
}
function capabilityTone(key) {
  if (key === 'downloadable' || key === 'convertible') return 'success';
  if (key === 'manifest' || key === 'permission') return 'warning';
  if (key === 'unsupported' || key === 'expired') return 'danger';
  return 'info';
}
function hasSettled(queue = {}) {
  const q = normalizeQueue(queue);
  return Boolean(q.completed.length || q.failed.length || q.canceled.length);
}
function setStatus(text) { if (els.workspaceStatus) els.workspaceStatus.textContent = text || ''; }
function byId(id) { return document.getElementById(id); }
function el(tag, options = {}, children = []) {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text != null) element.textContent = options.text;
  if (options.style) Object.assign(element.style, options.style);
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === false || value == null) continue;
      if (value === true) element.setAttribute(key, '');
      else element.setAttribute(key, String(value));
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) if (child) element.append(child);
  return element;
}
