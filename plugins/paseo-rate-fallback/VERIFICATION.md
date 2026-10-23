# Verification

Verified on 2026-10-22 against the local Paseo 0.12.0 daemon.

- `npm run typecheck`: passed.
- `npm test`: 206 tests passed across six files, including same-provider recovery, Claude quota detection, cross-provider forks, durable ownership and context-generation races.
- Installed plugin RPCs: `fallback.status` responded; `fallback.configure` disabled and enabled the plugin with no tracked fallback agents, then restored the original enabled setting.
- Live configuration smoke: a disposable Codex agent changed from `gpt-6-astra` with `high` reasoning to `gpt-6.1-sol` with `ultra`, then returned to `gpt-6-astra` with `high`. These used real authenticated daemon configuration RPCs and live provider sessions.
- The live smoke simulated the rate limit event, recovered quota report, and acknowledgement of one continuation. It sent no inference prompt and did not consume a real quota to force rate limiting.
- Cleanup passed: the fixture agent and workspace were archived, its project registration was removed, and temporary files were deleted. The last fixture agent was `dcbf2e8a-1cd6-436f-b9e8-603aea5d29ab`.
- The served client bundle passed Hermes compatibility verification. Attempts to inspect the UI through computer use and the Paseo browser timed out, so visual UI verification remains incomplete.

The repeatable smoke script is `server/live-smoke.ts`. It creates a temporary Git repository and a no-prompt agent, exercises installed RPCs only when the real plugin has no tracked fallback agents, and cleans up in `finally`.

## Cross-provider fork verification

The repeatable `server/live-fork-smoke.ts` exercises the new fork controller against real disposable provider sessions while keeping its journal inside a temporary repository. It does not modify the installed plugin's enabled setting or journals.

- A real Claude source retained its configured `opus` model, `high` reasoning, `plan` mode, and workspace throughout the round trip.
- The controller created a real child using `codex/gpt-6.1-sol` with `ultra`, in the same workspace. Both parent and plugin ownership labels were checked.
- Paseo generated the original session's native `chat_history` fork attachment for the outbound handoff, then generated the Codex child's native attachment for the return to Claude. The script checked both attachments against the values delivered to its send stub.
- The rate limit event, quota exhaustion/recovery, clock advancement, and two send acknowledgements were simulated. No inference prompts were sent, and the disposable chats contained no generated task progress. This verifies session creation, native context transport, preserved source settings, and controller transitions; it does not claim a real quota was exhausted or that provider inference resumed.
- The isolated journal cleared after the return acknowledgement grace. Cleanup passed: both fixture agents and their workspace were archived, the unique project registration was removed, and fixture files plus the generated smoke bundle were deleted.
- The latest fixture IDs were source `28cf2818-9587-4ff7-b564-6f14d98d7fd0` and backup `ec9efe1a-96fe-478f-8507-a45183d5c4fd`.

Paseo 0.12 does not advertise Codex's internal `read-only` mode for creation. Claude plan/read-only sessions therefore create backups with supported mode `auto`, explicit native `sandbox_mode: "read-only"` and `approval_policy: "on-request"`; plan sessions additionally enable `plan_mode`. This configuration was accepted by the real daemon in a separate disposable adapter probe. Other default modes use Codex's normal approval flow; an existing bypass/full-access choice maps to full access.

## Real GPT transport verification

The optional `PASEO_RATE_FORK_REAL_INFERENCE=1` path passed against the installed plugin host. Exactly one inference prompt was sent to the disposable `gpt-6.1-sol` backup with `ultra` thinking and its native outbound fork attachment. The assistant returned `PASEO_FORK_TRANSPORT_OK`, and the backup's native return context contained that real response.

The original Claude session retained its configured `opus` model, `high` thinking and `plan` mode. The initial limit, quota recovery and Claude return acknowledgement remained simulated; no inference prompt was sent to Claude. Both sessions shared the same workspace, the isolated journal cleared, and all fixture agents, workspace, project registration and temporary files were cleaned up. Source: `4d0ef47d-ae18-42b9-9e82-bc3472ae5c3d`; backup: `0f4240ba-064f-4ada-9540-c20f3ac1d324`.
