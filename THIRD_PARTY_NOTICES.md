# Third-party notices

Media Scout Downloader 3.7.13 has no bundled third-party runtime library. Development, test, audit, and CI tools are external to the extension ZIP and are not required while the installed extension runs.

Direct development-only npm packages are locked to exact versions:

| Package | Version | License | Purpose | Packaged in extension |
| --- | --- | --- | --- | --- |
| `@eslint/js` | 10.0.1 | MIT | ESLint recommended rule configuration | No |
| `eslint` | 10.8.1 | MIT | Conventional JavaScript lint | No |
| `globals` | 17.11.0 | MIT | Lint environment definitions | No |
| `c8` | 12.0.0 | ISC | V8 coverage reporting and thresholds | No |
| `axe-core` | 4.13.0 | MPL-2.0 | Automated accessibility checks | No |
| `playwright-core` | 1.62.1 | Apache-2.0 | Disposable-profile browser automation | No |

Transitive development packages and their declared licenses are represented in the release SPDX SBOM generated from `package-lock.json` and the locked installed metadata. `npm audit` covers the full development dependency tree; the extension package inspection independently verifies that none of these packages enters the upload ZIP.

The repository's CI configuration references these external GitHub Actions by immutable commit:

| Tool | Upstream | License | Packaged in extension |
| --- | --- | --- | --- |
| `actions/checkout` | <https://github.com/actions/checkout> | MIT | No |
| `actions/setup-node` | <https://github.com/actions/setup-node> | MIT | No |
| `actions/upload-artifact` | <https://github.com/actions/upload-artifact> | MIT | No |
| `github/codeql-action` | <https://github.com/github/codeql-action> | MIT | No |

FFmpeg 8.1.2 was used as an external generator for the original synthetic browser media fixtures. Its executable and libraries are not redistributed. The produced fixtures contain only programmatic `testsrc2`, `color`, and `sine` output plus original project caption text. Gitleaks, Semgrep, CodeQL, Git, Node.js, npm, ImageMagick, Chrome, and Brave are likewise external audit/build/test tools rather than extension contents.

No other runtime third-party attribution notice has been identified from repository imports, package metadata, source headers, or asset metadata. This statement is not proof that all pre-existing source or assets are original. The owner's current creation statement and its limits are recorded in `PROVENANCE.md` and `docs/evidence/OWNER_ATTESTATION.md`. If later development adds a runtime package, fixture source, font, code excerpt, or media asset, update this file, the source inventory, lockfile/audit records, and SPDX SBOM before release.
