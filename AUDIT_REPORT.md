# Production-readiness audit report

Date: 2026-08-16
Audited version: 3.7.11
Resulting version: 3.7.12

## Scope

The audit covered every tracked application, configuration, test, asset, workflow, and documentation file. It reviewed the popup, side-panel routes, Settings, content/page scanning, background detection, downloads, HLS handling, queue persistence, report generation, message boundaries, permissions, CSP, accessibility, build/CI behavior, repository structure, and release documentation.

The project is a dependency-free Chrome Manifest V3 extension. It has no server, database, authentication service, deployment environment, environment-variable contract, analytics SDK, or runtime package dependency to audit.

## Important findings and changes

### Functionality and data integrity

- Fixed the preferred-subfolder sanitizer so an intentionally empty value persists instead of silently reverting to the default folder.
- Normalized bounded numeric settings and queue concurrency to whole numbers; added enum/type validation for settings messages.
- Removed a dead install handler that could never observe missing settings because defaults are always merged.
- Added stale-response protection to side-panel state loading so a slower earlier scan cannot overwrite a newer user action.
- Corrected report-ZIP path sanitation to discard traversal and absolute-path segments.

### Security and privacy

- Fixed POSIX single-quote escaping in external-helper notes. The prior replacement did not safely represent embedded apostrophes in copied commands.
- Closed report-redaction gaps for referrers, posters, relative/malformed URL fields, URLs embedded in diagnostic text, and secret-shaped object keys.
- Kept host permissions optional, confirmed CSP is local-only, and added automated checks against high-risk permissions, remote imports, dynamic code execution, and HTML-string injection.
- Preserved fail-closed behavior for encryption, DRM, authentication, paywalls, CORS, signed stream components, stale evidence, and unsupported layouts.
- Added regression coverage for helper escaping, ZIP paths, settings payload types, enum validation, and empty-folder persistence.

### Performance and reliability

- Bounded normal page scans to 500 prioritized candidates, companion media to 120 items, Resource Timing inspection to 2,000 recent entries/240 matches, page-literal text to 2 MB, and literal attribute inspection to 2,000 elements.
- Prioritized HLS/DASH and primary video/audio ahead of artwork and metadata before content-script messages and before multi-frame background ingestion.
- Removed a mutation-triggered page overlay that repeatedly modified host pages and announced scan activity. Scans are now silent until the user opens extension UI.
- Added deterministic format, lint, syntax, test, and staging-build commands with no third-party packages.

### Second-pass hardening

- Serialized service-worker initialization before message handling so restored settings, queue history, diagnostics, and detector state cannot race the first popup or side-panel request.
- Added per-tab scan revisions and live-document checks across DOM scans, web-request enrichment, follow-up scans, and report generation. Results from a closed or navigated page are now discarded rather than being attributed to its successor.
- Coalesced follow-up scan timers, bounded concurrent manifest inspection, capped manifest and playlist reads, and added individual HLS-segment limits before data is retained.
- Made queue cancellation authoritative when a worker resolves concurrently, rejected late progress, serialized summary/history persistence, bounded settled-task retention, and removed evicted tasks from the in-memory index.
- Prevented duplicate enqueue attempts from consuming filename sequence numbers and reset per-tab filename counters when the source document ends.
- Preserved the strongest protection evidence when later observations are less specific, preventing encrypted or unsupported media from being weakened by repeat detection.
- Classified browser-download failures before retry decisions and cancel the underlying browser download when a completion watchdog expires, avoiding misleading retries and orphaned transfers.
- Made optional diagnostic persistence best-effort so storage errors cannot turn a completed download into a failed or duplicate attempt.
- Reduced session-state exposure by storing only the route, tab identifier, and timestamp for one-shot side-panel navigation intents, then consuming that intent unconditionally.
- Added targeted regressions for cancellation races, late progress, bounded retention, stale scans, protection-evidence monotonicity, duplicate filename indices, error classification, route-intent privacy, and numeric progress validation.

### Third-pass hardening

- Made detected-state cleanup authoritative: clearing the cache now cancels scheduled rescans, removes all network-observation scopes, invalidates in-flight revisions, and broadcasts an empty snapshot. Navigation and monitored-tab closure also clear the open popup/side-panel state instead of leaving stale candidates visible.
- Added full-snapshot replacement broadcasts so the popup and side panel reflect background eviction rather than growing indefinitely through merge-only updates. Per-tab media retention is capped at 750 prioritized items, preserving protected findings, manifests, and primary video/audio ahead of artwork and low-value fragments.
- Bounded pathological page/report work across legacy scanning, detailed frame aggregation, DOM/attribute/script traversal, candidate and decision lists, Resource Timing, episode discovery, iframe detail, URL length, and page-controlled strings.
- Added structural HLS/DASH limits before retained arrays or merge work can grow without bound: 200 HLS variants, 100 audio renditions, 6,000 HLS segments, and 500 DASH representations. Exact counts and truncation/unsupported flags are retained for diagnosis.
- Serialized explicit queue-history clearing behind already-started persistence writes, canceled delayed snapshots, and clear stored history immediately when retention is lowered. Corrupt or unavailable queue history and diagnostics are now optional context rather than startup/report/download blockers.
- Hardened Chrome download monitoring against missing download identifiers, listener-registration failures, status-search failures, callback exceptions, and watchdog cleanup. Ambiguous handoffs no longer trigger an automatic duplicate download attempt.
- Removed query-parameter names from runtime HLS errors and default report summaries, redacted blob/relative/embedded URL secrets, advanced the report schema to version 6, and blocked prototype-key collisions in externally derived diagnostic/report/resource dictionaries.
- Corrected primary-button contrast across the full purple-to-cyan gradient and added an automated 4.5:1 endpoint invariant.

### UX and accessibility

- Removed whole-popup live-region behavior; targeted status regions continue to announce meaningful feedback.
- Added names to Inspector filters, labeled queue progress bars and values, and dynamic route-specific document titles.
- Repaired invalid nested labels in Settings and labeled the file-type search field.
- Prevented file-type search from marking settings dirty, disabled Save when no changes exist, added unsaved-navigation protection, reflected saved/pending state, and stopped failed self-tests from being announced as successful.
- Raised the faint-text token to meet a 4.5:1 normal-text contrast threshold on the soft background.

### Repository cleanup

- Removed unused `src/shared/types.js` and unreferenced utilities, logger methods, MIME maps, and registry helpers after repository-wide reference checks.
- Consolidated accumulated historical material from the oversized README, test plan, and download-policy document into current, task-oriented documentation. Release history remains in `CHANGELOG.md`.
- Added a clean staging build that packages only the manifest, source, and icons; generated output remains ignored.
- Updated CI to run the full quality gate and staging build.

## Validation completed

- All commands that compose `npm run check` passed against the final tree.
- Formatting checks: passed.
- Repository lint and security invariants: passed.
- JavaScript syntax checks across all `.js`/`.mjs` files: passed.
- Nine self-test suites plus expanded repository, storage-race, report-redaction, resource-bound, and browser-download assertions: passed.
- Formatting target: passed; all 52 checked text files were already normalized.
- Staging-build target: passed; staged 38 extension files totaling 662,162 bytes.
- `npm ci --offline`: passed; the lockfile is reproducible without dependency downloads.
- `npm ls --all`: passed with an empty dependency tree.
- `git diff --check` and `git fsck --full`: passed.
- Packaged icon signatures/dimensions and a targeted private-key/token pattern scan: passed.

## Remaining risks and next steps

1. **Manual Chrome flow validation remains open.** No Chrome/Chromium binary is available in the audit environment, so real extension APIs, browser Save As prompts, console logs, screen-reader output, responsive side-panel widths, and media playback fixtures could not be exercised here. Run every section of `TEST_PLAN.md` in clean stable-browser profiles before release.
2. **HLS is inherently memory-sensitive.** Built-in merge/remux remains Blob-based with a 768 MiB aggregate hard cap; individual segments are now streamed through a 64 MiB limit, but retained segment arrays and final Blob/remux buffers still create substantial aggregate pressure. Lower-memory devices need fixture testing; a streaming native/helper architecture would be required to remove this constraint safely.
3. **Known stream formats remain deliberately limited.** fMP4/CMAF assembly, separate-audio merge, low-latency partials, and unbounded live capture are not exposed as complete built-in video outputs. Each would require dedicated parsers, fixtures, cancellation/memory tests, and browser-matrix validation.
4. **Several domain files remain large.** The HLS/remux, service-worker, scanner, and allow-list modules encode coupled safety policy. They were not split speculatively during a cleanup release; safe decomposition requires characterization fixtures and browser integration tests first.
5. **Distribution review is separate.** Chrome Web Store disclosures, legal authorization language, license review, vulnerability-reporting contact, and platform-specific accessibility sign-off require maintainer decisions before public distribution.
6. **There is no compile-time type system.** The `typecheck` gate verifies JavaScript syntax and local import integrity, while runtime validators and tests cover important data boundaries. Full compile-time checking would require a deliberate JSDoc/`@ts-check` adoption or a typed-language migration with browser fixtures; that was too broad for a safe cleanup release.
