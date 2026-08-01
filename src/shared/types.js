/**
 * @typedef {'video'|'audio'|'hls'|'dash'|'unknown'} MediaType
 * @typedef {'network'|'dom-video'|'dom-audio'|'dom-source'|'response-header'|'hls-variant'|'dash-representation'|'blob'|'manual-url'} DetectionSource
 *
 * @typedef {Object} MediaItem
 * @property {string} id Stable local id based on tab, normalized URL, and media type.
 * @property {number} tabId Chrome tab id.
 * @property {string} url Downloadable or inspectable URL. Stored only in runtime state, not diagnostics.
 * @property {string} normalizedUrl URL with hash removed for dedupe.
 * @property {MediaType} mediaType
 * @property {string} extension
 * @property {string=} mime
 * @property {number=} sizeBytes
 * @property {string=} hostname
 * @property {string=} resolution
 * @property {DetectionSource} source
 * @property {string[]} detectionMethods
 * @property {boolean} isProtected
 * @property {string=} unsupportedReason
 * @property {Object[]=} variants HLS variants.
 * @property {Object[]=} representations DASH representations.
 * @property {string} detectedAt ISO timestamp.
 *
 * @typedef {Object} DownloadTask
 * @property {string} id
 * @property {string} mediaId
 * @property {number} tabId
 * @property {MediaItem} media
 * @property {string} filename
 * @property {number} attempts
 * @property {number} maxRetries
 * @property {string} status
 * @property {string=} strategy
 * @property {Object=} lastError
 *
 * @typedef {Object} StructuredError
 * @property {string} category
 * @property {string} code
 * @property {string} message
 * @property {boolean=} retryable
 * @property {string=} strategy
 */
export const TYPES_MODULE_LOADED = true;
