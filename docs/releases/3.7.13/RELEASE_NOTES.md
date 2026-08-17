# Media Scout Downloader 3.7.13 release notes

Version 3.7.13 is the first repository-backed public candidate. Earlier development occurred privately and is not represented by earlier Git tags or GitHub Releases.

## Highlights

- Recommendation-first Manifest V3 popup with an advanced side-panel workspace.
- Local-first media detection with optional per-site network visibility and no developer-operated backend.
- Explicit capability classification for progressive media, HLS, DASH, page-local Blob media, subtitles, artwork, and supporting formats.
- Fail-closed boundaries for encrypted/DRM, authenticated, signed or expiring, CORS-blocked, stale, fMP4/CMAF, separate-audio, live, and low-latency paths that are not safely supported.
- Privacy-reviewed diagnostic Report Preview with literal file contents, field-by-field disclosure, redacted defaults, source-change invalidation, and exact ZIP equality checks.
- Bounded queue and restart metadata with no persisted raw media URL, hostname, or filename.
- Conventional ESLint, accurately named syntax/invariant checks, per-file safety coverage thresholds, controlled browser fixtures, automated accessibility checks, performance budgets, CodeQL, secret scanning, and deterministic release tooling.

## Safety change

In-browser HLS merge/remux is explicitly experimental and memory-bound. The previous 768 MiB aggregate ceiling was reduced to 128 MiB, the per-segment ceiling was reduced to 24 MiB, and estimated streams are rejected at approximately 83.2 MiB before allocation. This is a conservative limitation, not a low-memory compatibility claim.

## Distribution

The extension source is licensed under the MIT License. The extension upload ZIP contains only the manifest, runtime JavaScript, HTML/CSS, and four icon files; fixtures, tests, reports, documents, source maps, development dependencies, and local evidence are excluded. Chrome Web Store publication and signing are separate actions and are not implied by this source release.

See `KNOWN_LIMITATIONS.md`, `RELEASE_CHECKLIST.md`, the SPDX SBOM, build manifest, provenance statement, and `SHA256SUMS` in the release-candidate package.
