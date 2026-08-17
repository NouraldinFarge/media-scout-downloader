# CodeQL review — P0 candidate 3.7.13

Review date: 2026-08-17 (America/Chicago)

Status: **PASS for the exact P0 source commit.** This is bounded static-analysis evidence, not a claim that the extension is secure or vulnerability-free.

## Final source binding

- Commit: `91c070412f844c9c541a4b8622f0efd70e3f20c9`
- Tree: `33e3fff6c3505be36e287d50e877aea40946eae7`
- Version: 3.7.13
- License: MIT
- Exact Git source archive SHA-256: `85d6c532eda87d6398f92d4eb45345d209807ea9797da52cfbe16549b1034630`

The analysis source was created with `git archive` from the exact commit outside the repository. Generated `dist/`, dependencies, local tools, and uncommitted files therefore could not enter the database.

## Tool and query scope

| Item | Exact value |
| --- | --- |
| CodeQL CLI | 2.26.3, official Windows x64 bundle |
| Official bundle SHA-256 | `628ab5a3cca3ed06b57d96ac6657aefe07af1546fd76893531ce7111be8f1d09` |
| Query pack | `codeql/javascript-queries` 2.4.3 |
| Suite | `javascript-security-and-quality.qls` |
| Extracted scope | 33/33 JavaScript/TypeScript files and 1/1 GitHub Actions workflow |
| Rules represented in final SARIF | 201 |
| Final results | 0 |
| Final SARIF SHA-256 | `2340d5040c2e2ec2dabab4964e62f8336c879663587f783b56adc39b833c7831` |

The official release checksum matched the downloaded archive before extraction. The raw SARIF and database remain outside the repository because they contain machine-local paths; only this reviewed, path-free summary is publication eligible.

## Finding and fix history

The first eligible scan analyzed MIT transition commit `2a9e137` and returned no security alert but eight quality findings:

1. Identity replacement in the report filename timestamp.
2. A redundant initial service-worker status assignment.
3. One unused shared-validator import.
4. Three unused content-script constants.
5. A superfluous mapper argument.
6. A trivially true array fallback.

All eight findings were reviewed and fixed in commit `91c0704`. The fresh database and suite run for that commit returned zero results. The earlier source archive and SARIF remain private audit artifacts with SHA-256 values `baad351d5b2ad1ab9a7bdc3d2bf5b10b08be6c20d510eb004c5c22b2b206a2ad` and `a417a4eaf3ada3ff05e07c17cdf7ad6745d9b89de99fd4c4b29d0286d1a892b4`, respectively.

## Limits

- CodeQL is one static-analysis layer; it cannot prove absence of defects.
- Browser API behavior, permission prompts, service-worker lifecycle, accessibility, performance, and controlled media flows remain P1 evidence items.
- Semgrep, Gitleaks, dependency review, regression tests, and manual threat-model review remain separate evidence rather than substitutes for CodeQL.
