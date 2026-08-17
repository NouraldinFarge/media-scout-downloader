import { PROTECTED_QUERY_HINTS } from './constants.js';
import { stableHash } from './utils.js';

const textEncoder = new TextEncoder();
const OMITTED_TITLE = '[title omitted by default]';
const OMITTED_FILENAME = '[filename omitted by default]';
const REDACTED_SECRET = '[redacted secret field]';
const REDACTED_LOCAL_PATH = '[local path redacted]';
const REDACTED_BLOB = 'blob://redacted';
const CONTEXT_KEYS = Object.freeze([
  'schemaVersion',
  'tabId',
  'tabRevision',
  'sourceSignature',
  'candidateSignature',
  'queueSignature',
  'queueHistorySignature',
  'settingsSignature',
  'permissionSignature',
  'diagnosticsSignature',
  'scanSignature',
  'sensitivity'
]);

export function buildReportExposureSummary(includeSensitiveUrls = false) {
  if (includeSensitiveUrls) {
    return [
      exposure('page-title', 'Page titles', 'included', 'Exact page-visible titles are included and shown in the preview.'),
      exposure('hostname', 'Hostnames', 'included', 'Exact page and media hostnames are included and shown in the preview.'),
      exposure('filenames', 'Filenames', 'included', 'Exact runtime filenames may be included and are shown in the preview.'),
      exposure('full-urls', 'Full URLs', 'included-sensitive', 'Full HTTP(S) page and media URLs are included after this separate confirmation.'),
      exposure('url-paths', 'URL paths or hashes', 'included-sensitive', 'Exact URL paths are included; correlation hashes may also appear.'),
      exposure('query-names', 'Query names', 'included-sensitive', 'URL query-parameter names are included inside full URLs.'),
      exposure('query-values', 'Query values', 'included-sensitive', 'URL query values are included inside full URLs and may identify an account or session.'),
      exposure('tokens-secrets', 'Tokens or secret-shaped fields', 'redacted', 'Secret-shaped object fields, credential-bearing URL components, and secret-shaped URL parameters are always redacted.'),
      exposure('queue-history', 'Queue history', 'included', 'Current and privacy-reduced persisted queue evidence is included.'),
      exposure('diagnostics', 'Diagnostics', 'included', 'Bounded local strategy outcomes, error categories, and self-test results are included.'),
      exposure('screenshots', 'Screenshots', 'omitted', 'Screenshots are not generated or included.'),
      exposure('local-paths', 'Local paths', 'redacted', 'Drive, user-profile, home, temporary, and network paths are redacted.'),
      exposure('browser-platform', 'Browser or platform details', 'included', 'The extension version, manifest permissions, user agent, platform, and language are included.'),
      exposure('blob-identifiers', 'Blob identifiers', 'redacted', 'Page-local blob identifiers are always redacted because they are not useful outside the source page.')
    ];
  }

  return [
    exposure('page-title', 'Page titles', 'omitted', 'Page-visible titles are omitted because they can reveal private activity.'),
    exposure('hostname', 'Hostnames', 'hashed', 'Hostnames are replaced with stable local correlation hashes.'),
    exposure('filenames', 'Filenames', 'omitted', 'Runtime filenames and display names are omitted.'),
    exposure('full-urls', 'Full URLs', 'redacted', 'Full page and media URLs are replaced with redacted summaries.'),
    exposure('url-paths', 'URL paths or hashes', 'hashed', 'Only path hashes and safe extension hints are retained.'),
    exposure('query-names', 'Query names', 'omitted', 'Query-parameter names are omitted; only a count may remain.'),
    exposure('query-values', 'Query values', 'omitted', 'Query-parameter values are omitted.'),
    exposure('tokens-secrets', 'Tokens or secret-shaped fields', 'redacted', 'Secret-shaped fields, credentials, and token-like diagnostic text are redacted.'),
    exposure('queue-history', 'Queue history', 'included-redacted', 'Current queue evidence is redacted; persisted queue history is privacy-reduced and bounded by retention settings.'),
    exposure('diagnostics', 'Diagnostics', 'included', 'Bounded local strategy outcomes, error categories, and self-test results are included.'),
    exposure('screenshots', 'Screenshots', 'omitted', 'Screenshots are not generated or included.'),
    exposure('local-paths', 'Local paths', 'redacted', 'Drive, user-profile, home, temporary, and network paths are redacted.'),
    exposure('browser-platform', 'Browser or platform details', 'included', 'The extension version, manifest permissions, user agent, platform, and language are included.'),
    exposure('blob-identifiers', 'Blob identifiers', 'redacted', 'Page-local blob identifiers are always redacted.')
  ];
}

export function redactReportValue(value, key = '', seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => redactReportValue(item, key, seen));
  if (!value || typeof value !== 'object') return redactPrimitive(value, key);
  if (seen.has(value)) return '[circular value omitted]';
  seen.add(value);
  const output = Object.create(null);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = redactReportValue(entryValue, entryKey, seen);
  }
  seen.delete(value);
  return output;
}

export function sanitizeSensitiveReportValue(value, key = '', seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => sanitizeSensitiveReportValue(item, key, seen));
  if (!value || typeof value !== 'object') return sanitizeSensitivePrimitive(value, key);
  if (seen.has(value)) return '[circular value omitted]';
  seen.add(value);
  const output = Object.create(null);
  for (const [entryKey, entryValue] of Object.entries(value)) {
    output[entryKey] = sanitizeSensitiveReportValue(entryValue, entryKey, seen);
  }
  seen.delete(value);
  return output;
}

export function reportFileByteLength(content = '') {
  if (content instanceof Uint8Array) return content.byteLength;
  if (content instanceof ArrayBuffer) return content.byteLength;
  return textEncoder.encode(String(content)).byteLength;
}

export function reportFilesDigest(files = []) {
  const normalized = files.map((file) => ({
    path: String(file?.path || ''),
    content: file?.content instanceof Uint8Array
      ? Array.from(file.content)
      : file?.content instanceof ArrayBuffer
        ? Array.from(new Uint8Array(file.content))
        : String(file?.content ?? '')
  }));
  const byteCount = files.reduce((sum, file) => sum + reportFileByteLength(file?.content), 0);
  return `report-${normalized.length}-${byteCount}-${stableHash(canonicalStringify(normalized))}`;
}

export function buildReportContext({
  tab = {},
  tabRevision = 0,
  state = {},
  settings = {},
  siteAccess = {},
  diagnostics = {},
  detailedScan = {},
  persistedQueueHistory = {},
  includeSensitiveUrls = false
} = {}) {
  const mediaItems = Array.isArray(state?.mediaItems)
    ? state.mediaItems.slice().sort((left, right) => String(left?.id || left?.normalizedUrl || left?.url || '').localeCompare(String(right?.id || right?.normalizedUrl || right?.url || '')))
    : [];
  return {
    schemaVersion: 1,
    tabId: Number.isInteger(tab?.id) ? tab.id : null,
    tabRevision: Number.isInteger(tabRevision) ? tabRevision : 0,
    sourceSignature: signature({ id: tab?.id ?? null, url: tab?.url || '', pendingUrl: tab?.pendingUrl || '', title: tab?.title || '' }),
    candidateSignature: signature(mediaItems),
    queueSignature: signature(state?.queue || {}),
    queueHistorySignature: signature(persistedQueueHistory || {}),
    settingsSignature: signature(settings || {}),
    permissionSignature: signature(siteAccess || {}),
    diagnosticsSignature: signature(diagnostics || {}),
    scanSignature: signature(scanContextProjection(detailedScan || {})),
    sensitivity: includeSensitiveUrls ? 'sensitive-urls' : 'redacted'
  };
}

export function reportContextsMatch(expected = {}, current = {}) {
  return CONTEXT_KEYS.every((key) => expected?.[key] === current?.[key]);
}

export function reportPreviewToken(context = {}, digest = '', generatedAt = '') {
  return `preview-${stableHash(canonicalStringify({ context, digest, generatedAt }))}`;
}

export function collectSensitiveReportValues(...sources) {
  const values = new Set();
  const seen = new WeakSet();
  for (const source of sources) collectSensitiveValue(source, '', values, seen);
  return Array.from(values)
    .filter((value) => value.length >= 3)
    .sort((left, right) => right.length - left.length)
    .slice(0, 2048);
}

export function redactKnownReportText(text = '', sensitiveValues = []) {
  let output = String(text);
  for (const rawValue of sensitiveValues) {
    const value = String(rawValue || '');
    if (value.length < 3 || !output.toLowerCase().includes(value.toLowerCase())) continue;
    output = output.replace(new RegExp(escapeRegExp(value), 'gi'), '[identifying value omitted]');
  }
  return output;
}

function redactPrimitive(value, key) {
  if (looksSecretKey(key)) return REDACTED_SECRET;
  if (typeof value !== 'string') return value;
  if (looksTitleKey(key)) return value ? OMITTED_TITLE : '';
  if (looksFilenameKey(key)) return value ? OMITTED_FILENAME : '';
  if (looksHostnameKey(key)) return value ? `host-${stableHash(value.toLowerCase())}` : '';
  if (looksLocalPathKey(key) || looksLikeLocalPath(value)) return value ? REDACTED_LOCAL_PATH : '';
  if (looksUrlKey(key)) return redactUrlValue(value);
  return redactText(value);
}

function sanitizeSensitivePrimitive(value, key) {
  if (looksSecretKey(key)) return REDACTED_SECRET;
  if (typeof value !== 'string') return value;
  if (looksLocalPathKey(key) || looksLikeLocalPath(value)) return value ? REDACTED_LOCAL_PATH : '';
  if (looksUrlKey(key)) return sanitizeSensitiveUrl(value);
  if (looksSecretValue(value)) return REDACTED_SECRET;
  return sanitizeSensitiveText(value);
}

function redactText(text = '') {
  const replaced = replaceUrlLikeValues(String(text), redactUrlValue);
  return redactFilenameLikeText(redactStandaloneSecrets(redactLocalPaths(replaced)));
}

function sanitizeSensitiveText(text = '') {
  const placeholders = [];
  const placeholderText = replaceUrlLikeValues(String(text), (url) => {
    const index = placeholders.push(sanitizeSensitiveUrl(url)) - 1;
    return `\uE000${index}\uE001`;
  });
  const redacted = redactStandaloneSecrets(redactLocalPaths(placeholderText));
  return redacted.replace(/\uE000(\d+)\uE001/g, (_match, index) => placeholders[Number(index)] ?? '[URL omitted]');
}

function replaceUrlLikeValues(text, transform) {
  return String(text)
    .replace(/\b(?:blob:(?:https?:\/\/)?|https?:\/\/)[^\s"'<>]+/gi, (url) => transform(url))
    .replace(/(^|[\s(])((?:\/\/(?!\/)|\/(?!\/)|\.\.?\/)[^\s"'<>]*\?[^\s"'<>]*)/g, (_match, prefix, url) => `${prefix}${transform(url)}`);
}

function redactStandaloneSecrets(text = '') {
  return String(text)
    .replace(/\bbearer\s+[a-z0-9._~+\/-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi, REDACTED_SECRET)
    .replace(/\b(?:github_pat_|gh[pousr]_|sk_(?:live|test)_|sk-(?:live|test)-|AKIA|ASIA)[a-z0-9_-]{8,}\b/gi, REDACTED_SECRET)
    .replace(/\b(authorization|cookie|credential|password|private[_ -]?key|secret|signature|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function redactLocalPaths(text = '') {
  return String(text)
    .replace(/\b[A-Za-z]:\\[^\r\n\t"'<>]+/g, REDACTED_LOCAL_PATH)
    .replace(/\\\\[^\r\n\t"'<>]+/g, REDACTED_LOCAL_PATH)
    .replace(/(^|\s)\/(?:Users|home|Volumes|mnt|tmp|var)\/[^\r\n\t"'<>]+/g, (_match, prefix) => `${prefix}${REDACTED_LOCAL_PATH}`);
}

function redactUrlValue(raw = '') {
  const value = String(raw || '');
  if (!value) return '';
  if (/^https?:\/\/\*\/\*$/i.test(value)) return value;
  if (/^blob:/i.test(value)) return REDACTED_BLOB;
  if (looksLikeLocalPath(value) || /^file:/i.test(value)) return REDACTED_LOCAL_PATH;
  try {
    const url = new URL(value);
    const protocol = url.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return `[url-${stableHash(value)}]`;
    const host = url.hostname ? `host-${stableHash(url.hostname.toLowerCase())}` : 'host-unknown';
    const path = url.pathname && url.pathname !== '/' ? `/path-${stableHash(url.pathname)}` : '';
    const queryCount = Array.from(url.searchParams.keys()).length;
    return `${protocol}//${host}${path}${queryCount ? `?params=${queryCount}` : ''}`;
  } catch (_error) {
    return `[url-${stableHash(value)}]`;
  }
}

function sanitizeSensitiveUrl(raw = '') {
  const value = String(raw || '');
  if (!value) return '';
  if (/^blob:/i.test(value)) return REDACTED_BLOB;
  if (looksLikeLocalPath(value) || /^file:/i.test(value)) return REDACTED_LOCAL_PATH;
  try {
    const isProtocolRelative = /^\/\//.test(value);
    const isRelative = isProtocolRelative || /^(?:\/(?!\/)|\.\.?(?:\/|$))/.test(value);
    const url = new URL(value, isRelative ? 'https://relative.invalid' : undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
    url.username = '';
    url.password = '';
    for (const name of Array.from(url.searchParams.keys())) {
      const values = url.searchParams.getAll(name);
      if (looksSensitiveQueryName(name) || values.some(looksSecretValue)) url.searchParams.set(name, '[redacted]');
    }
    if (url.hash && (/(?:authorization|credential|password|secret|signature|token)\s*[:=]/i.test(url.hash) || looksSecretValue(url.hash.slice(1)))) url.hash = '#[redacted-secret-fragment]';
    if (isProtocolRelative) return `//${url.host}${url.pathname}${url.search}${url.hash}`;
    if (isRelative) return `${url.pathname}${url.search}${url.hash}`;
    return url.toString();
  } catch (_error) {
    return value;
  }
}

function looksUrlKey(key = '') {
  const value = String(key);
  return /(^|_)(url|urls|uri|uris|href|hrefs|src|srcs|origin|origins)$/i.test(value)
    || /(url|urls|uri|uris|href|hrefs|src|srcs)$/i.test(value)
    || /^(poster|referrer)$/i.test(value);
}

function looksSecretKey(key = '') {
  const value = String(key);
  return /(^|[-_])(authorization|cookie|credential|password|secret|signature|token)(s)?($|[-_])/i.test(value)
    || /(authorization|cookie|credential|password|secret|signature|token|apiKey|privateKey|secretKey|accessKey)s?$/i.test(value);
}

function looksTitleKey(key = '') {
  return /(^|[-_])title$/i.test(String(key)) || /^(?:page|document|media|tab)Title$/i.test(String(key));
}

function looksFilenameKey(key = '') {
  return /^(?:fileName|filename|filenameTemplate|outputFilename|preferredName|preferredSubfolder|displayName)$/i.test(String(key));
}

function looksHostnameKey(key = '') {
  return /^(?:host|hostname|hostName)$/i.test(String(key));
}

function looksLocalPathKey(key = '') {
  return /^(?:filePath|localPath|downloadPath|outputPath|sourcePath)$/i.test(String(key));
}

function looksLikeLocalPath(value = '') {
  const text = String(value || '');
  return /^[A-Za-z]:\\/.test(text)
    || /^\\\\/.test(text)
    || /^\/(?:Users|home|Volumes|mnt|tmp|var)\//.test(text)
    || /^file:/i.test(text);
}

function exposure(id, label, handling, detail) {
  return { id, label, handling, detail };
}

function collectSensitiveValue(value, key, values, seen) {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) collectSensitiveValue(item, key, values, seen);
    seen.delete(value);
    return;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    for (const [entryKey, entryValue] of Object.entries(value)) collectSensitiveValue(entryValue, entryKey, values, seen);
    seen.delete(value);
    return;
  }
  if (typeof value !== 'string' || !value) return;
  if (looksTitleKey(key) || looksCollectedFilenameKey(key) || looksHostnameKey(key) || looksLocalPathKey(key)) values.add(value);
  if (looksUrlKey(key)) collectUrlSensitiveParts(value, values);
  for (const match of value.matchAll(/\b(?:blob:(?:https?:\/\/)?|https?:\/\/)[^\s"'<>]+/gi)) collectUrlSensitiveParts(match[0], values);
  for (const match of value.matchAll(/(^|[\s(])((?:\/\/(?!\/)|\/(?!\/)|\.\.?\/)[^\s"'<>]*\?[^\s"'<>]*)/g)) collectUrlSensitiveParts(match[2], values);
}

function collectUrlSensitiveParts(rawValue, values) {
  const raw = String(rawValue || '').replace(/^blob:/i, '');
  try {
    const relative = /^(?:\/|\.\.?(?:\/|$))/.test(raw);
    const url = new URL(raw, relative ? 'https://relative.invalid' : undefined);
    if (url.hostname && url.hostname !== 'relative.invalid') values.add(url.hostname);
    const decodedPath = safeDecode(url.pathname);
    if (decodedPath && decodedPath !== '/') values.add(decodedPath);
    for (const [name, queryValue] of url.searchParams) {
      if (name && queryValue) values.add(`${name}=${queryValue}`);
      if (looksSensitiveQueryName(name) && name.length >= 3) values.add(name);
      if ((looksSensitiveQueryName(name) || looksSecretValue(queryValue)) && queryValue.length >= 3) values.add(queryValue);
    }
  } catch (_error) {}
}

function safeDecode(value = '') {
  try { return decodeURIComponent(value); }
  catch (_error) { return String(value); }
}

function redactFilenameLikeText(text = '') {
  return String(text).replace(/\b[^\s\\/:*?"<>|]{1,120}\.(?:3g2|3gp|aac|avi|flac|gif|jpeg|jpg|m3u8|m4a|m4v|mkv|mov|mp3|mp4|mpd|ogg|opus|png|srt|ts|vtt|wav|webm|webp)\b/gi, OMITTED_FILENAME);
}

function looksSensitiveQueryName(name = '') {
  const value = String(name).toLowerCase();
  return PROTECTED_QUERY_HINTS.some((hint) => value === hint || value.includes(hint))
    || /(?:^|[-_])(auth|authorization|bearer|code|cookie|credential|jwt|oauth|pass|password|policy|secret|session|sig|signature|token)(?:$|[-_])/i.test(value)
    || /^(?:x-amz|x-goog)-/i.test(value);
}

function looksSecretValue(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^bearer\s+[a-z0-9._~+\/-]{8,}$/i.test(text)) return true;
  if (/^eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}$/i.test(text)) return true;
  if (/^(?:github_pat_|gh[pousr]_|sk_(?:live|test)_|sk-(?:live|test)-|AKIA|ASIA)[a-z0-9_-]{8,}$/i.test(text)) return true;
  if (/^[a-f0-9]{32,}$/i.test(text)) return true;
  return text.length >= 32 && /^[a-z0-9._~-]+$/i.test(text) && /[a-z]/i.test(text) && /\d/.test(text);
}

function looksCollectedFilenameKey(key = '') {
  return /^(?:fileName|filename|outputFilename|preferredName|displayName)$/i.test(String(key));
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function signature(value) {
  return stableHash(canonicalStringify(value));
}

function scanContextProjection(scan = {}) {
  return {
    unavailable: Boolean(scan?.unavailable),
    error: String(scan?.error || ''),
    frame: projectFields(scan?.frame, ['url', 'title', 'referrer', 'isTop']),
    document: projectFields(scan?.document, ['url', 'title', 'iframeCount', 'mediaElementCount', 'videoCount', 'audioCount']),
    frames: projectList(scan?.frames, ['frameId', 'url', 'title', 'isTop', 'unavailable', 'error', 'mediaElementCount', 'iframeCount']),
    mediaElements: projectList(scan?.mediaElements, ['frameId', 'frameUrl', 'tagName', 'currentSrc', 'srcProperty', 'srcAttribute', 'poster', 'resolution', 'sourceCount']),
    iframes: projectList(scan?.iframes, ['frameId', 'frameUrl', 'src', 'title', 'name']),
    literalMediaHints: projectList(scan?.literalMediaHints, ['frameId', 'frameUrl', 'url', 'source', 'context', 'extension']),
    decisions: projectList(scan?.decisions, ['frameId', 'frameUrl', 'rawUrl', 'normalizedUrl', 'source', 'attribute', 'tagName', 'mime', 'acceptedByBasicScanner', 'reasons']),
    playlistProbes: projectList(scan?.playlistProbes, ['frameId', 'frameUrl', 'ok', 'url', 'extension', 'playlistKind', 'encrypted', 'hasMap', 'hasByteRange', 'variantUrls', 'audioRenditionUrls', 'segmentCount', 'errorCategory']),
    performanceMedia: projectList(scan?.performance?.mediaLikeEntries, ['frameId', 'frameUrl', 'url', 'extension', 'initiatorType']),
    performanceInteresting: projectList(scan?.performance?.interestingEntries, ['frameId', 'frameUrl', 'url', 'extension', 'initiatorType'])
  };
}

function projectList(values, keys) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => projectFields(value, keys)).sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
}

function projectFields(value, keys) {
  if (!value || typeof value !== 'object') return {};
  const output = Object.create(null);
  for (const key of keys) {
    if (value[key] != null) output[key] = value[key];
  }
  return output;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value, new WeakSet()));
}

function canonicalize(value, seen) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    return value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key], seen);
  seen.delete(value);
  return output;
}
