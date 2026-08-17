# Contributing

This project is not accepting external code contributions while it remains a private release-readiness candidate. Reproducible bug reports and safety-boundary observations are welcome after publication.

Every change must preserve fail-closed handling for DRM, encryption, authentication, paywalls, signed URLs, CORS, and stale evidence; add or update regression coverage; pass `npm run check` and `npm run build`; and complete the relevant manual Chrome checks in [`TEST_PLAN.md`](TEST_PLAN.md).

AI-assisted suggestions are treated as untrusted drafts. The maintainer owns architecture, review, verification, legal boundaries, and release decisions.
