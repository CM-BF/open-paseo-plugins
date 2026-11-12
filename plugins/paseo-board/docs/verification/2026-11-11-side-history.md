# New Side: blank or with the owner agent's history

Request: when a Board creates a new Side, the user chooses whether it starts blank or with the owner (main) agent's conversation, because some questions cannot be answered without that context.

## Behaviour

- The composer and the drafts drawer show **新建 Side 时 ○ 空白 Side ● 带主 agent 记录** for every send that can create a Side. Hotkeys use the visible choice. It is a per-host, per-Board local preference (default blank, only the history choice is stored) read when a composer or the drawer opens. Existing Sides are never changed; while one exists the row says so and **新建 Side 并发送** creates another.
- With history, the service reads the owner's projected timeline through the public SDK on the first dispatch of the creation, curates it like Paseo's native fork context (user/assistant messages, tool names and short summaries; Board prompts reduced to the user's words, selection and the Board's recorded answer; no reasoning, tool outputs or external tool input), keeps the newest 100,000 characters, and journals the text, its sha256 and metadata with the creation payload before `create`. The first message carries it as a `chat_history` text attachment. Retries and restarts reuse it; the text is compacted from `service.json` once the first send can no longer happen.
- Provenance (`带主 agent 记录 · 最近 42 条消息 · 更早的未带上`) is derived from the first-send outcome and shown in the thread header, threads drawer and Side picker. Failures before creation (owner archived/missing, unreadable history) never fall back to blank; they release the Side reservation and offer **重新编辑发送**.
- Blank Sides send byte-identical requests, prompts and system prompts to `4f88cd7` (golden comparison against the read-only reference checkout).

## Validation (isolated branch `sw/board-side-fork`)

Code head `29cc7e7` (the later commit only adds this note and PROGRESS.md), all from `plugins/paseo-board`:

| Check | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | |
| `npx vitest run --maxWorkers=4 --exclude server/inbox-sync.test.ts` | 0 | 812 tests in 52 files (37 new: 30 server, 7 client) |
| `npx vitest run server/inbox-sync.test.ts --maxWorkers=1` | 0 | 10 tests |
| `npm run test:browser` | 0 | 118 checks |
| `npm run test:host` | 0 | 50 checks (38 existing + 12 new-Side choice flows, incl. 1024/420/320 px geometry) |
| `npm run test:release` | 0 | 30 checks |
| `npm run test:release-host` | 0 | 38 checks |
| `build:client`, `build:worker` rebuild, then `git status --porcelain` | 0 | byte-identical; `app-runtime.txt` and its inputs unchanged from `4f88cd7` |

Additional host scopes (`toolbar`, `drafts`, `batch`, `modal`, `inbox`, `resume`) also passed. A golden comparison bundled against the read-only `4f88cd7` checkout found blank-mode prompts (5 shapes) and the Side system prompt byte-identical.

Private evidence: `$PASEO_HOME/verification/paseo-board/glass-fork-20261111/` (`IMPL-FORK.md`, `logs/final/`, `fork-shots/`).

## Not verified

The browser host harness adapts Paseo transport and native primitives; service tests use a fake SDK. Nothing was installed, no plugin was reloaded, no real agent received a history attachment, and no physical phone or Hermes build was exercised. Whether a third-party (plugin-registered) provider renders text attachments cannot be checked through the public API. The Side's own Paseo session shows no "Previous conversation" pill because the daemon does not persist attachment metadata on user messages.
