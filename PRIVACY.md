# Privacy

Media Scout Downloader is local-first. It has no analytics service, advertising SDK, telemetry endpoint, cloud account, developer-operated backend, database, or remote-configuration channel. The extension does not sell user data or send browsing data to the developer or an analytics provider.

## Data the extension handles

To provide its user-facing media detection and download workflow, Media Scout can process website content and resources visible to the active page, including the current tab title and URL, media/resource URLs, selected response metadata, media-element metadata, iframe and Resource Timing evidence, and the user's download choices. Under Chrome Web Store terminology, website content/resources and the related URL/domain activity are user data even when processing is entirely local.

The extension does not request Chrome cookie, browsing-history, clipboard, debugger, tab-capture, or request-blocking permissions. It does not read request bodies or request headers. Its non-blocking `webRequest` listeners use response content type, content length, content disposition, request URL, resource type, and completion state only for tabs the user has actively scoped. Chrome exposes those observations only where the extension has applicable tab/host access.

## Permission and network behavior

- `activeTab` gives temporary access after the user invokes the extension.
- HTTP(S) host access is optional. The user can grant only the current origin or deliberately grant all HTTP(S) origins, and can revoke access later.
- `scripting` injects only code packaged with the extension into the active or user-authorized page.
- `webRequest` observes non-blocking media-response metadata on scoped, permitted tabs; it does not modify traffic.
- `downloads` saves a user-selected media item, helper note, or report through the browser's download UI.
- Page-context or service-worker `fetch()` calls are limited to media/manifest resources involved in a user-visible scan or download. They contact the resource's own origin under normal browser rules, not a developer service, and they do not add account data or developer tracking parameters.
- `storage`, `sidePanel`, and `notifications` support local settings/state, the workspace UI, and optional completion feedback.

## Local storage and retention

- Settings remain in `chrome.storage.local` until changed, cleared with the browser's extension data controls, or removed with the extension.
- Diagnostics retain bounded strategy names, generic outcomes, error categories, counters, and timestamps. Full URLs, filenames, raw errors, headers, and page content are not intentionally persisted in diagnostics.
- Queue recovery retains privacy-reduced task metadata for the configured period from 0 to 30 days (default 7). Persisted entries omit media/page URLs, hostnames, filenames, output names, and raw error/progress text. Lowering retention clears older history immediately; explicit clearing is serialized after pending writes so an older write cannot restore cleared history.
- Current tab titles, URLs, candidates, and runtime task details remain in extension memory while needed. Navigation, tab closure, cache clearing, or extension/service-worker lifecycle changes clear or invalidate that evidence.
- Warning and opt-in debug console messages pass through URL, credential, secret-shaped-field, filename-like text, and local-path redaction. Console availability and retention are controlled by the browser.

## Diagnostic reports

Reports are generated only when the user requests them. The Reports workspace shows a field-by-field exposure table and the literal text of every generated file before export.

Default reports omit page titles and filenames; replace hostnames and URL paths with correlation hashes; omit query names and values; and redact URL credentials, local paths, blob identifiers, secret-shaped fields, and secret-like diagnostic text. Screenshots are not generated in any report mode.

Sensitive URL mode requires both a saved setting and a separate confirmation for each generated preview. It can include exact titles, hostnames, filenames, URL paths, and non-secret query names/values. URL credentials, secret-shaped fields/parameters, local paths, and blob identifiers remain redacted. Sensitive reports can still identify private activity and should not be shared without inspecting every file.

Preview contents live only in the open extension page and are invalidated when source or report inputs change. The extension does not retain a copy of an exported ZIP. The browser and operating system control the downloaded file; users should delete it manually when it is no longer needed.

## Sharing and deletion

Media Scout does not automatically share handled data with the developer, advertisers, data brokers, or other third parties. A user can deliberately download media, save helper notes, or export and share a report; those user-directed files may contain context disclosed in the UI and become the user's responsibility after export.

Use Diagnostics to clear queue history, detected media, or learning data within their named scopes. Browser extension-data controls or uninstalling the extension remove remaining extension-managed local storage.

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

This document describes the public-source `3.7.13` prerelease candidate. Public source availability is not a claim of legal compliance, a supported binary release, or Chrome Web Store approval.
