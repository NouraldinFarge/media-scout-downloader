# P0 publication gate — private candidate 3.7.13

Assessment date: 2026-08-17 (America/Chicago)

Result: **BLOCKED — do not begin P1 publication work or publish/showcase the project.**

The known high-severity report-preview privacy defect is fixed and no unresolved critical/high product security or privacy finding was identified by the completed local P0 review. P0 still cannot pass because source/remux/icon rights require owner attestation and the required CodeQL result lacks an established eligible execution context.

## Exit-criterion decision

| P0 exit criterion | Result | Evidence/reason |
| --- | --- | --- |
| Dedicated reviewed branch | Pass | `release-readiness-2026-08-17`; no edit was made directly on `main`. |
| Clean worktree and honest commits | Pending final evidence-binding commit at initial assessment | Reviewed 3.7.12 snapshot is commit `cfcbf4a`; current P0 implementation/evidence is being committed without fabricated chronology. This row must be updated only after clean status is observed. |
| Existing work preserved; no loss | Pass | Verified patch, Git bundle, untracked copies, and SHA-256 manifests outside the repository; ledger EV-001/EV-002. |
| Truthful history/changelog; no fake tags/releases | Pass | False history claim removed; no remote/tag/release exists; ledger EV-003/EV-028. |
| Version references aligned | Pass at reviewed worktree | Current candidate surfaces and staged manifest say 3.7.13; historical evidence remains explicitly historical; ledger EV-004. |
| Preview truthfully represents export | Pass locally | Exact exposure table, literal text preview, normalized file set, recomputed digest, fresh context validation, parsed ZIP equality; ledger EV-005–EV-009. |
| Default and sensitive privacy checks | Pass locally | Automated synthetic fixtures plus manual field-by-field read; deterministic sanitized sample; `REPORT_PRIVACY_REVIEW.md`. |
| No unresolved critical/high product security/privacy defect | Pass for completed local scope | Gitleaks, Semgrep, dependency audit, static/source controls, regressions, threat model; `SECURITY_PRIVACY_REVIEW.md`. Browser-managed cases remain accurately deferred to P1. |
| Required CodeQL-compatible check | **Blocked** | No run was performed. Standalone CLI eligibility is not established for this private all-rights-reserved code; eligible private GitHub execution is not available/authorized in current evidence. Ledger EV-016. |
| License and public-source state unambiguous | Pass | `LICENSE.md` is all rights reserved; project is not described as open source; ledger EV-018. |
| Code/fixture/asset/AI provenance documented and cleared | **Blocked** | Inventory/disclosures exist, but inspection cannot prove source/remux/icon rights. Owner attestation is required; ledger EV-017 and `OWNER_ATTESTATION_DRAFT.md`. |
| Proposed public artifacts contain no private identifiers | Pass for current local P0 drafts/sample | Saved report sample was manually read/searched; no real/private fixture values or machine paths are present. Store copy remains explicitly draft/private. No P2 public visuals/copy exist yet. |

## Exact blockers

1. **Owner provenance decision.** Complete `OWNER_ATTESTATION_DRAFT.md` for the exact candidate. Any copied/adapted material or license/notice obligation must be identified and resolved.
2. **CodeQL eligibility and execution.** Select an eligible route and run CodeQL against the exact commit. A private GitHub/GitHub Advanced Security route would require explicit approval before remote creation, push, or workflow execution. A license change is a separate explicit-approval action. Semgrep and local tests do not replace CodeQL.
3. **Immutable rebinding after resolution.** Rerun all affected local checks, build/sample/inventory, secret/static scans, bind results and hashes to the exact commit, and confirm a clean worktree.

## Claims supportable now in private review only

- The 3.7.13 candidate has a locally tested report-preview/export privacy contract with a deterministic sanitized sample.
- The default report omits titles/filenames, hashes host/path correlation values, omits query names/values, and redacts credentials, secret-shaped values, local paths, and blob identifiers.
- Gitleaks 8.30.0 and Semgrep Community 1.173.0 completed the exact scopes recorded in the ledger without a finding.
- The P0 npm dependency tree is empty and npm reported zero dependency vulnerabilities.
- The repository is all rights reserved, private, and has no remote/tag/release/store publication.

These are bounded evidence statements, not public-release approval.

## Claims still forbidden

Publicly released; Chrome Web Store published/approved; production-ready; open source; secure/vulnerability-free; CodeQL passed; tested in Chrome/Brave; cross-platform; WCAG compliant; conventionally linted; compile-time typed; covered at any percentage; performance/memory-safe; remote CI passed; signed; used by customers; legally authorized for arbitrary downloads; or able to bypass/provide unsupported protected media.

## External actions requiring later explicit approval

Create/connect a remote; push; enable private GitHub Advanced Security/workflows; make public; create a PR/tag/release; upload artifacts; submit to a store; publish privacy/support URLs; or edit GitHub profile, portfolio, résumé, LinkedIn, Indeed, or another recruiter-visible surface.
