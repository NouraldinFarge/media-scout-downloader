# P1 test evidence — 3.7.13

Status: **in progress; not yet publication evidence**

This record will be finalized against the immutable P1 source/runtime commit and extension artifact. Results produced from the current working tree are useful defect-finding evidence but do not authorize a public compatibility or release claim.

## Completed locally before final binding

- Conventional ESLint 10.8.1 passes with zero warnings.
- JavaScript syntax and repository invariant commands are accurately named and pass.
- The four designated safety-critical modules meet per-file floors of 75% statements/lines, 70% functions, and 55% branches. Current aggregate for that set is approximately 91% statements/lines, 91% functions, and 72% branches; exact final values will be copied from the bound coverage summary.
- Controlled fixture endpoint tests cover direct MP4/WebM/MP3, subtitles, artwork, ordinary/master/fMP4/protected/separate-audio/live/low-latency HLS, DASH, Blob, empty, slow, CORS, authentication, expired-link, 6,001-segment, large-master, and 20,000-element cases.
- Consecutive FFmpeg 8.1.2 fixture generations are byte-identical; the generated manifest records every file hash.
- Brave 151.1.93.136 accepted the extension in a disposable profile for automated testing. The current working-tree run covered the fixture app, service worker, popup, Inspector, Queue, Reports, Settings persistence, axe, keyboard order/focus, dynamic focus restoration, progress semantics, RTL filename preview, forced colors, reduced motion, 200% CSS zoom, 360/720-pixel layouts, cold/warm popup timing, initial/pathological scans, and 500/750-candidate rendering with no page/console error. This must be rerun against the bound commit.
- Google Chrome 151.0.7922.138 rejected command-line unpacked-extension side-loading as expected for current branded Chrome. Its exact matrix therefore requires owner-confirmed manual loading into a disposable profile.
- Seven repeatable Node performance benchmarks pass their median/p95 budgets. A 256 MiB V8-heap proxy assembled a controlled 64 MiB Blob within budget; this is not low-memory browser evidence.
- Experimental in-browser HLS limits were reduced from 64 MiB/segment and 768 MiB aggregate to 24 MiB/segment and 128 MiB aggregate, with estimate rejection near 83.2 MiB.
- The staged extension contains 39 allowlisted runtime files and no dependency, fixture, report, document, source map, or test artifact.

## Pending final P1 evidence

- Exact immutable source/runtime commit and artifact SHA-256.
- Exact Chrome and Brave Windows manual checklist.
- Built-in Windows Narrator 10.0.26100.7309 screen-reader path plus keyboard/zoom/forced-colors review.
- Final remote CI, CodeQL, and automated browser-smoke workflow runs.
- Final clean release reproducibility run and release-package hashes.
- Final P1 gate decision and reviewer statement.

No “tested in Chrome/Brave,” screen-reader-tested, performance-qualified, remotely verified, or release-ready public wording is allowed from this interim record.
