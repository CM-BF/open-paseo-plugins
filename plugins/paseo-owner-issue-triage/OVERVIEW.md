# Owner issue triage

Automatically analyze GitHub issues you authored and keep their classification, priority, affected plugins, and suggested next steps in a visible Paseo queue. Each analysis links to its real Paseo agent. Scanning between discoveries does not call a model.

Add an explicit repository allowlist and bind your existing GitHub CLI account. The plugin verifies the author's numeric GitHub ID, excludes pull requests, and uses only your own comments. Existing issues are discovered without automatic analysis unless you enable backfill or select them. Mark already-owned work as manually claimed to prevent duplicate handling.

Requires Paseo 0.13.2 or later, authenticated `gh` on the daemon host, and an available agent provider. The default worker uses Codex GPT-6-Astra, ultra reasoning, Full Access, and Fast service tier; all settings are configurable and checked against the host's capabilities. Installation preparation uses Node LTS/npm 11 and the committed dependency lock. See the README for development setup.

The plugin reads GitHub only. It does not comment, label, close, merge, or publish. Its analysis workers receive issue evidence and instructions to classify without taking action. The selected permission mode still governs those agents; Full Access is not an analysis sandbox.

Configuration, ownership claims, results, and deduplication records persist locally. Issue text and your comments are sent to the chosen agent provider for analysis; GitHub credentials are not. Errors, rate-limit backoff, retries, and incomplete runs remain visible. A local diagnostic fixture can exercise the actual agent workflow without creating a GitHub issue.
