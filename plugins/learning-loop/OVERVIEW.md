# Learning Loop

Learning Loop gives every Paseo agent the learning loop of Hermes Agent: a small persistent memory, a library of skills that agents write and fix themselves, full-text recall of past conversations, and a background review that turns your corrections and the techniques an agent worked out into memory and skills. Memory and skills are shared by every agent on the host, whatever the provider, so something Claude Code learned is there for Codex next time.

## How it works

- **Memory.** Three small stores of separate facts: who you are (user, 1,375 characters), notes about the environment (memory, 2,200 characters) and facts about one repository (project, shared by its worktrees). New agents get a snapshot of them in their system prompt. Agents save facts with a `memory` tool; when a store is full the write is refused with the current entries, and the agent consolidates them.
- **Skills.** A skill is the procedure and pitfalls for a class of task, in the agentskills.io layout (`SKILL.md` plus `references/`, `templates/`, `scripts/`). New agents get an index of skill names and short descriptions and load a skill with `skill_view` when it applies. Agents create and patch skills with `skill_manage`; a patch needs a fresh view of the file first, so two agents do not overwrite each other. Every change is recorded and can be rolled back.
- **Past sessions.** Saved Claude Code and Codex conversations (your messages, the agent's replies and one-line summaries of tool calls) are indexed in local SQLite after each turn and during background scans. Indexing reads transcript files directly and never starts an agent or provider process. Agents search with `session_search`; you search in Learning → Sessions. Archived conversations stay searchable. Other providers and missing, malformed or oversized source files are skipped; any previously indexed copy stays available.
- **Background review.** After an agent has done enough work (6 user turns or 20 tool calls by default, at most once every 15 minutes per agent, and once more when it is archived), Learning Loop runs Claude Code headless with only the learning tools, on a digest of the conversation, using Hermes' review instructions. What it saves appears as a row in that agent's chat and in Learning → Activity.
- **Curator.** Skills written by agents that go unused for 14 days are marked stale, and archived after 30. Pinned skills and skills you wrote are never touched, and archived skills can be restored. An optional model pass merges overlapping skills into broader ones.

## In the app

- **Learning** in the sidebar: an overview, the memory stores (edit, delete, approve staged writes), the skill library (read, pin, archive, restore, history with rollback), session search, and the review log.
- `/learn <what>` in an agent's composer asks the agent to turn a folder, a URL or the work it just did into a skill.
- `/remember <fact>` saves a fact without a turn; prefix it with `user:` or `project:` to pick the store.
- `/review` reviews the current conversation now.
- Settings → Plugins → Learning Loop: what new agents get, store sizes, write approval (none, background reviews only, or every agent write), the review model, thresholds, cooldown and budget, and the curator.

## Requirements and limits

- History indexing supports saved Claude Code and Codex transcripts, including configured provider home directories. A single global queue reads one transcript at a time; limits are 256 MiB per file, 8 MiB per JSONL line, 32 MiB of indexed text and 40,000 entries per conversation. A changing or invalid file is skipped until a later sync; indexing never falls back to starting a provider. Existing index copies for unsupported providers remain searchable.
- Paseo 0.12 or later. The tools are added to Claude Code, Codex and OpenCode agents created after the plugin is installed; other providers that read a system prompt get the memory snapshot only.
- Background reviews and skill consolidation run the `claude` CLI through a Claude-family Paseo provider (the built-in `claude` provider by default) and use that account. Each review is capped by a per-run budget (USD 0.50 by default, at list prices). Providers whose environment holds API keys are refused rather than copied into a second process.
- A new memory entry reaches agents created afterwards; a running agent keeps the snapshot it started with, as in Hermes.
- Everything stays on the daemon host under `~/.paseo/learning-loop/`. Text written to memory and skills is checked for prompt-injection and exfiltration patterns. Credential-shaped strings are removed from review digests. Nothing is sent anywhere except the review runs you enable.

## Reliability and ownership (0.2)

New installations propose background writes for approval and share a $2 per UTC-day model budget. Existing settings migrate without changing their write-approval choice, model or per-run cap. Review/curator reserve their maximum cost before starting; incomplete runs keep their reservation after restart. The Overview shows charged and reserved amounts. Background model execution currently requires Claude Code, even when the reviewed session used another provider.

Memory and Skills each show pending proposals. Approving checks the saved content and validity revisions again, so a competing edit or archival produces a conflict. Memory entry metadata marks legacy source as unknown; reference, archived or overdue entries are excluded from new prompt snapshots. Skills can be marked reference and given a review date; explicit loading remains available. These operations do not rewrite existing conversations.

Newly created agents receive v2 tools: `memory(target="project", action="read")` shows current entries and revision; inside a multi-repo workspace, `project_path` selects a repository under that workspace. Without a selection, the scope remains the workspace. `session_search` defaults to the current repository/workspace; `scope="host"` deliberately searches across projects. Older bindings retain their original schema and host-wide search default. The Sessions page can filter by repository/workspace path. Retention deletes index copies only; to clear all copies, turn indexing off first.

The optional **Publish Learned catalog** setting atomically publishes `$PASEO_HOME/learning-loop/exports/learned-catalog.v1.json`. Its schema is `schemaVersion:1`, owner `learning-loop`, and `skills` entries with stable `id`, content revision, source, host scope, state, `readOnly:true`, supporting-file names and SKILL.md text. Skills Center can read this explicitly configured export; it does not take ownership, copy the skills into native folders or import Learning Loop implementation files. This export is disabled by default and is removed within 15 seconds after disabling it. Supporting-file bodies remain accessible through Learning → Skills.
