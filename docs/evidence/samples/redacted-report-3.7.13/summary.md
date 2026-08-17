# Media Scout Downloader detection report

Generated: 2026-08-17T17:00:00.000Z
Active tab title: [title omitted by default]
Active tab URL: https://host-sennqh/path-i42jla?params=2
Origin permission: granted (https://host-sennqh/path-3hmri)

## Summary counts

- Popup media items: 1
- Popup item groups: video:1
- Protected/unsupported popup items: 0
- Page scan candidates accepted by the basic DOM scanner: 1
- Page scan candidates rejected by the basic DOM scanner: 0
- Accessible frames scanned: 1
- Top-page iframe elements: 0
- Media elements across scanned frames: 1
- Page-embedded media URL hints: 0
- Media-looking performance entries: 1
- Playlist/manifest probes attempted: 0
- Interesting non-media-confirmed resource hints: 0
- Queue active/pending/completed/failed: 0/0/0/0



## Likely reasons a visible video was not listed

- Media Scout found supported media. If another extension shows a different item, compare its URL/type with detected-media.json and decision-log.json.

## What Media Scout accepted into the popup

- mp4 video from host-wxfefg — detected

## Observed media/player clues

- media element: video 1280×720, frame host-sennqh
- Performance resource: mp4 from host-wxfefg via video

## Playlist/manifest probe details

- No playlist/manifest probes were attempted.

## Recent HLS/remux results

- No recent completed or failed HLS/remux tasks were available in this report.

## Rejection reason counts from page scan

- No rejected basic-scan candidates.

## Next diagnostic steps

- Start playback, then press Rescan and Generate report again. Many players load media lazily only after playback begins.
- Grant active site access from the popup, refresh the page, play the video, and generate another report to include future network-request observations.
- If page-scan.json shows the player inside a different iframe origin, grant broader site access from Options or test on a page where Chrome permits that frame to be scanned, then refresh and generate another report.
- Compare decision-log.json with what the other extension reports. If the other item is encrypted, signed, DRM-protected, or site-specific, Media Scout is expected to skip it.
- Review page-scan.json for blob: URLs, empty currentSrc values, missing source tags, frame scan coverage, literal media URL hints, media-like resource timing entries, and iframe/player hints.
