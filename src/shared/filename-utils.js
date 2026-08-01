import { DEFAULT_SETTINGS, DUPLICATE_BEHAVIORS, MAX_FILENAME_LENGTH } from './constants.js';
import { getHostname, nowISO } from './utils.js';

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

export function sanitizeFilenamePart(value, fallback = 'media') {
  let text = String(value || '').replace(UNSAFE_FILENAME_CHARS, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/[. ]+$/g, '');
  if (!text || WINDOWS_RESERVED_NAMES.test(text)) text = fallback;
  return text.slice(0, MAX_FILENAME_LENGTH).trim() || fallback;
}

export function sanitizeSubfolder(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .map((part) => sanitizeFilenamePart(part, 'Downloads'))
    .filter(Boolean)
    .join('/');
}

export function sanitizeExtension(extension) {
  const clean = String(extension || 'media').toLowerCase().replace(/[^a-z0-9]/g, '');
  return clean || 'media';
}

/**
 * Extracts the preferred media title from a browser tab title.
 *
 * Many pages include the human-readable video/program name inside Chinese
 * book-title brackets, for example: `Site - 《大东北之你要下岗我涨薪》 - Watch`.
 * When present, Media Scout uses the first non-empty bracketed value as the
 * default filename base. This is a naming convenience only; it does not alter
 * detection, access, or download behavior.
 *
 * @param {string} value Raw tab title.
 * @returns {string|null} Text inside the first non-empty `《...》` pair, or null.
 */
export function extractBookTitleBracketText(value) {
  const text = String(value || '');
  const matches = text.matchAll(/《([^《》]{1,240})》/gu);
  for (const match of matches) {
    const candidate = match[1].replace(/\s+/g, ' ').trim();
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Returns the safest title to use for filenames.
 * Prefer `《...》` content from the tab title, then the full tab title, then a
 * media-provided title, finally a stable fallback.
 */
export function getPreferredTabTitleForFilename(tab, media) {
  const rawTabTitle = tab?.title || '';
  return extractBookTitleBracketText(rawTabTitle) || rawTabTitle || media?.title || 'Untitled tab';
}

export function buildFilename({ settings = DEFAULT_SETTINGS, media, tab, index = 0 }) {
  const extension = sanitizeExtension(media.extension);
  const preferredTitle = getPreferredTabTitleForFilename(tab, media);
  const tabTitle = sanitizeFilenamePart(preferredTitle, 'Untitled tab');
  const rawTabTitle = sanitizeFilenamePart(tab?.title || media.title || 'Untitled tab', 'Untitled tab');
  const hostname = sanitizeFilenamePart(media.hostname || getHostname(media.url) || 'site', 'site');
  const resolution = sanitizeFilenamePart(media.resolution || 'unknown-resolution', 'unknown-resolution');
  const date = nowISO().slice(0, 10);
  const indexSuffix = index > 0 ? ` (${index})` : '';
  const template = settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate;
  let filename = template
    .replaceAll('{tabTitle}', tabTitle)
    .replaceAll('{rawTabTitle}', rawTabTitle)
    .replaceAll('{hostname}', hostname)
    .replaceAll('{resolution}', resolution)
    .replaceAll('{date}', date)
    .replaceAll('{index}', String(index))
    .replaceAll('{indexSuffix}', indexSuffix)
    .replaceAll('{extension}', extension);

  if (!filename.toLowerCase().endsWith(`.${extension}`)) filename = `${filename}.${extension}`;
  const lastDot = filename.lastIndexOf('.');
  const namePart = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const extPart = lastDot > 0 ? filename.slice(lastDot + 1) : extension;
  filename = `${sanitizeFilenamePart(namePart, 'media')}.${sanitizeExtension(extPart)}`;

  const folder = sanitizeSubfolder(settings.preferredSubfolder || '');
  return folder ? `${folder}/${filename}` : filename;
}

export function duplicateBehaviorToConflictAction(duplicateBehavior) {
  switch (duplicateBehavior) {
    case DUPLICATE_BEHAVIORS.ASK:
      return 'prompt';
    case DUPLICATE_BEHAVIORS.OVERWRITE:
      return 'overwrite';
    case DUPLICATE_BEHAVIORS.AUTO_NUMBER:
    default:
      return 'uniquify';
  }
}
