# Changelog

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
