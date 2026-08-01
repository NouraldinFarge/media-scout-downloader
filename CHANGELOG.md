# Changelog

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

Earlier version notes remain in the historical section of [`README.md`](README.md).
