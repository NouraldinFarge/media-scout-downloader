import {
  DEFAULT_SETTINGS,
  DUPLICATE_BEHAVIORS,
  IMPLEMENTED_HLS_OUTPUT_METHODS,
  HLS_WORK_MODES,
  HLS_VARIANT_PREFERENCES,
  MAX_PARALLEL_MAX,
  MAX_PARALLEL_MIN,
  MESSAGE_TYPES
} from '../shared/constants.js';
import { MEDIA_TYPE_REGISTRY } from '../shared/media-type-registry.js';

const els = {
  fileTypes: byId('fileTypes'),
  fileTypeSearch: byId('fileTypeSearch'),
  maxParallelDownloads: byId('maxParallelDownloads'),
  duplicateBehavior: byId('duplicateBehavior'),
  segmentParallelism: byId('segmentParallelism'),
  segmentRetryLimit: byId('segmentRetryLimit'),
  episodeBatchScanParallelism: byId('episodeBatchScanParallelism'),
  confirmLargeEpisodeBatchThreshold: byId('confirmLargeEpisodeBatchThreshold'),
  hlsOutputMethod: byId('hlsOutputMethod'),
  hlsWorkMode: byId('hlsWorkMode'),
  hlsVariantPreference: byId('hlsVariantPreference'),
  showManualM3u8Converter: byId('showManualM3u8Converter'),
  includeSensitiveUrlsInReports: byId('includeSensitiveUrlsInReports'),
  queueHistoryRetentionDays: byId('queueHistoryRetentionDays'),
  filenameTemplate: byId('filenameTemplate'),
  preferredSubfolder: byId('preferredSubfolder'),
  notifications: byId('notifications'),
  debugLogs: byId('debugLogs'),
  status: byId('status'),
  changeStateLabel: byId('changeStateLabel'),
  testResults: byId('testResults'),
  duplicateConsequence: byId('duplicateConsequence'),
  permissionHealth: byId('permissionHealth'),
  streamCapabilityPreview: byId('streamCapabilityPreview'),
  filenameDryRun: byId('filenameDryRun'),
  copySupportSummary: byId('copySupportSummary'),
  save: byId('save'),
  clearCache: byId('clearCache'),
  resetDiagnostics: byId('resetDiagnostics'),
  runSelfTests: byId('runSelfTests'),
  grantAllSiteAccess: byId('grantAllSiteAccess'),
  revokeAllSiteAccess: byId('revokeAllSiteAccess'),
  clearQueueHistory: byId('clearQueueHistory'),
  enableCoreTypes: byId('enableCoreTypes'),
  enableAllTypes: byId('enableAllTypes'),
  disableMetadataTypes: byId('disableMetadataTypes')
};

let settings = DEFAULT_SETTINGS;
let dirty = false;

renderFileTypeControls();
wireControls();
load();

function wireControls() {
  els.save?.addEventListener('click', save);
  els.clearCache?.addEventListener('click', () => action(MESSAGE_TYPES.CLEAR_DETECTED_CACHE, 'Detected media cache cleared.'));
  els.resetDiagnostics?.addEventListener('click', () => action(MESSAGE_TYPES.RESET_DIAGNOSTICS, 'Local learning data reset.'));
  els.runSelfTests?.addEventListener('click', runSelfTests);
  els.grantAllSiteAccess?.addEventListener('click', grantAllSiteAccess);
  els.revokeAllSiteAccess?.addEventListener('click', revokeAllSiteAccess);
  els.clearQueueHistory?.addEventListener('click', () => action(MESSAGE_TYPES.CLEAR_QUEUE_HISTORY, 'Queue history cleared.'));
  els.enableCoreTypes?.addEventListener('click', () => setTypePreset(coreMediaExtensions()));
  els.enableAllTypes?.addEventListener('click', () => setAllTypeCheckboxes(true));
  els.disableMetadataTypes?.addEventListener('click', disableMetadataTypes);
  els.fileTypeSearch?.addEventListener('input', filterFileTypes);
  els.copySupportSummary?.addEventListener('click', copySupportSummaryText);
  for (const control of document.querySelectorAll('input:not(#fileTypeSearch), select:not(:disabled)')) {
    control.addEventListener('input', markDirty);
  }
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

async function load() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SETTINGS_GET });
    if (!response?.ok) throw new Error(response?.error || 'The background worker rejected the settings request.');
    settings = response?.settings || DEFAULT_SETTINGS;
    updatePermissionHealth();
    render();
    setDirty(false);
    setStatus('Settings loaded.');
  } catch (error) {
    setStatus(error?.message || 'Could not load settings.');
    settings = DEFAULT_SETTINGS;
    render();
  }
}

function renderFileTypeControls() {
  if (!els.fileTypes) return;
  els.fileTypes.replaceChildren();
  const groups = new Map();
  for (const entry of MEDIA_TYPE_REGISTRY) {
    if (!groups.has(entry.group)) groups.set(entry.group, []);
    groups.get(entry.group).push(entry);
  }
  for (const [group, entries] of groups) {
    const details = document.createElement('details');
    details.className = 'type-group';
    details.dataset.group = group;
    if (['video', 'audio', 'hls'].includes(group)) details.open = true;

    const extensions = [...new Set(entries.flatMap((entry) => entry.extensions))];
    const summary = document.createElement('summary');
    const title = document.createElement('span');
    title.textContent = groupLabel(group);
    const count = document.createElement('span');
    count.className = 'type-count';
    count.textContent = `${extensions.length} type${extensions.length === 1 ? '' : 's'}`;
    summary.append(title, count);

    const grid = document.createElement('div');
    grid.className = 'type-grid';
    for (const entry of entries) {
      for (const extension of entry.extensions) {
        const label = document.createElement('label');
        label.className = 'check';
        label.title = `${entry.label} (${entry.mimeTypes.join(', ')})`;
        label.dataset.searchText = `${extension} ${entry.label} ${entry.group} ${entry.mimeTypes.join(' ')}`.toLowerCase();
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.extension = extension;
        const span = document.createElement('span');
        span.textContent = extension.toUpperCase();
        label.append(input, span);
        grid.append(label);
      }
    }
    details.append(summary, grid);
    els.fileTypes.append(details);
  }
}

function render() {
  for (const input of els.fileTypes?.querySelectorAll('input[type="checkbox"]') || []) {
    input.checked = settings.enabledFileTypes?.[input.dataset.extension] !== false;
  }
  setValue('maxParallelDownloads', settings.maxParallelDownloads);
  setValue('segmentParallelism', settings.segmentParallelism || DEFAULT_SETTINGS.segmentParallelism);
  setValue('segmentRetryLimit', Number.isFinite(Number(settings.segmentRetryLimit)) ? settings.segmentRetryLimit : DEFAULT_SETTINGS.segmentRetryLimit);
  setValue('episodeBatchScanParallelism', Number.isFinite(Number(settings.episodeBatchScanParallelism)) ? settings.episodeBatchScanParallelism : DEFAULT_SETTINGS.episodeBatchScanParallelism);
  setValue('confirmLargeEpisodeBatchThreshold', Number.isFinite(Number(settings.confirmLargeEpisodeBatchThreshold)) ? settings.confirmLargeEpisodeBatchThreshold : DEFAULT_SETTINGS.confirmLargeEpisodeBatchThreshold);
  setValue('hlsOutputMethod', IMPLEMENTED_HLS_OUTPUT_METHODS.includes(settings.hlsOutputMethod) ? settings.hlsOutputMethod : DEFAULT_SETTINGS.hlsOutputMethod);
  setValue('hlsWorkMode', Object.values(HLS_WORK_MODES).includes(settings.hlsWorkMode) ? settings.hlsWorkMode : DEFAULT_SETTINGS.hlsWorkMode);
  setValue('hlsVariantPreference', Object.values(HLS_VARIANT_PREFERENCES).includes(settings.hlsVariantPreference) ? settings.hlsVariantPreference : DEFAULT_SETTINGS.hlsVariantPreference);
  setValue('duplicateBehavior', Object.values(DUPLICATE_BEHAVIORS).includes(settings.duplicateBehavior) ? settings.duplicateBehavior : DUPLICATE_BEHAVIORS.AUTO_NUMBER);
  setChecked('showManualM3u8Converter', Boolean(settings.showManualM3u8Converter));
  setChecked('includeSensitiveUrlsInReports', Boolean(settings.includeSensitiveUrlsInReports));
  setValue('queueHistoryRetentionDays', String(Number.isFinite(Number(settings.queueHistoryRetentionDays)) ? settings.queueHistoryRetentionDays : DEFAULT_SETTINGS.queueHistoryRetentionDays));
  setValue('filenameTemplate', settings.filenameTemplate);
  setValue('preferredSubfolder', settings.preferredSubfolder);
  setChecked('notifications', Boolean(settings.notifications));
  setChecked('debugLogs', Boolean(settings.debugLogs));
  updateTypeCounts();
  updatePreviews();
}

async function save() {
  const enabledFileTypes = {};
  for (const input of els.fileTypes?.querySelectorAll('input[type="checkbox"]') || []) {
    enabledFileTypes[input.dataset.extension] = input.checked;
  }
  const nextSettings = {
    enabledFileTypes,
    maxParallelDownloads: boundedInteger(els.maxParallelDownloads?.value, MAX_PARALLEL_MIN, MAX_PARALLEL_MAX, DEFAULT_SETTINGS.maxParallelDownloads),
    segmentParallelism: boundedInteger(els.segmentParallelism?.value, 1, 16, DEFAULT_SETTINGS.segmentParallelism),
    segmentRetryLimit: boundedInteger(els.segmentRetryLimit?.value, 0, 4, DEFAULT_SETTINGS.segmentRetryLimit),
    episodeBatchScanParallelism: boundedInteger(els.episodeBatchScanParallelism?.value, 1, 4, DEFAULT_SETTINGS.episodeBatchScanParallelism),
    confirmLargeEpisodeBatchThreshold: boundedInteger(els.confirmLargeEpisodeBatchThreshold?.value, 2, 48, DEFAULT_SETTINGS.confirmLargeEpisodeBatchThreshold),
    hlsOutputMethod: IMPLEMENTED_HLS_OUTPUT_METHODS.includes(els.hlsOutputMethod?.value) ? els.hlsOutputMethod.value : DEFAULT_SETTINGS.hlsOutputMethod,
    hlsWorkMode: Object.values(HLS_WORK_MODES).includes(els.hlsWorkMode?.value) ? els.hlsWorkMode.value : DEFAULT_SETTINGS.hlsWorkMode,
    hlsVariantPreference: Object.values(HLS_VARIANT_PREFERENCES).includes(els.hlsVariantPreference?.value) ? els.hlsVariantPreference.value : DEFAULT_SETTINGS.hlsVariantPreference,
    duplicateBehavior: Object.values(DUPLICATE_BEHAVIORS).includes(els.duplicateBehavior?.value) ? els.duplicateBehavior.value : DEFAULT_SETTINGS.duplicateBehavior,
    showManualM3u8Converter: Boolean(els.showManualM3u8Converter?.checked),
    includeSensitiveUrlsInReports: Boolean(els.includeSensitiveUrlsInReports?.checked),
    queueHistoryRetentionDays: boundedInteger(els.queueHistoryRetentionDays?.value, 0, 30, DEFAULT_SETTINGS.queueHistoryRetentionDays),
    filenameTemplate: String(els.filenameTemplate?.value || '').trim() || DEFAULT_SETTINGS.filenameTemplate,
    preferredSubfolder: String(els.preferredSubfolder?.value || '').trim(),
    notifications: Boolean(els.notifications?.checked),
    debugLogs: Boolean(els.debugLogs?.checked)
  };
  if (els.save) els.save.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: nextSettings });
    if (response?.ok) {
      settings = response.settings;
      render();
      setDirty(false);
      setStatus('Settings saved.');
    } else {
      setStatus(response?.error || 'Could not save settings.');
    }
  } catch (error) {
    setStatus(error?.message || 'Could not reach the background worker to save settings.');
  } finally {
    if (els.save) els.save.disabled = !dirty;
  }
}

async function grantAllSiteAccess() {
  const confirmed = confirm('Grant network detection for all http/https sites? Prefer per-site access unless you need broad detection.');
  if (!confirmed) return setStatus('All-site access request canceled.');
  try {
    const granted = await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
    setStatus(granted ? 'Network detection enabled for all sites.' : 'Site access was not granted.');
  } catch (error) {
    setStatus(error?.message || 'Chrome could not show the all-site access prompt.');
  }
  updatePermissionHealth();
}

async function revokeAllSiteAccess() {
  try {
    const removed = await chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] });
    setStatus(removed ? 'All-site network detection revoked.' : 'All-site access was not present or could not be revoked.');
  } catch (error) {
    setStatus(error?.message || 'Could not revoke all-site access.');
  }
  updatePermissionHealth();
}

async function action(type, successText) {
  try {
    const response = await chrome.runtime.sendMessage({ type });
    setStatus(response?.ok ? successText : (response?.error || 'Action failed.'));
  } catch (error) {
    setStatus(error?.message || 'Could not reach the background worker.');
  }
}

async function runSelfTests() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RUN_SELF_TESTS });
    if (els.testResults) els.testResults.textContent = JSON.stringify(response?.selfTests || response, null, 2);
    const passed = response?.ok === true && response?.selfTests?.passed === true;
    setStatus(passed ? 'Self-tests passed.' : 'Self-tests returned failures.');
  } catch (error) {
    if (els.testResults) els.testResults.textContent = error?.message || 'Self-tests could not run.';
    setStatus(error?.message || 'Could not reach the background worker for self-tests.');
  }
}

function setTypePreset(enabledExtensions) {
  const enabled = new Set(enabledExtensions);
  for (const input of els.fileTypes?.querySelectorAll('input[type="checkbox"]') || []) input.checked = enabled.has(input.dataset.extension);
  markDirty('Core media preset selected. Save to apply.');
}

function setAllTypeCheckboxes(checked) {
  for (const input of els.fileTypes?.querySelectorAll('input[type="checkbox"]') || []) input.checked = checked;
  markDirty(checked ? 'All registry types selected. Save to apply.' : 'All registry types cleared. Save to apply.');
}

function disableMetadataTypes() {
  for (const input of els.fileTypes?.querySelectorAll('input[type="checkbox"]') || []) {
    if (['json', 'xml'].includes(input.dataset.extension)) input.checked = false;
  }
  markDirty('Noisy metadata hints disabled. Save to apply.');
}

function coreMediaExtensions() {
  const coreGroups = new Set(['video', 'audio', 'hls', 'dash', 'subtitle', 'image']);
  return MEDIA_TYPE_REGISTRY
    .filter((entry) => coreGroups.has(entry.group))
    .flatMap((entry) => entry.extensions)
    .filter((extension) => !['json', 'xml'].includes(extension));
}

function filterFileTypes() {
  const query = String(els.fileTypeSearch?.value || '').trim().toLowerCase();
  for (const group of els.fileTypes?.querySelectorAll('.type-group') || []) {
    let visibleCount = 0;
    for (const label of group.querySelectorAll('.check')) {
      const visible = !query || label.dataset.searchText.includes(query);
      label.classList.toggle('filtered-out', !visible);
      if (visible) visibleCount += 1;
    }
    group.classList.toggle('filtered-out', visibleCount === 0);
    if (query && visibleCount) group.open = true;
  }
}

function updateTypeCounts() {
  for (const group of els.fileTypes?.querySelectorAll('.type-group') || []) {
    const inputs = [...group.querySelectorAll('input[type="checkbox"]')];
    const enabled = inputs.filter((input) => input.checked).length;
    const badge = group.querySelector('.type-count');
    if (badge) badge.textContent = `${enabled}/${inputs.length} enabled`;
  }
}

function updatePreviews() {
  updateDuplicateConsequence();
  updateStreamPreview();
  updateFilenameDryRun();
}

function updateDuplicateConsequence() {
  if (!els.duplicateConsequence || !els.duplicateBehavior) return;
  els.duplicateConsequence.textContent = {
    'auto-number': 'Auto-number avoids silent overwrite risk and works well with batch downloads.',
    ask: 'Ask can pause downloads behind browser prompts until the user confirms.',
    overwrite: 'Overwrite is a warning state: Chrome may still uniquify or block depending on browser policy.'
  }[els.duplicateBehavior.value] || 'Choose a duplicate policy.';
}

function updateStreamPreview() {
  if (!els.streamCapabilityPreview) return;
  els.streamCapabilityPreview.replaceChildren();
  const method = els.hlsOutputMethod?.value || DEFAULT_SETTINGS.hlsOutputMethod;
  const labels = [
    ['Direct', 'Progressive MP4/WebM/MP3 and allowed files remain downloadable when fresh.'],
    ['Convertible', method === 'smart-mp4' ? 'Smart MP4 probes compatibility and falls back safely.' : `Default HLS method: ${method}.`],
    ['Manifest only', 'DASH MPD and unsupported stream manifests are evidence-first unless a supported pipeline exists.'],
    ['Unsupported', 'Encrypted HLS, fMP4/CMAF gaps, low-latency partials, signed-expiring URLs, auth/CORS blocks stop safely.']
  ];
  for (const [name, copy] of labels) {
    const span = document.createElement('span');
    span.textContent = `${name}: ${copy}`;
    els.streamCapabilityPreview.append(span);
  }
}

function updateFilenameDryRun() {
  if (!els.filenameDryRun) return;
  const template = els.filenameTemplate?.value || DEFAULT_SETTINGS.filenameTemplate;
  const folder = els.preferredSubfolder?.value?.trim() || '(default downloads folder)';
  const sample = template
    .replaceAll('{tabTitle}', 'Sample Video Title')
    .replaceAll('{rawTabTitle}', 'Sample Video Title - Browser Tab')
    .replaceAll('{hostname}', 'example.com')
    .replaceAll('{resolution}', '1080p')
    .replaceAll('{date}', new Date().toISOString().slice(0, 10))
    .replaceAll('{index}', '1')
    .replaceAll('{indexSuffix}', '')
    .replaceAll('{extension}', 'mp4')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const warnings = [];
  if (/\{[^}]+\}/.test(sample)) warnings.push('invalid token remains');
  if (sample.length > 160) warnings.push('path may be too long');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sample)) warnings.push('reserved name risk');
  els.filenameDryRun.textContent = `Dry-run: ${folder}/${sample || 'media.mp4'}${warnings.length ? ` • Warning: ${warnings.join(', ')}` : ' • Valid preview'}`;
}

function updatePermissionHealth() {
  if (!els.permissionHealth) return;
  if (!chrome.permissions?.contains) {
    els.permissionHealth.textContent = 'Permission API unavailable in this browser context. Active-tab scanning remains available.';
    return;
  }
  chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }, (granted) => {
    const error = chrome.runtime.lastError;
    if (error) {
      els.permissionHealth.textContent = `Permission health unavailable: ${error.message || 'browser permission check failed'}. Active-tab scanning remains available.`;
      return;
    }
    els.permissionHealth.textContent = granted
      ? 'All-site network detection is currently granted. You can revoke it here and return to site-only prompts.'
      : 'All-site network detection is not granted. Media Scout will ask for site access only when a feature needs it.';
  });
}

async function copySupportSummaryText() {
  const manifest = chrome.runtime.getManifest();
  const text = [
    `Media Scout Downloader ${manifest.version}`,
    `HLS method: ${els.hlsOutputMethod?.value || settings.hlsOutputMethod}`,
    `Queue retention: ${els.queueHistoryRetentionDays?.value || settings.queueHistoryRetentionDays} day(s)`,
    `Reports full URLs allowed: ${els.includeSensitiveUrlsInReports?.checked ? 'after confirmation' : 'no'}`,
    'Support reports should be generated from Side panel > Reports so the redaction checklist is visible.'
  ].join('\n');
  const copied = await copyText(text);
  setStatus(copied ? 'Support summary copied. It contains settings only, not media URLs.' : 'Clipboard unavailable. Select and copy the support summary from the report preview instead.');
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_error) {
    // Fall back to the legacy local textarea copy below.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand?.('copy') === true;
    textarea.remove();
    return copied;
  } catch (_error) {
    return false;
  }
}

function markDirty(message) {
  setDirty(true);
  if (els.status) els.status.textContent = typeof message === 'string' ? message : 'Unsaved changes. Review consequences, then save.';
  updateTypeCounts();
  updatePreviews();
}

function setDirty(value) {
  dirty = Boolean(value);
  if (els.save) els.save.disabled = !dirty;
  if (els.changeStateLabel) els.changeStateLabel.textContent = dirty ? 'Pending changes' : 'All changes saved';
}

function setStatus(text) {
  if (!els.status) return;
  els.status.textContent = text;
  setTimeout(() => { if (!dirty && els.status.textContent === text) els.status.textContent = ''; }, 3500);
}

function setValue(key, value) { if (els[key]) els[key].value = value; }
function setChecked(key, value) { if (els[key]) els[key].checked = Boolean(value); }
function boundedInteger(value, minimum, maximum, fallback) {
  const numeric = value == null || value === '' ? Number.NaN : Number(value);
  const normalized = Number.isFinite(numeric) ? Math.round(numeric) : fallback;
  return Math.min(maximum, Math.max(minimum, normalized));
}
function groupLabel(group) {
  return {
    video: 'Video containers',
    audio: 'Audio files',
    hls: 'HLS playlists',
    dash: 'DASH manifests',
    stream: 'Other streaming manifests',
    playlist: 'Playlists',
    segment: 'Segments / fragments',
    subtitle: 'Subtitles / captions',
    image: 'Posters / thumbnails',
    metadata: 'Media metadata hints'
  }[group] || group;
}
function byId(id) { return document.getElementById(id); }
