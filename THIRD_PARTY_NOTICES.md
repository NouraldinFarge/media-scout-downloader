# Third-party notices

Media Scout Downloader 3.7.13 has no bundled third-party runtime library and no npm dependency at the P0 checkpoint. The extension ZIP is intended to contain only the repository's manifest, application source, CSS/HTML, and icon assets.

The repository's CI configuration references these external GitHub Actions by immutable commit:

| Tool | Upstream | License | Packaged in extension |
| --- | --- | --- | --- |
| `actions/checkout` | <https://github.com/actions/checkout> | MIT | No |
| `actions/setup-node` | <https://github.com/actions/setup-node> | MIT | No |

External audit/build/test tools are not redistributed in the extension package. Their use and versions are recorded in evidence rather than copied here.

No other third-party attribution notice has been identified from repository imports, package metadata, source headers, or asset metadata. This statement is not proof that all pre-existing source or assets are original. `PROVENANCE.md` lists the owner attestations required before public distribution. If later development adds a third-party package, fixture, font, code excerpt, or media asset, update this file, the source inventory, lockfile/audit records, and SPDX SBOM before release.
