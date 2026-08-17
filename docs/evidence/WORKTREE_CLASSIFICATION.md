# Reviewed 3.7.12 worktree classification

Date reviewed: 2026-08-17

Original commit: `af23d5eac76dc68fb1a0711869f17a376223a512`

Candidate state when reviewed: private release-readiness snapshot; now retained as historical evidence for a public-source prerelease

> The repository has since become public. This classification preserves the earlier worktree review and does not describe the current visibility or imply a supported binary release.

The pre-existing worktree was preserved outside the repository before review. Every modified, deleted, and untracked path present in that snapshot is classified below. No path was classified as unclear after source, reference, build, and automated-gate review.

| Path | Classification | Review conclusion |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Test or build tooling | Intended: expands the local workflow definition from tests only to the repository gate and staged build. No remote execution evidence exists. |
| `CHANGELOG.md` | Documentation | Intended, with the false tag/commit-history sentence corrected during review. |
| `CONTRIBUTING.md` | Documentation | Intended: aligns contribution checks with the candidate test plan. |
| `DOWNLOAD_ALLOW_LIST.md` | Documentation | Intended: replaces accumulated historical prose with the current action boundary. |
| `PRIVACY.md` | Documentation | Intended: documents bounded diagnostics, queue retention, and report redaction limits. |
| `README.md` | Documentation | Intended: replaces oversized historical material with a current private-candidate overview. |
| `SECURITY.md` | Documentation | Intended: aligns the supported-state wording with 3.7.12. |
| `TESTING.md` | Documentation | Intended: describes the local gate and the still-unexecuted browser gate. |
| `TEST_PLAN.md` | Documentation | Intended: replaces historical material with a current manual release checklist. |
| `manifest.json` | Intended current implementation | Intended: version/description update; permissions and optional-host model remain unchanged. |
| `package-lock.json` | Test or build tooling | Intended: aligns the private-candidate version; dependency tree remains empty. |
| `package.json` | Test or build tooling | Intended: adds local formatting, invariant, syntax, test, and staged-build commands. The conventional-quality naming limitation is tracked separately. |
| `src/background/diagnostics-manager.js` | Intended current implementation | Intended: makes optional diagnostic storage fail-safe, bounded, and resistant to prototype-key collisions. |
| `src/background/download-manager.js` | Intended current implementation | Intended: fixes duplicate filename-counter use, queue-history clearing, and per-tab cleanup. |
| `src/background/download-strategies.js` | Intended current implementation | Intended: hardens browser-download handoff, monitoring, timeouts, error classification, and helper quoting. |
| `src/background/media-detector.js` | Intended current implementation | Intended: bounds manifest reads/structures and prevents stale scan ingestion. |
| `src/background/queue-manager.js` | Intended current implementation | Intended: makes cancellation final, serializes persistence, bounds settled history, and reconciles restored state safely. |
| `src/background/report-manager.js` | Intended current implementation | Intended security hardening for URL/secret redaction; the separate report-preview truth defect remains a P0 blocker. |
| `src/background/service-worker.js` | Intended current implementation | Intended: serializes startup, invalidates stale document work, bounds scan/report aggregation, and clears UI state authoritatively. |
| `src/background/tab-media-store.js` | Intended current implementation | Intended: caps per-tab media state, prioritizes retained evidence, and preserves stronger protection findings. |
| `src/content/content.js` | Intended current implementation | Intended: removes the page overlay, bounds HLS work and reads, and strengthens cancel/protection behavior. |
| `src/content/page-media-scanner.js` | Intended current implementation | Intended: replaces unbounded DOM/materialized scans with bounded traversal and bounded report data. |
| `src/options/options.css` | Intended current implementation | Intended accessibility correction for primary-control contrast. |
| `src/options/options.html` | Intended current implementation | Intended accessibility/state markup corrections. |
| `src/options/options.js` | Intended current implementation | Intended: validates save responses, normalizes numbers, tracks dirty state, and protects unsaved changes. |
| `src/popup/popup.css` | Intended current implementation | Intended accessibility correction for primary-control contrast. |
| `src/popup/popup.html` | Intended current implementation | Intended: removes the over-broad live region. |
| `src/popup/popup.js` | Intended current implementation | Intended: supports authoritative state replacement/reset and minimizes side-panel launch intent. |
| `src/shared/constants.js` | Intended current implementation | Intended dead-export cleanup. |
| `src/shared/download-allow-list.js` | Intended current implementation | Intended dead policy-table export cleanup; executable policy remains present and tested. |
| `src/shared/filename-utils.js` | Intended current implementation | Intended dead-export cleanup. |
| `src/shared/frontend-model.js` | Intended current implementation | Intended dead-export cleanup. |
| `src/shared/logger.js` | Intended current implementation | Intended removal of unreferenced logger helpers. |
| `src/shared/media-type-registry.js` | Intended current implementation | Intended removal of unreferenced derived registries/helpers. |
| `src/shared/report-utils.js` | Intended current implementation | Intended: removes query-name retention and advances the report schema. |
| `src/shared/self-tests.js` | Test or build tooling | Intended: expands settings, policy, and command-escaping regression coverage. |
| `src/shared/storage-utils.js` | Intended current implementation | Intended: validates settings types, normalizes bounded integers, preserves an intentionally empty subfolder, and removes unused APIs. |
| `src/shared/types.js` | Obsolete/dead file | Deletion confirmed: no runtime or test import/reference exists, the only historical reference was a README tree entry, and the staged extension does not contain the file. |
| `src/shared/ui/tokens.css` | Intended current implementation | Intended: raises faint-text contrast and adds a verified accent foreground. |
| `src/shared/utils.js` | Intended current implementation | Intended: bounds URL normalization and removes unreferenced helpers. |
| `src/shared/validators.js` | Intended current implementation | Intended: strengthens message, scheme, numeric, enum, and settings validation. |
| `src/shared/zip-utils.js` | Intended current implementation | Intended: removes traversal/absolute path components from ZIP entries. |
| `src/sidepanel/sidepanel.css` | Intended current implementation | Intended accessibility correction for primary-control contrast. |
| `src/sidepanel/sidepanel.js` | Intended current implementation | Intended: prevents stale state loads, clears stale UI/report state, improves labels/titles, and narrows session data. The content-preview defect remains a P0 blocker. |
| `test-harness/run-tests.mjs` | Test or build tooling | Intended: adds queue, persistence, redaction, bounds, handoff, and repository regressions. |
| `AUDIT_REPORT.md` | Documentation | Intended private-candidate audit. Claims are treated as historical local evidence and must be superseded after later changes. |
| `test-harness/build-extension.mjs` | Test or build tooling | Intended: stages only the manifest, source, and icons under a validated build target. |
| `test-harness/format-files.mjs` | Test or build tooling | Intended: deterministic text normalization utility. |
| `test-harness/static-checks.mjs` | Test or build tooling | Intended repository-specific formatting, syntax, import, permission, CSP, injection, markup, and contrast invariants. It is not a conventional linter or compile-time type checker. |

## Review result and commit plan

The changes form one pre-existing, tightly coupled 3.7.12 hardening snapshot. Splitting them into invented historical increments would misrepresent chronology, so they should be committed together as a reviewed current snapshot. Later work should use separate truthful commits for report privacy/P0, conventional engineering evidence/P1, and presentation/recruiter material/P2.

Generated output was not part of the captured untracked worktree. The reproducible `dist/` staging directory is ignored and was regenerated only for verification.
