# Known limitations — 3.7.13

Media Scout Downloader works only with media that the browser and current page normally expose and that the user is authorized to save. It does not decrypt DRM or encrypted HLS, bypass authentication/paywalls/access controls, defeat CORS, manufacture expired signed URLs, or discover media hidden from the browser.

## Browser and platform scope

- The supported publication matrix is Windows 11 with the exact Chrome and Brave versions recorded in the final evidence. The manifest's minimum Chrome version is an API floor, not proof that every intermediate version was tested.
- macOS, Linux, other Chromium browsers, and mobile browsers are not claimed as tested platforms for 3.7.13.
- Browser permission prompts, Save As dialogs, download verification, and screen-reader output include manual acceptance steps and cannot be inferred from source-only automation.

## Media paths

- Progressive HTTP(S) video/audio and selected companion files can use the browser download handoff when current evidence and settings allow it.
- DASH remains manifest-only; Media Scout does not assemble DASH representations.
- fMP4/CMAF, byte-range, separate-audio, low-latency, event/live, and other complex HLS layouts are playlist-only or unsupported unless a clearly self-contained safe fallback exists.
- Page-local Blob actions require the original source tab and page context to remain available.
- Signed or expiring URLs are treated conservatively and may be refused even when the user has legitimate access.
- Browser download completion cannot independently prove media integrity, playback quality, or the absence of an OS/browser Save As prompt.

## Experimental HLS merge/remux

- Built-in finite unencrypted MPEG-TS HLS merge/remux is experimental.
- Structural ceilings are 6,000 segments, 24 MiB per segment, 128 MiB aggregate bytes, 200 retained variants, 100 audio renditions, and 4 MiB playlist text.
- Estimated streams are rejected at about 83.2 MiB, before the hard aggregate ceiling.
- A constrained 256 MiB V8-heap Node proxy is not equivalent to a low-memory browser/device test. No low-memory safety claim is made.
- Raw TS concatenation may have timestamp/audio-sync limitations; the UI describes safer alternatives.

## Privacy and diagnostics

- Runtime candidates necessarily contain page/media context in extension memory while the user inspects or downloads them.
- Redaction reduces accidental disclosure but is not anonymization. Correlation hashes can still link repeated values inside one report.
- Sensitive URL mode is opt-in and separately confirmed; users remain responsible for reviewing the literal preview before export and deleting exported files when no longer needed.
- Novel identifier formats that do not resemble known paths, URLs, filenames, or secrets may require manual review.

## Release and store status

- A GitHub source publication is not a Chrome Web Store listing.
- The extension ZIP is not claimed to be signed.
- No user count, download count, production adoption, universal compatibility, legal-compliance, vulnerability-free, WCAG-conformance, or “downloads anything” claim is made.
