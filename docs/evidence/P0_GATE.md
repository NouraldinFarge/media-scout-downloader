# P0 publication gate — private candidate 3.7.13

Assessment date: 2026-08-17 (America/Chicago)

Candidate source commit: `21cd0caa582384e3e0d5a7b4df3c8e5071e30fda` (tree `26a949b294989af7a32440f2576dc705939ed3b7`)

Result: **BLOCKED — do not begin P1 publication work or publish/showcase the project.**

The known high-severity report-preview privacy defect is fixed and no unresolved critical/high product security or privacy finding was identified by the completed local P0 review. The owner stated, “I fully created this extension,” resolving the current source/remux/icon origin question for P0. P0 still cannot pass because the required CodeQL result lacks an established eligible execution context.

## Exit-criterion decision

| P0 exit criterion | Result | Evidence/reason |
| --- | --- | --- |
| Dedicated reviewed branch | Pass | `release-readiness-2026-08-17`; no edit was made directly on `main`. |
| Clean source checkpoint and honest commits | Pass | Reviewed 3.7.12 snapshot is commit `cfcbf4a`; P0 source/evidence checkpoint is `21cd0ca`. The status was clean when post-commit checks ran; this follow-up changes only evidence bindings. No chronology was fabricated. |
| Existing work preserved; no loss | Pass | Verified patch, Git bundle, untracked copies, and SHA-256 manifests outside the repository; ledger EV-001/EV-002. |
| Truthful history/changelog; no fake tags/releases | Pass | False history claim removed; no remote/tag/release exists; ledger EV-003/EV-028. |
| Version references aligned | Pass at candidate source commit | Current candidate surfaces and staged manifest say 3.7.13; historical evidence remains explicitly historical; ledger EV-004. |
| Preview truthfully represents export | Pass locally | Exact exposure table, literal text preview, normalized file set, recomputed digest, fresh context validation, parsed ZIP equality; ledger EV-005–EV-009. |
| Default and sensitive privacy checks | Pass locally | Automated synthetic fixtures plus manual field-by-field read; deterministic sanitized sample; `REPORT_PRIVACY_REVIEW.md`. |
| No unresolved critical/high product security/privacy defect | Pass for completed local scope | Gitleaks, Semgrep, dependency audit, static/source controls, regressions, threat model; `SECURITY_PRIVACY_REVIEW.md`. Browser-managed cases remain accurately deferred to P1. |
| Required CodeQL-compatible check | **Blocked** | No run was performed. Standalone CLI eligibility is not established for this private all-rights-reserved code; eligible private GitHub execution is not available/authorized in current evidence. Ledger EV-016. |
| License and public-source state unambiguous | Pass | `LICENSE.md` is all rights reserved; project is not described as open source; ledger EV-018. |
| Code/fixture/asset/AI provenance documented and current owner origin attested | Pass for current P0 scope | Inventory/disclosures exist; the owner's full-creation statement is recorded in `OWNER_ATTESTATION.md`. It is not independent legal proof, does not cover future assets, and does not authorize publication. |
| Proposed public artifacts contain no private identifiers | Pass for current local P0 drafts/sample | Saved report sample was manually read/searched; no real/private fixture values or machine paths are present. Store copy remains explicitly draft/private. No P2 public visuals/copy exist yet. |

## Exact blockers

1. **CodeQL eligibility and execution.** Select an eligible route and run CodeQL against the exact commit. A private GitHub/GitHub Advanced Security route would require explicit approval before remote creation, push, or workflow execution. A license change is a separate explicit-approval action. Semgrep and local tests do not replace CodeQL.
2. **Publication-final rebinding after resolution.** Rerun all affected local checks, build/sample/inventory, secret/static scans, bind results and hashes to the exact commit, and confirm a clean worktree.

## Claims supportable now in private review only

- The 3.7.13 candidate has a locally tested report-preview/export privacy contract with a deterministic sanitized sample.
- The default report omits titles/filenames, hashes host/path correlation values, omits query names/values, and redacts credentials, secret-shaped values, local paths, and blob identifiers.
- Gitleaks 8.30.0 and Semgrep Community 1.173.0 completed the exact scopes recorded in the ledger without a finding.
- The P0 npm dependency tree is empty and npm reported zero dependency vulnerabilities.
- The repository is all rights reserved, private, and has no remote/tag/release/store publication.
- The owner attests that they fully created the extension; the audit records this as current source/remux/icon origin evidence with explicit limits.

These are bounded evidence statements, not public-release approval.

## Claims still forbidden

Publicly released; Chrome Web Store published/approved; production-ready; open source; secure/vulnerability-free; CodeQL passed; tested in Chrome/Brave; cross-platform; WCAG compliant; conventionally linted; compile-time typed; covered at any percentage; performance/memory-safe; remote CI passed; signed; used by customers; legally authorized for arbitrary downloads; or able to bypass/provide unsupported protected media.

## External actions requiring later explicit approval

Create/connect a remote; push; enable private GitHub Advanced Security/workflows; make public; create a PR/tag/release; upload artifacts; submit to a store; publish privacy/support URLs; or edit GitHub profile, portfolio, résumé, LinkedIn, Indeed, or another recruiter-visible surface.
