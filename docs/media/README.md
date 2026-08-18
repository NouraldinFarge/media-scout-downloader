# Recruiter media provenance

These images were captured on August 17, 2026 from the unpacked Media Scout Downloader `3.7.13` runtime at commit `aeda9d2e703e5292939643255a8926244a1fa934`.

The capture used the lockfile-pinned Playwright Chromium build (`playwright-core 1.62.1`, Chromium `151.0.7922.34`) in a disposable Playwright Chromium profile on Windows. The extension interacted only with its loopback-controlled fixture server and generated test state. No daily browser profile, account, personal media, private URL, browsing history, extension identifier, local path, or secret is represented.

| Asset | What it shows | Data classification |
| --- | --- | --- |
| `inspector-route.png` | A real side-panel Inspector render with one generated candidate after the 750-item bounded-render test. | Synthetic candidate and loopback URL only. |
| `report-route.png` | The real Report Preview route and its default, always-on, and separately confirmed redaction boundaries. | Empty local report state. |
| `settings-overview.png` | The real settings hero, local defaults, queue retention, and permission-health controls. | Default settings in a disposable profile. |
| `github-social-preview.png` | A repository preview composed from the real report-route capture, packaged icon, and verified engineering facts. | Synthetic presentation; no product-release claim. |

`npm run media:verify` checks PNG signatures, exact dimensions, absence of text/EXIF metadata chunks, README references, capture provenance, and the targeted coverage disclaimer. These assets document a public-source unreleased prerelease; they are not Chrome Web Store media, a supported binary, or evidence that the remaining manual gates are complete.
