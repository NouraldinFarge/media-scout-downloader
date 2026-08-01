(() => {
  if (globalThis.MediaScoutPageScanner) return;

  const MEDIA_EXTENSIONS = new Set(['mp4','m4v','mp4v','mov','qt','webm','ogv','ogx','mpeg','mpg','mpe','m1v','m2v','ts','m2ts','mts','mkv','avi','3gp','3g2','flv','f4v','wmv','asf','mxf','mp3','m4a','mp4a','m4b','aac','adts','wav','wave','ogg','oga','opus','weba','flac','aiff','aif','aifc','amr','awb','mid','midi','m3u8','m3u','mpd','ism','isml','f4m','m4s','cmfv','cmfa','part','vtt','srt','ttml','dfxp','smi','sami','ass','ssa','lrc','sbv','jpg','jpeg','jfif','pjpeg','pjp','png','webp','avif','gif','apng','svg','bmp','ico','cur','tif','tiff','json','xml']);
  const MEDIA_MIME_PARTS = ['video/', 'audio/', 'image/', 'mpegurl', 'dash+xml', 'application/ogg', 'application/mxf', 'application/vnd.ms-sstr+xml', 'application/f4m+xml', 'text/vtt', 'application/x-subrip', 'application/ttml+xml'];
  const PROTECTED_QUERY_HINTS = [
    'signature', 'sig', 'policy', 'expires', 'expiry', 'exp', 'token', 'auth',
    'authorization', 'x-amz-signature', 'x-amz-credential', 'x-amz-expires',
    'x-goog-signature', 'x-goog-credential', 'x-goog-expires', 'key-pair-id'
  ];
  const GENERIC_MEDIA_HINTS = ['m3u8', 'mpd', 'mp4', 'webm', 'mov', 'm4s', 'ts', 'video', 'audio', 'media', 'stream', 'playlist', 'manifest', 'caption', 'subtitle', 'thumbnail', 'poster', 'sprite', 'playurl', 'player', 'source'];
  const MEDIA_LITERAL_REGEX = /(?:(?:https?:)?\/\/|\.{0,2}\/|[A-Za-z0-9_%.-]+\/)[^\s"'<>`]+?\.(?:pjpeg|mp4v|webm|mpeg|m2ts|mp4a|adts|wave|opus|weba|flac|aiff|aifc|midi|m3u8|isml|cmfv|cmfa|part|ttml|dfxp|sami|jpeg|jfif|webp|avif|apng|tiff|json|mp4|m4v|mov|ogv|ogx|mpg|mpe|m1v|m2v|mts|mkv|avi|3gp|3g2|flv|f4v|wmv|asf|mxf|mp3|m4a|m4b|aac|wav|ogg|oga|aif|amr|awb|mid|m3u|mpd|ism|f4m|m4s|vtt|srt|smi|ass|ssa|lrc|sbv|jpg|pjp|png|gif|svg|bmp|ico|cur|tif|xml|qt|ts)(?:\?[^\s"'<>`]*)?/gi;
  const MAX_PLAYLIST_PROBES = 6;
  const PLAYLIST_PROBE_TIMEOUT_MS = 4000;

  function normalizeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const url = new URL(cleanCandidateUrl(rawUrl), document.baseURI);
      url.hash = '';
      return url.toString();
    } catch (_error) {
      return '';
    }
  }

  function cleanCandidateUrl(rawUrl) {
    return String(rawUrl || '')
      .trim()
      .replace(/&amp;/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/\\u002f/gi, '/')
      .replace(/\\x2f/gi, '/')
      .replace(/^["'({\[]+|["'),;\]}]+$/g, '');
  }

  function extensionFromUrl(rawUrl) {
    try {
      const match = new URL(rawUrl).pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/i);
      return match ? match[1] : '';
    } catch (_error) {
      return '';
    }
  }

  function typeLooksMedia(type = '') {
    const normalized = String(type).toLowerCase();
    return MEDIA_MIME_PARTS.some((part) => normalized.includes(part));
  }

  function urlLooksMedia(url = '') {
    const extension = extensionFromUrl(url);
    return MEDIA_EXTENSIONS.has(extension) || url.startsWith('blob:');
  }

  function resolutionFor(element) {
    if (!element) return '';
    const width = element.videoWidth || element.getAttribute?.('width') || '';
    const height = element.videoHeight || element.getAttribute?.('height') || '';
    return width && height ? `${width}x${height}` : '';
  }

  function makeItem(url, element, source, type = '', extra = {}) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    if (!urlLooksMedia(normalized) && !typeLooksMedia(type)) return null;
    return {
      url: normalized,
      source,
      type,
      resolution: resolutionFor(element),
      ...extra
    };
  }

  function scan() {
    const items = [];
    collectDomMediaItems(items);
    collectCompanionMediaItems(items);
    collectLiteralMediaItems(items);
    collectPerformanceMediaItems(items);
    return dedupeItems(items);
  }

  function collectDomMediaItems(items) {
    for (const element of document.querySelectorAll('video, audio')) {
      const source = element.tagName.toLowerCase() === 'video' ? 'dom-video' : 'dom-audio';
      const mediaInfo = compactMediaInfo(element);
      for (const value of [element.currentSrc, element.src, element.getAttribute('src')]) {
        const item = makeItem(value, element, source, element.getAttribute('type') || '', {
          probableMseBlob: String(value || '').startsWith('blob:') && element.readyState >= HTMLMediaElement.HAVE_METADATA,
          mediaDuration: Number.isFinite(element.duration) ? element.duration : null,
          mediaInfo
        });
        if (item) items.push(item);
      }
      for (const sourceElement of element.querySelectorAll('source')) {
        const item = makeItem(sourceElement.src || sourceElement.getAttribute('src'), element, 'dom-source', sourceElement.type || sourceElement.getAttribute('type') || '', { mediaInfo });
        if (item) items.push(item);
      }
    }
    for (const sourceElement of document.querySelectorAll('source')) {
      const parent = sourceElement.closest('video, audio');
      const item = makeItem(sourceElement.src || sourceElement.getAttribute('src'), parent, 'dom-source', sourceElement.type || sourceElement.getAttribute('type') || '', { mediaInfo: parent ? compactMediaInfo(parent) : null });
      if (item) items.push(item);
    }
  }


  function collectCompanionMediaItems(items) {
    for (const track of document.querySelectorAll('track[src]')) {
      const item = makeItem(track.src || track.getAttribute('src'), null, 'dom-track', track.getAttribute('type') || 'text/vtt', {
        frameUrl: location.href,
        companionKind: track.kind || '',
        language: track.srclang || '',
        label: track.label || ''
      });
      if (item) items.push(item);
    }
    for (const video of document.querySelectorAll('video[poster]')) {
      const item = makeItem(video.poster || video.getAttribute('poster'), video, 'dom-video-poster', 'image/*', {
        frameUrl: location.href,
        mediaInfo: compactMediaInfo(video),
        companionKind: 'poster'
      });
      if (item) items.push(item);
    }
    for (const link of document.querySelectorAll('link[href][rel~="preload"], link[href][rel~="prefetch"]')) {
      const asType = link.getAttribute('as') || '';
      if (!/^(video|audio|image|track|fetch)$/i.test(asType)) continue;
      const item = makeItem(link.href || link.getAttribute('href'), null, `link-${asType || 'resource'}`, link.getAttribute('type') || '', { frameUrl: location.href });
      if (item) items.push(item);
    }
    for (const meta of document.querySelectorAll('meta[property], meta[name]')) {
      const key = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
      if (!/(og:video|og:audio|og:image|twitter:player|twitter:image|video|audio|image|thumbnail|poster)/.test(key)) continue;
      const content = meta.getAttribute('content') || '';
      const item = makeItem(content, null, `meta-${key}`, key.includes('image') ? 'image/*' : '', { frameUrl: location.href, literalContext: key });
      if (item) items.push(item);
    }
    for (const img of document.querySelectorAll('img[src], source[srcset], img[srcset]')) {
      const values = srcsetUrls(img.getAttribute('srcset') || '');
      if (img.src || img.getAttribute('src')) values.unshift(img.src || img.getAttribute('src'));
      for (const value of values.slice(0, 4)) {
        const item = makeItem(value, null, 'dom-image-companion', img.getAttribute('type') || 'image/*', {
          frameUrl: location.href,
          alt: img.getAttribute?.('alt') || '',
          companionKind: 'image-or-thumbnail'
        });
        if (item) items.push(item);
      }
    }
  }

  function collectDetailedCompanionDecisions(decisions) {
    for (const track of document.querySelectorAll('track[src]')) {
      addDecision(decisions, track.src || track.getAttribute('src'), {
        source: 'dom-track', attribute: 'track-src', tagName: 'track', elementIndex: -1,
        mime: track.getAttribute('type') || 'text/vtt', element: null
      });
    }
    for (const video of document.querySelectorAll('video[poster]')) {
      addDecision(decisions, video.poster || video.getAttribute('poster'), {
        source: 'dom-video-poster', attribute: 'poster', tagName: 'video', elementIndex: -1,
        mime: 'image/*', element: video
      });
    }
    for (const meta of document.querySelectorAll('meta[property], meta[name]')) {
      const key = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
      if (!/(og:video|og:audio|og:image|twitter:player|twitter:image|video|audio|image|thumbnail|poster)/.test(key)) continue;
      addDecision(decisions, meta.getAttribute('content') || '', {
        source: `meta-${key}`, attribute: 'content', tagName: 'meta', elementIndex: -1,
        mime: key.includes('image') ? 'image/*' : '', element: null
      });
    }
  }

  function srcsetUrls(srcset = '') {
    return String(srcset || '').split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
  }

  function collectLiteralMediaItems(items) {
    for (const hint of findLiteralMediaHints()) {
      const item = makeItem(hint.url, null, hint.source, '', { literalContext: hint.context, frameUrl: location.href });
      if (item) items.push(item);
    }
  }

  function collectPerformanceMediaItems(items) {
    const entries = typeof performance?.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
    const seen = new Set();
    for (const entry of entries) {
      const normalized = normalizeUrl(entry.name);
      if (!normalized || seen.has(normalized) || !urlLooksMedia(normalized)) continue;
      seen.add(normalized);
      const item = makeItem(normalized, null, 'performance-resource', '', {
        frameUrl: location.href,
        initiatorType: entry.initiatorType || '',
        transferSize: entry.transferSize || 0,
        encodedBodySize: entry.encodedBodySize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
        performanceStartTime: Math.round(entry.startTime || 0),
        resourceInfo: compactResourceInfo(entry)
      });
      if (item) items.push(item);
    }
  }

  async function scanDetailed() {
    const decisions = [];
    const mediaElements = [];
    const anchors = [];
    const literalMediaHints = [];

    for (const element of document.querySelectorAll('video, audio')) {
      const tagName = element.tagName.toLowerCase();
      const elementIndex = mediaElements.length;
      const elementInfo = describeMediaElement(element, elementIndex);
      mediaElements.push(elementInfo);
      const source = tagName === 'video' ? 'dom-video' : 'dom-audio';

      addDecision(decisions, element.currentSrc, { source, attribute: 'currentSrc', tagName, elementIndex, mime: element.getAttribute('type') || '', element });
      addDecision(decisions, element.src, { source, attribute: 'src-property', tagName, elementIndex, mime: element.getAttribute('type') || '', element });
      addDecision(decisions, element.getAttribute('src'), { source, attribute: 'src-attribute', tagName, elementIndex, mime: element.getAttribute('type') || '', element });
      if (tagName === 'video') {
        addDecision(decisions, element.getAttribute('poster'), { source: 'dom-video-poster', attribute: 'poster', tagName, elementIndex, mime: '', element, expectedMedia: false, nonCandidateReason: 'poster-or-artwork' });
      }

      for (const sourceElement of element.querySelectorAll('source')) {
        addDecision(decisions, sourceElement.src || sourceElement.getAttribute('src'), {
          source: 'dom-source',
          attribute: 'source-src',
          tagName: 'source',
          parentTagName: tagName,
          elementIndex,
          mime: sourceElement.type || sourceElement.getAttribute('type') || '',
          element
        });
      }
    }

    for (const sourceElement of document.querySelectorAll('source')) {
      const parent = sourceElement.closest('video, audio');
      addDecision(decisions, sourceElement.src || sourceElement.getAttribute('src'), {
        source: 'document-source',
        attribute: 'source-src',
        tagName: 'source',
        parentTagName: parent?.tagName?.toLowerCase?.() || '',
        elementIndex: -1,
        mime: sourceElement.type || sourceElement.getAttribute('type') || '',
        element: parent
      });
    }

    collectDetailedCompanionDecisions(decisions);

    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.href || anchor.getAttribute('href');
      if (!href || (!urlLooksMedia(normalizeUrl(href)) && !typeLooksMedia(anchor.type || ''))) continue;
      anchors.push({
        href: normalizeUrl(href),
        text: String(anchor.textContent || '').trim().slice(0, 120),
        downloadAttribute: anchor.getAttribute('download') || '',
        type: anchor.type || '',
        note: 'Media-looking page link. Main detection focuses on loaded media resources, not every page link.'
      });
    }

    for (const hint of findLiteralMediaHints()) {
      literalMediaHints.push(hint);
      addDecision(decisions, hint.url, {
        source: hint.source,
        attribute: hint.context,
        tagName: hint.tagName || '',
        elementIndex: -1,
        mime: '',
        element: null
      });
    }

    const performance = scanPerformanceEntries(decisions);
    const playlistProbes = await probePlaylistMetadata(literalMediaHints, performance.mediaLikeEntries);

    return {
      generatedAt: new Date().toISOString(),
      frame: describeFrame(),
      document: {
        title: document.title,
        url: location.href,
        baseURI: document.baseURI,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        mediaElementCount: mediaElements.length,
        iframeCount: document.querySelectorAll('iframe').length
      },
      environment: {
        hasMediaSourceApi: typeof MediaSource !== 'undefined',
        hasEncryptedMediaApi: typeof navigator.requestMediaKeySystemAccess === 'function',
        note: 'API availability does not prove the page uses MSE/EME; it helps explain possible player behavior.'
      },
      iframes: describeIframes(),
      mediaElements,
      anchors: limitList(anchors, 80),
      literalMediaHints: limitList(literalMediaHints, 120),
      performance,
      playlistProbes,
      decisions: dedupeDecisions(decisions)
    };
  }

  async function probePlaylistMetadata(literalMediaHints, mediaLikeEntries) {
    const urls = [];
    for (const item of [...(literalMediaHints || []), ...(mediaLikeEntries || [])]) {
      const url = normalizeUrl(item.url || item.name || '');
      if (!url || !/\.(m3u8|mpd)(?:[?#]|$)/i.test(url)) continue;
      if (!urls.includes(url)) urls.push(url);
      if (urls.length >= MAX_PLAYLIST_PROBES) break;
    }
    const probes = [];
    for (const url of urls) probes.push(await probeOnePlaylist(url));
    return probes;
  }

  async function probeOnePlaylist(url) {
    const startedAt = performance?.now?.() || Date.now();
    try {
      const text = await fetchTextWithTimeout(url, PLAYLIST_PROBE_TIMEOUT_MS);
      const extension = extensionFromUrl(url);
      const metadata = extension === 'mpd' ? summarizeDashManifest(text) : summarizeHlsPlaylist(text, url);
      return {
        ok: true,
        url,
        hostname: hostnameFor(url),
        extension,
        elapsedMs: Math.round((performance?.now?.() || Date.now()) - startedAt),
        ...metadata
      };
    } catch (error) {
      return {
        ok: false,
        url,
        hostname: hostnameFor(url),
        extension: extensionFromUrl(url),
        errorCategory: /abort|timeout/i.test(error?.message || '') ? 'network-timeout' : 'normal-fetch-blocked',
        error: error?.message || String(error),
        note: 'The report probe uses normal page fetch rules only. Failure can mean CORS, access control, network blocking, or an expired playlist URL.'
      };
    }
  }

  async function fetchTextWithTimeout(url, timeoutMs) {
    if (typeof AbortController === 'undefined') {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'follow', referrerPolicy: 'strict-origin-when-cross-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('playlist-probe-timeout'), timeoutMs);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'follow', referrerPolicy: 'strict-origin-when-cross-origin', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  function summarizeHlsPlaylist(text, baseUrl) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variants = [];
    const segments = [];
    let targetDuration = null;
    let totalInfDuration = 0;
    let encrypted = false;
    let hasMap = false;
    let hasByteRange = false;
    let hasPartialSegments = false;
    let hasPreloadHint = false;
    let iframeOnly = false;
    let hasEndList = false;
    let playlistType = '';
    let mediaSequence = null;
    let pendingInf = null;
    let pendingStream = null;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) encrypted = true;
      if (line.startsWith('#EXT-X-MAP')) hasMap = true;
      if (line.startsWith('#EXT-X-BYTERANGE')) hasByteRange = true;
      if (line.startsWith('#EXT-X-PART')) hasPartialSegments = true;
      if (line.startsWith('#EXT-X-PRELOAD-HINT')) hasPreloadHint = true;
      if (line.startsWith('#EXT-X-I-FRAMES-ONLY')) iframeOnly = true;
      if (line.startsWith('#EXT-X-ENDLIST')) hasEndList = true;
      if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) playlistType = String(line.split(':')[1] || '').trim().toLowerCase();
      if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.split(':')[1]) || null;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = Number(line.split(':')[1]) || null;
      if (line.startsWith('#EXTINF:')) {
        pendingInf = Number((line.match(/^#EXTINF:([0-9.]+)/) || [])[1]) || null;
        if (pendingInf) totalInfDuration += pendingInf;
      }
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        pendingStream = parseAttributeList(line.slice(line.indexOf(':') + 1));
        continue;
      }
      if (!line.startsWith('#')) {
        const absolute = normalizeUrlWithBase(line, baseUrl);
        if (pendingStream) {
          variants.push({
            url: absolute,
            bandwidth: Number(pendingStream.BANDWIDTH || pendingStream['AVERAGE-BANDWIDTH']) || null,
            resolution: pendingStream.RESOLUTION || '',
            codecs: stripQuotes(pendingStream.CODECS || ''),
            audioGroupId: stripQuotes(pendingStream.AUDIO || ''),
            hostname: hostnameFor(absolute),
            extension: extensionFromUrl(absolute)
          });
          pendingStream = null;
        } else {
          segments.push({ url: absolute, duration: pendingInf, hostname: hostnameFor(absolute), extension: extensionFromUrl(absolute) });
          pendingInf = null;
        }
      }
    }
    const topSegmentHosts = Object.entries(segments.reduce((acc, segment) => {
      const host = segment.hostname || 'unknown';
      acc[host] = (acc[host] || 0) + 1;
      return acc;
    }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hostname, count]) => ({ hostname, count }));
    return {
      playlistKind: variants.length ? 'hls-master' : 'hls-media',
      encrypted,
      hasMap,
      hasFmp4Segments: segments.some((segment) => /\.(m4s|mp4|m4v|cmfv|cmfa)$/i.test(segment.extension || '')),
      hasByteRange,
      hasPartialSegments,
      hasPreloadHint,
      iframeOnly,
      hasEndList,
      playlistType,
      variantCount: variants.length,
      variants: variants.slice(0, 12),
      variantUrls: variants.map((variant) => variant.url).filter(Boolean).slice(0, 24),
      segmentCount: segments.length,
      segmentUrls: segments.map((segment) => segment.url).filter(Boolean).slice(0, 120),
      segmentExtensionCounts: countBy(segments.map((segment) => segment.extension || 'unknown')),
      targetDuration,
      estimatedDurationSeconds: Math.round((totalInfDuration || (targetDuration || 0) * segments.length) * 1000) / 1000,
      mediaSequence,
      topSegmentHosts,
      notes: hlsProbeNotes({ encrypted, hasMap, hasFmp4Segments: segments.some((segment) => /\.(m4s|mp4|m4v|cmfv|cmfa)$/i.test(segment.extension || '')), hasByteRange, hasPartialSegments, hasPreloadHint, iframeOnly, hasEndList, playlistType, variants, segments })
    };
  }

  function summarizeDashManifest(text) {
    const contentProtectionCount = (String(text).match(/<\s*ContentProtection\b/gi) || []).length;
    const representationCount = (String(text).match(/<\s*Representation\b/gi) || []).length;
    const segmentTemplateCount = (String(text).match(/<\s*SegmentTemplate\b/gi) || []).length;
    const durationMatch = String(text).match(/mediaPresentationDuration=["']([^"']+)/i);
    return {
      playlistKind: 'dash-manifest',
      contentProtectionCount,
      representationCount,
      segmentTemplateCount,
      mediaPresentationDuration: durationMatch?.[1] || '',
      notes: contentProtectionCount ? ['DASH ContentProtection markers were found. Media Scout does not download DRM-protected media.'] : []
    };
  }

  function hlsProbeNotes({ encrypted, hasMap, hasFmp4Segments, hasByteRange, hasPartialSegments, hasPreloadHint, iframeOnly, hasEndList, playlistType, variants, segments }) {
    const notes = [];
    if (encrypted) notes.push('Encryption markers were found; segment merging will stop safely.');
    if (hasMap || hasFmp4Segments) notes.push('fMP4/CMAF HLS markers or segment files were found; the built-in merge path currently supports MPEG-TS segments only.');
    if (hasByteRange) notes.push('Byte-range HLS was found; this is not supported by the current segment merger.');
    if (hasPartialSegments || hasPreloadHint) notes.push('Low-latency HLS partial/preload markers were found; built-in finite-file merging is not enabled for this layout.');
    if (iframeOnly) notes.push('I-frame-only HLS was found; this is a trick-play index, not a complete media playlist.');
    if (!hasEndList && !variants.length && playlistType !== 'vod') notes.push('No EXT-X-ENDLIST marker was visible; this may be a live/event playlist rather than a finite file.');
    if (!hasEndList && playlistType === 'vod') notes.push('Playlist is marked VOD but lacks EXT-X-ENDLIST; Media Scout treats merge eligibility as conditional.');
    if (variants.length) notes.push('This is a master playlist; the downloader will use the configured HLS variant preference when it can normally fetch the selected variant.');
    if (segments.length && !segments.some((segment) => segment.extension === 'ts')) notes.push('No .ts segment extension was visible; MP4 remux compatibility may be limited.');
    return notes;
  }

  function parseAttributeList(text) {
    const out = {};
    const regex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
    let match;
    while ((match = regex.exec(text || ''))) out[match[1].toUpperCase()] = stripQuotes(match[2]);
    return out;
  }

  function stripQuotes(value) {
    return String(value || '').replace(/^"|"$/g, '');
  }

  function normalizeUrlWithBase(rawUrl, baseUrl) {
    try {
      const url = new URL(cleanCandidateUrl(rawUrl), baseUrl || document.baseURI);
      url.hash = '';
      return url.toString();
    } catch (_error) {
      return '';
    }
  }

  function countBy(values) {
    return values.reduce((acc, value) => {
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    }, {});
  }

  function describeFrame() {
    let isTop = false;
    try { isTop = window.top === window.self; } catch (_error) { isTop = false; }
    return {
      url: location.href,
      title: document.title,
      referrer: document.referrer,
      isTop,
      origin: location.origin
    };
  }

  function describeIframes() {
    return limitList(Array.from(document.querySelectorAll('iframe')).map((iframe, index) => {
      const src = normalizeUrl(iframe.src || iframe.getAttribute('src') || '');
      return {
        index,
        src,
        title: iframe.getAttribute('title') || '',
        name: iframe.getAttribute('name') || '',
        allow: iframe.getAttribute('allow') || '',
        sandbox: iframe.getAttribute('sandbox') || '',
        loading: iframe.getAttribute('loading') || '',
        width: iframe.getAttribute('width') || '',
        height: iframe.getAttribute('height') || '',
        sameOrigin: Boolean(src && sameOrigin(src, location.href)),
        note: src ? 'Frame can only be scanned when Chrome grants the extension access to that frame origin.' : 'Inline or empty iframe source.'
      };
    }), 80);
  }

  function describeMediaElement(element, elementIndex) {
    const sourceElements = Array.from(element.querySelectorAll('source')).map((sourceElement) => ({
      src: normalizeUrl(sourceElement.src || sourceElement.getAttribute('src')),
      type: sourceElement.type || sourceElement.getAttribute('type') || '',
      media: sourceElement.media || sourceElement.getAttribute('media') || ''
    }));
    return {
      index: elementIndex,
      tagName: element.tagName.toLowerCase(),
      currentSrc: normalizeUrl(element.currentSrc),
      srcProperty: normalizeUrl(element.src),
      srcAttribute: normalizeUrl(element.getAttribute('src')),
      poster: normalizeUrl(element.getAttribute('poster')),
      typeAttribute: element.getAttribute('type') || '',
      readyState: element.readyState,
      networkState: element.networkState,
      paused: Boolean(element.paused),
      ended: Boolean(element.ended),
      duration: Number.isFinite(element.duration) ? element.duration : null,
      resolution: resolutionFor(element),
      currentTime: Number.isFinite(element.currentTime) ? element.currentTime : null,
      playbackRate: Number.isFinite(element.playbackRate) ? element.playbackRate : null,
      defaultPlaybackRate: Number.isFinite(element.defaultPlaybackRate) ? element.defaultPlaybackRate : null,
      buffered: rangesToList(element.buffered),
      seekable: rangesToList(element.seekable),
      controls: Boolean(element.controls),
      muted: Boolean(element.muted),
      autoplay: Boolean(element.autoplay),
      loop: Boolean(element.loop),
      preload: element.preload || element.getAttribute('preload') || '',
      crossOrigin: element.crossOrigin || element.getAttribute('crossorigin') || '',
      error: mediaErrorInfo(element.error),
      textTrackCount: element.textTracks?.length || 0,
      likelyMseBlob: String(element.currentSrc || element.src || '').startsWith('blob:') && sourceElements.length === 0,
      sourceElements,
      notes: mediaElementNotes(element, sourceElements)
    };
  }

  function compactMediaInfo(element) {
    if (!element) return null;
    return {
      tagName: element.tagName?.toLowerCase?.() || '',
      duration: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) / 1000 : null,
      currentTime: Number.isFinite(element.currentTime) ? Math.round(element.currentTime * 1000) / 1000 : null,
      resolution: resolutionFor(element),
      readyState: element.readyState,
      networkState: element.networkState,
      paused: Boolean(element.paused),
      ended: Boolean(element.ended),
      controls: Boolean(element.controls),
      muted: Boolean(element.muted),
      autoplay: Boolean(element.autoplay),
      preload: element.preload || element.getAttribute?.('preload') || '',
      playbackRate: Number.isFinite(element.playbackRate) ? element.playbackRate : null,
      buffered: rangesToList(element.buffered),
      seekable: rangesToList(element.seekable),
      sourceCount: element.querySelectorAll?.('source')?.length || 0,
      error: mediaErrorInfo(element.error)
    };
  }

  function compactResourceInfo(entry) {
    return {
      initiatorType: entry.initiatorType || '',
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
      decodedBodySize: entry.decodedBodySize || 0,
      startTime: Math.round(entry.startTime || 0),
      duration: Math.round(entry.duration || 0),
      responseEnd: Math.round(entry.responseEnd || 0),
      nextHopProtocol: entry.nextHopProtocol || ''
    };
  }

  function rangesToList(ranges) {
    const list = [];
    if (!ranges || typeof ranges.length !== 'number') return list;
    for (let index = 0; index < Math.min(8, ranges.length); index += 1) {
      try {
        list.push({ start: Math.round(ranges.start(index) * 1000) / 1000, end: Math.round(ranges.end(index) * 1000) / 1000 });
      } catch (_error) { break; }
    }
    return list;
  }

  function mediaErrorInfo(error) {
    if (!error) return null;
    const names = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
    return { code: error.code, name: names[error.code] || 'MEDIA_ERR_UNKNOWN', message: error.message || '' };
  }

  function mediaElementNotes(element, sourceElements) {
    const notes = [];
    if (!element.currentSrc && !element.getAttribute('src') && !sourceElements.length) notes.push('No currentSrc/src/source elements are exposed on this media element.');
    if (String(element.currentSrc || element.src || '').startsWith('blob:')) notes.push('This media element uses a blob: URL, often associated with Media Source Extensions or page-generated media.');
    if (element.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) notes.push('Browser reports NETWORK_NO_SOURCE for this element.');
    if (element.readyState === HTMLMediaElement.HAVE_NOTHING) notes.push('Browser reports HAVE_NOTHING; media metadata may not be loaded yet.');
    return notes;
  }

  function findLiteralMediaHints() {
    const hints = [];
    for (const script of document.scripts || []) {
      if (script.src) {
        collectMatchesFromText(script.src, 'script-src', 'src', 'script', hints);
      } else {
        collectMatchesFromText(script.textContent || '', 'inline-script-literal', 'inline-script', 'script', hints);
      }
    }
    for (const element of document.querySelectorAll('[src], [href], [srcset], [data-src], [data-url], [data-play], [data-video], [data-audio], [data-media], [data-stream], [data-file], [data-original], [poster]')) {
      const tagName = element.tagName.toLowerCase();
      for (const attribute of ['src', 'href', 'srcset', 'data-src', 'data-url', 'data-play', 'data-video', 'data-audio', 'data-media', 'data-stream', 'data-file', 'data-original', 'poster']) {
        if (!element.hasAttribute(attribute)) continue;
        collectMatchesFromText(element.getAttribute(attribute) || '', `attribute-${attribute}`, attribute, tagName, hints);
      }
    }
    return dedupeHints(hints);
  }

  function collectMatchesFromText(text, source, context, tagName, hints) {
    const normalizedText = normalizeScriptText(text);
    if (!normalizedText) return;
    MEDIA_LITERAL_REGEX.lastIndex = 0;
    let match;
    let guard = 0;
    while ((match = MEDIA_LITERAL_REGEX.exec(normalizedText)) && guard < 200) {
      guard += 1;
      const url = normalizeUrl(match[0]);
      if (!url || !urlLooksMedia(url)) continue;
      hints.push({
        url,
        source: source === 'inline-script-literal' ? 'page-text-literal' : source,
        context,
        tagName,
        hostname: hostnameFor(url),
        extension: extensionFromUrl(url),
        signedOrExpiringHint: looksSignedOrExpiringUrl(url)
      });
    }
  }

  function normalizeScriptText(text) {
    return String(text || '')
      .slice(0, 750_000)
      .replace(/&amp;/gi, '&')
      .replace(/\\\//g, '/')
      .replace(/\\u002f/gi, '/')
      .replace(/\\x2f/gi, '/');
  }

  function dedupeHints(hints) {
    const seen = new Set();
    const result = [];
    for (const hint of hints) {
      const key = `${hint.url}|${hint.source}|${hint.context}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(hint);
    }
    return limitList(result, 160);
  }

  function addDecision(decisions, rawUrl, context) {
    decisions.push(analyzeCandidate(rawUrl, context));
  }

  function analyzeCandidate(rawUrl, context) {
    const normalizedUrl = normalizeUrl(rawUrl);
    const mime = context.mime || '';
    const extension = extensionFromUrl(normalizedUrl);
    const reasons = [];
    let acceptedByBasicScanner = false;

    if (!rawUrl) reasons.push('empty-url');
    if (rawUrl && !normalizedUrl) reasons.push('invalid-url');

    let protocol = '';
    let hostname = '';
    if (normalizedUrl) {
      try {
        const parsed = new URL(normalizedUrl);
        protocol = parsed.protocol.replace(':', '');
        hostname = parsed.hostname;
        if (!['http', 'https', 'blob'].includes(protocol)) reasons.push('unsupported-url-scheme');
        if (looksSignedOrExpiring(parsed)) reasons.push('signed-or-expiring-query-hint');
      } catch (_error) {
        reasons.push('invalid-normalized-url');
      }
    }

    if (context.expectedMedia === false) reasons.push(context.nonCandidateReason ? `not-a-download-candidate-${context.nonCandidateReason}` : 'not-a-download-candidate');
    const mediaByUrl = normalizedUrl && urlLooksMedia(normalizedUrl);
    const mediaByMime = typeLooksMedia(mime);
    if (mediaByUrl) reasons.push('media-looking-url');
    if (mediaByMime) reasons.push('media-looking-mime');
    if (normalizedUrl?.startsWith('blob:')) reasons.push('blob-url-page-local');

    acceptedByBasicScanner = Boolean(context.expectedMedia !== false && normalizedUrl && (mediaByUrl || mediaByMime));
    if (!acceptedByBasicScanner && normalizedUrl && context.expectedMedia !== false) reasons.push('unsupported-extension-and-mime-for-basic-scan');

    return {
      source: context.source,
      attribute: context.attribute,
      tagName: context.tagName || '',
      parentTagName: context.parentTagName || '',
      elementIndex: context.elementIndex,
      rawUrl: rawUrl || '',
      normalizedUrl,
      protocol,
      hostname,
      extension,
      mime,
      resolution: resolutionFor(context.element),
      acceptedByBasicScanner,
      reasons
    };
  }

  function scanPerformanceEntries(decisions) {
    const entries = typeof performance?.getEntriesByType === 'function' ? performance.getEntriesByType('resource') : [];
    const initiatorCounts = {};
    const hostCounts = {};
    const mediaLikeEntries = [];
    const interestingEntries = [];

    for (const entry of entries) {
      initiatorCounts[entry.initiatorType || 'unknown'] = (initiatorCounts[entry.initiatorType || 'unknown'] || 0) + 1;
      const normalized = normalizeUrl(entry.name);
      const host = hostnameFor(normalized);
      if (host) hostCounts[host] = (hostCounts[host] || 0) + 1;
      const isMediaInitiator = ['video', 'audio', 'source', 'img', 'image', 'track'].includes(entry.initiatorType);
      const isMediaUrl = urlLooksMedia(normalized);
      const isInteresting = !isMediaUrl && isInterestingResource(entry, normalized);
      const record = {
        url: normalized,
        hostname: host,
        initiatorType: entry.initiatorType || '',
        extension: extensionFromUrl(normalized),
        transferSize: entry.transferSize || 0,
        encodedBodySize: entry.encodedBodySize || 0,
        decodedBodySize: entry.decodedBodySize || 0,
        startTime: Math.round(entry.startTime || 0),
        duration: Math.round(entry.duration || 0)
      };
      if (isMediaInitiator || isMediaUrl) {
        mediaLikeEntries.push(record);
        addDecision(decisions, normalized, {
          source: 'performance-resource',
          attribute: entry.initiatorType || 'resource',
          tagName: '',
          elementIndex: -1,
          mime: '',
          element: null
        });
      } else if (isInteresting) {
        interestingEntries.push({ ...record, note: 'Interesting resource URL, but no supported media extension/MIME was visible from Resource Timing.' });
        addDecision(decisions, normalized, {
          source: 'performance-resource-hint',
          attribute: entry.initiatorType || 'resource',
          tagName: '',
          elementIndex: -1,
          mime: '',
          element: null,
          expectedMedia: false,
          nonCandidateReason: 'resource-url-not-confirmed-media'
        });
      }
    }

    return {
      totalResourceEntries: entries.length,
      initiatorCounts,
      topHosts: Object.entries(hostCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([hostname, count]) => ({ hostname, count })),
      mediaLikeEntries: limitList(mediaLikeEntries, 160),
      interestingEntries: limitList(interestingEntries, 160)
    };
  }

  function isInterestingResource(entry, normalizedUrl) {
    const initiator = String(entry.initiatorType || '').toLowerCase();
    if (!['xmlhttprequest', 'fetch', 'other', 'iframe', 'script'].includes(initiator)) return false;
    const url = String(normalizedUrl || '').toLowerCase();
    return GENERIC_MEDIA_HINTS.some((hint) => url.includes(hint));
  }

  function dedupeItems(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${item.url}|${item.source}|${item.type}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function dedupeDecisions(decisions) {
    const seen = new Set();
    const result = [];
    for (const decision of decisions) {
      const key = `${decision.source}|${decision.attribute}|${decision.normalizedUrl}|${decision.mime}|${decision.elementIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(decision);
    }
    return limitList(result, 360);
  }

  function looksSignedOrExpiring(url) {
    const keys = Array.from(url.searchParams.keys()).map((key) => key.toLowerCase());
    return keys.some((key) => PROTECTED_QUERY_HINTS.some((hint) => key === hint || key.includes(hint)));
  }

  function looksSignedOrExpiringUrl(rawUrl) {
    try {
      return looksSignedOrExpiring(new URL(rawUrl));
    } catch (_error) {
      return false;
    }
  }

  function hostnameFor(rawUrl) {
    try {
      return new URL(rawUrl).hostname;
    } catch (_error) {
      return '';
    }
  }

  function sameOrigin(a, b) {
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch (_error) {
      return false;
    }
  }

  function limitList(items, max) {
    return items.slice(0, max).map((item) => ({ ...item }));
  }

  globalThis.MediaScoutPageScanner = { scan, scanDetailed };
})();
