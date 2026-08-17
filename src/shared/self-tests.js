import { DEFAULT_SETTINGS, DOWNLOAD_STATUSES, DUPLICATE_BEHAVIORS, ERROR_CATEGORIES, HLS_OUTPUT_METHODS, HLS_VARIANT_PREFERENCES, MEDIA_TYPES, MESSAGE_TYPES, SOURCES, STRATEGY_NAMES } from './constants.js';
import { buildFilename, extractBookTitleBracketText, sanitizeFilenamePart } from './filename-utils.js';
import { mergeSettings } from './storage-utils.js';
import { validateMediaUrl, validateMessage, canRetryCategory, isContentScriptMessageType, isPrivilegedExtensionMessageType } from './validators.js';
import { buildDownloadAllowSummary, getDownloadAllowDecision } from './download-allow-list.js';
import { buildPopupModel, classifyCandidate, downloadDecisionFor, filenamePreview, taskVisibleCopy } from './frontend-model.js';
import { probeHasSelfContainedVariant } from '../background/tab-media-store.js';
import { orderedStrategiesForMedia, shellQuote } from '../background/download-strategies.js';
import { parseHlsInspection } from '../background/media-detector.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function testFilenameSanitization() {
  assert(sanitizeFilenamePart('a/b:c*?d') === 'a b c d', 'unsafe filename characters are replaced');
  const filename = buildFilename({
    settings: DEFAULT_SETTINGS,
    media: { extension: 'mp4', hostname: 'example.com', url: 'https://example.com/video.mp4' },
    tab: { title: 'Example: Tab / Title' },
    index: 2
  });
  assert(filename.endsWith('Example Tab Title (2).mp4'), 'filename template applies tab title and counter');
  assert(extractBookTitleBracketText('Watch 《大东北之你要下岗我涨薪》 online') === '大东北之你要下岗我涨薪', 'Chinese book-title bracket text is extracted');
  const bracketFilename = buildFilename({
    settings: DEFAULT_SETTINGS,
    media: { extension: 'mp4', hostname: 'example.com', url: 'https://example.com/video.mp4' },
    tab: { title: 'Site - 《大东北之你要下岗我涨薪》 - Episode 1' },
    index: 0
  });
  assert(bracketFilename.endsWith('大东北之你要下岗我涨薪.mp4'), 'filename prefers text inside Chinese book-title brackets');
}

function testMediaUrlValidation() {
  assert(validateMediaUrl('https://example.com/video.mp4') === null, 'normal HTTPS media URL is valid');
  assert(validateMediaUrl('javascript:alert(1)')?.category === ERROR_CATEGORIES.VALIDATION || validateMediaUrl('javascript:alert(1)')?.category === ERROR_CATEGORIES.ACCESS_CONTROL, 'unsafe schemes are rejected');
  assert(validateMediaUrl('https://example.com/v.mp4?signature=abc')?.category === ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL, 'signed URLs are fail-closed');
}

function testMessageValidation() {
  assert(validateMessage({ type: MESSAGE_TYPES.GET_ACTIVE_TAB_STATE }), 'known messages are valid');
  assert(validateMessage({ type: MESSAGE_TYPES.CLEAR_SETTLED_QUEUE }), 'clear settled queue message is valid');
  assert(validateMessage({ type: MESSAGE_TYPES.PAUSE_QUEUE }), 'pause queue message is valid');
  assert(validateMessage({ type: MESSAGE_TYPES.RESUME_QUEUE }), 'resume queue message is valid');
  assert(validateMessage({ type: MESSAGE_TYPES.START_DOWNLOAD, tabId: 1, mediaId: 'media-1' }), 'start download message requires a tab and media id');
  assert(!validateMessage({ type: MESSAGE_TYPES.START_DOWNLOAD, tabId: 1, mediaId: 'media-1', hlsOutputMethod: HLS_OUTPUT_METHODS.FMP4_ASSEMBLY }), 'planned HLS modes are not valid user-facing start methods');
  assert(!validateMessage({ type: MESSAGE_TYPES.CONVERT_M3U8_TO_MP4, url: 'https://example.com/v.m3u8', hlsOutputMethod: HLS_OUTPUT_METHODS.VISIBLE_RECORDING }), 'planned HLS modes are not valid manual converter methods');
  assert(!validateMessage({ type: MESSAGE_TYPES.CONVERT_M3U8_TO_MP4, url: 'https://example.com/v.m3u8', filename: 'x'.repeat(241) }), 'manual converter rejects oversized filenames');
  assert(!validateMessage({ type: MESSAGE_TYPES.CONVERT_M3U8_TO_MP4, url: 'file:///private/video.m3u8' }), 'manual converter accepts only HTTP(S) playlists');
  assert(validateMessage({ type: MESSAGE_TYPES.START_EPISODE_BATCH_DOWNLOADS, episodes: [{ url: 'https://example.com/show/1', episodeNumber: 1, title: 'One' }] }), 'episode batch message accepts bounded http episode entries');
  assert(!validateMessage({ type: MESSAGE_TYPES.START_EPISODE_BATCH_DOWNLOADS, episodes: [{ url: 'javascript:alert(1)', episodeNumber: 1 }] }), 'episode batch message rejects unsafe episode URLs');
  assert(validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: { debugLogs: true } }), 'settings save accepts known setting payloads');
  assert(validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: DEFAULT_SETTINGS }), 'settings save accepts a complete options-page payload');
  assert(validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: { enabledFileTypes: DEFAULT_SETTINGS.enabledFileTypes } }), 'settings save accepts the full file-type registry payload');
  assert(!validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: { unexpectedSetting: true } }), 'settings save rejects unknown setting keys');
  assert(!validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE }), 'settings save requires a settings object');
  assert(!validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: { debugLogs: 'true' } }), 'settings save rejects non-boolean flags');
  assert(!validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: { maxParallelDownloads: '3' } }), 'settings save rejects numeric values encoded as strings');
  assert(!validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: { duplicateBehavior: 'replace-anything' } }), 'settings save rejects unknown duplicate behavior');
  assert(!validateMessage({ type: MESSAGE_TYPES.SETTINGS_SAVE, settings: { enabledFileTypes: { definitelyNotARealMediaType: true } } }), 'settings save rejects unknown file-type keys');
  assert(validateMessage({ type: MESSAGE_TYPES.DOM_MEDIA_FOUND, items: [{ url: 'https://example.com/video.mp4', source: 'dom-video' }] }), 'DOM media messages accept bounded scan items');
  assert(!validateMessage({ type: MESSAGE_TYPES.DOM_MEDIA_FOUND, items: [{ url: 'javascript:alert(1).mp4', source: 'dom-video' }] }), 'DOM media messages reject unsafe URL schemes');
  assert(!validateMessage({ type: MESSAGE_TYPES.DOM_MEDIA_FOUND, items: [{ url: `https://example.com/${'x'.repeat(5000)}.mp4` }] }), 'DOM media messages reject oversized scan URLs');
  assert(!validateMessage({ type: MESSAGE_TYPES.BLOB_DOWNLOAD_REQUEST, url: 'blob:https://example.com/id', filename: { unsafe: true } }), 'blob messages reject non-string filenames');
  assert(!validateMessage({ type: MESSAGE_TYPES.BLOB_DOWNLOAD_REQUEST, url: 'https://example.com/video.mp4', filename: 'video.mp4' }), 'blob messages require a page-local blob URL');
  assert(!validateMessage({ type: MESSAGE_TYPES.START_DOWNLOAD, mediaId: 'media-1' }), 'start download message without tab id is invalid');
  assert(!validateMessage({ type: MESSAGE_TYPES.DOWNLOAD_PROGRESS, taskId: 'task-1', percent: 120 }), 'out-of-range download progress is invalid');
  assert(!validateMessage({ type: 'NOPE' }), 'unknown messages are invalid');
  assert(isContentScriptMessageType(MESSAGE_TYPES.DOM_MEDIA_FOUND), 'DOM media messages are content-script messages');
  assert(isContentScriptMessageType(MESSAGE_TYPES.DOWNLOAD_PROGRESS), 'download progress messages are content-script messages');
  assert(isPrivilegedExtensionMessageType(MESSAGE_TYPES.START_DOWNLOAD), 'download starts are privileged extension-page messages');
  assert(isPrivilegedExtensionMessageType(MESSAGE_TYPES.GENERATE_REPORT), 'diagnostic reports are privileged extension-page messages');
  assert(!isPrivilegedExtensionMessageType(MESSAGE_TYPES.DOM_MEDIA_FOUND), 'content updates are not privileged extension-page messages');
}

function testStorageDefaults() {
  const settings = mergeSettings({ maxParallelDownloads: 4, segmentParallelism: 8, enabledFileTypes: { mp4: false } });
  assert(settings.enabledFileTypes.mp4 === false, 'partial file type setting is preserved');
  assert(settings.enabledFileTypes.webm === true, 'missing file type defaults are filled');
  assert(settings.segmentParallelism === 8, 'HLS segment parallelism setting is preserved');
  assert(mergeSettings({ segmentParallelism: 999 }).segmentParallelism === 16, 'HLS segment parallelism is clamped');
  assert(mergeSettings({ segmentRetryLimit: 999 }).segmentRetryLimit === 4, 'HLS segment retry limit is clamped');
  assert(mergeSettings({ queueHistoryRetentionDays: 999 }).queueHistoryRetentionDays === 30, 'queue history retention is clamped');
  assert(mergeSettings({ confirmLargeEpisodeBatchThreshold: 999 }).confirmLargeEpisodeBatchThreshold === 48, 'episode batch confirmation threshold is clamped');
  assert(mergeSettings({ confirmLargeEpisodeBatchThreshold: 1 }).confirmLargeEpisodeBatchThreshold === 2, 'episode batch confirmation threshold lower bound is clamped');
  assert(mergeSettings({ includeSensitiveUrlsInReports: true }).includeSensitiveUrlsInReports === true, 'full-report URL setting is preserved');
  assert(mergeSettings({ hlsVariantPreference: HLS_VARIANT_PREFERENCES.LOWEST }).hlsVariantPreference === HLS_VARIANT_PREFERENCES.LOWEST, 'HLS variant preference is preserved');
  assert(mergeSettings({ hlsVariantPreference: 'invalid' }).hlsVariantPreference === DEFAULT_SETTINGS.hlsVariantPreference, 'invalid HLS variant preference falls back safely');
  assert(mergeSettings({ hlsOutputMethod: HLS_OUTPUT_METHODS.SEPARATE_AUDIO_MERGE }).hlsOutputMethod === DEFAULT_SETTINGS.hlsOutputMethod, 'planned HLS output modes fall back safely');
  assert(!Object.prototype.hasOwnProperty.call(mergeSettings({ unexpectedSetting: true }), 'unexpectedSetting'), 'unknown settings are dropped before storage');
  assert(mergeSettings({ filenameTemplate: 'x'.repeat(300) }).filenameTemplate.length === 180, 'filename template setting is length-limited');
  assert(mergeSettings({ preferredSubfolder: '' }).preferredSubfolder === '', 'an empty preferred subfolder remains empty');
  assert(mergeSettings({ maxParallelDownloads: 2.6 }).maxParallelDownloads === 3, 'fractional parallelism is normalized to a whole number');
  assert(mergeSettings({ duplicateBehavior: 'replace-anything' }).duplicateBehavior === DUPLICATE_BEHAVIORS.AUTO_NUMBER, 'invalid duplicate behavior falls back safely');
  assert(mergeSettings({ includeSensitiveUrlsInReports: 'false' }).includeSensitiveUrlsInReports === false, 'corrupt string values cannot opt reports into sensitive URLs');
  assert(mergeSettings({ maxParallelDownloads: '' }).maxParallelDownloads === DEFAULT_SETTINGS.maxParallelDownloads, 'empty numeric values fall back to defaults');
}

function testCommandEscaping() {
  assert(shellQuote("a'b $HOME `whoami`") === "'a'\\''b $HOME `whoami`'", 'external-helper shell arguments use POSIX-safe single-quote escaping');
}


function testDownloadAllowList() {
  assert(getDownloadAllowDecision({ mediaType: 'video', extension: 'mp4', url: 'https://example.com/video.mp4' }).allowed, 'normal MP4 file is allow-listed');
  const emptyPerformanceMedia = getDownloadAllowDecision({ mediaType: 'video', extension: 'mp4', url: 'https://example.com/empty.mp4', source: SOURCES.PERFORMANCE, initiatorType: 'fetch', resourceInfo: { initiatorType: 'fetch', encodedBodySize: 0, decodedBodySize: 0, transferSize: 300, nextHopProtocol: 'h2' } });
  assert(!emptyPerformanceMedia.allowed && emptyPerformanceMedia.code === 'empty-performance-resource', 'empty fetch responses are not presented as downloadable media');
  const browserBlockedPerformanceMedia = getDownloadAllowDecision({ mediaType: 'video', extension: 'mp4', url: 'https://cdn.example.com/cors-blocked.mp4', source: SOURCES.PERFORMANCE, initiatorType: 'fetch', resourceInfo: { initiatorType: 'fetch', encodedBodySize: 0, decodedBodySize: 0, transferSize: 0, nextHopProtocol: '' } });
  assert(!browserBlockedPerformanceMedia.allowed && browserBlockedPerformanceMedia.code === 'browser-blocked-performance-resource', 'browser-blocked fetch observations fail closed instead of becoming direct-download actions');
  const authenticationPerformanceMedia = getDownloadAllowDecision({ mediaType: 'video', extension: 'mp4', mime: 'text/plain', url: 'https://example.com/auth/media.mp4', source: SOURCES.PERFORMANCE, initiatorType: 'fetch', resourceInfo: { initiatorType: 'fetch', responseStatus: 401, contentType: 'text/plain', encodedBodySize: 39, decodedBodySize: 39, transferSize: 339, nextHopProtocol: 'h2' } });
  assert(!authenticationPerformanceMedia.allowed && authenticationPerformanceMedia.code === 'performance-resource-authentication-response' && authenticationPerformanceMedia.category === ERROR_CATEGORIES.AUTHENTICATION, 'HTTP 401 performance observations are blocked as authentication responses');
  const accessDeniedPerformanceMedia = getDownloadAllowDecision({ mediaType: 'video', extension: 'mp4', mime: 'text/plain', url: 'https://example.com/expired/media.mp4', source: SOURCES.PERFORMANCE, initiatorType: 'fetch', resourceInfo: { initiatorType: 'fetch', responseStatus: 403, contentType: 'text/plain', encodedBodySize: 36, decodedBodySize: 36, transferSize: 336, nextHopProtocol: 'h2' } });
  assert(!accessDeniedPerformanceMedia.allowed && accessDeniedPerformanceMedia.code === 'performance-resource-access-denied-response' && accessDeniedPerformanceMedia.category === ERROR_CATEGORIES.ACCESS_CONTROL, 'HTTP 403 performance observations are blocked as access-control responses');
  const signedFinal = getDownloadAllowDecision({ mediaType: 'video', extension: 'mp4', url: 'https://cdn.example.com/video.mp4?token=abc', isProtected: true, signedOrExpiringHint: true, unsupportedReason: 'This URL appears to use signed, expiring, or tokenized access.' });
  assert(signedFinal.allowed && signedFinal.limited, 'signed top-level final media is allow-listed as a limited direct Chrome download');
  assert(getDownloadAllowDecision({ mediaType: 'video', extension: 'media', mime: 'video/mp4', url: 'https://example.com/download?id=1' }).allowed, 'MIME-only final media is allow-listed');
  assert(getDownloadAllowDecision({ mediaType: 'unknown', extension: 'media', mime: 'video/mp4', url: 'https://example.com/blob?id=2' }).allowed, 'unknown media type with clear video MIME is allow-listed as final media');
  const misleadingImageUrl = getDownloadAllowDecision({ mediaType: 'image', extension: 'jpg', mime: 'video/mp4', url: 'https://example.com/poster.jpg', sizeBytes: 9_000_000 });
  assert(misleadingImageUrl.allowed && misleadingImageUrl.action === 'save-final-media' && misleadingImageUrl.evidenceFlags.includes('extension-mime-conflict'), 'clear video MIME can override a misleading image URL extension for a final media download');
  const htmlInsteadOfMp4 = getDownloadAllowDecision({ mediaType: 'video', extension: 'mp4', mime: 'text/html', url: 'https://example.com/video.mp4' });
  assert(!htmlInsteadOfMp4.allowed && htmlInsteadOfMp4.code === 'response-mime-not-media', 'MP4-looking URLs that return HTML/login pages are blocked');
  const inlineFilenameVideo = getDownloadAllowDecision({ mediaType: 'unknown', extension: 'download', mime: 'application/octet-stream', url: 'https://example.com/file?id=4', contentDisposition: 'inline; filename="clip.webm"', sizeBytes: 7_000_000 });
  assert(inlineFilenameVideo.allowed && inlineFilenameVideo.inferredExtension === 'webm', 'Content-Disposition filename hints work for inline as well as attachment responses');
  const attachmentNamedVideoItem = { mediaType: 'unknown', extension: 'download', mime: 'application/octet-stream', url: 'https://example.com/download?id=3', contentDisposition: 'attachment; filename=movie.mp4', hasAttachmentDisposition: true, sizeBytes: 5_000_000 };
  const attachmentNamedVideo = getDownloadAllowDecision(attachmentNamedVideoItem);
  assert(attachmentNamedVideo.allowed && attachmentNamedVideo.inferredExtension === 'mp4' && attachmentNamedVideo.evidenceFlags.includes('attachment-filename'), 'attachment filename can allow octet-stream final media when the URL extension is unhelpful');
  const disabledAttachmentNamedVideo = getDownloadAllowDecision({ mediaType: 'unknown', extension: 'download', mime: 'application/octet-stream', url: 'https://example.com/download?id=3', contentDisposition: 'attachment; filename=movie.mp4', hasAttachmentDisposition: true }, { settings: mergeSettings({ enabledFileTypes: { mp4: false } }) });
  assert(!disabledAttachmentNamedVideo.allowed && disabledAttachmentNamedVideo.code === 'file-type-disabled-by-attachment-name', 'attachment-inferred media respects file type settings');
  assert(getDownloadAllowDecision({ mediaType: 'metadata', extension: 'json', mime: 'application/json', url: 'https://example.com/metadata.json' }, { settings: mergeSettings({ enabledFileTypes: { json: true } }) }).allowed, 'explicitly enabled media metadata files are allow-listed');
  assert(!getDownloadAllowDecision({ mediaType: 'metadata', extension: 'json', mime: 'application/json', url: 'https://example.com/metadata.json' }).allowed, 'metadata files remain blocked when the file type is disabled by default');
  assert(!getDownloadAllowDecision({ mediaType: 'segment', extension: 'ts', url: 'https://example.com/seg.ts?token=abc' }).allowed, 'tokenized stream segments are still blocked');
  const standaloneTs = getDownloadAllowDecision({ mediaType: 'segment', extension: 'ts', mime: 'video/mp2t', url: 'https://cdn.example.com/full.ts?token=abc', isProtected: true, signedOrExpiringHint: true, unsupportedReason: 'signed URL', source: SOURCES.DOM_VIDEO });
  assert(standaloneTs.allowed && standaloneTs.code === 'signed-standalone-transport-stream-file', 'signed top-level standalone MPEG-TS files with strong final-file hints are allow-listed');
  assert(!getDownloadAllowDecision({ mediaType: 'segment', extension: 'part', url: 'https://example.com/seg.part' }).allowed, 'low-latency .part fragments are blocked as standalone downloads');
  const misclassifiedFinalFile = getDownloadAllowDecision({ mediaType: 'segment', extension: 'm4s', mime: 'video/mp4', url: 'https://cdn.example.com/download/asset.m4s?token=abc', isProtected: true, signedOrExpiringHint: true, unsupportedReason: 'signed URL', hasAttachmentDisposition: true, contentDisposition: 'attachment; filename=asset.mp4', sizeBytes: 30_000_000 });
  assert(misclassifiedFinalFile.allowed && misclassifiedFinalFile.code === 'signed-final-file-evidence-override', 'segment-shaped URLs with final-file evidence are allowed as direct final media downloads');
  const octetSegmentFinalFile = getDownloadAllowDecision({ mediaType: 'segment', extension: 'm4s', mime: 'application/octet-stream', url: 'https://cdn.example.com/download/opaque.m4s?token=abc', isProtected: true, signedOrExpiringHint: true, unsupportedReason: 'signed URL', hasAttachmentDisposition: true, contentDisposition: 'attachment; filename=opaque.mp4', sizeBytes: 12_000_000 });
  assert(octetSegmentFinalFile.allowed && octetSegmentFinalFile.code === 'signed-final-file-evidence-override', 'segment-shaped octet-stream attachment with media filename is allowed as a final file, not a stream component');
  assert(octetSegmentFinalFile.evidenceFlags.includes('content-disposition-attachment'), 'final-file override exposes evidence flags');

  const rangeProbedFinalFile = getDownloadAllowDecision({ mediaType: 'segment', extension: 'm4s', mime: 'video/mp4', url: 'https://cdn.example.com/ranged/asset.m4s?token=abc', isProtected: true, signedOrExpiringHint: true, unsupportedReason: 'signed URL', responseHeaders: { contentRange: 'bytes 0-1048575/52428800', contentRangeTotal: 52_428_800, acceptRanges: 'bytes' } });
  assert(rangeProbedFinalFile.allowed && rangeProbedFinalFile.evidenceFlags.includes('content-range'), 'range-probed segment-shaped final media is allowed when headers prove a full final file');
  const encryptedHls = {
    mediaType: 'hls',
    extension: 'm3u8',
    url: 'https://example.com/live/index.m3u8',
    isProtected: true,
    status: 'encrypted',
    playlist: { encrypted: true, inspected: true }
  };
  assert(!getDownloadAllowDecision(encryptedHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 }).allowed, 'encrypted HLS is not allow-listed for merge/video download');
  assert(getDownloadAllowDecision(encryptedHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY }).allowed, 'encrypted HLS top-level playlist can be saved as playlist text only');
  const signedHls = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/v.m3u8?signature=abc', isProtected: true, signedOrExpiringHint: true, unsupportedReason: 'signed URL' };
  assert(!getDownloadAllowDecision(signedHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.MP4_REMUX }).allowed, 'signed HLS playlist is blocked for segment merge');
  assert(getDownloadAllowDecision(signedHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY }).allowed, 'signed HLS top-level playlist can be saved as playlist text only');
  const deferredHls = {
    mediaType: 'hls',
    extension: 'm3u8',
    url: 'https://example.com/segments-6001.m3u8',
    playlist: { inspected: false, inspectionDeferred: 'per-scan-limit' },
    safetyWarning: 'Playlist inspection was deferred because this scan exposed many manifests. Any conversion still validates encryption, signed components, layout, and size before fetching segments.'
  };
  const deferredHlsDecision = getDownloadAllowDecision(deferredHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 });
  assert(deferredHlsDecision.allowed && deferredHlsDecision.code === 'safe-hls-mpegts-merge', 'generic deferred-inspection guidance is not mistaken for evidence that the top-level HLS URL is signed');
  assert(!deferredHlsDecision.riskFlags.includes('signed-top-level-url'), 'deferred HLS inspection does not emit a false signed-URL risk flag');
  const htmlHls = { mediaType: 'hls', extension: 'm3u8', mime: 'text/html', url: 'https://example.com/not-a-playlist.m3u8' };
  assert(!getDownloadAllowDecision(htmlHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY }).allowed, 'HLS-looking URLs that return HTML are blocked as non-manifest responses');
  const liveHls = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/live.m3u8', playlist: { inspected: true, hasEndList: false, playlistType: 'event' } };
  assert(!getDownloadAllowDecision(liveHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 }).allowed, 'live/event HLS without ENDLIST is playlist-only, not merged as a finite file');
  const vodWithoutEndList = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/vod.m3u8', playlist: { inspected: true, hasEndList: false, playlistType: 'vod', segmentCount: 12, durationSeconds: 300 } };
  assert(getDownloadAllowDecision(vodWithoutEndList, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 }).allowed, 'VOD playlists without ENDLIST are conditionally allowed after runtime checks');
  const separateAudioHls = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/master.m3u8', playlist: { inspected: true, hasEndList: true, hasSeparateAudio: true } };
  assert(!getDownloadAllowDecision(separateAudioHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 }).allowed, 'separate-audio HLS is blocked for complete built-in merge');
  const mixedAudioMaster = {
    mediaType: 'hls',
    extension: 'm3u8',
    url: 'https://example.com/mixed-master.m3u8',
    playlist: { inspected: true, hasEndList: true, hasSeparateAudio: true },
    variants: [
      { url: 'https://example.com/video-only.m3u8', bandwidth: 4000000, audioGroupId: 'aud1', codecs: 'avc1.640028' },
      { url: 'https://example.com/muxed.m3u8', bandwidth: 2000000, codecs: 'avc1.64001f,mp4a.40.2' }
    ]
  };
  const mixedDecision = getDownloadAllowDecision(mixedAudioMaster, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 });
  assert(mixedDecision.allowed && mixedDecision.code === 'hls-self-contained-variant-fallback', 'HLS masters with a self-contained fallback variant are not falsely blocked by separate-audio renditions');
  const videoOnlySeparateAudioMaster = {
    mediaType: 'hls',
    extension: 'm3u8',
    url: 'https://example.com/video-only-master.m3u8',
    playlist: { inspected: true, hasEndList: true, hasSeparateAudio: true },
    variants: [{ url: 'https://example.com/video-only.m3u8', bandwidth: 3000000, codecs: 'avc1.640028' }]
  };
  assert(!getDownloadAllowDecision(videoOnlySeparateAudioMaster, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 }).allowed, 'video-only HLS variants are not mistaken for self-contained output when separate audio is required');
  const uriLessSeparateAudioInfo = parseHlsInspection(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud",CODECS="avc1.640028"
video-only.m3u8`, 'https://example.com/master.m3u8');
  assert(uriLessSeparateAudioInfo.playlist.hasSeparateAudio, 'HLS masters with URI-less AUDIO groups still require separate-audio handling');
  assert(!getDownloadAllowDecision({
    mediaType: 'hls',
    extension: 'm3u8',
    url: 'https://example.com/master.m3u8',
    playlist: { ...uriLessSeparateAudioInfo.playlist, hasEndList: true },
    variants: uriLessSeparateAudioInfo.variants
  }, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 }).allowed, 'URI-less alternate-audio HLS masters are not exposed as complete built-in downloads');
  const helperDecision = getDownloadAllowDecision({ mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/plain.m3u8', playlist: { inspected: true, hasEndList: true } }, { hlsOutputMethod: HLS_OUTPUT_METHODS.EXTERNAL_HELPER });
  assert(helperDecision.allowed && helperDecision.strategy === STRATEGY_NAMES.HLS_EXTERNAL_HELPER && helperDecision.fileRole === 'helper-notes', 'external-helper HLS uses a distinct helper-notes strategy instead of playlist-save reporting');
  const fmp4Hls = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/v.m3u8', playlist: { inspected: true, hasMap: true } };
  assert(!getDownloadAllowDecision(fmp4Hls, { hlsOutputMethod: HLS_OUTPUT_METHODS.MP4_REMUX }).allowed, 'fMP4 HLS is not allow-listed for MPEG-TS remux');
  const fmp4SegmentHls = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/fmp4.m3u8', playlist: { inspected: true, hasFmp4Segments: true } };
  assert(!getDownloadAllowDecision(fmp4SegmentHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.MP4_REMUX }).allowed, 'HLS with fMP4-like segment files is not allow-listed for MPEG-TS remux');
  assert(getDownloadAllowDecision(fmp4Hls, { hlsOutputMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY }).allowed, 'fMP4 HLS playlist file remains downloadable');
  const selectedVariantCountHls = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/master.m3u8', playlist: { inspected: true, playlistKind: 'master', segmentCount: 42, segmentCountScope: 'selected-variant', exactSegmentCount: true, durationSeconds: 252 }, variants: [{ url: 'https://example.com/v.m3u8', bandwidth: 1000, codecs: 'avc1.64001f,mp4a.40.2' }] };
  const selectedVariantCountDecision = getDownloadAllowDecision(selectedVariantCountHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 });
  assert(selectedVariantCountDecision.allowed && selectedVariantCountDecision.segmentCount === 42 && selectedVariantCountDecision.segmentCountScope === 'selected-variant', 'HLS allow-list exposes selected variant segment counts');
  assert(probeHasSelfContainedVariant({ variants: [{ url: 'https://example.com/v.m3u8', codecs: 'avc1.64001f,mp4a.40.2' }] }), 'detailed scan treats audio+video variants as self-contained');
  assert(!probeHasSelfContainedVariant({ variants: [{ url: 'https://example.com/audio.m3u8', codecs: 'mp4a.40.2' }] }), 'detailed scan does not treat audio-only HLS renditions as self-contained');
  assert(!probeHasSelfContainedVariant({ variants: [{ url: 'https://example.com/video.m3u8', codecs: 'avc1.64001f' }] }), 'detailed scan does not treat video-only HLS variants as self-contained');

  const hevcHls = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/hevc.m3u8', playlist: { inspected: true, hasEndList: true, segmentCount: 20, segmentCountScope: 'media-playlist' }, variants: [{ url: 'https://example.com/hevc-v.m3u8', bandwidth: 4000000, codecs: 'hvc1.1.6.L93.B0,mp4a.40.2' }] };
  const forcedHevcMp4 = getDownloadAllowDecision(hevcHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.MP4_REMUX });
  assert(!forcedHevcMp4.allowed && forcedHevcMp4.code === 'hls-codecs-not-mp4-remux-compatible', 'forced MP4 remux is blocked when variant codecs are outside H.264/AAC support');
  const smartHevc = getDownloadAllowDecision(hevcHls, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 });
  assert(smartHevc.allowed && smartHevc.limited && smartHevc.recommendedHlsMethod === HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS, 'Smart MP4 stays allowed with a timestamp-fixed TS fallback recommendation for unsupported codecs');
  const emptyMediaPlaylist = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/empty.m3u8', playlist: { inspected: true, playlistKind: 'media', segmentCount: 0, segmentCountScope: 'media-playlist', exactSegmentCount: true } };
  assert(!getDownloadAllowDecision(emptyMediaPlaylist, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 }).allowed, 'empty HLS media playlists are playlist-only, not merged');
  const masterCountUnavailable = { mediaType: 'hls', extension: 'm3u8', url: 'https://example.com/master.m3u8', playlist: { inspected: true, playlistKind: 'master', segmentCount: 0, segmentCountScope: 'selected-variant-unavailable', exactSegmentCount: false }, variants: [{ url: 'https://cdn.example.com/v.m3u8', bandwidth: 1000, codecs: 'avc1.64001f,mp4a.40.2' }] };
  const pendingCountDecision = getDownloadAllowDecision(masterCountUnavailable, { hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4 });
  assert(pendingCountDecision.allowed && pendingCountDecision.confidence === 'conditional', 'master playlist with unavailable selected-variant count remains conditionally allowed for runtime verification');
  const dash = { mediaType: 'dash', extension: 'mpd', url: 'https://example.com/manifest.mpd?X-Amz-Signature=abc', isProtected: true, manifest: { encrypted: true } };
  assert(getDownloadAllowDecision(dash).allowed, 'protected/signed DASH MPD is allow-listed as manifest file only');
  const summary = buildDownloadAllowSummary(encryptedHls);
  assert(summary.allowed && !summary.methods[HLS_OUTPUT_METHODS.SMART_MP4].allowed && summary.methods[HLS_OUTPUT_METHODS.PLAYLIST_ONLY].allowed, 'HLS summary tracks per-method allow decisions');
  assert(Array.isArray(summary.decisions) && summary.decisions.length >= 2, 'allow-list summary exposes detailed action decisions');
  assert(summary.decisions.some((decision) => typeof decision.confidence === 'string' && Array.isArray(decision.riskFlags)), 'allow-list decisions expose confidence and risk flags');
  assert(buildDownloadAllowSummary(attachmentNamedVideoItem).decisions.some((decision) => Array.isArray(decision.evidenceFlags) && decision.evidenceFlags.includes('attachment-filename')), 'allow-list summary exposes evidence flags for UI details');
}


function testFrontendTruthModel() {
  const protectedDash = {
    id: 'media-1-dash-a',
    mediaType: 'dash',
    extension: 'mpd',
    url: 'https://example.com/manifest.mpd?token=abc',
    isProtected: true,
    status: 'encrypted',
    manifest: { encrypted: true },
    downloadPolicy: buildDownloadAllowSummary({ mediaType: 'dash', extension: 'mpd', url: 'https://example.com/manifest.mpd?token=abc', isProtected: true, manifest: { encrypted: true } })
  };
  assert(downloadDecisionFor(protectedDash).allowed, 'frontend decision trusts allow-list for limited DASH manifest-only save');
  assert(classifyCandidate(protectedDash).key === 'manifest', 'protected DASH is shown as manifest-only, not as final video or false unsupported');

  const readyDirect = {
    id: 'media-2-video-a',
    mediaType: 'video',
    extension: 'mp4',
    url: 'https://example.com/video.mp4',
    hostname: 'example.com',
    detectedAt: new Date().toISOString(),
    downloadPolicy: buildDownloadAllowSummary({ mediaType: 'video', extension: 'mp4', url: 'https://example.com/video.mp4' })
  };
  const model = buildPopupModel({
    mediaItems: [readyDirect],
    siteAccess: { origin: 'https://example.com/*', granted: false },
    settings: DEFAULT_SETTINGS,
    queue: {}
  });
  assert(model.kind === 'ready-direct', 'missing optional host access does not hide a ready direct active-tab candidate');

  const disabledMp4Settings = {
    ...DEFAULT_SETTINGS,
    enabledFileTypes: { ...DEFAULT_SETTINGS.enabledFileTypes, mp4: false }
  };
  const cachedAllowedMp4 = {
    ...readyDirect,
    id: 'media-2-video-disabled',
    downloadPolicy: buildDownloadAllowSummary(readyDirect, DEFAULT_SETTINGS)
  };
  assert(!downloadDecisionFor(cachedAllowedMp4, disabledMp4Settings).allowed, 'frontend decisions recompute current Options file-type toggles instead of trusting stale cached policy');
  assert(classifyCandidate(cachedAllowedMp4, disabledMp4Settings).key === 'unsupported', 'disabled file types do not produce a usable popup CTA');

  const staleDirect = {
    ...readyDirect,
    id: 'media-2-video-stale',
    detectedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 11 * 60_000).toISOString()
  };
  assert(classifyCandidate(staleDirect, DEFAULT_SETTINGS).key === 'stale', 'expired media evidence is classified as stale before action decisions');
  const staleModel = buildPopupModel({ mediaItems: [staleDirect], settings: DEFAULT_SETTINGS, queue: {} });
  assert(staleModel.kind === 'needs-playback' && /Rescan current page/.test(staleModel.primary), 'popup disables stale snapshot actions and asks for rescan');

  const noMediaModel = buildPopupModel({
    mediaItems: [],
    siteAccess: { origin: 'https://example.com/*', granted: false },
    settings: DEFAULT_SETTINGS,
    queue: {},
    lastScan: { ok: true }
  });
  assert(noMediaModel.kind === 'needs-playback' && /Allow on this site/.test(noMediaModel.secondary), 'no-media state offers site access as a secondary action instead of blocking basic scan');

  const navigationModel = buildPopupModel({
    mediaItems: [],
    settings: DEFAULT_SETTINGS,
    queue: {},
    lastScan: { ok: false, message: 'This tab navigated to a new page. Media Scout cleared stale detections.' }
  });
  assert(navigationModel.kind === 'needs-playback' && /Rescan current page/.test(navigationModel.primary), 'navigation resets ask for rescan instead of pretending the browser page is restricted');

  const hlsItem = { mediaType: 'hls', url: 'https://example.com/video.m3u8', hostname: 'example.com' };
  assert(filenamePreview(hlsItem, { ...DEFAULT_SETTINGS, hlsOutputMethod: HLS_OUTPUT_METHODS.PLAYLIST_ONLY }).endsWith('.m3u8'), 'HLS filename preview follows playlist-only output');
  assert(filenamePreview(hlsItem, { ...DEFAULT_SETTINGS, hlsOutputMethod: HLS_OUTPUT_METHODS.EXTERNAL_HELPER }).endsWith('.txt'), 'HLS filename preview follows external-helper notes output');
  assert(/Verify uncertain/.test(taskVisibleCopy({ status: DOWNLOAD_STATUSES.VERIFY_UNCERTAIN })), 'verify-uncertain queue tasks get user-facing copy');
}

function testStrategyOrdering() {
  const diagnostics = {
    prioritize(list) {
      return [STRATEGY_NAMES.DIRECT_FILE, STRATEGY_NAMES.BLOB_PAGE_DOWNLOAD, STRATEGY_NAMES.DASH_MANIFEST, STRATEGY_NAMES.HTML_MEDIA_SOURCE]
        .filter((name) => list.includes(name))
        .concat(list.filter((name) => ![STRATEGY_NAMES.DIRECT_FILE, STRATEGY_NAMES.BLOB_PAGE_DOWNLOAD, STRATEGY_NAMES.DASH_MANIFEST, STRATEGY_NAMES.HTML_MEDIA_SOURCE].includes(name)));
    }
  };

  const blobStrategies = orderedStrategiesForMedia({ mediaType: MEDIA_TYPES.VIDEO, url: 'blob:https://example.com/1234' }, diagnostics);
  assert(blobStrategies.length === 1 && blobStrategies[0] === STRATEGY_NAMES.BLOB_PAGE_DOWNLOAD, 'blob downloads keep page-context strategy and cannot be diagnostics-reordered behind direct-file');

  const dashStrategies = orderedStrategiesForMedia({ mediaType: MEDIA_TYPES.DASH, extension: 'mpd', url: 'https://example.com/manifest.mpd' }, diagnostics);
  assert(dashStrategies.length === 1 && dashStrategies[0] === STRATEGY_NAMES.DASH_MANIFEST, 'DASH stays manifest-only and cannot fall through to direct video download');

  const directStrategies = orderedStrategiesForMedia({ mediaType: MEDIA_TYPES.VIDEO, source: SOURCES.DOM_VIDEO, url: 'https://example.com/video.mp4' }, diagnostics);
  assert(directStrategies[0] === STRATEGY_NAMES.DIRECT_FILE && directStrategies.includes(STRATEGY_NAMES.HTML_MEDIA_SOURCE), 'diagnostics can still prioritize equivalent HTTP direct-media strategies');
}

function testRetryPolicy() {
  assert(canRetryCategory(ERROR_CATEGORIES.NETWORK), 'network failures can be retried');
  assert(!canRetryCategory(ERROR_CATEGORIES.DRM), 'DRM failures are not retried');
}

export function runSelfTests() {
  const tests = [
    testFilenameSanitization,
    testMediaUrlValidation,
    testMessageValidation,
    testStorageDefaults,
    testDownloadAllowList,
    testFrontendTruthModel,
    testStrategyOrdering,
    testCommandEscaping,
    testRetryPolicy
  ];
  const results = [];
  for (const test of tests) {
    try {
      test();
      results.push({ name: test.name, passed: true });
    } catch (error) {
      results.push({ name: test.name, passed: false, message: error.message });
    }
  }
  return {
    passed: results.every((result) => result.passed),
    results
  };
}
