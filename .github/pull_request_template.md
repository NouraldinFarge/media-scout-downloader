## Summary

Describe the user-visible or engineering outcome and the safety boundary it preserves.

## Validation

- [ ] `npm ci`
- [ ] `npm run check`
- [ ] `npm run build`
- [ ] `npm run artifact:inspect`
- [ ] Browser/API behavior was tested with controlled fixtures and a disposable profile when applicable.

## Trust and release boundaries

- [ ] I reviewed the diff for credentials, private URLs, personal paths, reports, captured browsing data, and generated archives.
- [ ] Coverage claims name the measured files/modules and do not imply whole-extension coverage.
- [ ] The change does not decrypt DRM, bypass authentication/paywalls, evade CORS, or silently broaden permissions.
- [ ] Any UI or media uses synthetic/controlled state and has descriptive alternative text or a text equivalent.
- [ ] This PR does not imply a Chrome Web Store listing, supported public binary, tag, release, or completed manual gate.
