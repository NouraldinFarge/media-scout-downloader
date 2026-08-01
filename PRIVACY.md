# Privacy

Media Scout is local-first. It has no analytics service, advertising SDK, telemetry endpoint, cloud account, or remote configuration channel.

Website access is optional and requested for the sites the user chooses to inspect. The extension uses active-tab context, local extension storage, and Chrome's normal download APIs. It does not request cookie or browsing-history access.

Diagnostic learning stores strategy names, generic outcomes, counters, and timestamps. Queue recovery stores privacy-reduced task metadata. Full URLs and filenames are not intended to persist across service-worker restarts. Diagnostic report export is user initiated and presents a redaction review before saving.

Report content can still reflect page-visible data. Users should inspect an exported report before sharing it and should never share material containing personal, account, or confidential information.
