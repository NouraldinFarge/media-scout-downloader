# Security and privacy review — private candidate 3.7.13

Review date: 2026-08-17 (America/Chicago)

Environment: Windows 11 Pro 10.0.26100 (64-bit), Node.js 24.19.0, npm 11.16.0, Git 2.55.0.windows.3

Candidate source binding: `21cd0caa582384e3e0d5a7b4df3c8e5071e30fda` (tree `26a949b294989af7a32440f2576dc705939ed3b7`). Quality, build, dependency, Git-integrity, Gitleaks, and Semgrep checks were rerun after this source commit.

Result: **No unresolved critical or high-severity product security/privacy finding was identified in the local P0 review.** The corrected report preview closes the known high-severity privacy/UX finding. This result is not a claim that the extension is secure or vulnerability-free. Clean-profile browser testing, eligible remote CodeQL execution, owner provenance attestations, and final artifact review remain gates.

## Findings disposition

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| SEC-PRIV-001 | High | Report Preview previously showed paths and sizes while report text could retain page titles, hostnames, and filenames. | Fixed in 3.7.13: exact exposure table, literal safe text preview, stronger default minimization, sensitive-mode confirmation, comprehensive invalidation, exact ZIP equality, and regressions. See `REPORT_PRIVACY_REVIEW.md`. |
| SEC-PRIV-002 | Medium | Warning/UI error text could relay browser or page errors containing URLs, query data, filenames, or local paths. | Fixed: shared logger and service-worker public error responses pass values through report-grade redaction and omit raw Error objects/stacks. Regression assertions cover URL query, secret field, and local-path removal. |
| SEC-PRIV-003 | Informational | Default report host/path values are non-cryptographic correlation hashes. | Explicitly documented as correlation-only and not anonymization. Exact identifiers are omitted by default; sensitive mode remains identifying by design. |
| SEC-PRIV-004 | Evidence gap | CodeQL was not executed locally. | Blocked, not waived: the official standalone CodeQL CLI terms limit use to OSI-approved open-source code or academic research, while this repository is all-rights-reserved. Eligible private GitHub execution may require an organization with GitHub Advanced Security. A pinned remote-ready workflow and actual eligible run belong to P1; no CodeQL-pass claim is allowed now. |
| SEC-PRIV-005 | Evidence gap | Managed permission states and browser-specific download/UI failure behavior are not locally proven by Node tests. | P1 clean-profile Chrome/Brave matrix item; publication wording remains blocked until executed. |

## Tool evidence

Raw machine-path-bearing reports were kept outside the repository. Only reviewed summaries appear here.

| Check | Version/configuration | Scope | Result |
| --- | --- | --- | --- |
| Gitleaks Git scan | 8.30.0, official Windows x64 release; archive SHA-256 matched official checksum; 100% redaction | Complete three-commit local history through `21cd0ca` | Pass: 3 commits, approximately 1.19 MB, no leaks found, exit 0. |
| Gitleaks directory scan | 8.30.0; 100% redaction; archive depth 1 | Candidate directory plus the final uncommitted documentation-only evidence binding | Pass: approximately 1.69 MB, no leaks found, exit 0. |
| Semgrep Community | 1.173.0; `p/javascript` + `p/security-audit`; metrics off; Git ignores disabled; explicit `src` and `test-harness` roots | All 40 candidate source/test targets; 90 applicable rules from 292 loaded | Pass after source commit: 0 findings, 0 parse errors, exit 0. |
| Repository static scanner | Node.js 24.19.0, `npm run lint` (repository invariants; not ESLint) | Manifest, imports, CSP, permissions, dynamic code/HTML injection, markup, contrast, dead module | Pass. Command name will be made accurate or replaced during P1. |
| Syntax/import gate | Node.js 24.19.0, `npm run typecheck` (syntax only; not compile-time typing) | All JS/MJS plus local import existence | Pass. Misleading script name remains a P1 truth task. |
| Regression gate | Node.js 24.19.0 | Nine self-test suites plus repository/race/report/security assertions | Pass. |
| npm inventory/audit | npm 11.16.0 | `npm ls --all`; `npm audit --omit=dev --audit-level=high` | Empty dependency tree; 0 vulnerabilities reported. Absence of dependencies is not proof of security. |
| Pattern scan | ripgrep + `git grep` | Private-key headers, common GitHub/AWS/Slack token forms, dynamic execution, HTML-string sinks, remote imports, WebSocket/beacon/XHR, high-risk permission/header access | No prohibited match in runtime source; test/static-rule source strings were separately understood. |
| Git object/whitespace checks | Git 2.55.0.windows.3 | `git fsck --full`; `git diff --check` | Pass. |
| Staging build | Node.js 24.19.0 | `npm run build` after `21cd0ca` | Pass: 39 runtime files, 698,897 bytes; source/staged manifest SHA-256 both `60c96252046ce2d572e7e8832f91ca935163e7fb1d0183cfbe6ffdfdb0858a99`. This is not a final release ZIP. |
| CodeQL | Current official bundle observed as 2.25.5; not installed/run | JavaScript | Blocked by repository license/hosting eligibility; no result claimed. |

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

## CodeQL constraint and required next action

The [official CodeQL CLI binary repository](https://github.com/github/codeql-cli-binaries) states that standalone CLI use is limited to code under an OSI-approved open-source license or academic research. The [official CodeQL Action repository](https://github.com/github/codeql-action) says private use depends on appropriate GitHub Advanced Security eligibility. This project is private and all-rights-reserved, so downloading/running the CLI here would not be justified by the available terms.

P1 may add a workflow pinned to immutable `github/codeql-action` commits, but it must not be called passing until an eligible private GitHub repository runs it successfully against the exact commit. If eligibility is unavailable, the final report must record CodeQL as blocked and must not substitute Semgrep results as a CodeQL pass.

## Residual publication blockers

- Exact stable Chrome and Brave tests on Windows have not yet been run.
- Screen-reader, browser accessibility, responsive/zoom/forced-colors, and browser performance evidence has not yet been produced.
- The 768 MiB Blob-based HLS aggregate boundary still needs lower-memory evidence and may need reduction.
- Source/remux/icon rights require owner attestation; see `PROVENANCE.md`.
- Chrome Web Store declarations, privacy/support URLs, legal review, and any public action require owner approval.
