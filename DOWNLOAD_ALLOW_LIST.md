# Media Scout Downloader download allow list

This allow list defines what the extension should download. Anything outside this list should be shown as unsupported, warning-only, or diagnostic-only rather than attempted as a download.

## Always-required checks

Every download action must pass these checks first:

1. The URL is valid and uses an allowed scheme for that action.
   - Direct downloads: `http:` or `https:` only.
   - Page-local blob downloads: `blob:` only, and only from the same live tab/frame.
2. The item must be a known media/companion type from the registry and the file type must be enabled in settings.
3. Signed, expiring, tokenized, or authorization-style query hints such as `signature`, `sig`, `token`, `expires`, `X-Amz-Signature`, or `X-Goog-Signature` are evaluated by action scope. Top-level file-save actions may pass the exact URL to Chrome Downloads, while segment/component fetching and merge/conversion actions remain blocked.
4. The extension must not fetch segments, merge streams, decrypt, or reuse component URLs when encryption, DRM, protected components, auth, paywall, CORS, or access-control markers are detected.
5. If a stream cannot be converted safely, the extension may still allow saving a top-level manifest/playlist file when that top-level URL itself is safe. That action must be labeled as manifest/playlist text, not as video download.

## Allowed direct file downloads

| Category | Examples | Allowed action | Conditions |
|---|---|---|---|
| Progressive video | `.mp4`, `.m4v`, `.webm`, `.mov`, `.mkv`, `.avi`, `.mpeg`, `.flv`, `.wmv`, `.3gp`, `.mxf` | Save original file | HTTP(S), enabled file type or video MIME, no hard protection marker. Signed/tokenized top-level URLs are allowed only as direct Chrome downloads. |
| Progressive audio | `.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg`, `.opus`, `.flac`, `.aiff`, `.amr`, `.mid` | Save original file | HTTP(S), enabled file type or audio MIME, no hard protection marker. Signed/tokenized top-level URLs are allowed only as direct Chrome downloads. |
| Images/posters | `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, `.gif`, `.apng`, `.svg`, `.bmp`, `.ico`, `.tif` | Save original file | HTTP(S), enabled file type or image MIME. Signed/tokenized top-level URLs are allowed only as direct Chrome downloads. |
| Subtitles/captions | `.vtt`, `.srt`, `.ttml`, `.dfxp`, `.smi`, `.ass`, `.ssa`, `.lrc`, `.sbv` | Save original file | HTTP(S), enabled file type or subtitle MIME. Signed/tokenized top-level URLs are allowed only as direct Chrome downloads. |
| Standalone segments/fragments | `.ts`, `.m2ts`, `.mts`, `.m4s`, `.cmfv`, `.cmfa`, `.part` | Save raw segment only | HTTP(S), enabled file type, no encrypted-playlist association, no signed/tokenized top-level URL. Must not be presented as a final assembled video. |
| Other manifests/playlists | `.m3u`, `.ism`, `.isml`, `.f4m` | Save manifest/playlist file | HTTP(S), enabled file type or MIME, no hard protection marker. Signed/tokenized top-level URLs are allowed only as manifest-file saves. |

## HLS-specific allow list

| HLS action | Allowed when | Blocked when |
|---|---|---|
| Smart MP4 / MP4 remux / timestamp-fixed TS / raw TS | Top-level `.m3u8` is HTTP(S), no `#EXT-X-KEY`, no protected component URLs, no `#EXT-X-MAP`, no `#EXT-X-BYTERANGE`, and the page context can normally fetch segments. | Encrypted HLS, signed/tokenized playlist/variant/segment/audio URLs, fMP4/CMAF map playlists, byte-range playlists, auth/CORS/paywall/access-control failure, or missing live page context. |
| M3U8 playlist only | Top-level `.m3u8` URL itself is HTTP(S). Signed/tokenized top-level URLs are allowed for playlist-file saving only. | Invalid/unsupported scheme or inaccessible to Chrome download. |
| External helper notes | Non-encrypted/non-tokenized HLS where the top-level playlist URL is safe. | Encrypted, DRM, signed/tokenized, auth, paywall, or access-control protected HLS. |

Important: when HLS conversion is blocked because the stream is encrypted, fMP4, or byte-range, the extension can still offer **M3U8** if the top-level playlist file itself is safe. This avoids blocking a file that Chrome can normally save while still refusing to fetch/decrypt/merge protected media.

## DASH-specific allow list

DASH `.mpd` items are allowed as manifest-file downloads when the top-level MPD URL itself is HTTP(S). Signed/tokenized top-level MPD URLs are allowed for manifest-file saving only. Even if `ContentProtection` is present, the extension may save the MPD text file, but it must not fetch segments, merge, decrypt, or present the action as a video download.

## Explicitly not allowed

- `javascript:`, `file:`, `chrome:`, `data:` direct media URLs, and other unsupported schemes.
- Tokenized/signed/expiring URLs when used as stream components, raw segments, HLS/DASH merge inputs, or bypass/reuse material. Top-level direct file-save URLs are handled by the action-scoped rules above.
- Encrypted HLS conversion or encrypted segment saving.
- DASH segment fetching, decryption, or merging.
- Media Source Extensions blob placeholders where the blob is only a player buffer and not a standalone file.
- Cross-origin or page-context fetches that fail normal browser/CORS/auth rules.
- Unrecognized file types or file types disabled in Options.

## v3.6.13 refinement: action-scoped signed URL handling

Signed, tokenized, or expiring URLs are not all equivalent. The allow list now distinguishes between **passing a top-level URL unchanged to Chrome Downloads** and **fetching/reusing stream component URLs**.

Allowed as direct file-save actions:

- Top-level progressive video/audio files such as `video.mp4?token=...` when there is no DRM/encryption/auth/paywall marker.
- Top-level image/subtitle files such as poster images or `.vtt` captions with signed CDN URLs.
- Top-level HLS `.m3u8` files saved with the **M3U8** action only.
- Top-level DASH `.mpd` files saved as manifest XML only.
- Top-level Smooth/HDS/M3U manifests saved as manifest text only.

Still blocked:

- Signed/tokenized HLS merge/remux, because merging would fetch and reuse playlist, variant, segment, or audio rendition component URLs.
- Signed/tokenized raw segments such as `.ts`, `.m4s`, `.cmfv`, `.cmfa`, or `.part`.
- Encrypted HLS conversion, DASH segment fetching, DRM, paywall, auth, CORS, or access-control failures.
- Any action where the URL is not `http:`/`https:` or the file/MIME type is not allow-listed or enabled.

The popup now exposes the action-by-action decision list so users can see, for example, that **M3U8** is allowed while **Smart MP4** is blocked for the same playlist.

## v3.6.14 deeper decision metadata

Each allow-list decision now carries these user-visible fields where useful:

| Field | Meaning |
|---|---|
| `actionLabel` | Human-readable action, such as “Save final media file” or “Merge/remux HLS to media file”. |
| `confidence` | `high`, `medium`, or `conditional`. `conditional` means the item is structurally allowed but runtime page-context checks still have to verify fetch access, encryption state, and component URLs. |
| `outputKind` | What the user actually gets: final media, transport-stream file, raw segment, manifest file, companion file, helper notes, or assembled media. |
| `riskFlags` | Concise flags such as `signed-top-level-url`, `page-context-fetch`, `cross-origin-playlist`, `not-fully-inspected`, `hls-discontinuity`, `live-or-event-playlist`, `low-latency-hls`, `fmp4-cmaf`, or `byte-range-media`. |
| `fallbackAction` / `safeFallbackMethod` | Safer alternative when the selected action is blocked, usually saving the top-level playlist/manifest file. |

## v3.6.14 HLS refinements

HLS is allowed for built-in merge/remux only when it looks like a finite, non-encrypted MPEG-TS playlist that Media Scout can process without fetching protected component URLs. The following cases are **not** allowed for built-in video assembly, but may still allow saving the top-level M3U8 playlist file:

- encrypted playlists (`#EXT-X-KEY` or session keys);
- fMP4/CMAF playlists (`#EXT-X-MAP`);
- byte-range playlists (`#EXT-X-BYTERANGE`);
- live/event playlists without `#EXT-X-ENDLIST`;
- low-latency playlists with `#EXT-X-PART` or `#EXT-X-PRELOAD-HINT`;
- I-frame-only playlists;
- separate-audio master playlists when the selected output would imply a complete MP4/TS file;
- signed/tokenized playlist, variant, audio-rendition, or segment component URLs.

Cross-origin or otherwise uninspected HLS can remain **conditionally** allowed for merge only when no known hard block is visible. Runtime checks still fail closed before component fetching/merging if encryption, protected component URLs, CORS/auth failure, fMP4, byte ranges, low-latency parts, or live-only structure becomes visible.

## v3.6.14 standalone MPEG-TS exception

Most `.ts`, `.m4s`, `.cmfv`, `.cmfa`, and `.part` URLs are stream internals, not complete media files. The allow list still blocks signed/tokenized stream components and encrypted/protected segment associations.

A narrow exception exists for standalone MPEG-TS files:

- extension is `.ts`, `.m2ts`, or `.mts`;
- no playlist/probe/protection association is present;
- the item has strong final-file hints, such as being the direct source of a media element, or having `video/mp2t` MIME plus a large response/duration;
- if signed/tokenized, the exact top-level URL is only passed to Chrome Downloads and is not reused as a stream component.

This prevents downloadable transport-stream files from being blocked merely because they share an extension with HLS segments, while keeping HLS internals strict.


## v3.6.15 deeper allow-list refinements

### HLS master playlists with separate audio renditions

Do not treat every master playlist containing `#EXT-X-MEDIA:TYPE=AUDIO` as undownloadable. The allow list now distinguishes between:

- **variants that require separate audio**, identified by an `AUDIO="..."` group reference, even when the matching `EXT-X-MEDIA:TYPE=AUDIO` rendition has no separate `URI`; and
- **self-contained variants**, usually variants without an `AUDIO` group reference and, when available, with audio codecs such as `mp4a`, `aac`, `ac-3`, `ec-3`, `opus`, `vorbis`, or `flac` in `CODECS`.

Allowed:

- non-encrypted, finite MPEG-TS HLS where a self-contained variant is visible;
- the selected self-contained variant is fetched using normal page-context browser rules;
- if the user's highest/lowest preference points to a separate-audio variant, Media Scout may fall back to the closest self-contained variant rather than pretending it can merge separate audio.

Blocked:

- masters where all visible variants require separate audio renditions;
- any separate-audio HLS that is also encrypted, signed/tokenized at component level, fMP4/CMAF, byte-range, low-latency, I-frame-only, live/event-only, or otherwise unsupported.

Safe fallback:

- save the top-level `.m3u8` playlist text when that top-level playlist URL itself is safe.

### Metadata files

Media metadata files such as `.json` and `.xml` remain disabled by default because they are noisy and often represent site APIs rather than user-facing media. When the user explicitly enables those file types in Options, direct top-level metadata files can be saved if:

- the URL is HTTP(S);
- the extension/MIME type is recognized as metadata;
- there is no hard DRM/authentication/paywall/access-control marker;
- signed/tokenized top-level URLs are only passed unchanged to Chrome Downloads and are not parsed for components.

### MIME-inferred media

If a detected item has an unhelpful URL such as `/download?id=123` or an unknown extension, the allow list can now infer the action from a clear allow-listed MIME type such as `video/mp4`, `audio/mpeg`, `text/vtt`, or `image/png`. File-type settings still apply.

### Stronger standalone MPEG-TS hints

A `.ts`, `.m2ts`, or `.mts` item can be treated as a standalone file when it has strong final-file evidence, including:

- direct `<video>` / `<source>` use;
- `video/mp2t` plus large size or meaningful duration;
- `Content-Disposition: attachment` from the browser response headers.

Signed/tokenized HLS segments and protected playlist-associated segments remain blocked.

## v3.6.16 final-file evidence override

Some legitimate CDN downloads look like stream internals by URL, for example a path ending in `.m4s` or a tokenized endpoint that was initially grouped as a segment. v3.6.16 adds a narrow override so these are not falsely blocked when the response strongly proves that the URL is a standalone final file.

The override can allow a segment-shaped URL as a direct final-media download when all of the following are true:

- The item is not associated with an HLS/DASH playlist or encrypted/protected playlist probe.
- The response MIME is clearly final audio/video, such as `video/mp4` or `audio/mp4`, not `video/iso.segment` or `audio/iso.segment`.
- There is strong standalone-file evidence, such as `Content-Disposition: attachment`, a DOM `<video>/<audio>/<source>` origin, a large transfer size, or a meaningful media duration.
- Signed/tokenized URLs are passed through only to Chrome Downloads and are not reused as stream components.

Low-latency `.part` fragments, signed raw segments, fMP4/CMAF HLS components, encrypted playlist components, and playlist-associated segment hosts remain blocked for raw segment downloading or merging.

## v3.6.16 HLS finite-playlist refinements

HLS merge eligibility now distinguishes missing `#EXT-X-ENDLIST` more carefully:

- `#EXT-X-PLAYLIST-TYPE:EVENT` or no playlist type plus missing `#EXT-X-ENDLIST` is treated as live/event and is playlist-save only.
- `#EXT-X-PLAYLIST-TYPE:VOD` plus missing `#EXT-X-ENDLIST` is treated as conditional rather than automatically blocked, because some finite VOD playlists are malformed but still bounded. Runtime checks still block encryption, fMP4/CMAF, byte ranges, signed components, separate audio, and fetch failures.
- fMP4/CMAF segment URLs such as `.m4s`, `.cmfv`, and `.cmfa` block the MPEG-TS merger even if `#EXT-X-MAP` was not present.


## v3.6.17 HLS segment-count policy details

Media Scout now separates **what can be saved** from **what can be assembled** and includes segment-count evidence in HLS decisions:

- **Exact media playlist count:** A plain media playlist with full `#EXTINF` segment entries shows the number of full segments directly.
- **Selected variant count:** A master playlist may not contain media segments itself. When the selected variant playlist is same-origin and normally fetchable, Media Scout probes that selected variant and displays its segment count.
- **Runtime-only count:** If the selected variant cannot be counted safely in the background, the merge action stays conditional. The content-script runtime still fetches, validates, counts, and reports the selected media playlist before segment fetching begins.
- **Empty playlist:** A media playlist with zero full media segments is not eligible for merge/remux. Saving the `.m3u8` text remains allowed when the top-level playlist URL is otherwise safe.
- **Large playlist:** Large segment counts are not blocked by count alone. They are labeled with risk flags so users can understand that a download may take longer or use more memory/network.
- **Partial segments:** Low-latency `#EXT-X-PART` partial segments are counted separately from full media segments and remain blocked for built-in finite-file merge.

## v3.6.18 evidence-based direct-file refinements

The allow list now separates **classification evidence** from **download action scope**.

### Evidence that can allow a final top-level file

A direct file can be allowed even when the URL path is generic or misleading when enough safe evidence exists:

- allow-listed URL extension, such as `.mp4`, `.webm`, `.mp3`, `.vtt`, or `.jpg`;
- response MIME type, such as `video/mp4`, `audio/mpeg`, `text/vtt`, or `image/png`;
- `Content-Disposition: attachment` with an allow-listed filename extension;
- DOM media evidence, such as a direct `<video>`, `<audio>`, or `<source>` URL;
- meaningful response size or media duration that supports a final-file classification.

Examples that should be allowed as **direct top-level Chrome Downloads** when no DRM/encryption/auth/paywall marker is present:

- `/download?id=123` with `Content-Type: video/mp4`;
- `/download?id=123` with `Content-Disposition: attachment; filename=movie.mp4` and `Content-Type: application/octet-stream`;
- `/asset.m4s?token=...` with `Content-Disposition: attachment; filename=clip.mp4` and final-file size evidence.

These cases are direct file saves only. Media Scout passes the exact top-level URL to Chrome Downloads and does not parse it as a stream component.

### Evidence that does not open stream-internal paths

The following remain blocked for merge/remux or raw stream-component download unless they also have strong final-file evidence and are used only as a top-level direct file save:

- signed/tokenized HLS segment URLs;
- playlist-associated `.ts`, `.m4s`, `.cmfv`, `.cmfa`, or `.part` URLs;
- encrypted/protected HLS segment hosts discovered by report or page probe;
- fMP4/CMAF HLS internals;
- low-latency partial fragments.

### File-type settings still apply

Attachment-filename inference respects user file-type settings. For example, if `.mp4` is disabled in Options, an octet-stream attachment named `movie.mp4` is blocked even though the filename identifies it as video.

### Decision details

Popup decision details can now include:

- `evidence=high|medium|conditional`;
- evidence flags, such as `attachment-filename`, `response-mime`, `content-disposition-attachment`, `dom-media-source`, `large-response`, or `media-duration`;
- inferred extension, such as `inferred=.mp4`;
- HLS recommendations, such as `recommended=timestamp-fixed-ts` for discontinuous finite playlists.

## v3.6.19 range and codec evidence refinements

### Range-probed final media

Some servers expose final media files through URLs that look like stream internals, or through a first range response instead of a complete response. The allow list now treats safe response-header evidence as part of final-file classification.

A segment-shaped URL may be allowed as a **direct top-level Chrome Download** when the item has final-media evidence such as:

- `Content-Type: video/mp4` or another allow-listed final media MIME;
- `Content-Range: bytes start-end/total` with a media-sized total;
- `Accept-Ranges: bytes`;
- existing final-file evidence such as DOM media source, media duration, response size, or `Content-Disposition: attachment`.

This only changes direct file saving. The URL is not reused as an HLS/DASH component, not decrypted, not remuxed, and not fetched by background code.

### Codec-aware HLS output decisions

The built-in MP4 remuxer is intentionally narrow: it remuxes finite, non-encrypted MPEG-TS containing H.264 video and AAC audio. The allow list now reads visible `CODECS` metadata from the selected HLS variant when available.

- **MP4 Remux** is blocked when codecs explicitly advertise unsupported profiles such as HEVC/H.265, Dolby Vision, VP9, AV1, MPEG-2 video, AC-3, E-AC-3, Opus, FLAC, or MPEG audio.
- **Smart MP4** remains allowed in those cases because runtime can fall back to timestamp-fixed MPEG-TS.
- **Timestamp-fixed TS** and **Raw TS** remain available when the stream is otherwise safe MPEG-TS HLS.
- **M3U8** remains available for safe top-level playlist saving even when conversion/remux is not compatible.

This reduces false confidence without over-blocking content that can still be saved as MPEG-TS.

## v3.6.20 MIME/header conflict rules

The allow list no longer treats the URL extension as the single source of truth. For each direct-file action, the policy weighs these evidence sources:

- URL extension, such as `.mp4` or `.jpg`;
- response MIME type, such as `video/mp4`;
- `Content-Disposition` filename hints, including both `attachment` and `inline` filenames;
- DOM media source evidence, such as `<video>`, `<audio>`, or `<source>`;
- range/final-file headers such as `Content-Range`, `Accept-Ranges`, and media-sized byte totals;
- media duration and response size.

### Allowed conflict examples

These can be allowed as **direct top-level Chrome Downloads** when file-type settings permit the inferred type:

- `/download?id=123` with `Content-Type: video/mp4`;
- `/poster.jpg` with `Content-Type: video/mp4` and media-sized response evidence;
- `application/octet-stream` with `Content-Disposition: inline; filename="clip.webm"`;
- segment-shaped final files such as `/asset.m4s?token=...` when headers prove they are standalone final media.

### Blocked conflict examples

These are blocked even if the URL extension looks downloadable:

- `/video.mp4` returning `text/html`;
- `/movie.webm` returning `application/json` or an XML error body;
- `/playlist.m3u8` returning `text/html`;
- manifest URLs whose response MIME indicates a final media/image/subtitle file rather than a manifest.

The conflict rules do not loosen stream-internal protections. Signed HLS/DASH components, playlist-associated segments, encrypted streams, low-latency partial fragments, fMP4/CMAF internals, and unsupported HLS merge modes remain blocked for conversion/remux.
