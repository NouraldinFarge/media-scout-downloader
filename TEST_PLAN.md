# v3.7.10 deepest inspection pass

Latest regression focus: stale snapshot action blocking, current Options-aware CTA state, and hard-rescan content-script cleanup.

- Blob URL downloads now keep their required page-context strategy and cannot be reordered behind generic direct-file downloads by diagnostics learning.
- DASH remains a manifest-only strategy and cannot fall through to a false direct-video path.
- External-helper notes now use single-quoted shell escaping for playlist URLs and suggested filenames, reducing accidental shell interpolation if a user copies the example command.
- Added regression coverage for strategy ordering: blob page-context, DASH manifest-only, and diagnostics-prioritized HTTP direct media.

# Media Scout Downloader Test Plan

## 1. Manifest and install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load the unpacked `media-scout-downloader/` directory.
4. Confirm Chrome reports no manifest errors.
5. Open the service worker inspector and confirm no startup exceptions.

Expected: extension loads with Manifest V3 service worker and icons.

## 2. Active-tab DOM detection

1. Create a local HTML page containing:
   - `<video src="sample.mp4" controls>`
   - `<audio src="sample.mp3" controls>`
   - `<video><source src="sample.webm" type="video/webm"></video>`
2. Open the page in Chrome.
3. Open the popup.

Expected: MP4, MP3, and WebM rows appear, grouped by video/audio, with hostname, file type, and download buttons.

## 3. Network request detection

1. Open the popup on a normal HTTP(S) test page.
2. Click **Grant active site access**.
3. Refresh the page and play media.
4. Reopen/rescan popup.

Expected: future active-tab media network requests are detected when they match supported file extensions or response content types.

## 4. Unsupported protected URLs

1. Test a URL such as `https://example.com/video.mp4?signature=abc&expires=123`.
2. Add it as a source in a test page.
3. Open the popup.

Expected: item is marked unsupported with signed/expiring URL explanation; Download is disabled.

## 5. HLS non-encrypted playlist

1. Host a same-origin `.m3u8` playlist without `#EXT-X-KEY`.
2. Add it as a source or make it load through the page.
3. Open popup.

Expected: HLS item appears, variants are counted if present, and Convert uses the selected HLS output method: Smart MP4 / MP4 remux, timestamp-fixed TS, raw TS concat, M3U8 playlist-only, or external-helper notes. It must not report playlist-only/helper actions as segment merge, and it must stop on encryption, CORS/auth, signed/expiring components, or unsupported layouts.

## 6. HLS encrypted playlist

1. Host a same-origin `.m3u8` playlist with `#EXT-X-KEY:METHOD=AES-128`.
2. Open popup.

Expected: item is marked Encrypted/Unsupported; no decryption or segment merge is attempted.

## 7. DASH DRM manifest

1. Host a same-origin `.mpd` file containing `<ContentProtection>`.
2. Open popup.

Expected: DASH item is marked manifest-only. The MPD file itself may be saved as evidence/text through a normal Chrome download, but no segment fetching, merging, decryption, or video-download CTA is offered.

## 8. Cross-origin playlist parsing

1. Reference a `.m3u8` or `.mpd` from another origin.
2. Open popup.

Expected: extension shows a warning. HLS may merge only if the page/frame can fetch the playlist and all MPEG-TS segments through normal CORS/access rules. DASH may save only the manifest file itself through a normal Chrome download.

## 9. Queue concurrency

1. Set max parallel downloads to 1.
2. Start multiple downloads.
3. Repeat with max parallel downloads set to 3 and 6.

Expected: active downloads never exceed the configured limit; queued, active, completed, failed, retried, and canceled states render.

## 10. Retry behavior

1. Use a temporarily unavailable direct media URL.
2. Start download.

Expected: normal network failures may retry. DRM, encrypted, permission, access-control, CORS, signed URL, authentication, and unsupported failures do not retry automatically.

## 11. Filename sanitization

1. Open a tab with title `CON: Bad / Name * Test`.
2. Download multiple MP4 files.

Expected: filenames are safe, reserved names are avoided, extension is correct, and counters are appended.

## 12. Options page

1. Disable MP4.
2. Save settings.
3. Rescan a page with MP4.

Expected: MP4 items are filtered out.

Then test max parallel downloads, filename template, preferred subfolder, duplicate behavior, debug logs, notifications, cache clear, reset learning data, and self-tests.

## 13. Privacy checks

1. Inspect `chrome.storage.local` from the service worker console.
2. Confirm diagnostics contain only strategy names, success/failure counts, generic error categories, and timestamps.
3. Confirm no full URLs are stored in diagnostics.

Expected: no telemetry or upload behavior exists.

## 14. UI accessibility

1. Use keyboard Tab and Enter in popup and options.
2. Inspect contrast in Chrome DevTools.
3. Resize options page.

Expected: visible focus rings, disabled states, readable contrast, responsive layout, and no dynamic `innerHTML` rendering for media rows.

## 15. Diagnostic report ZIP

1. Open a page with no detected media and click the popup report/document icon.
2. Save the generated ZIP.
3. Open `summary.md`, `page-scan.json`, `decision-log.json`, `detected-media.json`, and `extension-state.json`.

Expected: the ZIP opens successfully and explains active tab details, permission status, accessible-frame coverage, iframe inventory, DOM media elements, page-embedded media URL literals, media-looking and interesting performance entries, accepted/rejected candidates, queue state, diagnostics, and likely reasons a visible video may not have appeared.

4. Repeat on a page with a `blob:` video, a signed media URL, an iframe-based player, a media URL literal inside an inline script, and a same-origin HLS playlist.

Expected: blob URLs are marked page-local, signed/tokenized URLs are explained as unsupported, and HLS/DASH protection decisions appear in the report without any bypass attempt.

5. Inspect the service worker storage after generating a report.

Expected: the report is not stored in `chrome.storage.local`; diagnostics still contain only strategy names/counts/error categories and timestamps.


## Filename title extraction

- Open a page whose tab title includes `《大东北之你要下岗我涨薪》`.
- Download a detected MP4 using the default template.
- Expected result: Chrome proposes/saves `大东北之你要下岗我涨薪.mp4`.
- Download a second item from the same tab.
- Expected result: the filename uses the same bracket title plus the normal counter, for example `大东北之你要下岗我涨薪 (1).mp4`.
- Change the template to `{rawTabTitle}.{extension}` and verify the full tab title is used after sanitization.


## 16. MSE/blob and Resource Timing detection

1. Open a page where the visible `<video>` element has a `blob:` currentSrc and the player loads `.m3u8` or `.mpd` resources.
2. Start playback, open the popup, and click Rescan.
3. Generate a report ZIP.

Expected: the popup/report show the blob video element as unsupported with an MSE explanation, and media-looking Resource Timing entries such as variant `.m3u8` playlists appear as detected candidates or report clues. Cross-origin playlists remain unsupported unless they can be handled without bypassing normal browser security.


## 15. Warning-only cross-origin playlist behavior

1. Open a page that exposes a cross-origin `.m3u8` or `.mpd` URL through a visible player or Resource Timing.
2. Generate a report and inspect `detected-media.json`.
3. Click Download on the playlist/manifest item.

Expected: the item is not marked protected solely because it is cross-origin. The popup shows a warning. For HLS, the extension may attempt non-encrypted MPEG-TS segment merge using normal page fetch rules; it must stop on CORS/access-control/auth/encryption failures. Chrome may save the `.m3u8`/`.mpd` file itself as fallback. The extension must not decrypt media or retry access-control failures.


## 17. Non-encrypted HLS MPEG-TS segment merge

1. Host a VOD HLS media playlist with several unencrypted `.ts` segments and no `#EXT-X-KEY`, `#EXT-X-MAP`, `#EXT-X-BYTERANGE`, or DRM markers.
2. Open a page that loads the playlist, open the popup, and click Download.

Expected: Media Scout fetches the playlist and segments from the content script frame using normal browser fetch rules, concatenates the segments, and prompts/saves a single `.ts` file.

3. Add `#EXT-X-KEY:METHOD=AES-128` to the playlist and repeat.

Expected: merge stops immediately with an encrypted HLS explanation; no decryption or merge attempt is made.

4. Test a playlist that uses fMP4 `#EXT-X-MAP`, byte ranges, or more than the configured safe segment/memory limits.

Expected: Media Scout reports a clear unsupported-layout reason and does not attempt unsafe reconstruction.

5. Test a cross-origin playlist without CORS headers or one requiring authentication.

Expected: merge fails with CORS/auth/access-control wording and does not bypass browser restrictions.

## 18. Progress bar and MP4 remux

1. Open a page that exposes an unencrypted HLS VOD playlist using MPEG-TS `.ts` segments with H.264 video and AAC audio.
2. Click Download in the popup.

Expected: the media card shows a progress bar. It advances through playlist parsing, segment fetching, remuxing, saving, and completion. The saved file should prefer `.mp4` when compatible.

3. Open the saved MP4 in Chrome, VLC, or another standards-compliant player.

Expected: the file plays without requiring decryption or network access. The popup completed entry says it was remuxed to MP4 and lists the segment count.

4. Repeat with an otherwise legal MPEG-TS HLS stream that uses an unsupported codec or lacks SPS/PPS metadata.

Expected: Media Scout shows a remux fallback reason and saves a `.ts` fallback rather than pretending conversion succeeded.

5. Repeat with encrypted HLS, a CORS-blocked segment, an authenticated segment, fMP4 `#EXT-X-MAP`, byte ranges, or DASH.

Expected: the task stops or falls back safely with a clear explanation. It must not decrypt, bypass CORS, reuse tokens, or defeat access controls.


## 19. Manual .m3u8-to-MP4 converter

1. Open a page that can normally access an unencrypted HLS VOD playlist.
2. Enable the manual HLS route in Options → General, open Side Panel → Inspector, and paste the playlist URL into **Manual HLS validation**.
3. Click **Convert**.

Expected: a manual HLS item appears in the side-panel Inspector, the task enters the queue, the progress bar advances through playlist parsing, segment fetching, remuxing, saving, and completion, and a compatible H.264/AAC MPEG-TS stream saves as `.mp4`.

4. Repeat with a master playlist.

Expected: Media Scout selects the configured HLS variant preference (highest by default), then remuxes compatible MPEG-TS segments to `.mp4`.

5. Repeat with encrypted HLS, fMP4 `#EXT-X-MAP`, byte ranges, unsupported codecs, a URL that is not `.m3u8`, a CORS-blocked playlist, and an authenticated playlist.

Expected: the task fails closed with a clear message or falls back only to a lawful `.ts` output for unsupported-but-fetchable remux cases. It must not decrypt, bypass CORS, reuse tokens, bypass authentication/paywalls, or defeat access controls.


## Detected HLS auto-MP4 behavior

1. Open a page that exposes a non-encrypted MPEG-TS `.m3u8` playlist with H.264/AAC segments.
2. Confirm the popup groups the item under **HLS playlists → MP4** and the primary action reads **Download MP4**.
3. Click **Download MP4**.
4. Confirm the progress phases include segment fetching, remuxing, saving, and completed.
5. Confirm the saved filename ends in `.mp4`.
6. Test an unsupported HLS playlist, such as fMP4, byte-range, encrypted, or CORS-blocked HLS. Confirm the task fails with a clear reason and does not save an `.m3u8` playlist or `.ts` fallback.

## All-tabs progress panel and parallel HLS segments

1. Open a page with a compatible non-encrypted HLS MPEG-TS playlist and start an MP4 download.
2. While the task is fetching segments, switch to a different tab and open the popup again.
3. Confirm the **Queue** route still shows the active task, progress bar, current phase, and segment counts even though the current tab is different.
4. Set **HLS segment parallelism** in Options to 1, repeat the download on a small test playlist, then set it to 4 and repeat.
5. Confirm progress details mention the configured parallel worker count and that the output media remains in the correct playback order.
6. Repeat with encrypted HLS, CORS-blocked HLS, fMP4 `#EXT-X-MAP`, byte-range HLS, and unsupported codecs.

Expected: normal, compatible playlists fetch faster with multiple parallel segment requests and save as MP4. Unsupported/protected playlists fail with a clear reason and no bypass behavior.

## Regression test: long HLS MP4 remux stack safety

1. Open a page with a long, non-encrypted MPEG-TS HLS playlist that produces many audio/video samples.
2. Start playback, open the popup, and click **Download MP4** on the detected `.m3u8` item.
3. Confirm segment fetching reaches 100% and the task proceeds through **remuxing / Writing MP4 boxes** without `Maximum call stack size exceeded`.
4. Confirm the task either saves a playable MP4 or fails with a specific unsupported-stream reason. It should not fail with a JavaScript call-stack overflow.
5. Generate a report after the run and confirm any failure category is specific, not `mp4-remux-failed` caused by `Maximum call stack size exceeded`.


## v2.2 regression checks

1. Load a long non-encrypted HLS stream with more than 1,000 MPEG-TS segments.
2. Set HLS segment parallelism to 8, 12, and 16 in separate runs.
3. Confirm the popup remains responsive and progress updates do not flood the UI.
4. Confirm fetched segments are preserved in playlist order before MP4 remuxing.
5. Confirm retry count appears when transient segment fetches fail and are retried.
6. Confirm hard-stop categories still stop safely: DRM/EME, `#EXT-X-KEY`, auth, paywall, permission denial, and persistent CORS/access-control failures.
7. Confirm media cards show richer details such as duration, resolution, resource timing, frame host, and HLS variants when visible to the extension.
8. Confirm warnings/errors are collapsed by default and expand with keyboard/mouse interaction.

## v2.3 regression checks

- Start a long non-encrypted HLS download and verify retry counts increase once per retry, not twice.
- Confirm popup progress remains smooth while the job fetches hundreds of segments.
- Close and reopen the popup during an active job; the Queue route should still show current progress.
- Generate a report after a completed job and verify `extension-state.json` contains `persistedQueueHistory` without raw media URLs.
- Generate a report on an HLS page and verify `page-scan.json` includes `playlistProbes` when normal page fetch rules allow playlist metadata probing.
- Confirm encrypted HLS, DRM/DASH ContentProtection, CORS, authentication, paywall, signed URL, and unsupported fMP4/byte-range cases still fail safely.


## v2.4 registry coverage tests

1. Open a page with direct video/audio files and verify MP4, WebM, MOV, MP3, M4A, WAV, Ogg, FLAC, MKV, AVI, and similar direct links are grouped under Video files or Audio files.
2. Open a page with HLS/DASH manifests and verify `.m3u8` appears as HLS → MP4 and `.mpd` appears as a DASH manifest.
3. Open a page with `<track>` subtitles and verify `.vtt`/`.srt` files appear under Subtitles, captions, and tracks.
4. Open a page with `video[poster]`, OpenGraph image metadata, or responsive image sources and verify posters/thumbnails appear under Posters, thumbnails, and images.
5. Verify stream fragments such as `.ts` and `.m4s` are grouped as Stream internals / segments instead of being presented as final videos.
6. Generate a report and confirm `media-type-registry.json` is present and `summary.md` contains popup item group counts.
7. Disable a file type in Options, rescan, and confirm matching candidates are no longer accepted into the popup list.
8. Confirm warnings/errors are collapsed by default in the popup and still expandable.
9. Confirm DRM/encrypted/auth/CORS/access-control failures still fail safely and are not retried as bypass attempts.

## v2.5 regression checks

- Open a page with many detected segments/images and verify each popup category is collapsible.
- Verify warnings and unsupported explanations are collapsed by default.
- Open a page where the visible player uses `blob:` plus an HLS playlist in Resource Timing. Confirm the blob video card offers a linked HLS→MP4 action instead of only showing an unavailable blob message.
- Convert a non-encrypted MPEG-TS HLS stream and verify MP4 output includes video samples, audio sample metadata when present, and estimated FPS in the completed download details.
- Verify the remuxer refuses likely broken black/still MP4 output when video sample density is implausibly low for a long playlist.
- Verify the Options page file-type filter, presets, grouped collapsible controls, and save action all work.


## v2.6 regression checks

- Download a long non-encrypted MPEG-TS HLS stream and confirm the saved MP4 starts on a real keyframe rather than a black/still frame.
- Confirm reports include recent remux stats after completion, including video sample count, audio sample count, keyframe count, FPS, durations, and remux warnings.
- Confirm unsupported audio codecs such as AAC LATM/LOAS, AC-3/E-AC-3, and MPEG audio fail with a clear unsupported-codec message instead of silently saving a no-audio MP4.
- Restart the browser/service worker after a completed HLS job, then generate a report and confirm persisted queue history was not overwritten by an empty queue.



## v2.7 regression checks

- Verify the Options page saves Default HLS output method and Processing impact.
- Verify each HLS popup card has its own method dropdown.
- Verify MP4 remux queues an .mp4 job.
- Verify Fast TS concat queues and saves a .ts job without running the MP4 remuxer.
- Verify Playlist only saves the .m3u8 file.
- Verify planned modes fail quickly with a clear unsupported explanation.
- Verify Gentle mode caps segment concurrency lower than Fast mode and keeps popup progress responsive.

## v2.8.0 regression checks

1. Open the popup on a normal HTTPS video page. Confirm a single startup status appears and the popup does not flicker/glitch.
2. Open a video page with cross-origin iframes. Confirm the status says the top frame scanned even if all-frame scanning is limited.
3. Start playback, click Rescan, and verify detected items update without closing/reopening the popup.
4. Keep an HLS download running, switch tabs, reopen the popup, and confirm global progress still renders.
5. Simulate old queue/settings state in `chrome.storage.local` and confirm the popup shows a recoverable status instead of a blank UI.


## v2.9 regression checks

- Open an iframe-heavy HLS page that previously exposed a blob video and HLS `.m3u8` resources.
- Open the popup before playback starts; confirm the scanner status appears and does not glitch.
- Start playback and wait a few seconds; confirm follow-up/resource-triggered scans surface the HLS item.
- Click Rescan; confirm the broad all-frame scan, top-frame scan, and legacy fallback can all run without blanking the popup.
- Generate a report and verify detected media, page scan, and decision log still include HLS/blob/MSE clues.


## v3.0 popup and detection stabilization

- Rebuilt the popup into a simpler state-driven interface with clear health/status messaging.
- Added separate **Scan now** and **Hard rescan** actions. Hard rescan clears the active tab cache, resets the injected scanner flag, reinjects the scanner, and performs multiple scan passes to catch late-loading iframe/MSE/HLS resources.
- Added **Refresh + reload**, which reloads the active page with cache bypass, requests a Chrome extension update check when available, then calls `chrome.runtime.reload()`. For unpacked installs this reloads the extension from disk; Chrome still requires the user to enable the extension for incognito before any incognito popup button can run.
- Kept all media categories collapsible and preserved the global all-tabs download progress panel.
- Added render recovery so a malformed stored task/media item should not blank the popup.


## v3.1 regression test

- Start a non-encrypted HLS `.m3u8` job in TS concat and MP4 remux modes. Confirm segment fetching begins without `work is not defined` and progress advances past the first segment window.
- Generate a report after a failed network segment and confirm the failure is a real fetch/CORS/timeout error, not an internal reference error.


## Regression: popup HLS method control

1. Open a page with detected HLS items.
2. Open the popup and expand HLS playlists.
3. Open the Method menu and choose Fast TS concat, Playlist only, then MP4 remux.
4. Verify the popup remains open and the action button label updates without restarting detection.
5. Repeat in the manual .m3u8 converter method menu.


## v3.3 regression checks

1. Open the popup and press the HLS MP4 / TS / Playlist buttons; verify the popup does not close or blank.
2. Use the manual .m3u8 converter and toggle MP4 / TS / M3U8 segmented buttons; verify no native dropdown appears.
3. Download a long non-encrypted MPEG-TS HLS stream as MP4; verify progress reaches remuxing and the output contains non-zero video samples/keyframes.
4. If MP4 remux is not playable, download TS from the same card and compare report remux stats.


## v3.4 stabilization update

This build adds Smart MP4 routing, Timestamp-fixed TS fallback, raw TS concat labeling, and an external-helper instruction export. The popup now avoids dropdowns and popup menus for HLS actions; each HLS card uses direct buttons: Smart, MP4, Fixed TS, Raw TS, M3U8, and Helper. Smart MP4 first tries the in-browser MP4 remuxer for compatible non-encrypted MPEG-TS HLS and then falls back to Timestamp-fixed TS instead of raw byte concatenation when the browser-only remuxer cannot produce a validated MP4.

Timestamp-fixed TS is a browser-side fallback that rewrites continuity counters and rebases obvious PCR/PTS/DTS timestamp resets while preserving normal browser access boundaries. It is safer than raw TS concat for desync-prone streams, but it is not a full native FFmpeg replacement. fMP4/CMAF assembly, separate audio/video HLS muxing, DASH assembly, and visible-player recording remain explicit planned/unsupported modes unless a future native or bundled worker muxer is added.


## v3.5 popup stability and manual converter visibility

- The popup was rebuilt around direct action buttons and a single guarded action path so scan, hard rescan, report generation, page refresh/reload, and media downloads do not interrupt each other.
- Native popup dropdowns and popup menus are not used in the popup. HLS actions are direct buttons on each detected HLS card.
- The optional manual `.m3u8` converter is hidden by default. Enable **Show manual .m3u8 converter in Side Panel → Inspector** from Options when manual URL entry is needed.
- Detected-media categories remain collapsible, while warnings/details remain collapsed by default.

## v3.6 episode batch tests

1. Open a page with a numbered episode URL such as `/play/39018009-2-1`.
2. Confirm the popup shows an Episode batch section when same-series links are visible on the page.
3. Confirm the active episode appears as current.
4. Confirm the list is sorted numerically by episode number.
5. Click Refresh episode list and verify the list refreshes without closing/glitching the popup.
6. Click Download all found and grant same-origin site access when Chrome prompts.
7. Confirm episode pages open in inactive tabs up to the configured Episode page scan parallelism.
8. Confirm each episode queues at most one primary HLS/video item and queue jobs respect Max parallel downloads.
9. Confirm failures are reported per episode instead of stopping the whole batch.
10. Confirm the feature does not probe or generate episode URLs that were not found in page-visible links/data.

## v3.6.1 improvement-pass tests

### Privacy-safe queue persistence
1. Queue and complete at least one media download whose filename and source host are recognizable.
2. Open DevTools for the extension service worker and inspect `chrome.storage.local.get(['mediaScout.queueHistory'])`.
3. Expected: persisted queue history contains counts and coarse task metrics only; it does not include full URLs, page URLs, hostnames, `filename`, or `outputFilename` fields.
4. Click **Clear queue history** in Options.
5. Expected: `mediaScout.queueSummary` and `mediaScout.queueHistory` are removed.

### HLS cancellation
1. Start a large non-encrypted MPEG-TS HLS download.
2. Click Cancel while segments are still fetching.
3. Expected: progress stops, the task moves to Canceled, segment fetches abort, and no final object URL download is triggered after cancellation.

### Direct download cancellation
1. Start a large direct HTTP(S) media download.
2. Click Cancel after Chrome returns a download id.
3. Expected: Chrome cancels or interrupts the download and the queue marks the task as Canceled.

### Episode batch tab cleanup
1. Start a same-series episode batch download.
2. Wait for queued jobs to complete, fail, or be canceled.
3. Expected: inactive episode tabs opened by the batch helper are closed after each related task settles.

### Permission controls
1. Open Options and click **Grant network detection for all sites**.
2. Expected: a confirmation appears before Chrome's permission prompt.
3. Grant the permission, then click **Revoke all-site network detection**.
4. Expected: the optional all-site host permission is removed.

### Message validation ownership
1. Start an HLS task and send a malformed `DOWNLOAD_PROGRESS` message from DevTools or a mismatched tab/frame.
2. Expected: the service worker rejects the update and does not mutate the task progress.

## v3.6.2 second-pass tests

### Redacted reports by default
1. Leave **Allow full URLs in diagnostic reports after confirmation** disabled in Options.
2. Generate a popup report.
3. Expected: the ZIP filename starts with `media-scout-redacted-report-`, README says URLs are redacted, and JSON files do not contain full media/page URLs.
4. Enable the Options setting, generate another report, and accept the popup confirmation.
5. Expected: the ZIP filename starts with `media-scout-full-report-` and full URLs are present only in this explicitly allowed report.

### Queue retention
1. Set Queue history retention to **Do not persist queue history** and save.
2. Complete a download.
3. Expected: `mediaScout.queueHistory` and `mediaScout.queueSummary` are removed or remain absent from `chrome.storage.local`.
4. Set retention to 1/7/30 days and complete a download.
5. Expected: privacy-safe queue history is stored with an `expiresAt` timestamp.

### HLS object URL handoff
1. Complete a small non-encrypted HLS download as Smart/MP4 or fixed TS.
2. Expected: the browser download starts successfully; cleanup does not revoke the generated object URL before Chrome accepts the download.

### Source-tab closure
1. Start an HLS download from a tab, then close that source tab before completion.
2. Expected: the related task moves to Canceled with a source-tab-closed error and no hidden/background tab remains.

### Direct-download watchdog
1. Start a direct HTTP(S) download and cancel it from Media Scout.
2. Expected: Chrome receives a cancel request and the queue marks the task Canceled.
3. Test a deliberately stalled large download if available.
4. Expected: the task fails with an idle-timeout/network error instead of remaining active forever.

## v3.6.3 third-pass tests

### HLS variant preference
1. Open Options and set **Default HLS variant** to **Highest bandwidth / quality**.
2. Open a page with a non-encrypted master `.m3u8` playlist containing multiple variants.
3. Start a Smart MP4 download.
4. Expected: the highest-bandwidth variant is selected and the completed queue details include the selected resolution/bandwidth when available.
5. Repeat with **Lowest bandwidth / smaller file**.
6. Expected: the lowest-bandwidth variant is selected, the estimated size risk is lower, and normal DRM/encryption/CORS/auth boundaries still stop safely.

### Episode batch hardening
1. Open a page whose URL ends with a numbered episode path and discover a same-series batch.
2. Start **Download all found** from the popup.
3. Expected: same-origin URLs matching the active page's episode pattern queue normally.
4. From the service worker console or a temporary test harness, send `START_EPISODE_BATCH_DOWNLOADS` with mixed URLs: a valid same-series URL, a cross-origin URL, a javascript/data URL, and a same-origin but non-matching path.
5. Expected: only the valid same-series URL is considered; unsafe or non-matching URLs are ignored and no arbitrary background tabs are opened.

### Message validation regression
1. Run Options → **Run self-tests**.
2. Expected: all self-tests pass, including HLS variant preference preservation and unsafe episode URL rejection.

## v3.6.4 fourth-pass tests

### Queue cancel controls
1. Start a large direct download or HLS task.
2. Open the popup and confirm the related media card and Queue card show **Cancel**.
3. Click **Cancel**.
4. Expected: direct downloads receive a Chrome cancel request; HLS tasks receive a content-script cancel; the task moves to Canceled without completing a final save.

### Pending batch tab cleanup
1. Set Max parallel downloads to 1.
2. Start an episode batch with at least three detected episodes.
3. Cancel a queued/pending episode task before it starts.
4. Expected: the inactive tab opened for that pending episode is closed and the queue marks the task Canceled.

### Clear finished queue
1. Complete, fail, or cancel at least one task.
2. Click **Clear finished** in the Queue route.
3. Expected: completed, failed, and canceled entries disappear from the popup queue, active/pending jobs remain, and persisted privacy-safe queue history no longer contains the cleared settled entries.

### Large episode batch confirmation
1. Open Options and set **Confirm episode batch above** to a low value such as 2.
2. On a page with more than two detected same-series episodes, click **Download all found**.
3. Expected: the popup asks for confirmation before opening background tabs.
4. Cancel the confirmation.
5. Expected: no background episode tabs are opened.

### Source-tab context guard
1. Scan a page with media, switch to another tab before clicking a stale popup download action if possible.
2. Expected: the service worker resolves the original source tab by id, or fails safely with a rescan message if that tab no longer exists.

### Message validation regression
1. Run Options → **Run self-tests**.
2. Expected: all self-tests pass, including queue-clear message validation and episode-batch confirmation threshold clamping.

## v3.6.5 fifth-pass tests

### Queue pause/resume
1. Open a page with several downloadable HLS/video items.
2. Click **Pause queue** in the Queue route.
3. Queue multiple downloads.
4. Expected: currently active downloads continue, but newly queued/pending jobs do not start while paused.
5. Click **Resume queue**.
6. Expected: pending jobs begin according to the configured Max parallel downloads limit.

### Duplicate start suppression
1. Click the same media item's same HLS/action button several times quickly.
2. Expected: only one active or queued task for that media/method appears, and the popup warns that the item is already active or queued.
3. Click a different HLS method for the same media item.
4. Expected: the different method may queue as a distinct task.

### Retry eligibility
1. Trigger a normal retryable network failure and confirm the failed queue card offers **Retry**.
2. Trigger or simulate a non-retryable failure category such as DRM, encrypted, signed/expiring URL, paywall, permission, CORS, or user-canceled.
3. Expected: the failed queue card does not show **Retry**.

### Self-tests
1. Run self-tests from Options.
2. Expected: all self-tests pass, including pause/resume queue message validation.

## v3.6.6 sixth-pass tests

1. Open Options and verify Default HLS output method only shows implemented choices: Smart MP4, MP4 remux, Timestamp-fixed TS, Raw TS concat, Save playlist only, and External helper handoff.
2. Simulate or manually save an old planned HLS mode value in `chrome.storage.local`; reload Options and verify it falls back to Smart MP4.
3. Open a normal http(s) media page without site permission. The popup should show Limited network detection plus a Grant current site button.
4. Click Grant current site, accept the Chrome prompt, and verify the popup rescans and the limited-access notice disappears.
5. From DevTools or a temporary test harness, send `REQUEST_SITE_ACCESS` for an origin that does not match the active tab. Verify the request is refused and Chrome does not prompt for the unrelated origin.
6. Run self-tests and verify all tests pass.

## v3.6.7 message-source hardening regression tests

1. Load the extension unpacked and open the popup on a normal http(s) media page. Verify scanning, current-site permission grant, direct download, HLS download, queue pause/resume, cancel, retry, and redacted report generation still work from the popup.
2. From a content-script debugging context, attempt to send privileged messages such as `START_DOWNLOAD`, `GENERATE_REPORT`, `REQUEST_SITE_ACCESS`, `REQUEST_ALL_SITE_ACCESS`, `SETTINGS_SAVE`, and `START_EPISODE_BATCH_DOWNLOADS` directly to the background.

Expected: background replies with `Message source is not allowed for this action.` and performs no privileged work.

3. Confirm content-script `DOM_MEDIA_FOUND` updates and `DOWNLOAD_PROGRESS` still work, but progress from the wrong tab/frame is ignored.

## v3.6.8 navigation-scope and scan-payload hardening tests

### Navigation cleanup
1. Open a normal http(s) media page, open the popup, and verify detections appear.
2. In the same tab, navigate to a different page or domain without closing the tab.
3. Expected: stale detections are cleared, the tab is removed from network-detection scope until the user scans again, and the popup shows a rescan/new-page message instead of old media.
4. Navigate using only a URL hash change on the same document, such as adding `#section`.
5. Expected: detections are not cleared for a hash-only same-document navigation.

### Page-context task cancellation on navigation
1. Start a long HLS merge or blob-backed page download.
2. Before it completes, navigate the source tab to a different document.
3. Expected: the page-context task is canceled with a source-tab/navigation message, in-flight HLS work is aborted, and no final page-context save occurs.
4. Start a direct Chrome download, then navigate the source tab.
5. Expected: the direct Chrome download is not canceled solely because the page navigated.

### DOM scan payload bounds
1. From a controlled content-script test context, send `DOM_MEDIA_FOUND` with a normal item such as `https://example.com/video.mp4`.
2. Expected: the message validates and the item can be ingested normally.
3. Send `DOM_MEDIA_FOUND` with an oversized URL or oversized string fields.
4. Expected: message validation rejects the oversized payload before ingestion.
5. Run Options → **Run self-tests** and verify all tests pass, including bounded DOM scan item validation.

## v3.6.9 queue-history privacy and restart-recovery tests

### Privacy-safe persisted progress/error text
1. Start and complete an HLS or direct download whose output filename would normally appear in progress text.
2. Inspect `chrome.storage.local` for `mediaScout.queueHistory`.
3. Expected: persisted queue history does not contain the output filename, full media URL, frame URL, hostname, or raw progress detail text such as `Saved filename.mp4`.
4. Trigger or simulate a failure containing a URL or filename in the raw error message.
5. Expected: persisted history keeps only category/code/message-code style metadata, not the raw error string.

### Service-worker restart recovery
1. Queue multiple jobs, including at least one active or pending task.
2. Reload the extension service worker from `chrome://extensions` or by clicking the extension reload button while jobs are in flight.
3. Reopen the popup.
4. Expected: previously active/pending jobs appear as interrupted/canceled with a rescan-and-queue-again message instead of disappearing silently.
5. Expected: those restored interrupted jobs do not offer Retry because the privacy-safe history intentionally does not retain raw URLs/page context.

### Older history migration
1. Seed `mediaScout.queueHistory` with older-style progress details or last-error messages in a local test profile.
2. Reload v3.6.9 and open the popup.
3. Expected: the history is rewritten in the stricter privacy-safe format after it is read.

## v3.6.10 protected-HLS-component and settings-hardening tests

### HLS signed/tokenized component URLs
1. In a local test page, expose an `.m3u8` playlist whose playlist URL is clean but whose media segment URLs include query keys such as `signature=`, `token=`, `expires=`, `X-Amz-Signature=`, or `X-Goog-Signature=`.
2. Scan the page and start the HLS download.
3. Expected: Media Scout refuses the job with a signed/expiring HLS component error before fetching protected segments.
4. Repeat with a master playlist whose selected variant URL contains a protected query key.
5. Expected: the selected variant is refused before it is fetched.
6. Repeat with a same-origin playlist that the background inspector can read.
7. Expected: the popup marks the HLS item unsupported before download when the protected component is visible during inspection.

### Settings storage hardening
1. From the extension service worker console, try saving settings with an extra key, for example `unexpectedSetting: true`.
2. Expected: the message validator rejects the payload, or `mergeSettings()` drops the unknown key before storage.
3. Try saving an extremely long filename template or preferred subfolder.
4. Expected: values are clipped to safe lengths before being saved.
5. Run Options → **Run self-tests**.
6. Expected: all self-tests pass, including settings-key rejection and length-limit checks.

## v3.6.11 report-driven encrypted-playlist tests

### Report-driven encrypted HLS annotation
1. Open a page whose visible player uses an HLS playlist containing `#EXT-X-KEY` encryption markers.
2. Open the popup, scan the page, then generate a redacted report.
3. Expected: matching HLS playlist items in the report are marked `encrypted` or `unsupported` with a clear encryption reason instead of remaining warning-only detected items.
4. Expected: observed `.ts` segment items from the same encrypted HLS segment host are also marked protected so the popup does not encourage downloading encrypted stream internals.
5. Expected: the report's likely-reasons section explicitly mentions encrypted playlist probes.

### fMP4 and byte-range probe annotation
1. Test with an HLS media playlist containing `#EXT-X-MAP` and no encryption.
2. Expected: matching HLS items are marked unsupported for the current local MPEG-TS merger, with an fMP4/CMAF reason.
3. Test with an HLS media playlist containing `#EXT-X-BYTERANGE`.
4. Expected: matching HLS items are marked unsupported with a byte-range reason.

### Redacted report URL plural fields
1. Generate a redacted report from a page with HLS variants and many segments.
2. Inspect `page-scan.json` in the exported ZIP.
3. Expected: fields such as `variantUrls` and `segmentUrls` are redacted to hashed path summaries, not full raw URLs.
4. Run Options → **Run self-tests** and verify all tests pass.

## v3.6.12 download allow-list tests

1. Load the unpacked extension and run self-tests. Expected: the download allow-list tests pass.
2. On a page with a plain `.mp4`, `.mp3`, image, and subtitle URL, scan the page. Expected: each supported enabled type shows an allowed/downloadable action.
3. On a URL with `?token=`, `?signature=`, or `?expires=`, scan the page. Expected: the direct media button is disabled and the allow-list decision explains the signed/tokenized URL block.
4. On encrypted HLS, open the popup. Expected: Smart/MP4/Fixed TS/Raw TS are disabled, but **M3U8** is enabled when the top-level playlist URL itself is safe.
5. On fMP4/CMAF or byte-range HLS, open the popup. Expected: built-in merge buttons are disabled, **M3U8** remains enabled for the safe playlist file, and the decision explains that the built-in MPEG-TS merger does not support that layout.
6. On a DASH MPD with `ContentProtection`, scan the page. Expected: the MPD can be saved as a manifest file only; no segment download/merge is offered.
7. Confirm that a protected `.ts` segment from an encrypted HLS report remains disabled as a raw segment download.
8. Confirm that disabling a file extension in Options removes that extension from the effective allow list.

## v3.6.13 refined allow-list tests

### Signed top-level direct files
1. Serve a normal final media file with a signed-looking top-level URL, for example `/video.mp4?token=test` or `/audio.mp3?X-Amz-Signature=test`.
2. Scan the page.
3. Expected: the item is shown as downloadable/limited, not unavailable, and the direct Download button is enabled.
4. Start the download.
5. Expected: Media Scout passes the exact top-level URL to Chrome Downloads and does not attempt segment fetching, playlist parsing, or URL rewriting.

### Signed stream components stay blocked
1. Serve an HLS playlist whose top-level `.m3u8` URL is signed.
2. Expected: **M3U8** is allowed as playlist text, but Smart MP4 / MP4 / Fixed TS / Raw TS are blocked with a signed top-level playlist merge reason.
3. Serve an HLS playlist whose segment URLs are signed while the top-level playlist URL is clean.
4. Expected: all HLS merge/remux actions are blocked before protected segments are fetched.
5. Serve a standalone `.ts?token=test` segment.
6. Expected: raw segment download is blocked because stream components do not get the top-level signed file exception.

### MIME-only final files
1. Serve a final video from a URL with no useful extension, such as `/download?id=123`, with `Content-Type: video/mp4`.
2. Expected: the item is allow-listed by MIME type and the Download button is enabled, assuming the matching file type is enabled in Options.
3. Disable MP4 in Options and rescan.
4. Expected: the same MIME-only item is blocked by file type settings.

### Popup decision details
1. Open the popup on a page with plain MP4, signed MP4, signed HLS, encrypted HLS, and DASH MPD examples.
2. Expand **Allow-list action details** on each card.
3. Expected: each card lists allowed/blocked action decisions with specific reasons, including top-level signed URL exceptions and HLS merge blocks.
4. Run Options → **Run self-tests** and verify all tests pass.

## v3.6.14 deeper allow-list tests

### HLS finite-file boundaries
1. Serve a normal finite MPEG-TS HLS media playlist with `#EXT-X-ENDLIST` and no encryption, fMP4, byte-range, low-latency, or signed component URLs.
2. Expected: Smart MP4 / MP4 / Fixed TS / Raw TS remain allowed, and the allow-list detail shows assembled-media output.
3. Serve a live/event HLS playlist without `#EXT-X-ENDLIST`.
4. Expected: built-in merge/remux actions are blocked as `live-hls-merge`, while **M3U8** remains available when the top-level playlist file is safe.
5. Serve a low-latency HLS playlist with `#EXT-X-PART` or `#EXT-X-PRELOAD-HINT`.
6. Expected: built-in merge/remux actions are blocked as low-latency HLS; **M3U8** remains the fallback.
7. Serve an I-frame-only playlist.
8. Expected: merge/remux is blocked because it is a trick-play index, not complete media.
9. Serve a master playlist with separate audio renditions.
10. Expected: built-in complete MP4/TS outputs are blocked until separate audio/video merging is implemented; **M3U8** remains available.

### Standalone MPEG-TS exception
1. Serve a direct `<video src="/full.ts?token=test">` file with `Content-Type: video/mp2t`.
2. Expected: the item is allowed as a limited standalone transport-stream file, not blocked as a signed segment.
3. Serve a signed HLS segment such as `/seg-001.ts?token=test` discovered from a playlist or detailed report.
4. Expected: the item remains blocked as a signed/protected stream component.
5. Serve a `.part` low-latency fragment.
6. Expected: the raw segment action is blocked.

### Decision metadata
1. Open popup decision details for plain MP4, signed MP4, cross-origin HLS, live HLS, and standalone `.ts` examples.
2. Expected: details include action labels, confidence, output kind, risk flags, and fallback method/action where applicable.
3. Run Options → **Run self-tests** and verify all tests pass, including the new v3.6.14 allow-list cases.


## v3.6.15 deeper allow-list tests

### Mixed separate-audio HLS master
1. Serve an HLS master playlist that includes `#EXT-X-MEDIA:TYPE=AUDIO` renditions and two variants: one variant with `AUDIO="aud1"` and one variant without an `AUDIO` attribute whose `CODECS` includes both video and audio codecs.
2. Scan the page.
3. Expected: built-in HLS merge is allowed conditionally instead of being blocked only because audio renditions exist.
4. Start the download.
5. Expected: Media Scout chooses the self-contained variant and does not attempt unsupported separate-audio merging.

### Required separate-audio HLS master
1. Serve an HLS master playlist where every visible variant references an `AUDIO` group.
2. Scan the page.
3. Expected: Smart MP4 / MP4 / Fixed TS / Raw TS are blocked with a separate-audio reason.
4. Expected: **M3U8** remains available when the top-level playlist URL is safe.

### MIME-inferred final media
1. Serve a final video from a URL with no useful extension, for example `/download?id=123`, with `Content-Type: video/mp4`.
2. Scan the page.
3. Expected: the item is allow-listed as final media by MIME type.
4. Disable MP4 in Options and rescan.
5. Expected: the same item is blocked by file-type settings.

### Opt-in metadata files
1. With default settings, scan a page that exposes `/metadata.json` or `/metadata.xml`.
2. Expected: metadata files are not treated as normal downloadable media by default.
3. Enable JSON/XML file types in Options and rescan.
4. Expected: direct metadata files are allowed as metadata-file downloads, with decision details explaining that metadata is opt-in.

### Standalone MPEG-TS attachment
1. Serve a complete `.ts` file with `Content-Type: video/mp2t` and `Content-Disposition: attachment`.
2. Scan the page.
3. Expected: the item is allowed as a standalone transport-stream file.
4. Serve a signed HLS segment from a playlist.
5. Expected: the segment remains blocked as a protected stream component.

### Regression checks
1. Run Options → **Run self-tests**.
2. Expected: all self-tests pass, including metadata opt-in, MIME-inferred unknown media, and mixed separate-audio/self-contained HLS cases.

## v3.6.16 deeper allow-list tests

1. Run Options → **Run self-tests** and verify the new v3.6.16 allow-list cases pass.
2. Serve a URL that looks segment-like, for example `/asset.m4s?token=test`, with `Content-Type: video/mp4`, `Content-Disposition: attachment; filename=asset.mp4`, and a normal finite MP4 body. Expected: the item is allowed as a limited direct final-media download, not blocked as a raw signed segment.
3. Serve an HLS media playlist with `#EXT-X-PLAYLIST-TYPE:VOD`, finite MPEG-TS segments, and no `#EXT-X-ENDLIST`. Expected: the popup marks merge as conditional rather than live-blocked; runtime still blocks if encryption, fMP4, byte-range, signed components, or fetch errors are found.
4. Serve an HLS media playlist with `#EXT-X-PLAYLIST-TYPE:EVENT` and no `#EXT-X-ENDLIST`. Expected: merge is blocked as live/event; M3U8 playlist saving remains available when the top-level playlist URL is safe.
5. Serve an HLS playlist using `.m4s`/`.cmfv` segment files without an `#EXT-X-MAP`. Expected: MPEG-TS merge/MP4 remux is blocked as fMP4/CMAF; M3U8 playlist saving remains available.
6. Serve an HLS master playlist containing `#EXT-X-SESSION-KEY`. Expected: report/page probes annotate it as encrypted and the popup does not offer merge/remux actions.


## v3.6.17 allow-list and HLS segment-count tests

1. Run Options → **Run self-tests** and confirm the v3.6.17 allow-list cases pass.
2. Open a same-origin HLS master playlist whose selected variant is fetchable. Expected: the media card shows the selected variant resolution/bandwidth and an exact **Selected variant segments** count.
3. Open a direct HLS media playlist. Expected: the card shows **Media playlist segments** and playlist duration when `#EXTINF` or target-duration metadata is visible.
4. Open a cross-origin master playlist whose variant cannot be probed in the background. Expected: the card shows that the segment count is unavailable or runtime-verified, and the merge action remains conditional rather than falsely blocked.
5. Open an empty media playlist with no full segment URIs. Expected: MP4/TS merge actions are blocked and M3U8 playlist saving remains available.
6. Open a playlist with low-latency `#EXT-X-PART` entries. Expected: partial segment count is visible when detected, full segment count remains separate, and finite-file merge is blocked.
7. Open a separate-audio HLS master that also contains a self-contained variant. Expected: the extension chooses the self-contained variant and does not block the whole master solely because audio renditions exist.

## v3.6.18 evidence-based allow-list tests

1. Run Options → **Run self-tests** and confirm the v3.6.18 allow-list cases pass.
2. Serve a final MP4 from a generic URL like `/download?id=123` with `Content-Type: application/octet-stream` and `Content-Disposition: attachment; filename=movie.mp4`. Expected: the item is allow-listed as final media, the popup decision details show `evidence=high`, `attachment-filename`, and `content-disposition-attachment`, and the inferred extension is `.mp4`.
3. Disable MP4 in Options and rescan the same generic attachment URL. Expected: the item is blocked by file-type settings even though the attachment filename indicates MP4.
4. Serve a signed-looking URL such as `/asset.m4s?token=test` with `Content-Disposition: attachment; filename=asset.mp4`, `Content-Type: application/octet-stream`, and a complete finite MP4 body. Expected: the item is allowed as a limited direct final-media download, not as a raw stream segment or HLS component.
5. Serve a signed `.m4s` or `.ts` URL that is associated with an HLS playlist and has no final-file attachment evidence. Expected: it remains blocked as a stream component.
6. Open popup **Allow-list action details** for a plain MP4, a MIME-inferred generic download, an attachment-inferred octet-stream download, a signed final file, and an HLS playlist. Expected: details show evidence level/flags for direct files and recommended/fallback method data for HLS.

## v3.6.19 deeper allow-list tests

1. Run Options → **Run self-tests** and confirm the v3.6.19 allow-list cases pass.
2. Serve a final MP4 through a segment-shaped URL such as `/asset.m4s?token=test` with `Content-Type: video/mp4`, `Accept-Ranges: bytes`, and `Content-Range: bytes 0-1048575/52428800`. Expected: it is allowed as a limited direct final-media download, and decision details show `content-range` / range evidence.
3. Serve a signed HLS `.m4s` or `.ts` component from a playlist without final-file headers. Expected: it remains blocked as a stream component.
4. Serve an HLS master or media playlist whose selected variant advertises `CODECS="hvc1...,mp4a.40.2"`. Expected: forced **MP4 Remux** is blocked with an unsupported-codec reason, while **Smart MP4** remains conditional and recommends timestamp-fixed TS fallback.
5. Serve an HLS variant with `CODECS="avc1...,mp4a.40.2"`. Expected: MP4 remux remains allow-listed when the playlist is otherwise finite, non-encrypted MPEG-TS.
6. Open popup **Allow-list action details** for range-probed final media and incompatible-codec HLS. Expected: details show evidence/risk flags instead of a generic unsupported message.

## v3.6.20 header-aware allow-list tests

1. Run Options → **Run self-tests** and confirm the v3.6.20 allow-list cases pass.
2. Serve `/poster.jpg` with `Content-Type: video/mp4` and a media-sized response. Expected: it is allowed as final media, and action details show `extension-mime-conflict` plus `response-mime` evidence.
3. Serve `/video.mp4` with `Content-Type: text/html`. Expected: it is blocked with a non-media response MIME reason instead of being trusted by the `.mp4` extension.
4. Serve `/not-a-playlist.m3u8` with `Content-Type: text/html`. Expected: M3U8 save and HLS merge are blocked as a non-manifest response.
5. Serve `/file?id=4` with `Content-Type: application/octet-stream` and `Content-Disposition: inline; filename="clip.webm"`. Expected: it is allowed as final WebM media when WebM is enabled, and blocked if WebM is disabled.
6. Repeat the existing signed HLS component and segment-shaped final-file tests. Expected: stream internals remain blocked unless final-file headers prove a direct top-level media download.

## 18. v3.7.5 regression checks

1. In Side Panel > Inspector, type continuously in the filter box.

Expected: focus and caret position stay in the filter while the candidate list updates.

2. Enable Manual HLS in Options, open Side Panel > Inspector, and type a valid-looking `.m3u8` URL into an initially empty field.

Expected: **Validate and queue manual HLS** enables immediately without changing routes or forcing a rerender.

3. Set HLS output to **M3U8 only** and then to **External helper notes**. Queue a safe HLS candidate each time.

Expected: queue/report diagnostics show `hls-playlist` for M3U8-only and `hls-external-helper` for helper notes, not `hls-segment-merge`.

4. Start a page-context HLS/blob save from a temporary batch/source tab.

Expected: when the task reaches **Verify uncertain**, the temporary source tab is cleaned up and a notification can be shown if notifications are enabled.

## 19. v3.7.6 regression checks

1. Run Options → **Run self-tests**.

Expected: all self-tests pass, including detailed-scan HLS self-contained variant checks for audio+video, audio-only, and video-only variants.

2. Serve or simulate a detailed HLS master report with separate audio and an audio-only variant using `CODECS="mp4a.40.2"`.

Expected: Media Scout marks the playlist as requiring separate audio/video support and does not offer built-in MP4/TS merge as complete output.

3. Serve or simulate a detailed HLS master report with a self-contained variant using `CODECS="avc1.64001f,mp4a.40.2"`.

Expected: Media Scout recognizes the self-contained variant and does not block the entire master solely because alternate audio renditions exist.

4. Test a page where bundled scanner injection fails but the legacy broad scan finds a media URL.

Expected: scan status is successful or fallback-based, not a false browser-blocked page state.

5. Change HLS output method in Options, then open Side Panel → Inspector on HLS candidates.

Expected: candidate capability sorting and labels reflect the current setting.

## v3.7.8 Options save regression

- Open Options, toggle any setting, click Save settings, and verify the status reads `Settings saved.`
- Reload Options and confirm the setting persisted.
- Specifically test Enabled file types because the options page submits the full registry, not a small patch.
- Run self-tests and confirm the SETTINGS_SAVE validation accepts a complete options-page payload and rejects unknown file-type keys.

## 21. v3.7.9 regression checks

### Stale snapshot action blocking
1. Create or simulate a media item whose `detectedAt`/`updatedAt` is older than 10 minutes.
2. Open the popup and Side Panel → Inspector.
3. Expected: the popup shows **Snapshot expired — rescan current tab** and the primary action is **Rescan current page**. Inspector/side-panel download actions refuse to queue the stale media.
4. Expected service-worker behavior: `START_DOWNLOAD` returns a `stale-media-snapshot` validation error until the page is rescanned.

### Options-aware frontend CTA state
1. Detect a direct `.mp4` candidate.
2. Disable `mp4` in Options → File types and save.
3. Reopen the popup/side panel without rescanning.
4. Expected: the candidate no longer presents a usable Download CTA; the decision explains that `.mp4` is disabled instead of failing only after click.

### Hard-rescan cleanup
1. Repeatedly run hard rescan on a media page.
2. Trigger DOM/resource changes or page playback.
3. Expected: one content-script instance handles scans; duplicate overlays, runtime message handlers, and scan messages do not accumulate after reinjection.



## 22. v3.7.10 regression checks

### URI-less separate-audio HLS master
1. Serve a master playlist with an audio group but no audio rendition URI, for example `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,AUTOSELECT=YES`, plus a variant with `AUDIO="aud"` and video-only `CODECS`.
2. Open the page, play/rescan, and inspect the candidate in the popup and Side Panel → Inspector.
3. Expected: built-in Smart MP4, MP4 remux, timestamp-fixed TS, and raw TS actions are blocked with a separate-audio reason.
4. Expected: M3U8 playlist save and external-helper notes remain available only through the normal explicit HLS methods and raw-URL confirmation rules.
5. Run built-in self-tests. Expected: all self-tests pass, including URI-less separate-audio HLS classification.

### Queue retry feedback
1. Restore or simulate a failed queue-history task that no longer has runnable media evidence.
2. Click retry from Side Panel → Queue.
3. Expected: the UI says retry is unavailable and asks for a fresh rescan instead of reporting a fake retry request.
