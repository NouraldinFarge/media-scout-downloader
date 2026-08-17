# Source, asset, fixture, and AI provenance

Status: private candidate 3.7.13, reviewed 2026-08-17.

## Distribution and license status

`LICENSE.md` states copyright 2026 Nouraldin Farge and reserves all rights. It does not grant open-source rights and is not an OSI-approved open-source license. Unless the owner makes a separate licensing decision, the project must not be described as open source. If the repository is later made public without a license change, public copy must explain that the source is visible but copying, modification, and distribution remain restricted by `LICENSE.md`.

No license change was made during release-readiness work. GitHub may display this custom license file but is not expected to classify it as MIT, Apache-2.0, GPL, or another standard SPDX license.

## File-level inventory

Run `npm run evidence:provenance` to regenerate `docs/evidence/SOURCE_INVENTORY.json`. The inventory records the relative path, byte length, SHA-256 digest, file kind, origin record, license status, AI-assistance status, and whether owner attestation is still required for application/source/test/configuration/assets/documentation and generated sample files. It excludes its own self-referential output, the evidence ledger that binds the inventory hash, Git internals, dependencies/tools, and generated `dist/` output. That narrow ledger exclusion prevents an impossible recursive hash dependency and is declared in the generated scope field.

The inventory is evidence of what was reviewed. A repository hash and copyright notice do not independently prove authorship or clear third-party rights.

## Application and remux source

- The application source was supplied in the owner's private repository snapshot and has been reviewed and modified during the current release-readiness work.
- `src/content/mp4-remuxer.js` is a repository-contained MPEG-TS (H.264/AAC) to MP4 repackaging implementation. It imports no third-party library and contains no third-party copyright header or attribution notice.
- A limited public exact-phrase search on 2026-08-17 for distinctive function/error/comment strings from the remuxer found no matching source. That search is not exhaustive and is not proof of originality or non-infringement.
- Before any public distribution, the owner must attest that the application and remux source are owner-authored, properly licensed, or otherwise authorized, and must identify any copied algorithm, snippet, specification text, or prior AI/tool source that requires attribution.
- Standard container/codec concepts, box names, and byte-layout operations are interoperability facts; this audit does not make a legal conclusion about protectability or implementation origin.

## Icons and visual assets

The only packaged raster assets at the P0 checkpoint are four sizes of the same extension icon:

| Asset | Dimensions | SHA-256 |
| --- | --- | --- |
| `assets/icons/icon16.png` | 16×16 | `10b1e6f6ece45f6d4b1295e1802fd85c1d82a412f66973c6807a2096e57c1afc` |
| `assets/icons/icon32.png` | 32×32 | `759144c2345af4a312ff71b2406c3951e503ececd66cfae52d975e8645df33f4` |
| `assets/icons/icon48.png` | 48×48 | `dcaf5a7ab78498eca9bb576f39c7bc5e3a4204c92fc56ff18202b33b0466ab53` |
| `assets/icons/icon128.png` | 128×128 | `8d4406c2f098eaea396ffbe32d88bffabb2fe87f6d749d76c7a8b599bb79943` |

ImageMagick 7.1.2-27 inspection found a simple five-color sRGB palette/alpha image and no visible author/license attribution in the inspected metadata. The files were present in the supplied private snapshot. Their exact creation method and originality cannot be independently established from the files, so owner attestation is required before publication. Future screenshots, social previews, diagrams, and demo media require their own generated/source record and privacy review.

## Fonts

No font file is bundled. CSS names `Inter` first and then uses platform/system fallbacks (`ui-sans-serif`, `system-ui`, Segoe UI, and common monospace families). Naming an installed font does not add that font file to the extension package. A release artifact inspection must continue to reject unexpected font binaries or remote font URLs.

## Test fixtures and report samples

- P0 automated fixtures are code-generated strings, in-memory manifest structures, synthetic task objects, reserved `.invalid` domains, obvious non-working secret/credential placeholders, Unicode text, and traversal-shaped names. They contain no real account, private site, token, local path, or copyrighted media.
- `test-harness/generate-sanitized-report-sample.mjs` creates the saved default-redacted report evidence from a fictional `Aurora Field Lab` fixture. The raw reserved-domain fixture remains in source; the saved report contains only redacted correlation values and static product text.
- No third-party audio/video fixture is stored in the P0 tree. Any P1 real-browser media fixture must be original, programmatically generated, public-domain, or permissively licensed with an exact source/license record before use.
- Do not use Chrome/Chromium test media merely because it is publicly viewable; each file's stated license/provenance must be checked before redistribution.

## Documentation and source material

- `Media_Scout_Downloader_Complete_Frontend_Design_Plan_v10.docx` is private input outside the repository. It describes an older inspected version, contains a private preparer line/metadata, and mixes implemented and aspirational requirements. It is not release evidence and must not be published verbatim.
- Public-facing repository documentation was rewritten from current implementation inspection, local evidence, and linked primary documentation. It does not intentionally reproduce the private preparer line or obsolete version claims.
- Chrome Web Store policy notes link to official Chrome sources and paraphrase requirements. The short Limited Use sentence in `PRIVACY.md` is included because current official guidance requests that affirmative disclosure.
- `AUDIT_REPORT.md` is historical local evidence for the 3.7.11→3.7.12 review and is not proof for later candidate changes.

## Dependencies and external tools

- P0 `npm ls --all` reports an empty package tree: there are no runtime or npm development dependencies at this checkpoint.
- The repository workflow references pinned commits of GitHub's `actions/checkout` and `actions/setup-node`; both upstream projects publish MIT licenses. They execute only in CI and are not bundled into the extension.
- Audit tools such as Git, Node.js, npm, Gitleaks, Semgrep, ImageMagick, and browser/testing tools are external review/build tools. Their licenses do not become the extension's license, and their versions/results belong in the evidence ledger.
- A later P1 decision to add npm development tools must update `package-lock.json`, dependency audit results, `THIRD_PARTY_NOTICES.md`, and the SPDX SBOM. It must not preserve a stale “no dependencies” claim.

## AI assistance and accountability

AI coding agents assisted with research, implementation, testing, and iteration. The owner set requirements and architecture, reviews and validates changes, defines safety, licensing, privacy, and authorization boundaries, and retains final responsibility for published claims and releases.

AI output is treated as untrusted draft material: changes are diff-reviewed, relevant tests are run, generated UI/artifacts are inspected, and claims remain private until they map to immutable passing evidence. The presence of human review does not itself establish copyright ownership of generated or pre-existing material.

## Required owner attestation before the publication gate can pass

The owner must explicitly confirm, in the final release record:

1. Rights to distribute every application source file, especially `src/content/mp4-remuxer.js`.
2. Rights and originality/licensing for the four icon files.
3. Origins and licenses for every added browser fixture, screenshot, diagram, social image, and demo asset.
4. Whether any algorithm, code snippet, design copy, or asset was copied or adapted from a third party and what notice is required.
5. The intended all-rights-reserved/public-source distribution model or an approved license change.

Until that attestation exists, provenance is documented but the external publication gate remains closed.
