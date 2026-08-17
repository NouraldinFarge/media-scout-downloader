# Release checklist — 3.7.13

This checklist binds the candidate to the final commit and hashes recorded in the generated build manifest and evidence ledger. A checked item is evidence-scoped, not a broader product guarantee.

## Source, legal, and privacy

- [x] Original worktree preserved without reset, clean, or history rewrite.
- [x] Owner creation attestation recorded with explicit limits.
- [x] Standard MIT License approved and applied.
- [x] Source, icon, remux, synthetic fixture, dependency, action, and AI-assistance provenance recorded.
- [x] Default and sensitive diagnostic report modes reviewed with controlled secret/identifier fixtures.
- [x] Report Preview shows literal files and exact exposure categories; stale source evidence blocks export.
- [x] Protected/ambiguous paths remain fail-closed.

## Engineering gates

- [x] Formatting, ESLint, syntax, repository invariants, tests, coverage thresholds, and build pass locally.
- [x] Dependency audit, Semgrep, Gitleaks, and exact-source CodeQL evidence recorded.
- [x] Controlled synthetic browser fixtures and hashes verified.
- [x] Repeatable Node performance budgets and constrained-memory proxy pass.
- [ ] Exact final Chrome Windows manual matrix pass recorded.
- [ ] Exact final Brave Windows manual matrix pass recorded.
- [ ] Keyboard, screen-reader, zoom, forced-colors, reduced-motion, and responsive checklist pass recorded.
- [ ] Final remote CI and CodeQL workflows pass for the exact candidate commit.

## Artifacts and presentation

- [ ] Deterministic extension ZIP and source ZIP reproduced from the exact clean commit.
- [ ] Extension ZIP loads unpacked and its manifest matches source.
- [ ] Packaged-file allowlist and private-data inspection pass.
- [ ] SHA256SUMS, SPDX SBOM, build manifest, provenance, sample report, evidence, notes, and limitations agree.
- [ ] Sanitized actual-product screenshot set and social preview pass privacy review.
- [ ] README, architecture, threat model, privacy/security/support/testing docs, issue forms, and recruiter copy match the evidence ledger.
- [ ] P0, P1, and P2 publication gates explicitly pass.
- [ ] Owner authorizes the exact final push/public-visibility action.
