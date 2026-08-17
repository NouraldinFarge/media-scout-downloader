import { DEFAULT_ENABLED_FILE_TYPES, MEDIA_EXTENSION_MAP, MEDIA_GROUPS } from './media-type-registry.js';

export const MESSAGE_TYPES = Object.freeze({
  GET_ACTIVE_TAB_STATE: 'GET_ACTIVE_TAB_STATE',
  ACTIVE_TAB_STATE: 'ACTIVE_TAB_STATE',
  SCAN_PAGE_MEDIA: 'SCAN_PAGE_MEDIA',
  DOM_MEDIA_FOUND: 'DOM_MEDIA_FOUND',
  START_DOWNLOAD: 'START_DOWNLOAD',
  RETRY_DOWNLOAD: 'RETRY_DOWNLOAD',
  CANCEL_DOWNLOAD: 'CANCEL_DOWNLOAD',
  CANCEL_HLS_TASK: 'CANCEL_HLS_TASK',
  QUEUE_UPDATED: 'QUEUE_UPDATED',
  DOWNLOAD_PROGRESS: 'DOWNLOAD_PROGRESS',
  SETTINGS_GET: 'SETTINGS_GET',
  SETTINGS_SAVE: 'SETTINGS_SAVE',
  CLEAR_DETECTED_CACHE: 'CLEAR_DETECTED_CACHE',
  CLEAR_QUEUE_HISTORY: 'CLEAR_QUEUE_HISTORY',
  CLEAR_SETTLED_QUEUE: 'CLEAR_SETTLED_QUEUE',
  PAUSE_QUEUE: 'PAUSE_QUEUE',
  RESUME_QUEUE: 'RESUME_QUEUE',
  RESET_DIAGNOSTICS: 'RESET_DIAGNOSTICS',
  REQUEST_SITE_ACCESS: 'REQUEST_SITE_ACCESS',
  REQUEST_ALL_SITE_ACCESS: 'REQUEST_ALL_SITE_ACCESS',
  REVOKE_ALL_SITE_ACCESS: 'REVOKE_ALL_SITE_ACCESS',
  RUN_SELF_TESTS: 'RUN_SELF_TESTS',
  BLOB_DOWNLOAD_REQUEST: 'BLOB_DOWNLOAD_REQUEST',
  HLS_MERGE_DOWNLOAD_REQUEST: 'HLS_MERGE_DOWNLOAD_REQUEST',
  SCAN_PAGE_MEDIA_DETAILED: 'SCAN_PAGE_MEDIA_DETAILED',
  GENERATE_REPORT: 'GENERATE_REPORT',
  CONVERT_M3U8_TO_MP4: 'CONVERT_M3U8_TO_MP4',
  HARD_RESCAN_ACTIVE_TAB: 'HARD_RESCAN_ACTIVE_TAB',
  RELOAD_EXTENSION_AND_REFRESH_PAGE: 'RELOAD_EXTENSION_AND_REFRESH_PAGE',
  DISCOVER_EPISODE_BATCH: 'DISCOVER_EPISODE_BATCH',
  START_EPISODE_BATCH_DOWNLOADS: 'START_EPISODE_BATCH_DOWNLOADS'
});

export const MEDIA_TYPES = Object.freeze({
  VIDEO: MEDIA_GROUPS.VIDEO,
  AUDIO: MEDIA_GROUPS.AUDIO,
  HLS: MEDIA_GROUPS.HLS,
  DASH: MEDIA_GROUPS.DASH,
  STREAM: MEDIA_GROUPS.STREAM,
  SEGMENT: MEDIA_GROUPS.SEGMENT,
  SUBTITLE: MEDIA_GROUPS.SUBTITLE,
  IMAGE: MEDIA_GROUPS.IMAGE,
  PLAYLIST: MEDIA_GROUPS.PLAYLIST,
  METADATA: MEDIA_GROUPS.METADATA,
  UNKNOWN: MEDIA_GROUPS.UNKNOWN
});

export const MEDIA_EXTENSIONS = Object.freeze(MEDIA_EXTENSION_MAP);

export const DOWNLOAD_STATUSES = Object.freeze({
  DETECTED: 'detected',
  QUEUED: 'queued',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CONVERTING: 'converting',
  FAILED: 'failed',
  RETRIED: 'retried',
  CANCELED: 'canceled',
  VERIFY_UNCERTAIN: 'verify-uncertain',
  UNSUPPORTED: 'unsupported',
  ENCRYPTED: 'encrypted'
});

export const SOURCES = Object.freeze({
  NETWORK: 'network',
  DOM_VIDEO: 'dom-video',
  DOM_AUDIO: 'dom-audio',
  DOM_SOURCE: 'dom-source',
  HEADER: 'response-header',
  HLS_VARIANT: 'hls-variant',
  DASH_REPRESENTATION: 'dash-representation',
  BLOB: 'blob',
  PERFORMANCE: 'performance-resource',
  MANUAL: 'manual-url'
});

export const STRATEGY_NAMES = Object.freeze({
  DIRECT_FILE: 'direct-file',
  HTML_MEDIA_SOURCE: 'html-media-source',
  BLOB_PAGE_DOWNLOAD: 'blob-page-download',
  HLS_SEGMENT_MERGE: 'hls-segment-merge',
  HLS_PLAYLIST: 'hls-playlist',
  HLS_EXTERNAL_HELPER: 'hls-external-helper',
  DASH_MANIFEST: 'dash-manifest'
});

export const ERROR_CATEGORIES = Object.freeze({
  NETWORK: 'network',
  ENCRYPTED: 'encrypted',
  DRM: 'drm',
  ACCESS_CONTROL: 'access-control',
  PERMISSION: 'permission',
  PAYWALL: 'paywall',
  AUTHENTICATION: 'authentication',
  CORS: 'cors',
  SIGNED_OR_EXPIRING_URL: 'signed-or-expiring-url',
  UNSUPPORTED: 'unsupported',
  VALIDATION: 'validation',
  USER_CANCELED: 'user-canceled',
  UNKNOWN: 'unknown'
});

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'mediaScout.settings',
  DIAGNOSTICS: 'mediaScout.diagnostics',
  QUEUE_SUMMARY: 'mediaScout.queueSummary',
  QUEUE_HISTORY: 'mediaScout.queueHistory'
});

export const DUPLICATE_BEHAVIORS = Object.freeze({
  AUTO_NUMBER: 'auto-number',
  ASK: 'ask',
  OVERWRITE: 'overwrite'
});

export const HLS_OUTPUT_METHODS = Object.freeze({
  SMART_MP4: 'smart-mp4',
  MP4_REMUX: 'mp4-remux',
  TIMESTAMP_FIXED_TS: 'timestamp-fixed-ts',
  TS_CONCAT: 'ts-concat',
  PLAYLIST_ONLY: 'playlist-only',
  FMP4_ASSEMBLY: 'fmp4-assembly',
  SEPARATE_AUDIO_MERGE: 'separate-audio-merge',
  VISIBLE_RECORDING: 'visible-recording',
  EXTERNAL_HELPER: 'external-helper'
});

export const IMPLEMENTED_HLS_OUTPUT_METHODS = Object.freeze([
  HLS_OUTPUT_METHODS.SMART_MP4,
  HLS_OUTPUT_METHODS.MP4_REMUX,
  HLS_OUTPUT_METHODS.TIMESTAMP_FIXED_TS,
  HLS_OUTPUT_METHODS.TS_CONCAT,
  HLS_OUTPUT_METHODS.PLAYLIST_ONLY,
  HLS_OUTPUT_METHODS.EXTERNAL_HELPER
]);

export const HLS_WORK_MODES = Object.freeze({
  GENTLE: 'gentle',
  BALANCED: 'balanced',
  FAST: 'fast'
});

export const HLS_VARIANT_PREFERENCES = Object.freeze({
  HIGHEST: 'highest',
  LOWEST: 'lowest'
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabledFileTypes: Object.freeze(DEFAULT_ENABLED_FILE_TYPES),
  maxParallelDownloads: 3,
  segmentParallelism: 4,
  segmentRetryLimit: 2,
  hlsOutputMethod: HLS_OUTPUT_METHODS.SMART_MP4,
  hlsWorkMode: HLS_WORK_MODES.BALANCED,
  hlsVariantPreference: HLS_VARIANT_PREFERENCES.HIGHEST,
  showManualM3u8Converter: false,
  includeSensitiveUrlsInReports: false,
  queueHistoryRetentionDays: 7,
  episodeBatchScanParallelism: 2,
  confirmLargeEpisodeBatchThreshold: 8,
  filenameTemplate: '{tabTitle}{indexSuffix}.{extension}',
  duplicateBehavior: DUPLICATE_BEHAVIORS.AUTO_NUMBER,
  notifications: true,
  debugLogs: false,
  preferredSubfolder: 'Media Scout Downloader'
});

export const RETRY_BLOCKED_CATEGORIES = Object.freeze([
  ERROR_CATEGORIES.ENCRYPTED,
  ERROR_CATEGORIES.DRM,
  ERROR_CATEGORIES.ACCESS_CONTROL,
  ERROR_CATEGORIES.PERMISSION,
  ERROR_CATEGORIES.PAYWALL,
  ERROR_CATEGORIES.AUTHENTICATION,
  ERROR_CATEGORIES.CORS,
  ERROR_CATEGORIES.SIGNED_OR_EXPIRING_URL,
  ERROR_CATEGORIES.UNSUPPORTED,
  ERROR_CATEGORIES.VALIDATION,
  ERROR_CATEGORIES.USER_CANCELED
]);

export const PROTECTED_QUERY_HINTS = Object.freeze([
  'signature', 'sig', 'policy', 'expires', 'expiry', 'exp', 'token', 'auth',
  'authorization', 'x-amz-signature', 'x-amz-credential', 'x-amz-expires',
  'x-goog-signature', 'x-goog-credential', 'x-goog-expires', 'key-pair-id'
]);

export const MAX_FILENAME_LENGTH = 180;
export const MAX_PARALLEL_MIN = 1;
export const MAX_PARALLEL_MAX = 6;
export const SEGMENT_PARALLELISM_MIN = 1;
export const SEGMENT_PARALLELISM_MAX = 16;
export const SEGMENT_RETRY_LIMIT_MIN = 0;
export const SEGMENT_RETRY_LIMIT_MAX = 4;
