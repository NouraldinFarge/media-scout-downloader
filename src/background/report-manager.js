import {
  buildDecisionLog,
  buildExtensionState,
  buildLimitationsText,
  buildReportFilename,
  buildReportReadme,
  buildSummaryMarkdown,
  sanitizeMediaItemsForReport,
  registryCoverageForReport
} from '../shared/report-utils.js';
import { nowISO } from '../shared/utils.js';
import { getQueueHistory } from '../shared/storage-utils.js';

/**
 * Builds the on-demand local diagnostic report used by the popup.
 * The report is returned as text files; the popup packages those files into a ZIP.
 */
export class ReportManager {
  constructor({ getSettings, diagnostics, downloadManager }) {
    this.getSettings = getSettings;
    this.diagnostics = diagnostics;
    this.downloadManager = downloadManager;
  }

  async buildActiveTabReport({ tab, siteAccess, tabState, detailedScan, scannerError, selfTests, includeSensitiveUrls = false }) {
    const generatedAt = nowISO();
    const settings = await this.getSettings();
    const state = {
      ...(tabState || {}),
      queue: this.downloadManager.getState()
    };
    const diagnostics = this.diagnostics.snapshot();
    const persistedQueueHistory = await getQueueHistory();
    const allowSensitiveUrls = Boolean(includeSensitiveUrls && settings.includeSensitiveUrlsInReports);
    const reportTab = allowSensitiveUrls ? tab : redactTabForReport(tab);
    const detectedMedia = sanitizeMediaItemsForReport(state.mediaItems || []);
    const extensionState = buildExtensionState({ state, settings, diagnostics, siteAccess, selfTests, generatedAt, persistedQueueHistory });
    const normalizedScan = detailedScan || { unavailable: true, error: scannerError || 'Detailed page scan unavailable.' };
    const decisionLog = buildDecisionLog(normalizedScan);

    const files = [
      { path: 'README.txt', content: buildReportReadme(allowSensitiveUrls ? 'full' : 'redacted') },
      { path: 'summary.md', content: buildSummaryMarkdown({ tab: reportTab, siteAccess, state: allowSensitiveUrls ? state : redactReportValue(state), detailedScan: allowSensitiveUrls ? normalizedScan : redactReportValue(normalizedScan), generatedAt, scannerError, persistedQueueHistory }) },
      { path: 'detected-media.json', content: stringify(allowSensitiveUrls ? detectedMedia : redactReportValue(detectedMedia)) },
      { path: 'page-scan.json', content: stringify(allowSensitiveUrls ? normalizedScan : redactReportValue(normalizedScan)) },
      { path: 'decision-log.json', content: stringify(allowSensitiveUrls ? decisionLog : redactReportValue(decisionLog)) },
      { path: 'extension-state.json', content: stringify(allowSensitiveUrls ? extensionState : redactReportValue(extensionState)) },
      { path: 'limitations.txt', content: buildLimitationsText() },
      { path: 'media-type-registry.json', content: stringify(registryCoverageForReport()) }
    ];

    return {
      filename: buildReportFilename(reportTab, generatedAt).replace('media-scout-report-', allowSensitiveUrls ? 'media-scout-full-report-' : 'media-scout-redacted-report-'),
      generatedAt,
      files,
      summary: {
        detectedMediaCount: detectedMedia.length,
        decisionCount: decisionLog.length,
        siteAccessGranted: Boolean(siteAccess?.granted),
        scannerAvailable: !scannerError,
        redacted: !allowSensitiveUrls
      }
    };
  }
}

function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}


function redactTabForReport(tab = {}) {
  return {
    ...tab,
    url: redactUrlValue(tab.url),
    pendingUrl: redactUrlValue(tab.pendingUrl),
    title: tab.title || ''
  };
}

function redactReportValue(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => redactReportValue(item, key));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && looksSensitiveKey(key)) return redactUrlValue(value);
    return value;
  }
  const out = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (looksSensitiveKey(entryKey)) out[entryKey] = typeof entryValue === 'string' ? redactUrlValue(entryValue) : redactReportValue(entryValue, entryKey);
    else out[entryKey] = redactReportValue(entryValue, entryKey);
  }
  return out;
}

function looksSensitiveKey(key = '') {
  const value = String(key);
  return /(^|_)(url|urls|uri|uris|href|hrefs|src|srcs|currentSrc|frameUrl|frameUrls|documentUrl|documentUrls|pageUrl|pageUrls|tabUrl|tabUrls|normalizedUrl|normalizedUrls|originalPlaylistUrl|originalPlaylistUrls|variantUrl|variantUrls)$/i.test(value)
    || /(url|urls|uri|uris|href|hrefs|src|srcs)$/i.test(value);
}

function redactUrlValue(raw = '') {
  const value = String(raw || '');
  if (!value) return '';
  try {
    const url = new URL(value);
    const queryNames = Array.from(url.searchParams.keys()).sort();
    return `${url.protocol}//${url.hostname}${url.pathname ? `/path-${hashText(url.pathname)}` : ''}${queryNames.length ? `?params=${queryNames.map((name) => encodeURIComponent(name)).join(',')}` : ''}`;
  } catch (_error) {
    if (value.startsWith('blob:')) return 'blob://redacted';
    return value.length > 80 ? `${value.slice(0, 24)}…redacted…${value.slice(-12)}` : value;
  }
}

function hashText(text = '') {
  let hash = 5381;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) + value.charCodeAt(index);
    hash &= 0xffffffff;
  }
  return Math.abs(hash).toString(36);
}
