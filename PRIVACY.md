# Privacy

Media Scout is local-first. It has no analytics service, advertising SDK, telemetry endpoint, cloud account, or remote configuration channel.

Website access is optional and requested for the sites the user chooses to inspect. The extension uses active-tab context, local extension storage, and Chrome's normal download APIs. It does not request cookie or browsing-history access.

Diagnostic learning stores bounded strategy names, generic outcomes, counters, and timestamps. Queue recovery stores privacy-reduced task metadata. Full URLs and filenames are not intended to persist across service-worker restarts. Lowering queue-retention settings clears previously stored queue history immediately, and an explicit clear is serialized after pending writes so stale metadata is not restored by an older save.

Diagnostic report export is user initiated and presents a redaction review before saving. Default reports redact full URLs, URL-shaped diagnostic text, blob identifiers, secret-shaped fields, query values, and query-parameter names. They retain hostnames, path hashes, and query-parameter counts for comparison.

Report content can still reflect page-visible data. Users should inspect an exported report before sharing it and should never share material containing personal, account, or confidential information.
