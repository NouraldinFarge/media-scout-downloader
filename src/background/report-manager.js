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
import {
  buildReportContext,
  buildReportExposureSummary,
  collectSensitiveReportValues,
  redactKnownReportText,
  redactReportValue,
  reportFileByteLength,
  reportFilesDigest,
  reportPreviewToken,
  sanitizeSensitiveReportValue
} from '../shared/report-privacy.js';
import { nowISO } from '../shared/utils.js';
import { getQueueHistory } from '../shared/storage-utils.js';
import { normalizeZipEntries } from '../shared/zip-utils.js';

export { redactReportValue };

/**
 * Builds the on-demand local diagnostic report used by the popup.
 * The report is returned as text files; the popup packages those files into a ZIP.
 */
export class ReportManager {
  constructor({ getSettings, diagnostics, downloadManager, getCurrentTime = nowISO }) {
    this.getSettings = getSettings;
    this.diagnostics = diagnostics;
    this.downloadManager = downloadManager;
    this.getCurrentTime = getCurrentTime;
  }

  async buildActiveTabReport({ tab, tabRevision = 0, siteAccess, tabState, detailedScan, scannerError, selfTests, includeSensitiveUrls = false }) {
    const generatedAt = this.getCurrentTime();
    const settings = await this.getSettings();
    const state = {
      ...(tabState || {}),
      queue: this.downloadManager.getState()
    };
    const diagnostics = this.diagnostics.snapshot();
    let persistedQueueHistory = null;
    try {
      persistedQueueHistory = await getQueueHistory();
    } catch (_error) {
      // Persisted history is optional context. A transient or corrupt storage
      // read must not block export of the current in-memory report.
    }
    const allowSensitiveUrls = Boolean(includeSensitiveUrls && settings.includeSensitiveUrlsInReports);
    const normalizedScan = detailedScan || { unavailable: true, error: scannerError || 'Detailed page scan unavailable.' };
    const rawDetectedMedia = sanitizeMediaItemsForReport(state.mediaItems || []);
    const rawDecisionLog = buildDecisionLog(normalizedScan);
    const exposure = buildReportExposureSummary(allowSensitiveUrls);
    const transform = allowSensitiveUrls ? sanitizeSensitiveReportValue : redactReportValue;
    const reportTab = transform(tab || {});
    const reportState = transform(state);
    const reportScan = transform(normalizedScan);
    const reportHistory = transform(persistedQueueHistory || {});
    const reportSiteAccess = transform(siteAccess || {});
    const reportScannerError = transform(scannerError || '', 'scannerError');
    const runtimeDetails = buildRuntimeDetails();
    const extensionState = transform(buildExtensionState({
      state,
      settings,
      diagnostics,
      siteAccess,
      selfTests,
      generatedAt,
      persistedQueueHistory,
      runtimeDetails,
      exposure,
      allowSensitiveUrls
    }));

    let files = normalizeZipEntries([
      { path: 'README.txt', content: buildReportReadme(allowSensitiveUrls ? 'full' : 'redacted') },
      { path: 'data-exposure.json', content: stringify({ mode: allowSensitiveUrls ? 'sensitive-urls' : 'redacted', fields: exposure }) },
      { path: 'summary.md', content: buildSummaryMarkdown({ tab: reportTab, siteAccess: reportSiteAccess, state: reportState, detailedScan: reportScan, generatedAt, scannerError: reportScannerError, persistedQueueHistory: reportHistory }) },
      { path: 'detected-media.json', content: stringify(transform(rawDetectedMedia)) },
      { path: 'page-scan.json', content: stringify(reportScan) },
      { path: 'decision-log.json', content: stringify(transform(rawDecisionLog)) },
      { path: 'extension-state.json', content: stringify(extensionState) },
      { path: 'limitations.txt', content: buildLimitationsText() },
      { path: 'media-type-registry.json', content: stringify(registryCoverageForReport()) }
    ]);

    if (!allowSensitiveUrls) {
      const identifyingValues = collectSensitiveReportValues(tab, state, normalizedScan, persistedQueueHistory, diagnostics, settings, siteAccess);
      files = files.map((file) => ({ ...file, content: redactKnownReportText(file.content, identifyingValues) }));
    }

    const context = buildReportContext({
      tab,
      tabRevision,
      state,
      settings,
      siteAccess,
      diagnostics,
      detailedScan: normalizedScan,
      persistedQueueHistory,
      includeSensitiveUrls: allowSensitiveUrls
    });
    const previewDigest = reportFilesDigest(files);
    const totalBytes = files.reduce((sum, file) => sum + reportFileByteLength(file.content), 0);

    return {
      filename: buildReportFilename(reportTab, generatedAt).replace('media-scout-report-', allowSensitiveUrls ? 'media-scout-full-report-' : 'media-scout-redacted-report-'),
      generatedAt,
      files,
      exposure,
      context,
      previewDigest,
      previewToken: reportPreviewToken(context, previewDigest, generatedAt),
      summary: {
        detectedMediaCount: rawDetectedMedia.length,
        decisionCount: rawDecisionLog.length,
        siteAccessGranted: Boolean(siteAccess?.granted),
        scannerAvailable: !scannerError,
        redacted: !allowSensitiveUrls,
        mode: allowSensitiveUrls ? 'sensitive-urls' : 'redacted',
        fileCount: files.length,
        totalBytes,
        screenshotsIncluded: false
      }
    };
  }
}

function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function buildRuntimeDetails() {
  const manifest = globalThis.chrome?.runtime?.getManifest?.() || {};
  const navigatorValue = globalThis.navigator || {};
  return {
    extensionVersion: manifest.version || '',
    manifestVersion: manifest.manifest_version || '',
    permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
    optionalHostPermissions: Array.isArray(manifest.optional_host_permissions) ? manifest.optional_host_permissions : [],
    browserUserAgent: navigatorValue.userAgent || '',
    platform: navigatorValue.userAgentData?.platform || navigatorValue.platform || '',
    language: navigatorValue.language || ''
  };
}
