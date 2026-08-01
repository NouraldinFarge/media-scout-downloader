import { DOWNLOAD_STATUSES, MEDIA_TYPES } from '../shared/constants.js';
import { makeMediaId, nowISO } from '../shared/utils.js';
import { buildDownloadAllowSummary } from '../shared/download-allow-list.js';

export class TabMediaStore {
  constructor() {
    this.tabs = new Map();
  }

  setTabInfo(tab) {
    if (!Number.isInteger(tab?.id)) return;
    const state = this._getTabState(tab.id);
    state.tab = {
      id: tab.id,
      title: tab.title || 'Untitled tab',
      url: tab.url || ''
    };
    this.tabs.set(tab.id, state);
  }

  addMedia(tabId, item) {
    if (!Number.isInteger(tabId) || !item?.normalizedUrl) return null;
    const state = this._getTabState(tabId);
    const id = item.id || makeMediaId(tabId, item.normalizedUrl, item.mediaType);
    const existing = state.items.get(id);
    const merged = {
      ...(existing || {}),
      ...item,
      id,
      tabId,
      status: item.status || (item.isProtected ? DOWNLOAD_STATUSES.UNSUPPORTED : (existing?.status || DOWNLOAD_STATUSES.DETECTED)),
      detectionMethods: Array.from(new Set([...(existing?.detectionMethods || []), ...(item.detectionMethods || [])])),
      detectedAt: existing?.detectedAt || item.detectedAt || nowISO(),
      updatedAt: nowISO()
    };
    if (existing?.variants || item.variants) merged.variants = item.variants || existing.variants;
    if (existing?.representations || item.representations) merged.representations = item.representations || existing.representations;
    applyDownloadAllowSummary(merged);
    state.items.set(id, merged);
    this.tabs.set(tabId, state);
    this.updateBadge(tabId).catch(() => undefined);
    return merged;
  }

  addMany(tabId, items = []) {
    const added = [];
    for (const item of items) {
      const result = this.addMedia(tabId, item);
      if (result) added.push(result);
    }
    return added;
  }

  getMedia(tabId, mediaId) {
    return this.tabs.get(tabId)?.items.get(mediaId) || null;
  }

  applyPlaylistProbeFindings(tabId, probes = []) {
    const state = this.tabs.get(tabId);
    if (!state || !Array.isArray(probes) || !probes.length) return { updated: 0 };

    const findings = buildPlaylistProbeFindings(probes);
    if (!findings.playlistUrls.size && !findings.segmentHosts.size) return { updated: 0 };

    let updated = 0;
    for (const [id, item] of state.items.entries()) {
      const itemUrl = normalizeProbeUrl(item.normalizedUrl || item.url || '');
      const itemHost = item.hostname || hostnameFor(itemUrl);
      const exactFinding = itemUrl ? findings.byUrl.get(itemUrl) : null;
      const hostFinding = item.mediaType === MEDIA_TYPES.SEGMENT && itemHost ? findings.bySegmentHost.get(itemHost) : null;
      const finding = exactFinding || hostFinding;
      if (!finding || !isStrongerPlaylistFinding(item, finding)) continue;

      const patched = {
        ...item,
        isProtected: true,
        status: finding.status,
        unsupportedReason: finding.reason,
        safetyWarning: '',
        playlistProbe: {
          source: 'detailed-page-scan',
          reasonCode: finding.reasonCode,
          playlistKind: finding.playlistKind,
          playlistHost: finding.playlistHost,
          segmentCount: finding.segmentCount || null,
          estimatedDurationSeconds: finding.estimatedDurationSeconds || null,
          matchedBy: exactFinding ? 'url' : 'segment-host'
        },
        updatedAt: nowISO()
      };
      applyDownloadAllowSummary(patched);
      state.items.set(id, patched);
      updated += 1;
    }
    if (updated) {
      this.tabs.set(tabId, state);
      this.updateBadge(tabId).catch(() => undefined);
    }
    return { updated };
  }

  getTabState(tabId) {
    const state = this._getTabState(tabId);
    return {
      tab: state.tab,
      mediaItems: Array.from(state.items.values()).sort((a, b) => String(a.mediaType || '').localeCompare(String(b.mediaType || '')) || String(a.hostname || '').localeCompare(String(b.hostname || '')))
    };
  }

  clearTab(tabId) {
    this.tabs.delete(tabId);
    this.updateBadge(tabId).catch(() => undefined);
  }

  clearAll() {
    const tabIds = Array.from(this.tabs.keys());
    this.tabs.clear();
    for (const tabId of tabIds) this.updateBadge(tabId).catch(() => undefined);
  }

  async updateBadge(tabId) {
    if (!chrome.action || tabId == null) return;
    const count = this.tabs.get(tabId)?.items.size || 0;
    await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#22c55e' });
  }

  _getTabState(tabId) {
    return this.tabs.get(tabId) || { tab: { id: tabId, title: 'Untitled tab', url: '' }, items: new Map() };
  }
}


function buildPlaylistProbeFindings(probes = []) {
  const byUrl = new Map();
  const bySegmentHost = new Map();
  const playlistUrls = new Set();
  const segmentHosts = new Set();
  const encryptedPlaylistUrls = new Set(probes
    .filter((probe) => probe?.ok && probe.encrypted)
    .map((probe) => normalizeProbeUrl(probe.url))
    .filter(Boolean));

  for (const probe of probes) {
    if (!probe?.ok) continue;
    const playlistUrl = normalizeProbeUrl(probe.url);
    const linkedEncryptedVariant = (probe.variantUrls || []).some((url) => encryptedPlaylistUrls.has(normalizeProbeUrl(url)));
    const finding = classifyPlaylistProbe(probe, linkedEncryptedVariant);
    if (!finding) continue;

    const urls = new Set([
      playlistUrl,
      ...(probe.variantUrls || []).map(normalizeProbeUrl),
      ...(probe.segmentUrls || []).map(normalizeProbeUrl),
      ...(probe.audioRenditionUrls || []).map(normalizeProbeUrl)
    ].filter(Boolean));
    for (const url of urls) {
      byUrl.set(url, chooseStrongerFinding(byUrl.get(url), finding));
      playlistUrls.add(url);
    }

    if (finding.reasonCode === 'encrypted-hls') {
      for (const entry of probe.topSegmentHosts || []) {
        const host = String(entry?.hostname || '').trim();
        if (!host || host === 'unknown') continue;
        bySegmentHost.set(host, chooseStrongerFinding(bySegmentHost.get(host), finding));
        segmentHosts.add(host);
      }
    }
  }

  return { byUrl, bySegmentHost, playlistUrls, segmentHosts };
}

function classifyPlaylistProbe(probe = {}, linkedEncryptedVariant = false) {
  const base = {
    playlistKind: probe.playlistKind || probe.extension || 'playlist',
    playlistHost: probe.hostname || hostnameFor(probe.url || ''),
    segmentCount: probe.segmentCount || null,
    estimatedDurationSeconds: probe.estimatedDurationSeconds || null,
    playlistType: probe.playlistType || ''
  };
  if (probe.encrypted || linkedEncryptedVariant) {
    return {
      ...base,
      priority: 100,
      status: DOWNLOAD_STATUSES.ENCRYPTED,
      reasonCode: 'encrypted-hls',
      reason: linkedEncryptedVariant
        ? 'The selected HLS variant playlist contains encryption markers. Decryption and merging are not supported.'
        : 'Encrypted HLS playlist detected (#EXT-X-KEY). Decryption and merging are not supported.'
    };
  }
  if (probe.hasMap || probe.hasFmp4Segments) {
    return {
      ...base,
      priority: 70,
      status: DOWNLOAD_STATUSES.UNSUPPORTED,
      reasonCode: 'hls-fmp4-map',
      reason: 'HLS fMP4/CMAF markers were detected (#EXT-X-MAP or fMP4-like segments). The built-in merger currently supports MPEG-TS segments only.'
    };
  }
  if (probe.hasByteRange) {
    return {
      ...base,
      priority: 60,
      status: DOWNLOAD_STATUSES.UNSUPPORTED,
      reasonCode: 'hls-byte-range',
      reason: 'HLS byte-range segments were detected (#EXT-X-BYTERANGE). This segment layout is not supported by the current merger.'
    };
  }
  if (probe.hasPartialSegments || probe.hasPreloadHint) {
    return {
      ...base,
      priority: 55,
      status: DOWNLOAD_STATUSES.UNSUPPORTED,
      reasonCode: 'low-latency-hls',
      reason: 'Low-latency HLS partial/preload markers were detected. The built-in merger currently supports finite MPEG-TS media playlists only.'
    };
  }
  if (probe.iframeOnly) {
    return {
      ...base,
      priority: 54,
      status: DOWNLOAD_STATUSES.UNSUPPORTED,
      reasonCode: 'hls-iframe-only',
      reason: 'I-frame-only HLS was detected. This is a trick-play index, not a complete media playlist.'
    };
  }
  if ((probe.hasSeparateAudio || Number(probe.audioRenditionCount || 0) > 0) && !probeHasSelfContainedVariant(probe)) {
    return {
      ...base,
      priority: 53,
      status: DOWNLOAD_STATUSES.UNSUPPORTED,
      reasonCode: 'hls-separate-audio',
      reason: 'Separate HLS audio renditions were detected and no self-contained variant was visible. The built-in merger does not align separate audio/video yet, so complete MP4/TS output is disabled.'
    };
  }
  if (probe.playlistKind === 'hls-media' && probe.hasEndList === false && String(probe.playlistType || '').toLowerCase() !== 'vod') {
    return {
      ...base,
      priority: 52,
      status: DOWNLOAD_STATUSES.UNSUPPORTED,
      reasonCode: 'live-hls',
      reason: 'No EXT-X-ENDLIST marker was visible and the playlist is not marked VOD. This appears to be a live/event HLS playlist rather than a finite file.'
    };
  }
  return null;
}

export function probeHasSelfContainedVariant(probe = {}) {
  const variants = Array.isArray(probe.variants) ? probe.variants : [];
  return variants.some((variant) => {
    if (!variant?.url) return false;
    if (variant.audioGroupId) return false;
    const codecs = String(variant.codecs || '').toLowerCase();
    if (!codecs) return true;
    const hasVideoCodec = /avc|hvc|hev|vp0?9|av01|theora|dvhe|dvh1|mp4v/.test(codecs);
    const hasAudioCodec = /mp4a|aac|ac-3|ec-3|opus|vorbis|flac|mp3/.test(codecs);
    return hasVideoCodec && hasAudioCodec;
  });
}

function chooseStrongerFinding(existing, candidate) {
  if (!existing) return candidate;
  return (candidate.priority || 0) > (existing.priority || 0) ? candidate : existing;
}

function isStrongerPlaylistFinding(item = {}, finding = {}) {
  if (!finding) return false;
  if (!item.isProtected) return true;
  if (item.status === DOWNLOAD_STATUSES.ENCRYPTED) return false;
  return finding.status === DOWNLOAD_STATUSES.ENCRYPTED;
}

function normalizeProbeUrl(raw = '') {
  try {
    const url = new URL(String(raw || ''));
    url.hash = '';
    return url.toString();
  } catch (_error) {
    return '';
  }
}

function hostnameFor(raw = '') {
  try {
    return new URL(String(raw || '')).hostname;
  } catch (_error) {
    return '';
  }
}

function applyDownloadAllowSummary(item) {
  const policy = item.downloadPolicy?.methods ? item.downloadPolicy : buildDownloadAllowSummary(item);
  item.downloadPolicy = policy;
  item.downloadAllowed = Boolean(policy.allowed);
  item.downloadPrimaryAllowed = Boolean(policy.primaryAllowed);
  item.downloadAllowReason = policy.reason || '';
}
