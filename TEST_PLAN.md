# Media Scout release test plan

Use this plan for version 3.7.13. Record the Chrome/Brave version, operating system, extension commit, fixture source, results, console errors, and reviewer. Do not publish while a critical or high-severity item is unresolved.

## 1. Automated gate

From a clean checkout with Node.js 22 or newer:

```sh
npm ci --offline
npm run format
npm run check
npm run build
```

Expected results:

- formatting, repository lint, JavaScript syntax, self-tests, archive checks, and build all pass;
- `dist/media-scout-downloader/manifest.json` matches the source version;
- the staging directory contains only `manifest.json`, `src/`, and `assets/`;
- `git diff --check` reports no whitespace errors;
- no deleted module remains referenced.

## 2. Browser matrix

Test current stable Chrome on Windows and macOS. Test stable Chrome or Chromium on Linux when that platform is supported. Run one pass at a narrow side-panel width and one at a wide width. Repeat the core flow with keyboard only and with a screen reader on at least one supported operating system.

Use only controlled, unprotected fixtures. Include direct MP4, WebM, MP3, a finite unencrypted MPEG-TS HLS VOD, an HLS master with muxed audio/video variants, DASH MPD, subtitles, posters, a page-local blob, and explicit negative fixtures.

## 3. Install and first use

1. Load `dist/media-scout-downloader/` as an unpacked extension in a clean browser profile.
2. Confirm install-time permissions match `manifest.json`; HTTP(S) website access must not be mandatory.
3. Open the popup on a normal page with no media.
4. Verify the page identity, local-only trust signal, empty state, playback guidance, and site-access secondary action.
5. Open each side-panel route and Settings. Confirm back/focus behavior and that the route title reflects the current view.

Pass criteria: no blank panels, clipped primary actions, unexpected overlays, console errors, or inaccessible unlabeled controls.

## 4. Detection and permissions

1. Scan a direct-media fixture without persistent host access.
2. Grant access for one origin and verify advanced detection starts only there.
3. Revoke access and confirm basic active-tab scanning remains available.
4. Grant and then revoke all-site access from Settings.
5. Navigate the source tab to a new document.
6. Try a browser-internal page and an unavailable frame.
7. Start a scan on a deliberately slow manifest, then navigate or close the source tab before it resolves.
8. Trigger several popup refreshes quickly and confirm only the current document receives follow-up results.
9. Keep the side panel open for a monitored tab, close that source tab, and confirm its candidates and report preview disappear immediately.
10. Clear the detected-media cache while delayed follow-up scans are scheduled; confirm the popup and side panel remain empty until a new explicit scan.
11. Scan a pathological fixture with more than 20,000 DOM elements, 300 scripts, 2,000 media-like attributes, 2,000 Resource Timing entries, 240 frames, and 750 distinct candidates.

Pass criteria: permission prompts explain their scope; denied prompts recover cleanly; navigation, cache clearing, and source-tab closure clear stale candidates and cancel source-dependent work; late scan/report results are discarded; full snapshots never exceed the documented caps and keep high-value manifests/primary media ahead of artwork; restricted pages show an actionable error rather than a false success.

## 5. Direct downloads and filenames

1. Download each supported progressive fixture.
2. Exercise auto-number, ask, and overwrite conflict settings.
3. Test Unicode, reserved Windows names, punctuation, very long titles, and `《title》` extraction.
4. Set a preferred subfolder, then clear it and save.
5. Close and reopen Settings.

Pass criteria: filenames are safe and bounded; an empty subfolder persists and saves directly to the browser's default download location; browser prompts and final status are represented honestly.

## 6. HLS and manifests

For finite unencrypted MPEG-TS HLS, test Smart MP4, MP4 remux, timestamp-fixed TS, raw TS concatenation, playlist-only, highest/lowest variants, retry limits, cancellation, and external-helper notes. Verify audio/video sync and seekability of completed outputs.

For negative fixtures, test encryption markers, DRM markers, separate audio without a self-contained variant, fMP4/CMAF, low-latency partials, live/event playlists without a safe finite boundary, empty media playlists, too many segments, oversized estimates, authentication failures, CORS failures, and expired/signed components.

Also test a page with more than eight manifest candidates, a manifest larger than 4 MiB, a segment larger than 24 MiB, aggregate HLS data above 128 MiB, a master with more than 200 variants, a master with more than 100 audio renditions, and a media playlist with more than 6,000 segments. Repeat detection of an encrypted candidate through a less-specific source.

Pass criteria: supported paths complete within configured bounds; deferred or oversized inputs are identified without unbounded reads; stronger encryption/unsupported evidence is retained; unsupported paths never claim to produce a complete video; helper notes quote shell arguments safely; canceled tasks stop promptly and release object URLs.

## 7. Queue and restart behavior

1. Start more downloads than the configured parallel limit.
2. Pause, resume, cancel queued/active tasks, retry a transient network failure, and clear settled work.
3. Trigger a browser Save As prompt and leave it pending.
4. Restart the extension service worker during a task.
5. Close the source tab during blob and HLS page-context work.
6. Cancel an active task as its browser download finishes and attempt to send late progress.
7. Repeatedly enqueue the same candidate and confirm the next distinct download has the expected sequence number.
8. Exercise enough completed, failed, and canceled tasks to exceed the retained-history limit.
9. Trigger a queue snapshot and immediately clear stored queue history; wait beyond the persistence-throttle interval and confirm the old snapshot does not reappear.
10. Simulate or inspect a Chrome download handoff that returns no usable identifier or cannot register its monitor; confirm Media Scout tells the user to check Downloads and does not start an automatic duplicate.

Pass criteria: whole-number parallelism is enforced; buttons prevent duplicate actions; cancellation remains final; late progress cannot revive settled tasks; duplicate attempts do not consume sequence numbers; retained task state stays bounded; progress is labeled for assistive technology; restart history contains no raw URL, hostname, or filename; interrupted work is not shown as completed.

## 8. Settings and diagnostics

1. Change every editable setting, save, reload, and verify persistence.
2. Type in the file-type filter without changing any setting.
3. Try fractional, empty, out-of-range, and invalid values through DevTools messages.
4. Leave Settings with unsaved changes.
5. Run self-tests, reset diagnostics, clear cache, and clear queue history.
6. With the extension stopped, place malformed diagnostics and queue-history values in local storage, restart it, and repeat a direct download plus report generation.
7. Lower queue-history retention, including to zero, and verify older stored summary/history keys are removed immediately.

Pass criteria: filtering does not mark Settings dirty; values normalize or reject safely; malformed optional storage cannot block startup, downloads, or reports; lower retention removes older stored history; Save is disabled when nothing changed; unsaved navigation receives a browser warning; failed self-tests are not announced as successful.

## 9. Reports and privacy

1. Generate a default report, read the field-by-field exposure table, open every disclosure, search the literal preview text, and inspect every ZIP entry.
2. Repeat with sensitive URL mode enabled in Settings and accepted through the separate per-report confirmation.
3. Use URLs containing credentials, query tokens, sensitive query-parameter names, fragments, Unicode, embedded URLs in error text, relative secret URLs, blob identifiers, and traversal-shaped filenames.
4. After preview generation, separately change the source page, candidate list, queue/history, settings, permissions, diagnostics, and sensitivity option; confirm each change disables export until a new preview is reviewed.
5. Inspect local storage before and after queue restart and cleanup actions.

Pass criteria: default reports omit titles and filenames; replace hostnames/paths with correlation hashes; omit query names/values; and redact blob identifiers, credentials, local paths, secret-shaped data, headers, cookies, and tokens. Screenshots remain absent in every mode. Sensitive mode exposes only the values named by its exact exposure table and continues to redact credentials, local paths, blob identifiers, and secret-shaped data. Preview content is rendered as literal text. Every ZIP path/content byte sequence matches the reviewed normalized file set, traversal cannot escape the archive root, stale inputs block export, and cleanup actions remove only their named data.

## 10. Accessibility and responsive UI

Verify logical heading order, landmarks, visible focus, tab order, Escape/Enter/Space behavior, form labels, status announcements, progress names/values, 200% zoom, forced colors, reduced motion, long translated-like text, and narrow/wide side panels. Inspect text contrast against WCAG AA thresholds, including both endpoints and the midpoint of every primary-button gradient.

Pass criteria: all operations are keyboard reachable; focus is retained during dynamic Inspector filtering; updates do not announce entire changing pages; no critical text or action is clipped; normal text contrast is at least 4.5:1.

## 11. Release record

Attach the automated output, completed browser matrix, fixture provenance, sample redacted report, accessibility notes, and known limitations. Review privacy, security, licensing, and Chrome Web Store disclosures separately before distribution.
