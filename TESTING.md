# Testing

Run the deterministic repository gate and create a clean staging build with Node.js 22 or newer:

```sh
npm run format
npm run check
npm run build
```

The automated gate covers formatting, repository invariants, JavaScript syntax, URL and message validation, filename safety, settings sanitization, the download allow-list, stale-evidence behavior, strategy ordering, queue races and retention, bounded manifest/media state, helper-command escaping, report redaction and ZIP paths, retry policy, browser-download handoff failures, contrast invariants, version alignment, CSP, permission boundaries, and packaged-file staging.

## Manual Chrome release gate

Before publishing a release candidate:

1. Load `dist/media-scout-downloader/` as an unpacked extension in a clean Chrome profile.
2. Confirm install-time permissions match `manifest.json` and website access is optional.
3. Exercise direct MP4/WebM download on user-controlled fixtures.
4. Exercise a non-encrypted HLS fixture and verify compatible MP4 remux plus fail-closed unsupported layouts.
5. Confirm encrypted, DRM-marked, authenticated, paywalled, signed/expiring, CORS-blocked, and stale candidates do not expose bypass behavior.
6. Confirm navigation, monitored-tab closure, and cache clearing remove stale candidates and cancel page-context work.
7. Inspect generated reports for URL, query-name, hostname, filename, and credential leakage under both privacy settings.
8. Complete [`TEST_PLAN.md`](TEST_PLAN.md), re-run `npm run check`, record the browser version, and attach the checklist to the release record.

No public-release claim should be made until this manual gate is recorded.
