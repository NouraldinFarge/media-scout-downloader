# Changelog

## 3.7.13 - 2026-08-17 (private candidate)

- Replace the report filename/size-only screen with a field-by-field exposure table and literal, searchable, selectable previews for every generated text file.
- Minimize default reports by omitting titles and filenames, hashing hostname/path correlation values, and removing query names, query values, local paths, blob identifiers, URL credentials, and secret-shaped fields.
- Keep sensitive URL mode behind both a saved setting and a separate per-report confirmation while continuing to redact credentials and secret-shaped values.
- Normalize and de-duplicate report paths before both preview and ZIP generation so exported paths and contents exactly match the reviewed file set.
- Invalidate previews when the source tab, scan, candidate state, queue/history, settings, permissions, diagnostics, or sensitivity changes, and revalidate current evidence immediately before export.
- Add synthetic regression coverage for identifiers, embedded/relative/blob/credential URLs, query data, secrets, Unicode, ZIP traversal, preview invalidation, stale source evidence, and preview/export equality.
- Adopt the owner-approved MIT License and align SPDX/package/provenance wording while preserving the authorized-media and no-bypass boundary.
- Run the official CodeQL JavaScript security-and-quality suite, resolve all eight initial maintainability findings, and verify a zero-result rerun against the corrected exact source commit.
- Replace the misleading custom `lint`/`typecheck` labels with conventional ESLint, accurately named syntax and invariant checks, and pinned development-only tools while retaining zero runtime dependencies.
- Enforce per-file coverage floors for report privacy/management, URL/message validation, and the download allow-list.
- Add reproducible synthetic MP4, WebM, MP3, HLS, fMP4, subtitle, and artwork fixtures plus controlled Blob, DASH, CORS, authentication, expired-link, encrypted, separate-audio, live, low-latency, 6,001-segment, large-master, and 20,000-element simulations.
- Add disposable-profile browser automation, axe/keyboard/focus/progress/responsive/media-preference checks, and repeatable popup/scan/render/report/queue/HLS performance budgets.
- Mark in-browser HLS merge/remux experimental and reduce its ceilings from 64 MiB per segment / 768 MiB aggregate to 24 MiB per segment / 128 MiB aggregate with earlier estimate rejection.
- Add pinned remote CI/CodeQL/browser-smoke workflows, allowlisted package inspection, verified Gitleaks download, dependency auditing, and deterministic extension/source/sample ZIP, SPDX SBOM, checksum, build-manifest, and provenance tooling.

## 3.7.12 - 2026-08-16

- Fix empty download-folder persistence, bounded integer settings, settings validation, and side-panel request races.
- Correct external-helper shell escaping and report-ZIP path sanitation.
- Bound and prioritize page scans while removing mutation-triggered host-page overlays.
- Discard stale scan/report results after navigation, coalesce follow-up scans, and preserve the strongest protection evidence.
- Make queue cancellation race-safe, serialize persistence, cap settled history, and avoid duplicate filename-sequence consumption.
- Bound manifest and HLS input reads, cancel stalled browser transfers, and classify browser errors before retrying.
- Gate messages on service-worker initialization and keep optional diagnostics failures from changing download outcomes.
- Improve Settings state, form semantics, live-region scope, progress labels, filter labels, route titles, and text contrast.
- Minimize and consume one-shot side-panel route state so source URLs and titles are not retained in session storage.
- Clear popup/side-panel candidates after cache reset, navigation, and monitored-tab closure; use authoritative bounded snapshots for follow-up scans.
- Cap per-tab retention, page/report traversal, URL/string inputs, HLS variant/audio/segment structures, and DASH representation details while retaining exact diagnostic counts.
- Make explicit queue-history clearing win pending writes; normalize corrupt diagnostics/history and reject prototype-collision keys safely.
- Harden Chrome download monitoring against ambiguous handoffs and remove query-key names plus embedded/blob/relative URL secrets from default reports.
- Fix primary-button text contrast across the complete accent gradient and lock the threshold into the static gate.
- Remove confirmed dead code and consolidate current product, policy, and release-test documentation.
- Add dependency-free format, lint, syntax, archive, build, and CI quality gates.

## 3.7.11 - 2026-08-01

- Add a repeatable Node-based regression gate and pinned GitHub Actions CI.
- Tighten the extension CSP to `object-src 'none'`.
- Add explicit privacy, security, testing, contribution, and licensing boundaries.
- Separate release history from the main product README.

## 3.7.10 - 2026-07-05

- Detect URI-less separate-audio HLS masters and block incomplete built-in MP4/TS output unless a self-contained variant is visible.
- Fail closed instead of choosing a video-only variant when separate audio is required.
- Block stale media evidence until the current tab is rescanned.
- Recompute popup and side-panel actions from current options.
- Preserve blob page-context and DASH manifest-only strategy boundaries.
- Add regression coverage for download-strategy ordering.

Development before the current repository snapshot occurred privately and is not represented by repository tags or earlier commits.
