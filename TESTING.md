# Testing

Run the deterministic source gate with Node.js 22 or newer:

```powershell
npm test
```

The automated gate covers URL and message validation, filename safety, settings sanitization, the download allow-list, stale-evidence behavior, strategy ordering, retry policy, version alignment, CSP, and permission boundaries.

## Manual Chrome release gate

Before publishing a release candidate:

1. Load the repository root as an unpacked extension in a clean Chrome profile.
2. Confirm install-time permissions match `manifest.json` and website access is optional.
3. Exercise direct MP4/WebM download on user-controlled fixtures.
4. Exercise a non-encrypted HLS fixture and verify compatible MP4 remux plus fail-closed unsupported layouts.
5. Confirm encrypted, DRM-marked, authenticated, paywalled, signed/expiring, CORS-blocked, and stale candidates do not expose bypass behavior.
6. Confirm navigation clears stale candidates and cancels page-context work.
7. Inspect generated reports for URL, hostname, filename, and credential leakage under both privacy settings.
8. Re-run `npm test`, record the Chrome version, and attach the completed checklist to the release record.

No public-release claim should be made until this manual gate is recorded.
