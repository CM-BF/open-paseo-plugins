# New Side: blank or with the owner agent's history

Request: when a Board creates a new Side, the user chooses whether it starts blank or with the owner (main) agent's conversation, because some questions cannot be answered without that context.

## Behaviour

- The composer and the drafts drawer show **新建 Side 时 ○ 空白 Side ● 带主 agent 记录** for every send that can create a Side. Hotkeys use the visible choice. It is a per-host, per-Board local preference (default blank, only the history choice is stored) read when a composer or the drawer opens. Existing Sides are never changed; while one exists the row says so and **新建 Side 并发送** creates another.
- With history, the service reads the owner's projected timeline through the public SDK on the first dispatch of the creation, curates it like Paseo's native fork context (user/assistant messages, tool names and short summaries, each tool call with a short excerpt of its own output since the real-app acceptance fixes below; Board prompts reduced to the user's words, selection and the Board's recorded answer; no reasoning, edit/write bodies or external tool input), keeps the newest 100,000 characters, and journals the text, its sha256 and metadata with the creation payload before `create`. The first message carries it as a `chat_history` text attachment. Retries and restarts reuse it; the text is compacted from `service.json` once the first send can no longer happen.
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

## Review fixes (code head `8b87d27`)

- The composer's send buttons are a footer outside its scroller. With a Side present and 带主 agent 记录 chosen, 丢弃草稿 / 加入待发送 / Side 发送 / 新建 Side 并发送 / 主会话发送 are hit-testable without scrolling at 1440, 1024, 420 and 320 px (also without a Side, and in the non-web compatible composer at 420/320). The note under the choice is one line, only for 带主 agent 记录; the full scope is on the option's tooltip and accessibility hint.
- The hotkey hint follows the visible (frozen on retry) choice; pressing the checked option returns focus to the input; on the web the choice is a radio group with one Tab stop and arrow/Home/End keys.
- Provenance puts delivery warnings first; the discussion rail tags history Sides. 重新编辑发送 (and 放回待发送 for grouped sends) appears only when the service marks `sideNotCreated` (journal-confirmed: no create call), never while a create result is pending reconciliation.
- The attachment starts with `[Earlier chat history omitted]` whenever older rows were not read (page, size or time guard, or a daemon window gap), not only when the curated text overflows. Board answers count as entries, not messages.

| Check | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | |
| `npx vitest run --maxWorkers=4 --exclude server/inbox-sync.test.ts` | 0 | 822 tests in 52 files |
| `npx vitest run server/inbox-sync.test.ts --maxWorkers=1` | 0 | 10 tests |
| `npm run test:browser` | 0 | 118 checks |
| `npm run test:host` | 0 | 56 checks (38 existing + 18 new-Side flows) |
| `npm run test:release` / `npm run test:release-host` | 0 / 0 | 30 / 38 checks |
| host scopes toolbar, drafts, batch, modal, inbox, resume | 0 each | 5, 14, 13, 3, 7, 19 checks |
| rebuild client and worker, `git status --porcelain` | 0 | byte-identical; `app-runtime.txt` inputs unchanged |

The golden comparison against the read-only `4f88cd7` checkout still finds the 5 blank-mode prompt shapes and the Side system prompt byte-identical.

## Not verified

The browser host harness adapts Paseo transport and native primitives; service tests use a fake SDK. Nothing was installed, no plugin was reloaded, no real agent received a history attachment, and no physical phone or Hermes build was exercised. Whether a third-party (plugin-registered) provider renders text attachments cannot be checked through the public API. The Side's own Paseo session shows no "Previous conversation" pill because the daemon does not persist attachment metadata on user messages.

## Real-app acceptance fixes (code head `b179322`)

The merged branch was accepted in the real Paseo app (real daemon, real Claude agents). These fixes address what that acceptance found.

- **History Sides carry short tool-output excerpts.** A 带主 agent 记录 Side could name PRs #12 and #13 but not their titles, because the titles only appeared in a command's output.
  - The public SDK exposes tool results on the projected timeline: `shell.output`/`exitCode`, `read.content`, search and fetch results, sub-agent/worktree logs, MCP `unknown.output`, and the `error` of a failed call. This was checked in the 0.13.2 typings and in the installed 0.15.3 runtime.
  - Each tool call now carries an excerpt of its own result, indented under the call: at most 600 characters, head and tail around `[… N characters of output omitted …]`.
  - Terminal escapes are removed. Binary output, data URLs, base64 runs and image/blob content become short markers. Tool input bodies (edit/write contents, plans, fetch prompts, MCP arguments) stay out.
  - The 100,000-character newest-first budget and the omission marker are unchanged.
  - The note reads `带上主 agent 最近的对话和命令输出摘要，仅作参考。`. Provenance adds `含命令输出摘要` when the snapshot has excerpts, and the history Side's first message says that outputs are excerpts.
- **Composer hint on two lines.** `…一起发主会话` and `Option / Alt + Enter 当前评论发 Side…` no longer run together. This was pre-existing: JSX dropped the line break.
- **Whole-canvas discussions.** A discussion started from the toolbar 发消息 (whole-canvas reference) shows `针对整个画布` instead of `未定位到当前组件 · 可查看原始引用`. This was pre-existing on `4f88cd7`.
- **Blank Sides unchanged.** Their prompts and system prompt are still byte-identical to `4f88cd7` (golden comparison: 5 of 5 shapes).

| Check | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | |
| `npx vitest run --maxWorkers=4 --exclude server/inbox-sync.test.ts` | 0 | 873 tests in 56 files |
| `npx vitest run server/inbox-sync.test.ts --maxWorkers=1` | 0 | 10 tests |
| `npm run test:browser` | 0 | 152 checks |
| `npm run test:host` | 0 | 60 checks |
| `npm run test:release` | 0 | 32 checks |
| `npm run test:release-host` | 0 | 38 checks |
| `build:client`, `build:worker` rebuild, then `git status --porcelain` | 0 | byte-identical; `app-runtime.txt` unchanged from `4f88cd7` |
