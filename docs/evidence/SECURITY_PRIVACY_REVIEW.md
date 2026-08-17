# Security and privacy review — private candidate 3.7.13

Review date: 2026-08-17 (America/Chicago)

Environment: Windows 11 Pro 10.0.26100 (64-bit), Node.js 24.19.0, npm 11.16.0, Git 2.55.0.windows.3

Candidate source binding: `91c070412f844c9c541a4b8622f0efd70e3f20c9` (tree `33e3fff6c3505be36e287d50e877aea40946eae7`). Quality, build, dependency, Git-integrity, Gitleaks, Semgrep, and CodeQL checks were rerun for this source commit.

Result: **No unresolved critical or high-severity product security/privacy finding was identified in the completed P0 review.** The corrected report preview closes the known high-severity privacy/UX finding, and the final exact-commit CodeQL security-and-quality analysis returned zero results. This is not a claim that the extension is secure or vulnerability-free. Clean-profile browser testing, future-asset provenance, and final artifact review remain later gates.

## Findings disposition

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| SEC-PRIV-001 | High | Report Preview previously showed paths and sizes while report text could retain page titles, hostnames, and filenames. | Fixed in 3.7.13: exact exposure table, literal safe text preview, stronger default minimization, sensitive-mode confirmation, comprehensive invalidation, exact ZIP equality, and regressions. See `REPORT_PRIVACY_REVIEW.md`. |
| SEC-PRIV-002 | Medium | Warning/UI error text could relay browser or page errors containing URLs, query data, filenames, or local paths. | Fixed: shared logger and service-worker public error responses pass values through report-grade redaction and omit raw Error objects/stacks. Regression assertions cover URL query, secret field, and local-path removal. |
| SEC-PRIV-003 | Informational | Default report host/path values are non-cryptographic correlation hashes. | Explicitly documented as correlation-only and not anonymization. Exact identifiers are omitted by default; sensitive mode remains identifying by design. |
| SEC-PRIV-004 | Resolved P0 evidence gap | CodeQL had not been executed. | Owner-approved MIT enabled the official CLI route. The first run found eight quality issues; all were fixed. CodeQL 2.26.3 then analyzed exact commit `91c0704` with 201 SARIF rules and returned zero results. See `CODEQL_3.7.13.md`. |
| SEC-PRIV-005 | Evidence gap | Managed permission states and browser-specific download/UI failure behavior are not locally proven by Node tests. | P1 clean-profile Chrome/Brave matrix item; publication wording remains blocked until executed. |

## Tool evidence

Raw machine-path-bearing reports were kept outside the repository. Only reviewed summaries appear here.

| Check | Version/configuration | Scope | Result |
| --- | --- | --- | --- |
| Gitleaks Git scan | 8.30.0, official Windows x64 release; archive SHA-256 matched official checksum; 100% redaction | All seven commits through `91c0704` | Pass: approximately 1.27 MB, no leaks found, exit 0. |
| Gitleaks directory scan | 8.30.0; 100% redaction; archive depth 1 | Current P0 worktree before evidence binding | Pass: approximately 1.70 MB, no leaks found, exit 0. |
| Semgrep Community | 1.173.0; `p/javascript` + `p/security-audit`; metrics off; Git ignores disabled; explicit `src` and `test-harness` roots | All 40 source/test targets at `91c0704`; 90 applicable rules from 292 loaded | Pass: 0 findings, 0 parse errors, exit 0. |
| Repository static scanner | Node.js 24.19.0, `npm run lint` (repository invariants; not ESLint) | Manifest, imports, CSP, permissions, dynamic code/HTML injection, markup, contrast, dead module | Pass. Command name will be made accurate or replaced during P1. |
| Syntax/import gate | Node.js 24.19.0, `npm run typecheck` (syntax only; not compile-time typing) | All JS/MJS plus local import existence | Pass. Misleading script name remains a P1 truth task. |
| Regression gate | Node.js 24.19.0 | Nine self-test suites plus repository/race/report/security assertions | Pass. |
| npm inventory/audit | npm 11.16.0 | `npm ls --all`; `npm audit --omit=dev --audit-level=high` | Empty dependency tree; 0 vulnerabilities reported. Absence of dependencies is not proof of security. |
| Pattern scan | ripgrep + `git grep` | Private-key headers, common GitHub/AWS/Slack token forms, dynamic execution, HTML-string sinks, remote imports, WebSocket/beacon/XHR, high-risk permission/header access | No prohibited match in runtime source; test/static-rule source strings were separately understood. |
| Git object/whitespace checks | Git 2.55.0.windows.3 | `git fsck --full`; `git diff --check` | Pass. |
| Staging build | Node.js 24.19.0 | `npm run build` at `91c0704` | Pass: 39 runtime files, 698,567 bytes; source/staged manifest SHA-256 both `60c96252046ce2d572e7e8832f91ca935163e7fb1d0183cfbe6ffdfdb0858a99`. This is not a final release ZIP. |
| CodeQL | CLI 2.26.3; `codeql/javascript-queries` 2.4.3; security-and-quality suite | Exact Git archive of `91c0704`; 33/33 JavaScript files and 1/1 workflow; 201 SARIF rules | Pass: zero results; reviewed SARIF SHA-256 `2340d5040c2e2ec2dabab4964e62f8336c879663587f783b56adc39b833c7831`. |

Gitleaks 8.30.0 was deliberately used instead of current 8.30.1 because the upstream issue tracker contained a 2026 report that 8.30.1's default rules could return false zero-findings. This review does not rely on that affected version.

## Required control review

| Control | Evidence and result |
| --- | --- |
| No remote executable code | Pass locally. Manifest V3 CSP is `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`; imports are local; no CDN/remote module or remotely evaluated configuration exists. |
| No `eval`, `new Function`, unsafe dynamic import, or HTML-string injection | Pass static and Semgrep review. UI builders create elements and assign `textContent`; report preview content is literal text. |
| Strict message boundary | Pass local review/tests. Message type/shape/count/length validators run before dispatch; content-script types require this extension plus a real page tab; privileged types require this extension's origin. Scanner/resource values are bounded. |
| Safe URL schemes | Pass tests/review. Media actions accept HTTP(S) and controlled blob handling only; malformed/oversized/unsafe schemes reject. |
| Secret/token redaction | Pass synthetic report/log tests and Gitleaks scans. Default and sensitive reports always remove credential components and secret-shaped fields/parameters; default also removes all query names/values. |
| Optional host access | Pass manifest/source review. HTTP(S) hosts are `optional_host_permissions`; exact current-origin prompts originate from visible UI gestures; all-sites access is a separate Options action. |
| Permissions least privilege | Engineering justification completed in `docs/store/CHROME_WEB_STORE_DRAFT.md`. Cookies/history/debugger/blocking/management/native messaging are absent. `notifications` optionalization and final HTTP policy remain owner/store review items, not a hidden claim. |
| Denied/revoked/managed permission recovery | Denied/revoked paths are explicit and fail without broadening access in source/Node checks. Exact managed-policy/browser prompt behavior remains P1 browser evidence. |
| Stale tab/frame authorization | Pass local regression/review. Navigation/closure clear scoped state and increment revisions; post-await results recheck revision; downloads recompute allow decisions; reports compare current tab/scan/candidate context. |
| Cancellation finality | Pass race regression. Late progress/worker completion cannot revive a canceled task. |
| Browser handoff ambiguity | Pass simulated regression. Missing/ambiguous Chrome download IDs fail without an automatic duplicate retry; watchdog cleanup cancels a known stalled ID. |
| Shell escaping | Pass existing POSIX/PowerShell/CMD regression fixtures for helper-note quoting. Helper notes remain explicit inert external artifacts. |
| No unintended report/diagnostic persistence | Pass schema/review. Report previews are in extension-page memory; persisted diagnostics/queue history omit browsing/media identifiers and raw text. |
| Clear/lower-retention ordering | Pass asynchronous race regression. Pending writes settle before explicit clear and cannot restore cleared history; lower retention clears prior history. |
| Hostile structure bounds | Pass source/fixtures for 20,000-visit DOM patterns, candidate caps, string/URL limits, frame/report lists, 4 MiB manifest reads, 200 variants, 100 audio renditions, 6,000 segments, 500 DASH representations, 64 MiB segments, and 768 MiB aggregate HLS merge limit. Performance/memory budgets remain P1. |
| Protected/unsupported fail closed | Pass self-tests and policy review. DRM/encryption/auth/paywall/CORS/signed/expired/stale/unsupported layouts do not gain a bypass path; DASH stays manifest-only and limited HLS paths are explicit. |
| Report preview/export contract | Pass local automated/manual review. See `REPORT_PRIVACY_REVIEW.md` and sanitized sample manifest. |

## Permission/data observations

- `webRequest` is non-blocking and scoped in application state to tabs the user has activated. It observes response URL/type and selected response metadata; it does not request request headers, response bodies, cookies, or blocking access.
- Service-worker manifest fetches explicitly use `credentials: 'omit'`. Page-context fetches use the page's normal same-origin/CORS behavior because HLS assembly is a source-page operation; a failure is never converted into a bypass.
- Full runtime candidates necessarily contain media URLs and filenames while the user is deciding/downloading. They stay in memory and are invalidated on document lifecycle changes; persistence uses reduced schemas.
- The extension handles Chrome-defined user data (website content/resources and browsing/resource activity) even without developer transmission. `PRIVACY.md` and the store draft disclose that conservative interpretation.

## CodeQL disposition

The [official CodeQL CLI binary repository](https://github.com/github/codeql-cli-binaries) states that standalone CLI use is limited to code under an OSI-approved open-source license or academic research. The owner explicitly approved the OSI-approved MIT License on 2026-08-17. The official CodeQL 2.26.3 Windows archive matched its published SHA-256 before extraction.

The first scan's eight non-security quality findings were fixed, then a fresh database for exact commit `91c0704` returned zero security-and-quality results. Full method, hashes, scope, and limitations are recorded in `CODEQL_3.7.13.md`. A later GitHub workflow still must run before any remote-CI claim; Semgrep remains separate evidence rather than a CodeQL substitute.

## Residual publication blockers

- Exact stable Chrome and Brave tests on Windows have not yet been run.
- Screen-reader, browser accessibility, responsive/zoom/forced-colors, and browser performance evidence has not yet been produced.
- The 768 MiB Blob-based HLS aggregate boundary still needs lower-memory evidence and may need reduction.
- The owner's current source/remux/icon creation attestation is recorded; future fixtures and release/presentation assets still require exact origin/license records.
- Chrome Web Store declarations, privacy/support URLs, legal review, and any public action require owner approval.
