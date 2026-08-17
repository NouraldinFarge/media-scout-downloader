import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReportManager } from '../src/background/report-manager.js';
import { DOWNLOAD_STATUSES, MEDIA_TYPES } from '../src/shared/constants.js';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = path.join(root, 'docs', 'evidence', 'samples', 'redacted-report-3.7.13');
const generatedAt = '2026-08-17T17:00:00.000Z';

installControlledChromeStub();

const tab = {
  id: 101,
  title: 'Aurora Field Lab — Controlled Clip A',
  url: 'https://media-scout-fixture.invalid/watch/aurora-a?quality=1080p&viewer=sample'
};
const mediaUrl = 'https://cdn.media-scout-fixture.invalid/media/aurora-a.mp4?quality=1080p&fixture=yes';
const mediaItem = {
  id: 'controlled-media-101',
  tabId: tab.id,
  title: 'Aurora Field Lab — Controlled Clip A',
  hostname: 'cdn.media-scout-fixture.invalid',
  filename: 'aurora-field-lab-a.mp4',
  url: mediaUrl,
  normalizedUrl: mediaUrl,
  mediaType: MEDIA_TYPES.VIDEO,
  extension: 'mp4',
  status: DOWNLOAD_STATUSES.DETECTED,
  detectionMethods: ['controlled-fixture'],
  note: 'Synthetic fixture note: Καλημέρα κόσμε.'
};
const queue = {
  maxParallel: 3,
  activeCount: 0,
  paused: false,
  pending: [],
  active: [],
  completed: [],
  failed: [],
  canceled: []
};
const detailedScan = {
  generatedAt,
  frame: { url: tab.url, title: tab.title, isTop: true },
  document: { url: tab.url, title: tab.title, iframeCount: 0, mediaElementCount: 1 },
  mediaElements: [{ index: 0, tagName: 'video', currentSrc: mediaUrl, frameUrl: tab.url, resolution: '1280×720' }],
  iframes: [],
  literalMediaHints: [],
  playlistProbes: [],
  decisions: [{
    source: 'dom-video',
    tagName: 'video',
    rawUrl: mediaUrl,
    normalizedUrl: mediaUrl,
    mime: 'video/mp4',
    acceptedByBasicScanner: true,
    reasons: []
  }],
  performance: {
    totalResourceEntries: 1,
    inspectedResourceEntries: 1,
    mediaLikeEntries: [{ url: mediaUrl, hostname: 'cdn.media-scout-fixture.invalid', extension: 'mp4', initiatorType: 'video' }],
    interestingEntries: []
  }
};
const settings = {
  enabledFileTypes: { mp4: true },
  maxParallelDownloads: 3,
  segmentParallelism: 4,
  segmentRetryLimit: 2,
  hlsOutputMethod: 'smart-mp4',
  hlsWorkMode: 'balanced',
  hlsVariantPreference: 'highest',
  showManualM3u8Converter: false,
  includeSensitiveUrlsInReports: false,
  queueHistoryRetentionDays: 7,
  episodeBatchScanParallelism: 2,
  confirmLargeEpisodeBatchThreshold: 8,
  filenameTemplate: '{tabTitle}{indexSuffix}.{extension}',
  duplicateBehavior: 'auto-number',
  notifications: true,
  debugLogs: false,
  preferredSubfolder: 'Media Scout Downloader'
};
const manager = new ReportManager({
  getSettings: async () => settings,
  diagnostics: { snapshot: () => ({ strategies: {}, errors: {}, updatedAt: generatedAt }) },
  downloadManager: { getState: () => queue },
  getCurrentTime: () => generatedAt
});
const report = await manager.buildActiveTabReport({
  tab,
  tabRevision: 1,
  siteAccess: { granted: true, origin: 'https://media-scout-fixture.invalid/*' },
  tabState: { tab, mediaItems: [mediaItem] },
  detailedScan,
  scannerError: '',
  selfTests: { passed: true, resultCount: 9 },
  includeSensitiveUrls: false
});

await mkdir(outputDirectory, { recursive: true });
const manifestFiles = [];
for (const file of report.files) {
  const target = path.join(outputDirectory, ...file.path.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  const content = String(file.content ?? '');
  await writeFile(target, content, 'utf8');
  manifestFiles.push({
    path: file.path,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: createHash('sha256').update(content, 'utf8').digest('hex')
  });
}

const sampleManifest = {
  sampleType: 'sanitized-default-redacted-report',
  product: 'Media Scout Downloader',
  version: '3.7.13',
  generatedAt,
  source: 'Repository-owned synthetic .invalid-domain fixture; no real media, account, page, URL, token, filename, or local path.',
  browserEvidence: false,
  mode: report.summary.mode,
  previewDigest: report.previewDigest,
  screenshotsIncluded: false,
  files: manifestFiles
};
await writeFile(path.join(outputDirectory, 'SAMPLE_MANIFEST.json'), `${JSON.stringify(sampleManifest, null, 2)}\n`, 'utf8');

console.log(`Generated sanitized report sample: ${manifestFiles.length} report files in docs/evidence/samples/redacted-report-3.7.13`);

function installControlledChromeStub() {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({
        manifest_version: 3,
        version: '3.7.13',
        permissions: ['activeTab', 'downloads', 'scripting', 'storage', 'webRequest', 'sidePanel', 'notifications'],
        optional_host_permissions: ['http://*/*', 'https://*/*']
      })
    },
    storage: {
      local: {
        get(_keys, callback) { callback({}); },
        remove(_keys, callback) { callback?.(); }
      }
    }
  };
}
