/**
 * Central media type registry for Media Scout Downloader.
 *
 * This registry intentionally covers common browser-visible media assets while
 * keeping strategy decisions separate from detection. Most entries are direct
 * downloads; only safe non-encrypted HLS MPEG-TS is currently converted to MP4.
 */
export const MEDIA_GROUPS = Object.freeze({
  VIDEO: 'video',
  AUDIO: 'audio',
  HLS: 'hls',
  DASH: 'dash',
  STREAM: 'stream',
  SEGMENT: 'segment',
  SUBTITLE: 'subtitle',
  IMAGE: 'image',
  PLAYLIST: 'playlist',
  METADATA: 'metadata',
  UNKNOWN: 'unknown'
});

function entry(id, group, extensions, mimeTypes, label, options = {}) {
  return Object.freeze({ id, group, extensions, mimeTypes, label, ...options });
}

export const MEDIA_TYPE_REGISTRY = Object.freeze([
  // Progressive video / containers
  entry('video.mp4', MEDIA_GROUPS.VIDEO, ['mp4', 'm4v', 'mp4v'], ['video/mp4', 'application/mp4'], 'MP4 video', { finalFile: true }),
  entry('video.quicktime', MEDIA_GROUPS.VIDEO, ['mov', 'qt'], ['video/quicktime', 'video/x-quicktime'], 'QuickTime video', { finalFile: true }),
  entry('video.webm', MEDIA_GROUPS.VIDEO, ['webm'], ['video/webm'], 'WebM video', { finalFile: true }),
  entry('video.ogg', MEDIA_GROUPS.VIDEO, ['ogv', 'ogx'], ['video/ogg'], 'Ogg video', { finalFile: true }),
  entry('video.mpeg', MEDIA_GROUPS.VIDEO, ['mpeg', 'mpg', 'mpe', 'm1v', 'm2v'], ['video/mpeg'], 'MPEG video', { finalFile: true }),
  entry('video.transport-stream', MEDIA_GROUPS.SEGMENT, ['ts', 'm2ts', 'mts'], ['video/mp2t'], 'MPEG-TS segment/video', { directDownload: true, segment: true }),
  entry('video.matroska', MEDIA_GROUPS.VIDEO, ['mkv'], ['video/x-matroska', 'video/matroska'], 'Matroska video', { finalFile: true }),
  entry('video.avi', MEDIA_GROUPS.VIDEO, ['avi'], ['video/x-msvideo', 'video/avi'], 'AVI video', { finalFile: true }),
  entry('video.3gpp', MEDIA_GROUPS.VIDEO, ['3gp', '3g2'], ['video/3gpp', 'video/3gpp2'], '3GPP video', { finalFile: true }),
  entry('video.flash', MEDIA_GROUPS.VIDEO, ['flv', 'f4v'], ['video/x-flv'], 'Flash video', { finalFile: true, legacy: true }),
  entry('video.windows-media', MEDIA_GROUPS.VIDEO, ['wmv', 'asf'], ['video/x-ms-wmv', 'video/x-ms-asf'], 'Windows Media video', { finalFile: true, legacy: true }),
  entry('video.mxf', MEDIA_GROUPS.VIDEO, ['mxf'], ['application/mxf'], 'MXF video', { finalFile: true, professional: true }),

  // Audio
  entry('audio.mp3', MEDIA_GROUPS.AUDIO, ['mp3'], ['audio/mpeg', 'audio/mp3'], 'MP3 audio', { finalFile: true }),
  entry('audio.mp4', MEDIA_GROUPS.AUDIO, ['m4a', 'mp4a', 'm4b'], ['audio/mp4', 'audio/x-m4a'], 'MPEG-4 audio', { finalFile: true }),
  entry('audio.aac', MEDIA_GROUPS.AUDIO, ['aac', 'adts'], ['audio/aac', 'audio/aacp', 'audio/adts'], 'AAC audio', { finalFile: true }),
  entry('audio.wav', MEDIA_GROUPS.AUDIO, ['wav', 'wave'], ['audio/wav', 'audio/x-wav', 'audio/vnd.wave'], 'WAV audio', { finalFile: true }),
  entry('audio.ogg', MEDIA_GROUPS.AUDIO, ['ogg', 'oga'], ['audio/ogg', 'application/ogg'], 'Ogg audio', { finalFile: true }),
  entry('audio.opus', MEDIA_GROUPS.AUDIO, ['opus'], ['audio/opus'], 'Opus audio', { finalFile: true }),
  entry('audio.webm', MEDIA_GROUPS.AUDIO, ['weba'], ['audio/webm'], 'WebM audio', { finalFile: true }),
  entry('audio.flac', MEDIA_GROUPS.AUDIO, ['flac'], ['audio/flac', 'audio/x-flac'], 'FLAC audio', { finalFile: true }),
  entry('audio.aiff', MEDIA_GROUPS.AUDIO, ['aiff', 'aif', 'aifc'], ['audio/aiff', 'audio/x-aiff'], 'AIFF audio', { finalFile: true }),
  entry('audio.amr', MEDIA_GROUPS.AUDIO, ['amr', 'awb'], ['audio/amr', 'audio/amr-wb'], 'AMR audio', { finalFile: true, legacy: true }),
  entry('audio.midi', MEDIA_GROUPS.AUDIO, ['mid', 'midi'], ['audio/midi', 'audio/x-midi'], 'MIDI audio', { finalFile: true }),

  // Streaming manifests/playlists
  entry('stream.hls', MEDIA_GROUPS.HLS, ['m3u8'], ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl', 'application/mpegurl'], 'HLS playlist', { manifest: true, canConvertToMp4: true }),
  entry('playlist.m3u', MEDIA_GROUPS.PLAYLIST, ['m3u'], ['audio/mpegurl', 'audio/x-mpegurl', 'application/mpegurl'], 'M3U playlist', { manifest: true }),
  entry('stream.dash', MEDIA_GROUPS.DASH, ['mpd'], ['application/dash+xml'], 'DASH manifest', { manifest: true }),
  entry('stream.smooth', MEDIA_GROUPS.STREAM, ['ism', 'isml'], ['application/vnd.ms-sstr+xml'], 'Smooth Streaming manifest', { manifest: true, directDownload: true }),
  entry('stream.hds', MEDIA_GROUPS.STREAM, ['f4m'], ['application/f4m+xml'], 'Adobe HDS manifest', { manifest: true, legacy: true, directDownload: true }),

  // Segments and fragments. Keep visible as stream internals, not final videos.
  entry('segment.fmp4', MEDIA_GROUPS.SEGMENT, ['m4s', 'cmfv', 'cmfa'], ['video/iso.segment', 'audio/iso.segment'], 'fMP4/CMAF segment', { segment: true }),
  entry('segment.partial', MEDIA_GROUPS.SEGMENT, ['part'], [], 'Low-latency partial segment', { segment: true }),

  // Subtitles, captions, chapters, timed metadata
  entry('subtitle.webvtt', MEDIA_GROUPS.SUBTITLE, ['vtt'], ['text/vtt'], 'WebVTT subtitles', { companion: true }),
  entry('subtitle.srt', MEDIA_GROUPS.SUBTITLE, ['srt'], ['application/x-subrip'], 'SRT subtitles', { companion: true }),
  entry('subtitle.ttml', MEDIA_GROUPS.SUBTITLE, ['ttml', 'dfxp'], ['application/ttml+xml'], 'TTML/DFXP subtitles', { companion: true }),
  entry('subtitle.sami', MEDIA_GROUPS.SUBTITLE, ['smi', 'sami'], ['application/smil'], 'SAMI subtitles', { companion: true }),
  entry('subtitle.ass', MEDIA_GROUPS.SUBTITLE, ['ass', 'ssa'], [], 'ASS/SSA subtitles', { companion: true }),
  entry('subtitle.lyrics', MEDIA_GROUPS.SUBTITLE, ['lrc', 'sbv'], [], 'Lyrics/caption text', { companion: true }),

  // Posters, thumbnails, sprites, cover art
  entry('image.jpeg', MEDIA_GROUPS.IMAGE, ['jpg', 'jpeg', 'jfif', 'pjpeg', 'pjp'], ['image/jpeg'], 'JPEG image', { companion: true }),
  entry('image.png', MEDIA_GROUPS.IMAGE, ['png'], ['image/png'], 'PNG image', { companion: true }),
  entry('image.webp', MEDIA_GROUPS.IMAGE, ['webp'], ['image/webp'], 'WebP image', { companion: true }),
  entry('image.avif', MEDIA_GROUPS.IMAGE, ['avif'], ['image/avif'], 'AVIF image', { companion: true }),
  entry('image.gif', MEDIA_GROUPS.IMAGE, ['gif'], ['image/gif'], 'GIF image', { companion: true }),
  entry('image.apng', MEDIA_GROUPS.IMAGE, ['apng'], ['image/apng'], 'APNG image', { companion: true }),
  entry('image.svg', MEDIA_GROUPS.IMAGE, ['svg'], ['image/svg+xml'], 'SVG image', { companion: true }),
  entry('image.bmp', MEDIA_GROUPS.IMAGE, ['bmp'], ['image/bmp', 'image/x-ms-bmp'], 'BMP image', { companion: true, legacy: true }),
  entry('image.ico', MEDIA_GROUPS.IMAGE, ['ico', 'cur'], ['image/vnd.microsoft.icon', 'image/x-icon'], 'Icon image', { companion: true, lowPriority: true }),
  entry('image.tiff', MEDIA_GROUPS.IMAGE, ['tif', 'tiff'], ['image/tiff'], 'TIFF image', { companion: true, professional: true }),

  // Metadata candidates are intentionally disabled by default because JSON/XML is noisy.
  entry('metadata.json', MEDIA_GROUPS.METADATA, ['json'], [], 'Media metadata JSON', { companion: true, defaultEnabled: false }),
  entry('metadata.xml', MEDIA_GROUPS.METADATA, ['xml'], [], 'Media metadata XML', { companion: true, defaultEnabled: false })
]);

export const MEDIA_EXTENSION_MAP = Object.freeze(Object.fromEntries(
  MEDIA_TYPE_REGISTRY.flatMap((entry) => entry.extensions.map((extension) => [extension, entry.group]))
));

export const DEFAULT_ENABLED_FILE_TYPES = Object.freeze(Object.fromEntries(
  MEDIA_TYPE_REGISTRY.flatMap((entry) => entry.extensions.map((extension) => [extension, entry.defaultEnabled !== false]))
));

export function registryEntryForExtension(extension = '') {
  const normalized = String(extension || '').toLowerCase().replace(/^\./, '');
  return MEDIA_TYPE_REGISTRY.find((entry) => entry.extensions.includes(normalized)) || null;
}

export function registryEntryForMime(mime = '') {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!normalized) return null;
  return MEDIA_TYPE_REGISTRY.find((entry) => entry.mimeTypes.includes(normalized)) || null;
}
