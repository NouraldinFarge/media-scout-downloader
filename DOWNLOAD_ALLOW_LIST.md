# Download allow-list

This document describes the current action boundary for Media Scout Downloader 3.7.12. The implementation in `src/shared/download-allow-list.js` is authoritative; regression tests cover the important branches.

## Decision order

Every user-facing action is recomputed from current evidence and settings. A cached label is never sufficient.

1. Validate the URL and supported scheme.
2. Reject stale evidence or a lost page context.
3. Respect the current file-type setting.
4. Classify final files, manifests, playlists, blobs, segments, metadata, and companions.
5. Apply response evidence such as MIME type, Content-Disposition, Content-Range, size, playlist inspection, and source.
6. Apply protection and capability boundaries.
7. Select only a strategy that can produce the named output honestly.

Ambiguous paths fail closed or expose a limited manifest/playlist action. Detection does not imply permission to download.

## Action matrix

| Evidence | Allowed action | Important conditions |
| --- | --- | --- |
| HTTP(S) progressive video/audio | Save final media | Supported extension or clear media MIME; fresh evidence; file type enabled. |
| Opaque HTTP(S) final file | Save final media | Strong Content-Disposition filename, Content-Range, media MIME, or other final-file evidence. |
| `blob:` video/audio | Page-local save handoff | Source tab and frame still available; cannot be retried after context loss. |
| HLS media/master playlist | One of the implemented HLS methods | Playlist inspected; no encryption; finite/bounded layout; selected variant is self-contained where required. |
| DASH MPD | Save manifest | Never presented as an assembled final video. |
| Subtitle/caption | Save file | Type enabled and response is not an HTML/login page. |
| Poster/thumbnail/image | Save companion file | Image type enabled and explicitly chosen; never preferred over primary media. |
| JSON/XML metadata | Save metadata | Disabled by default; must be explicitly enabled. |
| Standalone MPEG-TS | Save final media | Strong top-level/final-file evidence; not merely a playlist segment. |

## Signed or expiring URLs

Signed top-level final files may use Chrome's normal direct download when evidence shows one complete file. Media Scout does not refresh, reuse, or bypass expired authorization.

Signed HLS/DASH top-level manifests may be saved as text where allowed. Tokenized segments, partial fragments, and component URLs are not merged. Query keys are treated as protection hints; they are not logged or persisted intentionally.

## HLS methods

| Method | Output | Boundary |
| --- | --- | --- |
| Smart MP4 | MP4 when compatible, otherwise safer TS fallback | Probes codec/layout evidence and reports the actual path. |
| MP4 remux | MP4 | MPEG-TS with supported H.264/AAC-style layout only. |
| Timestamp-fixed TS | TS | Rewrites bounded transport-stream timing where supported. |
| Raw TS concat | TS | Fast fallback; UI warns about possible sync/seek issues. |
| Playlist only | `.m3u8` text | Does not claim to include media segments. |
| External helper | `.txt` instructions | Produces local notes with POSIX-safe shell quoting; does not execute a helper. |

The following are not complete built-in video paths: encrypted HLS, DRM-marked media, fMP4/CMAF assembly, separate audio without a visible self-contained variant, low-latency partial playlists, unbounded live streams, and empty or oversized segment sets. Built-in inspection fails closed above 200 HLS variants, 100 audio renditions, or 6,000 media segments.

## Response evidence

- An HTML response blocks a media-looking URL because it may be a login, error, or paywall page.
- A trustworthy media MIME can override a misleading filename extension when other final-file evidence agrees.
- Content-Disposition filenames are sanitized and must identify an enabled type.
- Content-Range can support a final-file decision when it describes one bounded resource.
- Image or metadata candidates remain lower priority than streams and progressive media.

## Fail-closed categories

No automatic retry or alternate strategy may bypass these categories:

- DRM or encryption;
- authentication, paywall, or access control;
- permission denial;
- CORS failure;
- signed/expiring component URLs;
- unsupported layout;
- invalid input;
- user cancellation.

Transient network errors may be retried within the configured bound. A retry always uses current evidence and the same protection policy.

## Data and UI requirements

- The popup and side panel must use the same policy model.
- Disabled actions must explain why they are unavailable.
- Queue status must distinguish complete, failed, canceled, interrupted, and verification-uncertain outcomes.
- Default reports redact full URLs and exclude headers, cookies, tokens, and screenshots; page titles, hostnames, and filenames remain review-required context.
- Default URL summaries retain query-parameter counts, never query-parameter names or values.
- The scanner caps and prioritizes candidates before crossing the content-script message boundary.

Run `npm test` after changing this policy and complete the HLS, negative-fixture, queue, and privacy sections of [`TEST_PLAN.md`](TEST_PLAN.md).
