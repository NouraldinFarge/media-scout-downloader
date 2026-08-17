# Controlled browser fixtures

These fixtures exist only to test Media Scout Downloader on media the project owner is authorized to use. They are synthetic, contain no third-party footage, and are excluded from the extension upload package.

## Provenance

- Visual source: FFmpeg `testsrc2` and `color` generators.
- Audio source: FFmpeg `sine` generator.
- Subtitle text: original project test copy.
- Artwork: a solid-color FFmpeg-generated PNG with no third-party source material.
- Fixture names and metadata: fictional project test data.
- Generator: `test-harness/generate-fixtures.mjs`.

Run `npm run fixtures:generate` with FFmpeg available on `PATH`, or set `MEDIA_SCOUT_FFMPEG` to an exact FFmpeg executable. The generator replaces only `test-fixtures/site/generated` after validating that exact destination.

The fixture server also exposes controlled failure simulations for empty, slow, authenticated, expired-link, cross-origin, protected HLS, fMP4/CMAF-like, separate-audio, live, low-latency, and oversized playlist cases. These simulations do not bypass any access control.
