# Published backend API browser verification

Command: `node scripts/release-browser-test.mjs`.

All 13 checks passed: the original eight static release checks and five backend API checks. This executes the generated standalone viewer and the actual `ReleasePreview` component in a private Chromium profile, with independent loopback HTTP origins and a file-backed fixture backend. It does not contact a company server, GitHub, SSH target or live Paseo daemon.

The added checks establish:

- An authored startup read and a trusted native button POST reach the real receiver through CORS. The receiver observes the published outer page's origin, not `null`; JSON POST exercises preflight. The exposed response provides status, success, response headers and decoded JSON.
- A fresh top-level document reads the record from backend file storage without another POST. A 409 response preserves its status, headers, text and JSON rather than being confused with a transport error.
- A cookie actually installed in the browser's cookie jar is absent from backend requests. Referrer, implicit authorization and private Board/export-token canaries are absent as well.
- Unapproved origins, credential-option overrides, forbidden headers, oversized UTF-8 request bodies and direct authored `fetch` fail without reaching the backend. Redirects do not reach their destination. A response over 1 MiB is rejected; an exact 256 KiB request succeeds.
- The actual opaque host preview rejects API-enabled startup reads and explicit writes with zero backend traffic.

Receipt: `/Users/citrine/.paseo/verification/paseo-board/release-api-20261108/run-1794179730104515000/receipt.json`. Log SHA-256: `39253bcf16f5c81459d0107c3f4b6c4b432adbc7dabd804b349af25670339842`.

The receipt records exact hashes for both test files and all exercised viewer, release-contract, exporter and preview source files. These hashes matched the working files at handoff. No product code was modified by this browser-test change.
