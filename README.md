# Media Scout Downloader

[![CI](https://github.com/NouraldinFarge/media-scout-downloader/actions/workflows/ci.yml/badge.svg)](https://github.com/NouraldinFarge/media-scout-downloader/actions/workflows/ci.yml)

**Release-readiness candidate · 2026 · Version 3.7.11**

Media Scout Downloader is an original Chrome Manifest V3 extension for detecting and downloading media files that are legally accessible through the browser. It is inspired by the broad category of browser media helpers, but it does not copy Video DownloadHelper's branding, UI, code, icons, name, layout, proprietary behavior, or protected features.

The source is currently maintained as a private review candidate. Automated checks cover the fail-closed download policy, stale-evidence blocking, message validation, filename safety, strategy ordering, and extension manifest boundaries. A public release remains gated on manual Chrome testing and a final legal review.

See [`CHANGELOG.md`](CHANGELOG.md), [`TESTING.md`](TESTING.md), [`PRIVACY.md`](PRIVACY.md), and [`SECURITY.md`](SECURITY.md).

## Project structure

```text
media-scout-downloader/
  manifest.json
  src/
    background/
      service-worker.js
      media-detector.js
      download-manager.js
      download-strategies.js
      queue-manager.js
      tab-media-store.js
      diagnostics-manager.js
      report-manager.js
    content/
      content.js
      page-media-scanner.js
    popup/
      popup.html
      popup.js
      popup.css
    sidepanel/
      sidepanel.html
      sidepanel.js
      sidepanel.css
    options/
      options.html
      options.js
      options.css
    shared/
      constants.js
      types.js
      utils.js
      filename-utils.js
      storage-utils.js
      logger.js
      report-utils.js
      zip-utils.js
      validators.js
      self-tests.js
  assets/
    icons/
      icon16.png
      icon32.png
      icon48.png
      icon128.png
  README.md
  TEST_PLAN.md
```

## Architecture

Media Scout is file-structure first. The code is separated by responsibility:

- `shared/`: constants, JSDoc types, validation, filename generation, storage wrappers, logging, and self-tests.
- `background/`: service worker orchestration, media detection, tab media runtime store, queue management, download strategy selection, local diagnostics, and report assembly.
- `content/`: active-tab DOM scanning and page-local blob download handling.
- `popup/`: recommendation-first UI with one primary CTA, compact permission/limitation evidence, queue mini-status, and specific route links.
- `sidepanel/`: persistent workspace for Home, Inspector, Queue, Batch Preview, Report Preview, Diagnostics, and Help routes.
- `options/`: settings with consequences, dependency warnings, privacy inventory, diagnostics reset, and self-tests.

The extension favors safe behavior with clear warnings. If a media item appears encrypted, DRM-protected, authentication-bound, paywalled, access-controlled, or otherwise protected, Media Scout marks it unsupported and does not retry bypass-like behavior. For non-encrypted HLS, Media Scout can attempt settings-selected outputs: compatible MP4 remux, timestamp-fixed TS, raw TS concat, M3U8 playlist save, or explicit external-helper notes. Segment work runs from the page/frame context using only normal browser `fetch` rules. If CORS, authentication, permissions, signed/expiring URL checks, encryption, or other access boundaries block the request, the action stops rather than bypassing them.

## Text event flow diagram

```text
User opens popup
  -> service-worker gets active tab
  -> service-worker injects content/page-media-scanner.js + content/content.js into accessible frames using activeTab
  -> content script scans <video>, <audio>, <source>, and generic page-embedded media URL literals, media-looking Resource Timing entries
  -> content script sends DOM_MEDIA_FOUND
  -> media-detector validates, deduplicates, and annotates items
  -> tab-media-store updates active-tab runtime media and badge
  -> popup renders a recommendation-first card and specific side-panel route links

User clicks Generate report.zip
  -> popup asks service-worker for GENERATE_REPORT
  -> service-worker injects/requests detailed page scan across accessible frames
  -> content script reports DOM media elements, source attributes, iframe inventory, page-embedded media URL literals, media-looking performance entries, interesting player/API resource hints, and candidate decisions
  -> report-manager combines scan data, popup media, settings, permissions, queue summary, diagnostics, and self-tests
  -> popup packages text files into a local ZIP with shared/zip-utils.js
  -> chrome.downloads.download() saves the ZIP after user confirmation

Optional site access granted
  -> webRequest observes future active-tab requests for granted origins
  -> media-detector reads URLs and response headers
  -> media-detector adds supported media to tab-media-store

User clicks Download or pastes an .m3u8 URL and clicks Convert
  -> download-manager creates a sanitized filename from the filename template; `{tabTitle}` prefers text inside `《...》` when present
  -> queue-manager enforces max parallel downloads, default 3, configurable 1-6
  -> popup all-downloads panel shows active, queued, failed, and recent completed tasks from any tab
  -> download-strategies tries allowed strategies in locally learned order
  -> for non-encrypted HLS, the page/frame content script fetches MPEG-TS segments concurrently, preserves segment order, and remuxes compatible H.264/AAC MPEG-TS into `.mp4`
  -> chrome.downloads.download() starts safe direct/manifest downloads for other supported items
  -> protected failures stop immediately; normal network failures may retry
  -> diagnostics-manager stores local-only strategy success/failure counts
```

## Permissions rationale

- `activeTab`: allows active-tab scanning after the user opens the extension.
- `downloads`: required for `chrome.downloads.download()`.
- `scripting`: injects the scanner into the active tab only.
- `storage`: stores settings, queue summaries, and local anonymized diagnostics.
- `webRequest`: observes/analyzes media traffic for granted origins. It is not used to intercept, modify, block, or bypass requests.
- `optional_host_permissions`: users may grant site access per active origin or all sites for network detection. Without it, DOM scanning still works.

## Supported detection

- Direct media files: MP4, WebM, MOV, MP3, M4A, WAV, OGG.
- Non-encrypted HLS `.m3u8` playlists, including warning-only cross-origin entries. Download attempts normal page-context parallel MPEG-TS segment fetching and MP4 remux when CORS/access rules allow it.
- Non-DRM DASH `.mpd` manifests when same-origin parsing is possible.
- Page DOM sources from `<video>`, `<audio>`, and `<source>` elements.
- Response header media hints when `webRequest` has permission.

## Download strategies

1. Direct HTTP(S) file download with `chrome.downloads.download()`.
2. HTML media source URL download with the downloads API.
3. Page-local blob URL anchor download, only when the blob URL is directly usable by the page.
4. Non-encrypted HLS MPEG-TS segment download/remux in the page/frame context. This fetches compatible `.ts`-style segments concurrently, preserves media order, and saves MP4 when normal browser fetch access allows it.
5. Non-DRM DASH manifest download. DRM or ContentProtection markers are unsupported.

## Local self-improvement loop

`diagnostics-manager.js` stores only strategy names, success counts, failure counts, generic error categories, and timestamps in `chrome.storage.local`. Queue persistence stores counts and privacy-safe task metadata only; it does not retain full URLs, hostnames, page URLs, or filenames across service-worker restarts. Future downloads prioritize strategies that have succeeded locally. The Options page includes Reset learning data and Clear queue history buttons.

## Installation

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `media-scout-downloader/` folder.
5. Pin the extension if desired.
6. Open a page with standard media and click the Media Scout toolbar icon.
7. For network request detection, grant active site access from the popup or all-site access from Options. DOM scanning does not require broad host access.

## User guide

- Open the popup to scan the active tab and get one recommendation-first CTA.
- Use **Rescan** after pressing play or after dynamic page changes.
- Click **Download** for supported items.
- Use **Copy URL** to copy a detected media URL.
- Enable the advanced manual HLS route in Options → General, then paste an `.m3u8` URL into Side Panel → Inspector → **Manual HLS validation** to queue a manual non-encrypted HLS conversion. Keep the source page open; the converter uses the active tab context, fetches segments in parallel, and stops on encryption, DRM, auth, paywalls, CORS, signed/expiring URL checks, or other access-control boundaries.
- Open **Side panel > Queue** to see active, queued, failed, and recent completed progress from any tab, not only the current tab.
- Use the **Report** document icon in the popup to save a local `report.zip` when Media Scout does not find a video that another extension reports. The ZIP contains `summary.md`, `detected-media.json`, `page-scan.json`, `decision-log.json`, `extension-state.json`, and `limitations.txt`.
- Configure max parallel downloads, HLS segment parallelism, enabled file types, filename template, subfolder, duplicate handling, debug logs, and notifications in Options. By default, `{tabTitle}` names downloads after the first non-empty text inside Chinese book-title brackets such as `《大东北之你要下岗我涨薪》`; use `{rawTabTitle}` to keep the full browser tab title.
- Use **Clear detected media cache** to remove runtime detections.
- Use **Reset learning data** to clear local strategy statistics.
- Use **Clear queue history** to remove persisted queue summaries/history from `chrome.storage.local`.
- Use **Revoke all-site network detection** in Options if you previously granted broad host access and want to return to per-site access.

## Filename template tokens

- `{tabTitle}` - preferred title; uses text inside `《...》` when present
- `{rawTabTitle}` - full browser tab title after sanitization
- `{hostname}`
- `{resolution}`
- `{date}`
- `{index}`
- `{indexSuffix}`
- `{extension}`

The default is `{tabTitle}{indexSuffix}.{extension}`. Filenames are sanitized for Windows, macOS, and Linux. Duplicate behavior maps to Chrome's conflict actions: auto-number, prompt, or overwrite if allowed.

## Diagnostic report feature

The side-panel Report Preview route generates an on-demand local ZIP after a visible redaction checklist. It is designed for cases where a visible video is not listed or another extension finds something Media Scout does not. The report explains what Media Scout sees and why candidates were accepted, rejected, or marked unsupported. It includes active-tab details, accessible-frame coverage, iframe inventory, DOM media/source attributes, page-embedded media URL literals, media-looking Performance API entries, interesting player/API resource hints, site permission status, queue state, local diagnostics, and self-test results.

The report is never uploaded by the extension. Because it is a user-requested local export, it may contain active-tab and candidate media URLs; review it before sharing. Diagnostics stored in `chrome.storage.local` still do not store full URLs.

## Known limitations

- The extension does not decrypt, merge, or reconstruct protected streams.
- HLS segment merge/remux is intentionally limited to non-encrypted MPEG-TS-style playlists. It does not support AES-128/SAMPLE-AES, DRM, fMP4 `#EXT-X-MAP`, byte-range playlists, separate audio/video rendition merging, subtitles, or transcoding.
- Cross-origin HLS segment merge only works when the page/frame can fetch the playlist and segments through normal browser CORS/access rules. DASH remains manifest-only; DASH segment assembly is not implemented.
- Some sites hide media behind inaccessible cross-origin iframes, MSE, DRM, service workers, authentication, short-lived URLs, or signed URLs; these are unsupported unless normal Chrome permissions expose a supported media URL.
- Service workers can be suspended, so runtime-only detections may need a popup rescan. Active jobs interrupted by tab closure or browser shutdown should be retried manually.
- Blob URL support is page-local and may fail if the blob is no longer valid.
- The extension is not a streaming-platform scraper and contains no site-specific platform logic.

## Security, privacy, and legal compliance

- No remote code execution.
- No external CDN scripts or frameworks.
- No telemetry.
- No upload of browsing data, URLs, filenames, media metadata, or diagnostic reports.
- On-demand report ZIPs are generated locally and saved only when the user clicks the report button.
- No full URLs in diagnostics, and persisted queue history is privacy-safe by default.
- No DRM, encryption, paywall, authentication, signed URL, CORS, or access-control bypass.
- Message payloads are validated.
- Dynamic DOM rendering uses safe DOM creation instead of unsafe dynamic `innerHTML`.
- Permissions are least-privilege by default, with optional host access for enhanced network detection and an Options control to revoke all-site access.

## Final best-practices checklist

- [x] Manifest V3 service worker.
- [x] Plain JavaScript, HTML, and CSS.
- [x] ES modules in background, popup, and options where supported.
- [x] No external scripts, CDNs, frameworks, or remote code.
- [x] Centralized constants, validators, storage helpers, logger, filename helpers, and self-tests.
- [x] Modular detection and download strategies.
- [x] Queue manager with concurrency cap 1-6, default 3.
- [x] Safe filename generation with tab-title defaults, `《...》` title extraction, `{rawTabTitle}` support, and counters.
- [x] Redesigned dark modern popup UI with accessible states, inline SVG icons, and an all-tabs download progress panel.
- [x] Options page with file types, max parallel downloads, HLS segment parallelism, filename template, notifications, debug logs, subfolder, duplicate behavior, cache reset, and diagnostics reset.
- [x] Local-only diagnostics and strategy prioritization.
- [x] On-demand local report ZIP for detection troubleshooting.
- [x] Unsupported protected streams fail safely.
- [x] Non-encrypted MPEG-TS HLS segment merge/remux uses parallel normal page-context fetch only, with fail-closed protection checks.
- [x] Manual `.m3u8` URL converter queues the same safe HLS pipeline and exposes popup progress.

## Self-review results and improvements made

- MV3 compliance checked: background uses `service_worker` with `type: module`.
- Permissions reviewed: host access is optional; active scanning uses `activeTab` + `scripting`.
- DRM/protection reviewed: HLS `#EXT-X-KEY` and DASH `ContentProtection` markers fail closed.
- CORS/access-control reviewed: v1.6 HLS segment merge runs inside the content script frame and uses normal page fetch/CORS behavior. It does not use extension host permissions or background fetch to bypass restrictions. v1.5 still allows playlist/manifest fallback when Chrome downloads can access the URL normally.
- Queue reviewed: concurrency uses `active.size < maxParallel` and re-drains after completion.
- Filenames reviewed: unsafe characters, reserved names, extensions, subfolders, and duplicate conflict actions are handled.
- UI reviewed: popup uses safe DOM methods, keyboard-focus states, clear empty state, and status chips.
- Diagnostics reviewed: stores only strategy names/counts/error categories, not URLs.
- Report reviewed: generated only by user action, saved locally, packaged without external libraries, and includes a privacy warning.


## Version 1.4.0 diagnostic improvement

The popup scanner now promotes media-looking Resource Timing entries into the same detection pipeline used by DOM and page-text hits. This helps pages that play video through Media Source Extensions, where the visible `<video>` element exposes only a `blob:` URL while HLS/DASH resources are loaded by the player script. Blob/MSE entries are shown as unsupported with an explanation instead of being silently omitted.


## v1.5 warning-only playlist/manifest behavior

A user-requested refinement reduces overblocking without weakening protection handling. Media Scout no longer treats every cross-origin HLS/DASH playlist as protected solely because it is cross-origin. Instead, it shows a warning and permits direct saving of the playlist or manifest file. In v1.6, Media Scout can now try a constrained non-encrypted HLS MPEG-TS segment merge when normal page-context fetch allows every playlist and segment. It still will not decrypt encrypted playlists, bypass CORS, reuse access tokens, defeat signed URL protections, work around authentication/paywall/DRM restrictions, merge fMP4/DASH, or transcode streams.


## v1.6 non-encrypted HLS segment merge

A user-requested download strategy now attempts to fetch and concatenate non-encrypted MPEG-TS-style HLS segments into a single `.ts` file. The strategy runs in the same page/frame content script that observed the media, so its `fetch()` calls obey normal browser CORS, credential, and access-control behavior. It stops immediately on `#EXT-X-KEY` encryption markers, HTTP 401/403/access failures, CORS/fetch blocking, signed/expiring URL validation, fMP4 `#EXT-X-MAP`, byte-range playlists, I-frame-only playlists, or oversized memory-bound merges. Unsupported-but-unprotected HLS layouts may fall back to saving the playlist file itself.

This is a simple browser-side concatenator, not a transcoder. The output is `.ts`, not `.mp4`; some media players can play it directly, while others may require a separate lawful conversion tool outside the extension. Preferred download subfolders may not apply to this blob-based page download because the final file is saved through an in-page object URL.

## v1.7 progress UI and compatible MP4 remux

The popup now shows task-level progress for supported downloads. HLS segment downloads report playlist parsing, segment-fetch counts, remuxing, saving, and completion. Direct Chrome downloads report byte progress when Chrome exposes byte counts.

For non-encrypted MPEG-TS-style HLS, Media Scout now tries to remux compatible H.264/AAC streams into MP4 locally in the content script. This is a remux only: it repackages samples from TS into MP4 boxes and does not decode, transcode, decrypt, or modify protected content. If MP4 remuxing is not possible because the stream uses unsupported codecs/layouts or lacks required AVC metadata, the extension saves the lawful `.ts` fallback instead and explains the fallback reason in the popup.

Supported MP4 remux path:

- HLS media or variant playlist is non-encrypted.
- Segments are MPEG-TS, not fMP4 `#EXT-X-MAP` or byte-range layouts.
- Video is H.264/AVC with SPS/PPS metadata.
- Audio, when present, is AAC/ADTS.
- All playlists and segments are fetchable through normal browser/page rules.

Still unsupported: DRM/EME, AES-128/SAMPLE-AES HLS, DASH segment assembly, CORS/auth/paywall bypass, signed URL circumvention, HEVC/H.265, MPEG-2 video, MPEG audio, separate audio/video rendition muxing, subtitles, and true transcoding.


## v1.9 manual .m3u8-to-MP4 converter

The side-panel Inspector can show a **Manual HLS validation** panel when the setting is enabled in Options → General. Paste a direct `http(s)` `.m3u8` playlist URL and click **Validate and queue manual HLS** to create a manual HLS task. The task uses the same queue, progress bar, segment fetcher, and compatible TS→MP4 remuxer as detected HLS items.

The manual converter is not a bypass path. It runs against the active tab context and is intended for playlists the current page can normally access. It stops on encrypted HLS markers, DRM/EME, authentication, paywalls, signed/expiring URL validation, CORS/fetch blocking, HTTP 401/403/access failures, fMP4 `#EXT-X-MAP`, byte ranges, unsupported codecs, and oversized memory-bound merges. When MP4 remux is not compatible but the stream is otherwise legal and fetchable, Media Scout may save a `.ts` fallback with a visible explanation.


## Version 1.9.0 update

Detected `.m3u8` HLS items now use the MP4 remux path by default. Pressing **Download MP4** on an HLS item means Media Scout will try to fetch normally accessible, non-encrypted MPEG-TS segments in the page/frame context and remux compatible H.264/AAC streams into an `.mp4` file. It no longer falls back to saving the `.m3u8` playlist text or a `.ts` fallback for detected HLS downloads. If MP4 remuxing is not compatible, blocked by normal browser access rules, encrypted, DRM-protected, authenticated, paywalled, or otherwise protected, the task fails with a clear reason.


## Version 2.0.0 update

The v10 frontend reorganized the popup into a recommendation-first summary, moved the global job list to Side Panel → Queue, and moved manual `.m3u8` entry to Side Panel → Inspector. The **Queue** route is global, so an HLS conversion started from one tab remains visible when the side panel is opened from another tab.

Non-encrypted HLS segment fetching is now parallelized. The content script fetches multiple MPEG-TS segments at once, preserves the original segment order before remuxing, and reports progress with segment counts and parallel worker details. Segment parallelism defaults to 6 and can be configured from 1 to 10 in Options. This still uses normal page/frame `fetch()` behavior and still stops on encryption, DRM, authentication, paywalls, CORS/access-control failures, signed/expiring URL validation, unsupported playlist layouts, or unsupported codecs.

## Version 2.1.0 update

The MP4 remuxer now uses stack-safe, preallocated MP4 sample-table writers for long HLS programs. Earlier builds could fetch all segments successfully and then fail during `Writing MP4 boxes` with `Maximum call stack size exceeded` when a long episode produced very large `stts`, `ctts`, `stss`, or `stsz` tables. This update removes large spread-argument calls in those table builders and keeps the segment order/remux safety rules unchanged.

This is a bug fix only. It does not add DRM decryption, CORS bypassing, authentication bypassing, paywall bypassing, transcoding, fMP4 support, byte-range HLS support, or protected stream handling.


## v2.2 updates: adaptive parallel segments, richer video details, cleaner popup

This build improves the large-HLS download path and the popup organization:

- HLS segment fetching now uses an adaptive scheduler instead of fixed always-on workers.
- Segment progress updates are throttled so the popup and page paint more smoothly during large downloads.
- Parallelism ramps up gradually, backs off after retryable failures, and preserves original segment order before MP4 remuxing.
- Transient segment failures can be retried locally with normal `fetch()` only. This does not bypass DRM, encryption, authentication, paywalls, CORS, signed URLs, or access controls.
- Options now include a segment retry limit and allow segment parallelism up to 16. The scheduler may automatically use less than the configured maximum when stability requires it.
- Detected media cards now show more metadata, including duration, resolution, resource timing, sizes, frame origin, HLS variants, buffered ranges, media state, and stream source details when available.
- Warnings and error explanations in the popup are collapsed by default to reduce visual clutter.

For very long HLS playlists, the extension still performs an in-browser memory-based merge/remux. Large files may hit browser memory limits even when every segment is legally accessible and non-encrypted.

## Version 2.3.0 update

This build smooths large segmented downloads further and improves diagnostics:

- Fixed a duplicated retry-progress callback that could inflate retry counts and contribute to UI churn during segment failures.
- Segment progress writes to `chrome.storage.local` are now throttled. The popup still receives live updates, but long HLS jobs no longer write storage on every progress event.
- The adaptive segment scheduler starts at a moderate concurrency, ramps faster after healthy completions, backs off on retryable failures, and yields to the browser only periodically instead of after every segment.
- Segment fetches now have a per-request timeout so a stuck request does not freeze the entire conversion indefinitely.
- Reports now include playlist/manifest probes when normal page fetch rules allow them, including HLS variant count, segment count, estimated duration, segment extension counts, encryption markers, fMP4/byte-range markers, and DASH ContentProtection counts.
- Recent queue history is persisted without raw media URLs so reports can still show recent completed/failed work after the MV3 service worker restarts.

The same safety boundary remains: no DRM/encryption bypass, CORS bypass, auth/paywall bypass, signed URL circumvention, site-specific scraping, or protected-stream handling.


## v2.4 Expanded media registry and detection

This build incorporates the expanded media research matrix into the extension architecture. Detection is now registry-driven through `src/shared/media-type-registry.js`, covering:

- Video containers: MP4/M4V, MOV/QT, WebM, Ogg/OGV, MPEG/MPG, MPEG-TS, MKV, AVI, 3GP/3G2, FLV/F4V, WMV/ASF, MXF.
- Audio files: MP3, M4A/M4B, AAC/ADTS, WAV, Ogg/OGA, Opus, WebA, FLAC, AIFF, AMR/AWB, MIDI.
- Streaming manifests/playlists: HLS `.m3u8`, M3U, DASH `.mpd`, Smooth Streaming `.ism/.isml`, Adobe HDS `.f4m`.
- Stream internals: MPEG-TS, fMP4/CMAF fragments, low-latency partial segments.
- Companion assets: WebVTT/SRT/TTML/DFXP/SAMI/ASS/SSA/LRC/SBV subtitles and captions, poster/thumbnail image formats, and optional metadata hints.

The side-panel Inspector groups detected assets by purpose: final video/audio, HLS-to-MP4, manifests, stream internals, subtitles/captions, posters/thumbnails, and metadata hints. Warnings remain collapsed by default.

The on-demand report now includes `media-type-registry.json` and group counts so users can see exactly which extensions/MIME types the extension knows about.

Safety boundary remains unchanged: direct downloads and conversion use only normal browser/extension access. HLS-to-MP4 is limited to non-encrypted, normally fetchable MPEG-TS HLS with compatible H.264/AAC streams. The extension still does not bypass DRM, encryption, paywalls, auth, signed URLs, CORS, or access controls.

## v2.5 updates

- Redesigned the popup into collapsible media categories so large pages with many segments/images stay readable.
- Redesigned the Options page with a cleaner sectioned layout, quick navigation, grouped file-type controls, registry filtering, and preset buttons.
- Improved blob/MSE handling in the popup: when a visible player uses a page-local `blob:` URL, Media Scout now looks for a related detected HLS/DASH/stream item from the same tab/frame and offers a linked-stream download/remux action. The blob URL itself is still not treated as a reusable downloadable file.
- Improved HLS TS→MP4 remux quality: video PES data is split into H.264 access units when Access Unit Delimiters are present, empty sync-sample tables are omitted, and the remuxer stops instead of saving an MP4 that is likely to be black/still due to too few detected video samples.
- Queue result metadata now includes audio presence and estimated video FPS when MP4 remuxing succeeds.

The extension still does not bypass DRM, encryption, authentication, paywalls, CORS, signed URL protections, or access controls.


## v2.6 updates

- Hardened the HLS MPEG-TS to MP4 remuxer to split H.264 access units even when streams omit Access Unit Delimiters.
- Aligns MP4 output to the first detected IDR/keyframe and drops leading non-decodable pre-keyframe samples instead of saving likely black-start files.
- Prepends SPS/PPS parameter sets to keyframe samples while also preserving avcC metadata for better player compatibility.
- Detects unsupported AAC LATM/LOAS, AC-3, E-AC-3, MPEG audio, HEVC, and MPEG-2 TS streams earlier instead of silently producing video-only or broken MP4 output.
- Reports richer remux stats: video/audio samples, output bytes, keyframes, estimated FPS, parsed durations, dropped pre-keyframe samples, and remux warnings.
- Prevents MV3 service-worker restarts from overwriting recent queue history with an empty queue before a report is generated.



## v2.7 HLS output method controls and freeze reduction

The side-panel Inspector exposes per-HLS output-method buttons for detected HLS candidates, and the Options page includes a default HLS method dropdown. Available user-facing modes are Smart MP4, MP4 remux, timestamp-fixed TS, Fast TS concat, Playlist only, and external helper info. Planned modes such as fMP4/CMAF assembly, separate audio/video merge, and visible-player recording remain internal constants only and are not selectable defaults.

To reduce freezes, the default segment parallelism is now lower for new installs, processing impact can be set to Gentle/Balanced/Fast, and HLS work modes cap adaptive segment concurrency internally. MP4 remux now yields between heavy phases. For very long videos or weaker machines, use Fast TS concat or Gentle mode first.

## v2.8.0 startup reliability patch

This build fixes a popup/detection startup regression from v2.7:

- The popup now starts only one initial scan instead of racing duplicate startup scans.
- Popup rendering has an error boundary, so a bad/old stored queue item cannot break the UI.
- The popup listens for late `ACTIVE_TAB_STATE` updates so media discovered after startup appears without reopening the popup.
- Scanner injection now runs top-frame first, then attempts all accessible frames. This prevents iframe-heavy pages from blocking top-page detection when one frame is inaccessible.
- A visible scanner status message shows whether the top frame, accessible frames, or fallback scan was used.


## Version 2.9 detection regression fix

Version 2.9 restores the broad detection path that worked before the v2.8 startup patch while keeping the safer popup startup behavior. Detection now tries all-frame scanning, top-frame scanning, a small legacy literal/resource scan that does not depend on the injected scanner bootstrap, message fallback, and two short follow-up scans to catch HLS/MSE resources that load after playback starts.

The content script also watches Resource Timing entries so late `.m3u8`, `.mpd`, `.ts`, `.m4s`, and other media-looking resources can trigger a scan even when the DOM does not change.


## v3.0 popup and detection stabilization

- Rebuilt the popup into a simpler state-driven interface with clear health/status messaging.
- Added separate **Scan now** and **Hard rescan** actions. Hard rescan clears the active tab cache, resets the injected scanner flag, reinjects the scanner, and performs multiple scan passes to catch late-loading iframe/MSE/HLS resources.
- Added **Refresh + reload**, which reloads the active page with cache bypass, requests a Chrome extension update check when available, then calls `chrome.runtime.reload()`. For unpacked installs this reloads the extension from disk; Chrome still requires the user to enable the extension for incognito before any incognito popup button can run.
- Kept all media categories collapsible and preserved the global all-tabs download progress panel.
- Added render recovery so a malformed stored task/media item should not blank the popup.


## v3.1.0 fix

- Fixed a regression in adaptive HLS segment fetching where the per-segment timeout referenced an out-of-scope `work` object. This caused long HLS jobs to fail around segment fetch startup with `work is not defined`, even when detection and playlist parsing were working.
- Kept the rebuilt v3 popup, hard rescan controls, all-tabs progress, grouped collapsible media sections, and configurable HLS output methods.


## Version 3.2 popup dropdown stability fix

Native HTML select controls were removed from the popup because Chrome extension popups can close when focus moves to the browser/OS select menu. HLS method choices now use side-panel route actions for detected HLS items and the manual .m3u8 validator. This keeps the popup open while changing methods and avoids reloading scanner state just because a method was selected.


## Version 3.3 notes

- Replaced popup HLS dropdown/menus with always-visible MP4 / TS / Playlist action buttons.
- Added segmented method selectors that do not use native `<select>` or popup-style `<details>` controls, reducing Chrome popup focus glitches.
- Improved MPEG-TS to MP4 remux timestamp interpolation for HLS streams where only the first access unit in each PES packet carries DTS/PTS. This targets MP4 outputs that opened as black or still video.
- Reports may still show TS concat as completed when that method is selected; choose **MP4** in the popup for standalone MP4 remux.


## v3.4 stabilization update

This build adds Smart MP4 routing, Timestamp-fixed TS fallback, raw TS concat labeling, and an external-helper instruction export. The popup now avoids dropdowns and popup menus for HLS actions; each HLS card uses direct buttons: Smart, MP4, Fixed TS, Raw TS, M3U8, and Helper. Smart MP4 first tries the in-browser MP4 remuxer for compatible non-encrypted MPEG-TS HLS and then falls back to Timestamp-fixed TS instead of raw byte concatenation when the browser-only remuxer cannot produce a validated MP4.

Timestamp-fixed TS is a browser-side fallback that rewrites continuity counters and rebases obvious PCR/PTS/DTS timestamp resets while preserving normal browser access boundaries. It is safer than raw TS concat for desync-prone streams, but it is not a full native FFmpeg replacement. fMP4/CMAF assembly, separate audio/video HLS muxing, DASH assembly, and visible-player recording remain explicit planned/unsupported modes unless a future native or bundled worker muxer is added.


## v3.5 popup stability and manual converter visibility

- The popup was rebuilt around direct action buttons and a single guarded action path so scan, hard rescan, report generation, page refresh/reload, and media downloads do not interrupt each other.
- Native popup dropdowns and popup menus are not used in the popup. HLS actions are direct buttons on each detected HLS card.
- The optional manual `.m3u8` converter is hidden by default. Enable **Show manual .m3u8 converter in Side Panel → Inspector** from Options when manual URL entry is needed.
- Detected-media categories remain collapsible, while warnings/details remain collapsed by default.

## v3.6 episode batch discovery

Media Scout now includes a generic same-origin episode batch helper for pages whose URL ends in a numbered episode token, for example:

```text
https://www.example.com/play/39018009-2-1
```

The detector treats the final numeric token as the episode number and scans the current page and accessible frames for visible same-series links matching the same prefix/suffix pattern, such as `.../play/39018009-2-2` and `.../play/39018009-2-3`.

Important limits:

- It does not hardcode site-specific scraping rules.
- It does not brute-force unlinked episode numbers.
- It only lists episode URLs the page exposes through links, attributes, onclick data, or page literals.
- Batch download opens episode pages in inactive tabs, scans each page with normal extension permissions, queues the first safe HLS/video candidate it finds, keeps each tab open only while its content-script download runs, and closes the tab after success, failure, or cancel.
- Downloads still use the normal queue and respect Max parallel downloads. Episode page scanning has its own small parallelism setting in Options.
- Protected, encrypted, DRM, auth, paywall, signed URL, CORS, or access-control failures still stop safely.


## v3.6.1 improvement pass

- Persisted queue history is now privacy-safe: it keeps counts and coarse task metrics, but no hostnames, full URLs, page URLs, or filenames across service-worker restarts.
- Added **Clear queue history** and **Revoke all-site network detection** controls in Options.
- Added an explicit confirmation before requesting all-site network detection.
- Added active HLS cancellation plumbing with content-script `AbortController` support so canceling an HLS job stops segment fetching before final save.
- Added Chrome download cancellation hooks for direct downloads once Chrome returns a download id.
- Added cleanup for inactive episode batch tabs after the queued task settles.
- Lowered the in-browser HLS merge memory cap and added a bandwidth/duration preflight estimate where HLS variant metadata is available.
- Tightened message validation and progress-update ownership checks.
- Added an explicit MV3 extension-page content security policy.

## v3.6.2 second improvement pass

- Diagnostic report exports are redacted by default. Full active-tab/media URLs are only included when the new Options setting is enabled and the popup confirmation is accepted.
- Added queue history retention controls: do not persist, 1 day, 7 days, or 30 days. Expired queue history is removed automatically when read.
- Fixed HLS blob URL cleanup so a successful object URL download is not revoked immediately by task cleanup.
- Improved HLS segment failure handling so a fatal segment error aborts in-flight segment fetches instead of letting them continue unnecessarily.
- Added tab-closure cancellation: if a source tab closes before its task completes, matching active/pending tasks are canceled and cleaned up.
- Added Chrome direct-download watchdogs for user cancellation, idle downloads, and long-running stalled downloads.

## v3.6.3 third improvement pass

- Added a **Default HLS variant** setting for master playlists: highest bandwidth/quality or lowest bandwidth/smaller file. The default remains highest; lowest can reduce memory use and failures on long streams.
- The HLS merge pipeline now carries the chosen variant preference through background selection, content-script master-playlist selection, queue results, and privacy-safe queue history metrics.
- Hardened episode batch downloads so externally supplied episode lists are revalidated against the active tab's same-origin episode pattern before Media Scout opens inactive tabs. Crafted cross-origin or non-matching episode URLs are ignored.
- Tightened message validation for HLS merge, blob download, cancel, and episode batch payloads.
- Updated popup wording from “Best variant” to “Top variant” so the UI does not imply the highest detected variant will always be selected when the user chooses the lower-bandwidth preference.

## v3.6.4 fourth improvement pass

- Added visible **Cancel** controls for active, queued, converting, and retried jobs in both media cards and the Queue route.
- Added **Clear finished** in the popup queue panel to remove completed, failed, and canceled entries from the visible runtime queue and privacy-safe queue history.
- Queued batch-episode tasks now close their inactive background tab even when the task is canceled before it starts.
- Added an explicit confirmation before **Download all found** opens a large number of background episode tabs. The threshold is configurable from Options.
- Added **Confirm episode batch above** in Options so users can choose when the popup asks before opening many episode tabs.
- Start-download handling now fetches the original source tab by id instead of assuming the currently active tab is still the right filename/context source.
- Added self-test coverage for the new queue-clear message and episode-batch confirmation threshold clamping.

## v3.6.5 fifth improvement pass

- Added **Pause queue / Resume queue** in the popup Queue route. Active downloads continue, while pending jobs wait until resumed.
- Duplicate starts for the same media item and HLS method are now ignored while an identical job is already active or queued.
- Failed tasks now expose retry eligibility, and the popup hides Retry for non-retryable categories such as DRM, encrypted/protected media, signed/expiring URLs, permission, paywall, CORS, and user-canceled cases.
- Queue pause state is included in runtime queue updates and privacy-safe queue summaries.
- Added self-test coverage for pause/resume queue message validation.

## v3.6.6 sixth improvement pass

- Planned HLS output modes (fMP4/CMAF assembly, separate audio/video merge, and visible-player recording) are no longer user-selectable defaults until implemented.
- Settings migration now falls back to Smart MP4 if an older saved setting points at a planned HLS mode.
- The popup now offers a one-click Grant current site action when network detection is limited.
- Site-access requests are checked against the active tab origin before Chrome is asked for permission, preventing a crafted message from requesting an unrelated origin.
- Self-tests now cover user-facing HLS method validation and planned-mode fallback.

## v3.6.7 seventh improvement pass

- Added a background message-source guard so privileged actions only run from Media Scout extension pages, not from content-script/page contexts.
- Content scripts are limited to scan-result and progress-update messages, which are still matched to the expected source tab/frame before mutating queue state.
- Self-tests now cover message privilege classification for extension-page versus content-script message types.

## v3.6.8 eighth improvement pass

- Added navigation-scoped cleanup: when a previously scanned tab navigates to a different document, Media Scout clears stale detections, removes the tab from webRequest/network-detection scope, and prompts the popup to rescan the new page.
- Page-context downloads that need the original tab, such as HLS segment merges and blob downloads, are canceled if that tab navigates before they finish. Already-started direct Chrome downloads are left alone because they no longer depend on the page context.
- Hash-only same-document navigations are ignored so single-page players do not lose detections just because the URL fragment changes.
- DOM scan result payloads are now bounded and sanitized before ingest, limiting oversized strings/objects from page-influenced scan data.
- Message validation now rejects oversized `DOM_MEDIA_FOUND` scan items before they reach background ingestion.
- Self-tests now cover bounded DOM scan item validation.

## v3.6.9 ninth improvement pass

- Tightened privacy-safe queue persistence again: saved queue history now strips free-form progress text, raw error messages, output filenames hidden inside progress details, hostnames, frame/page/media URLs, and raw remux warning strings.
- Persisted queue history keeps only coarse codes and metrics, such as phase, percent, segment counts, byte counts, selected HLS preference, strategy, and error category/code.
- Added restart recovery for MV3 service-worker restarts: if privacy-safe queue history says jobs were active or pending when the worker restarted, the popup shows them as interrupted/canceled instead of silently losing them.
- Restored interrupted jobs are intentionally non-retryable from saved history because the extension no longer has the raw media URL or page context needed to safely resume; users should rescan and queue again.
- Existing older saved queue history is sanitized the first time v3.6.9 reads and rewrites it.

## v3.6.10 tenth improvement pass

- Added protected-URI checks inside HLS handling. Media Scout now refuses HLS playlists, selected variant playlists, media segments, and separate audio renditions whose URLs appear signed, expiring, or tokenized, even when the originally detected `.m3u8` URL itself looks clean.
- Same-origin HLS inspection marks detected playlists unsupported when protected HLS component URLs are visible, so users see the safety boundary before starting a download when possible.
- Page-context HLS merging now performs the same fail-closed protected-URI checks after fetching master and media playlists, covering cross-origin playlists that can only be inspected from the page context.
- Settings persistence now drops unknown setting keys and length-limits filename template / preferred subfolder strings before saving to `chrome.storage.local`.
- `SETTINGS_SAVE` message validation now rejects unknown setting keys and oversized string settings before they reach storage.
- Self-tests now cover settings-key rejection, unknown-setting migration, and filename-template length limiting.

## v3.6.11 report-driven encrypted-playlist pass

- Diagnostic report generation now feeds detailed playlist-probe findings back into the active tab state before the report is built.
- If a detailed probe finds encrypted HLS (`#EXT-X-KEY`), matching playlist items and observed stream segments are marked encrypted/unsupported instead of remaining warning-only detected items.
- If a detailed probe finds fMP4 `#EXT-X-MAP` or HLS byte-range markers, matching items are marked unsupported for the current local merger.
- Segment items from the same probed encrypted HLS segment host are downgraded to protected so the popup discourages saving encrypted internal `.ts` pieces.
- Status preservation was fixed so encrypted items remain `encrypted` instead of being flattened to generic `unsupported` when merged into the tab media store.
- Redacted reports now treat plural sensitive keys such as `segmentUrls`, `variantUrls`, and `sourceUrls` as URL-bearing fields before exporting.

## v3.6.12 detailed download allow-list pass

- Added `src/shared/download-allow-list.js`, a centralized positive policy for download eligibility.
- Added `DOWNLOAD_ALLOW_LIST.md`, documenting exactly which direct files, manifests, playlists, segments, and HLS actions are allowed.
- HLS now has per-action decisions instead of one blanket protected flag:
  - encrypted/fMP4/byte-range/protected-component HLS remains blocked for video merge/download;
  - safe top-level `.m3u8` files can still be saved with the **M3U8** action when that file itself is downloadable.
- DASH `ContentProtection` manifests can be saved as MPD text files when the top-level MPD URL is safe; the extension still refuses DASH segment fetching, merging, and decryption.
- Popup buttons now enable or disable per HLS method based on the allow-list decision and show the reason in the button title/details.
- Download strategies now consult the same allow-list immediately before running, so UI and background behavior stay aligned.

## v3.6.13 allow-list refinement pass

- Refined the allow list from a simple URL/protection gate into an action-scoped policy: direct top-level file save, manifest-only save, raw segment save, page-local blob save, HLS merge, and helper-note actions now get separate decisions.
- Reduced false blocking for browser-downloadable assets: signed/tokenized top-level final media files, images, subtitles, HLS playlist files, DASH MPD files, and other manifest files may be saved directly when the action only passes that exact URL to Chrome Downloads.
- Kept stream-component safety strict: signed/tokenized HLS components, raw segments, variant playlists used for merging, and HLS conversion paths are still blocked because those would fetch/reuse protected component URLs.
- Added MIME-only allowance for final media and companion files when URLs do not expose a useful extension but the response MIME type is allow-listed.
- Popup media cards now include **Allow-list action details**, showing which actions are allowed or blocked and why.
- Limited-but-downloadable items are shown as detected/limited instead of unavailable when the only issue is a signed top-level file-save URL.

## v3.6.14 deeper allow-list pass

- Added richer allow-list decisions with action labels, confidence levels, output kind, safe fallback action/method, and risk flags. Popup **Allow-list action details** now explains not just allowed/blocked, but also whether the decision is high-confidence, conditional, signed-top-level-only, page-context-dependent, or playlist-only fallback.
- Tightened HLS merge eligibility for cases that were previously too ambiguous:
  - live/event playlists without `#EXT-X-ENDLIST` are playlist-only until the stream becomes a finite VOD;
  - low-latency HLS partial segments / preload hints are playlist-only;
  - I-frame-only playlists are playlist-only;
  - separate-audio HLS is not presented as a complete built-in MP4/TS download until audio/video alignment is implemented.
- Reduced false blocking for standalone MPEG-TS files. A `.ts`, `.m2ts`, or `.mts` item with strong final-file hints, such as a direct `<video src>` transport-stream file, can be downloaded as an original file even when the top-level URL is signed. Ordinary stream segments remain strict.
- Background and page-context HLS probes now annotate low-latency HLS markers, I-frame-only playlists, independent-segment markers, and playlist kind, so the allow list can make more precise decisions.
- Expanded self-tests for standalone signed MPEG-TS files, low-latency partial segments, live HLS, separate-audio HLS, and confidence/risk metadata.


## v3.6.15 deeper allow-list pass

- Refined separate-audio HLS handling so master playlists are no longer blocked just because they advertise audio renditions. If at least one self-contained variant is visible, Media Scout can choose that variant and avoid unsupported separate-audio merging.
- Background and page-context HLS variant selection now prefer self-contained variants when separate audio renditions exist, keeping policy, UI, and runtime behavior aligned.
- HLS variants now retain `AUDIO` group and `CODECS` metadata from `#EXT-X-STREAM-INF`, improving allow-list decisions and reducing false blocks.
- Added opt-in metadata-file downloading for user-enabled JSON/XML media metadata while keeping metadata disabled by default to avoid noisy API responses.
- Unknown media items with a clear allow-listed media MIME type can be classified by MIME in the allow-list layer, reducing false blocks for URLs such as `/download?id=123`.
- Standalone MPEG-TS detection now treats `Content-Disposition: attachment` as a strong final-file hint, so downloadable `.ts/.m2ts/.mts` files are less likely to be mistaken for HLS internals.
- Runtime HLS merging now fails closed when a master playlist truly requires separate audio variants and no self-contained fallback is available.
- Self-tests now cover metadata opt-in, MIME-inferred unknown media, and mixed separate-audio/self-contained HLS master playlists.

## v3.6.16 deeper allow-list pass

- Added a final-file evidence override for media that is initially classified as a segment by URL shape but has strong standalone-file evidence, such as `Content-Disposition: attachment`, clear `video/*` or `audio/*` MIME, DOM media-source evidence, large transfer size, or media duration. This reduces false blocking for signed CDN download endpoints that happen to use segment-like paths or extensions.
- Refined HLS live/VOD handling. Media playlists without `#EXT-X-ENDLIST` remain blocked for merge unless they are explicitly marked `#EXT-X-PLAYLIST-TYPE:VOD`, in which case the merge decision is conditional and runtime checks still enforce finite MPEG-TS compatibility.
- Added HLS fMP4 segment detection even when `#EXT-X-MAP` is absent. Playlists exposing `.m4s`, `.cmfv`, `.cmfa`, `.mp4`, or `.m4v` segment files are blocked for the MPEG-TS merger and remain playlist-save only.
- Included `#EXT-X-SESSION-KEY` in report/page playlist encryption detection so master-level encryption markers are treated consistently with media-level `#EXT-X-KEY`.
- Extended allow-list self-tests for segment-shaped final-file downloads, VOD-without-ENDLIST handling, live/event blocking, and fMP4 segment blocking.


## v3.6.17 deeper allow-list and HLS segment-count pass

- Added same-origin selected-variant HLS probing for master playlists. When a master playlist points to a selectable media playlist on the same origin, Media Scout now counts the selected variant's full media segments before download.
- The popup now displays HLS segment count, count source, selected variant resolution/bandwidth, partial-segment count, and playlist duration when available.
- The allow-list now carries segment-count metadata into per-action decisions so the UI can distinguish exact selected-variant counts from runtime-only verification.
- Empty finite HLS media playlists are blocked for merge/remux and remain playlist-file-only. Master playlists whose selected variant cannot be counted in the background remain conditionally allowed only because the runtime merger still validates and counts the selected media playlist before fetching segments.
- Large HLS segment counts are surfaced as risk flags instead of hard-blocked, reducing false blocks while making expensive downloads clearer.
- Detailed report/page-scan handling no longer treats every separate-audio master playlist as unsupported when a self-contained variant is visible.

## v3.6.18 deeper evidence-based allow-list pass

- Added an evidence model to allow-list decisions. Direct-file actions can now expose evidence level and evidence flags such as URL extension, response MIME, attachment filename, content-disposition attachment, DOM media source, response size, and media duration.
- Reduced false blocking for URLs with unhelpful or generic paths. A URL like `/download?id=123` or `/asset.m4s?token=...` can be allowed as a final media file when response headers provide a safe media filename or MIME evidence, instead of being blocked solely by URL shape.
- Added attachment-filename inference. `Content-Disposition: attachment; filename=movie.mp4` can classify an `application/octet-stream` response as final MP4 media, while still respecting the user’s enabled file-type settings.
- Kept stream-component safety strict. Attachment/MIME evidence only creates a direct top-level Chrome Download path; it does not allow signed HLS components, playlist-associated segments, encrypted stream internals, or merge/remux reuse of protected URLs.
- Popup allow-list details now show evidence level, evidence flags, inferred extension, and method recommendations alongside existing confidence/risk/fallback information.
- HLS allow-list decisions now expose a recommended HLS method. Discontinuous or VOD-without-ENDLIST playlists recommend timestamp-fixed TS while still allowing Smart MP4 runtime fallback behavior where applicable.

## v3.6.19 deeper allow-list pass

- Added response-header evidence to media items: `Content-Range`, `Accept-Ranges`, `Content-Encoding`, and safe byte-total hints are now retained as bounded metadata.
- Range-probed final files are no longer falsely blocked solely because the URL looks like a segment. A segment-shaped URL can be allowed as a direct final-media download when headers prove a normal media file, such as `Content-Range: bytes 0-.../large-total` with `Content-Type: video/mp4`.
- Added codec-aware HLS policy decisions for the built-in MP4 remuxer. Forced MP4 remux is blocked when a selected variant explicitly advertises codecs outside the local H.264 + AAC MPEG-TS remux support, such as HEVC, VP9, AV1, AC-3, E-AC-3, Opus, FLAC, or MPEG audio.
- Smart MP4 remains allowed for those incompatible HLS variants, but is marked conditional/limited with a recommended timestamp-fixed TS fallback instead of pretending MP4 remux is high-confidence.
- Popup allow-list details can now surface range-response evidence and codec-related risk flags, improving transparency without allowing signed/protected HLS component reuse.

## v3.6.20 header-aware allow-list refinement

- Added MIME/header conflict resolution to the detailed allow list. Media Scout now compares URL extension, response MIME type, `Content-Disposition` filename hints, DOM media evidence, range headers, response size, and duration before choosing a download action.
- Reduced false blocking for misleading URLs. A URL such as `/poster.jpg` or `/download?id=123` can be allowed as a final video/audio download when the server clearly responds with an allow-listed final media MIME or filename.
- Reduced false allowing for misleading URLs. A URL such as `/video.mp4` or `/playlist.m3u8` that responds with `text/html` is now blocked as a likely web page, login page, or error page rather than being trusted by extension alone.
- File-type settings remain authoritative for the selected evidence path. If the policy chooses an attachment filename or MIME-inferred extension, that inferred extension must still be enabled by the user.
- Allow-list details now expose `extension-mime-conflict`, `non-media-response-mime`, and related evidence/risk flags so users can see why the policy chose a safer action.

## v3.7.6 deepest inspection pass

- Tightened detailed HLS playlist truth: detailed scan no longer treats audio-only or video-only variants as self-contained complete output. Only variants with both video and audio codec evidence, or codec-unknown variants without a separate audio group, can satisfy the self-contained fallback check.
- Fixed legacy-scan status reporting so a successful legacy fallback, or a scan that actually ingests media items, does not falsely render as a blocked scanner state in the popup/side panel.
- Made Inspector candidate grouping and sorting use the current HLS output setting, so capability order reflects the selected method rather than a stale default.
- Removed unreachable planned HLS mode constants from the page content-script runtime copy; planned modes remain guarded in shared settings/message validation for migration and fail-closed safety.
- Added regression coverage for detailed-scan self-contained HLS variant classification.


### v3.7.8 options save fix

The options page now saves complete settings payloads correctly. The previous validator accepted small setting patches but rejected the full `enabledFileTypes` registry submitted by the options UI, so clicking **Save settings** could fail with an invalid-message response. v3.7.8 validates full registry payloads while still rejecting unknown file-type keys and non-boolean values.

## v3.7.9 deepest inspection pass

This pass closes three cross-surface mismatches that could make the extension feel working while the runtime would later disagree.

- Stale media evidence is now blocked before any Download/Convert action in the popup, side panel, and service-worker queue path. Expired snapshots show **Rescan current page** instead of a working-looking CTA.
- Frontend Download/Convert decisions now recompute the allow-list from the current Options settings. If a file type is disabled after detection, the popup and Inspector update to an unsupported/limited state instead of allowing a doomed click.
- Hard rescan now cleans up the previous content-script observers, timers, runtime message listener, page overlay, active page-context HLS handles, and event listeners before reinjection, preventing duplicate mutation/resource observers and duplicate runtime message handlers after repeated rescans.
- The tab media store now preserves detector-provided policy summaries instead of replacing them with a default-settings summary.
- Self-tests cover stale snapshot blocking and Options-aware CTA policy recomputation.



## v3.7.10 deeper HLS safety and queue UX pass

- HLS master playlists with `EXT-X-MEDIA:TYPE=AUDIO` are now treated as separate-audio masters even when the audio rendition has no `URI` and is referenced only by a variant `AUDIO="..."` group. Built-in MP4/TS outputs stay blocked unless a visible self-contained variant exists.
- Background HLS inspection now marks URI-less separate-audio masters as unsupported before the user clicks Convert, keeping popup, side panel, queue, and runtime policy aligned.
- Runtime page-context HLS merging now fails closed for URI-less separate-audio masters instead of choosing a video-only variant and producing incomplete output.
- HLS strategy selection no longer falls back to a separate-audio variant when a self-contained variant is required but unavailable.
- Queue retry feedback now explains when a restored or unsafe task cannot be retried and should be rescanned from fresh evidence.
- Regression self-tests now cover URI-less separate-audio HLS masters.
