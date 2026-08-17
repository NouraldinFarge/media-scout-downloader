# DRAFT — NOT PUBLICATION APPROVED

# Chrome Web Store disclosure package

Candidate: Media Scout Downloader `3.7.13` public-source prerelease candidate

Prepared: 2026-08-17

Status: local draft only; public source availability does not authorize a dashboard item, binary upload, store submission, or publication claim.

## Current primary-source basis

This draft was checked against current official Chrome material on 2026-08-17:

- [Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies): accurate metadata, single purpose, minimum permissions, user-data disclosure, Limited Use, secure handling, and packaged/reviewable functionality.
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use/): browsing activity only for a prominently described user-facing feature; no unrelated use, advertising, resale, or unapproved human access.
- [User-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/): website content/resources and browsing activity are user data, and local-only processing still requires disclosure and a privacy policy.
- [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy): single-purpose and permission justifications must be accurate and minimum-scope.
- [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) and [Optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions): use runtime optional host grants where functionality permits.
- [Manifest V3 security guidance](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security): extension logic must be packaged; remotely hosted executable code is not used.

Policies can change. They must be rechecked immediately before any submission. This document records engineering observations, not legal advice or a guarantee of approval.

## Canonical product purpose

**Single-purpose statement**

> Media Scout Downloader helps a user identify and save media resources that an active, user-authorized web page has already exposed to the browser, with local inspection, explicit download choices, and fail-closed handling for protected or unsupported media.

The popup recommendation, inspector, queue, controlled HLS handling, diagnostics, and report preview all support that single media-identification/download purpose. Batch behavior is limited to visible same-series links and does not brute-force hidden pages. External-helper notes are a disclosed fallback artifact, not a remote service or hidden downloader.

## Draft store description

Media Scout Downloader is a local-first Manifest V3 extension for inspecting media resources already visible to the active page and saving supported items through Chrome's download UI.

It can identify progressive video/audio, HLS and DASH manifests, subtitles, artwork, and selected supporting media evidence. The popup recommends one current action; the side panel provides candidate inspection, a bounded queue, recovery details, and a privacy-reviewed diagnostic report.

Website access is optional. Basic active-tab scanning begins after the user opens the extension. Users can grant the current origin—or deliberately grant all HTTP(S) origins—for future response-metadata detection and can revoke that access later.

Media Scout does not decrypt DRM, defeat encryption, bypass authentication or paywalls, reuse signed or expiring protected components, evade CORS, or claim unsupported stream layouts are complete videos. Use it only for media you own or are authorized to download.

No analytics, ads, developer backend, account, telemetry, or remote configuration is used. Website content and browsing/resource activity needed for the visible feature are processed locally. See the privacy policy for exact data, retention, report, and deletion behavior.

## Permission justifications

| Permission | Draft dashboard justification | Engineering verification | Owner/store judgment |
| --- | --- | --- | --- |
| `activeTab` | Temporarily inspects the page the user invokes Media Scout on, including its visible media evidence. Access ends with tab navigation/closure under Chrome's model. | Used for active-tab state and packaged scanner injection. | Confirm wording in the live permission review UI. |
| `downloads` | Saves the user-selected supported media file, helper note, or explicitly reviewed diagnostic ZIP and monitors that browser download's completion state. | Used only on explicit actions; ambiguous/missing handoffs fail without duplicate retry. | Confirm browser warning text and store questionnaire mapping. |
| `scripting` | Injects only scanner/remux code bundled in the extension into the active or user-authorized tab; no remote code is injected. | Manifest CSP/local import checks pass. | None identified beyond store review. |
| `storage` | Stores validated settings, bounded generic diagnostics, and privacy-reduced queue-recovery metadata locally. | Persistent schemas omit page/media URLs, titles, hostnames, filenames, and raw errors. | Privacy-policy URL must be live before submission. |
| `webRequest` | Observes non-blocking media response metadata for currently scoped tabs on origins the user has permitted. It does not block, redirect, or modify requests and does not read request bodies/headers or cookies. | Listeners use `onHeadersReceived`/`onCompleted`; retained header hints are content type/length/disposition-derived. | This access processes browsing/resource activity and must be declared accurately. |
| `sidePanel` | Provides the named Inspector, Queue, Batch, Reports, Diagnostics, and Help workspace supporting the extension's single purpose. | Packaged side-panel page only. | None identified. |
| `notifications` | Shows optional generic download completion/failure feedback controlled by the local Notifications setting. | No page title/URL is required in the permission justification. | Reassess whether this can become an optional API permission before submission. |
| Optional `http://*/*`, `https://*/*` | Lets the user grant only a discovered current origin at runtime or deliberately opt into all HTTP(S) sites for future media-response detection. It is not an install-time host grant. | Manifest uses `optional_host_permissions`; current-site request is origin-bound and UI-gesture initiated. | Confirm whether HTTP support is appropriate for final distribution/security posture. |

No cookie, history, clipboard, debugger, tab-capture, management, native-messaging, unlimited-storage, request-blocking, or required all-sites host permission is requested.

## Data-use questionnaire draft

Conservative answers are required because Chrome treats local processing as data handling.

| Category/question | Draft answer | Basis |
| --- | --- | --- |
| Website content | **Yes, handled locally.** | DOM/media/resource evidence is required for the visible scan/download feature. |
| Web browsing activity | **Yes, handled locally for the user-facing feature.** | Active page URL/domain and permitted resource URLs/response metadata are processed. |
| Authentication information | **Not intentionally collected or persisted.** URLs can contain credentials or secret-shaped parameters transiently; download policy, logs, and reports fail closed/redact them. | No cookie permission; URL credentials and secret-shaped report fields are always redacted. Owner/store reviewer must confirm category interpretation. |
| Personally identifiable information | **Not intentionally requested.** A page title/URL/filename may incidentally contain identifying text and is therefore treated as sensitive context. | Default reports omit/minimize it; runtime state is cleared/in-memory. |
| User-provided content | **Settings and explicit URL/filename inputs are handled locally.** | Options/manual HLS/report settings are validated and bounded. |
| Financial/health/personal communications | **No feature is designed to access these categories.** | Never use the extension on such pages for testing; owner/store reviewer must answer dashboard wording exactly. |
| Sale/advertising/analytics | **No.** | No backend, telemetry, analytics, ads, or data-broker integration. |
| Third-party transfer | **No automatic transfer by the developer.** | User-directed resource requests/downloads contact the resource origin; user-directed exported files may be shared by the user. |
| Human access by developer | **No.** | No developer service receives data. A user may separately choose to share a reviewed report for support. |

## Limited Use and privacy disclosures

Draft affirmative statement, also present in `PRIVACY.md`:

> The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

Draft privacy summary:

- Data is processed locally only to identify, explain, and save user-authorized media.
- No developer server, telemetry, advertising, sale, or unrelated use exists.
- Runtime titles/URLs/filenames are not intended to persist; stored queue/diagnostic data is minimized and bounded.
- Optional site access can be denied or revoked.
- Reports require a literal preview; defaults omit/hash identifying fields, sensitive mode requires separate confirmation, and credentials/secrets/local paths/blob identifiers remain redacted.
- Named clear actions and uninstall/browser controls remove extension-managed data; exported files are user-controlled.

The final submission requires a publicly accessible, current privacy-policy URL in the designated dashboard field. No URL is invented here.

## Authorized-use and safety disclosure

> Use Media Scout Downloader only for media you own or are authorized to save. The extension does not grant rights to third-party content and does not bypass DRM, encryption, authentication, paywalls, signed/expiring access controls, CORS, or other restrictions. Unsupported and ambiguous paths fail closed.

This is a product boundary, not a legal conclusion about any particular media or use.

## Support and test instructions draft

**Support channel:** owner must provide an approved public contact or support URL before submission. Do not direct users to publish private URLs, tokens, account data, or raw diagnostic reports in public issues.

**Reviewer test path:** use only the packaged controlled `.invalid`-domain/local fixture server and clean browser profile. The final upload package must include or link to precise test instructions that demonstrate active-tab scanning, current-origin permission, a direct file, an unsupported/protected fixture, queue cancellation, and default report preview without requiring credentials or copyrighted media.

## Items requiring owner or legal judgment

- Confirm rights/provenance for the complete source, remux implementation, icons, and any future media/demo assets.
- Preserve the owner-approved MIT license and do not imply that the project license grants rights to third-party media, websites, services, or content.
- Approve the public privacy-policy and support URLs.
- Review whether direct HTTP origin support should remain in the store build.
- Confirm data-category selections against the live dashboard's exact current wording.
- Confirm developer-account identity, two-step verification, country/distribution, and any required trader declarations.
- Review trademark/product-name availability and third-party-content authorization language.

No item above is evidence of Chrome Web Store acceptance. Submission and publication require separate action-time owner approval.
