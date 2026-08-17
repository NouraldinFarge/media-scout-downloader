# Contributing

The source repository is public, but this prerelease is not accepting external code contributions while its manual browser, accessibility, artifact, and release-approval gates remain open. Reproducible bug reports and safety-boundary observations using synthetic or non-sensitive data are welcome through the public issue tracker. Security-sensitive reports must use GitHub's private vulnerability-reporting route described in [`SECURITY.md`](SECURITY.md).

Every change must preserve fail-closed handling for DRM, encryption, authentication, paywalls, signed URLs, CORS, and stale evidence; add or update regression coverage; pass `npm run check` and `npm run build`; and complete the relevant manual Chrome checks in [`TEST_PLAN.md`](TEST_PLAN.md).

AI-assisted suggestions are treated as untrusted drafts. The maintainer owns architecture, review, verification, legal boundaries, and release decisions.
