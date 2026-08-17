# P0 publication gate — private candidate 3.7.13

Assessment date: 2026-08-17 (America/Chicago)

Candidate source commit: `91c070412f844c9c541a4b8622f0efd70e3f20c9` (tree `33e3fff6c3505be36e287d50e877aea40946eae7`)

Result: **PASS — P1 engineering/release-readiness work may begin. Public publication remains gated by P1 and P2.**

The known high-severity report-preview privacy defect is fixed, no unresolved critical/high product security or privacy finding was identified by the completed local P0 review, owner provenance is recorded, and the project is MIT-licensed. The first CodeQL run exposed eight maintainability findings; all eight were fixed, and the exact follow-up commit produced zero findings from the security-and-quality suite.

## Exit-criterion decision

| P0 exit criterion | Result | Evidence/reason |
| --- | --- | --- |
| Dedicated reviewed branch | Pass | `release-readiness-2026-08-17`; no edit was made directly on `main`. |
| Clean source checkpoint and honest commits | Pass | Reviewed 3.7.12 snapshot is `cfcbf4a`; report/privacy P0 source is `21cd0ca`; MIT transition is `2a9e137`; CodeQL cleanup/current P0 source is `91c0704`. No chronology was fabricated. |
| Existing work preserved; no loss | Pass | Verified patch, Git bundle, untracked copies, and SHA-256 manifests outside the repository; ledger EV-001/EV-002. |
| Truthful history/changelog; no fake tags/releases | Pass | False history claim removed; no tag or release exists; ledger EV-003/EV-028. |
| Version references aligned | Pass at candidate source commit | Current candidate surfaces and staged manifest say 3.7.13; historical evidence remains explicitly historical; ledger EV-004. |
| Preview truthfully represents export | Pass locally | Exact exposure table, literal text preview, normalized file set, recomputed digest, fresh context validation, parsed ZIP equality; ledger EV-005–EV-009. |
| Default and sensitive privacy checks | Pass locally | Automated synthetic fixtures plus manual field-by-field read; deterministic sanitized sample; `REPORT_PRIVACY_REVIEW.md`. |
| No unresolved critical/high product security/privacy defect | Pass for completed local scope | Gitleaks, Semgrep, dependency audit, static/source controls, regressions, threat model; `SECURITY_PRIVACY_REVIEW.md`. Browser-managed cases remain accurately deferred to P1. |
| Required CodeQL-compatible check | Pass | Official CodeQL CLI 2.26.3 with `codeql/javascript-queries` 2.4.3 security-and-quality suite analyzed all 33 JavaScript files and the workflow at `91c0704`: 201 SARIF rules, zero results. `CODEQL_3.7.13.md`; ledger EV-016/EV-034/EV-035. |
| License and public-source state unambiguous | Pass | `LICENSE.md` contains the standard MIT License and package metadata declares SPDX `MIT`; ledger EV-018. |
| Code/fixture/asset/AI provenance documented and current owner origin attested | Pass for current P0 scope | Inventory/disclosures exist; the owner's full-creation statement is recorded in `OWNER_ATTESTATION.md`. It is not independent legal proof, does not cover future assets, and does not authorize publication. |
| Proposed public artifacts contain no private identifiers | Pass for current local P0 drafts/sample | Saved report sample was manually read/searched; no real/private fixture values or machine paths are present. Store copy remains explicitly draft/private. No P2 public visuals/copy exist yet. |

## P0 blockers

None. P1 still requires conventional quality tooling, coverage, controlled browser fixtures, exact Chrome/Brave testing, accessibility/NVDA review, performance evidence, remote CI, and immutable release artifacts. P2 and public publication remain blocked until those later gates pass.

## Claims supportable now in private review only

- The 3.7.13 candidate has a locally tested report-preview/export privacy contract with a deterministic sanitized sample.
- The default report omits titles/filenames, hashes host/path correlation values, omits query names/values, and redacts credentials, secret-shaped values, local paths, and blob identifiers.
- Gitleaks 8.30.0 and Semgrep Community 1.173.0 completed the exact scopes recorded in the ledger without a finding.
- CodeQL CLI 2.26.3 analyzed the exact P0 source commit with the JavaScript security-and-quality suite and returned zero findings after the initial quality cleanup.
- The P0 npm dependency tree is empty and npm reported zero dependency vulnerabilities.
- The project is MIT-licensed and remains a private staging candidate with no tag/release/store publication.
- The owner attests that they fully created the extension; the audit records this as current source/remux/icon origin evidence with explicit limits.

These are bounded evidence statements, not public-release approval.

## Claims still forbidden

Publicly released; Chrome Web Store published/approved; production-ready; secure/vulnerability-free; tested in Chrome/Brave; cross-platform; WCAG compliant; conventionally linted; compile-time typed; covered at any percentage; performance/memory-safe; remote CI passed; signed; used by customers; legally authorized for arbitrary downloads; or able to bypass/provide unsupported protected media.

## External-action status

The owner approved the MIT change, repository/version/author metadata, private staging-repository creation, and first push. The public-GitHub outcome is requested, but visibility will not change until the P1/P2 publication gate passes. No PR, tag, GitHub Release, store submission, profile pin, portfolio deployment, résumé edit, LinkedIn/Indeed edit, or other external publication is implied by this P0 pass.
