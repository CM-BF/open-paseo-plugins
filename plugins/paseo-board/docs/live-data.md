# Live public data on shared pages

A shared page is a frozen release: its look, code and frozen data never change
without a new, reviewed release. Live public data adds one narrow path around
that freeze. Board data the owner explicitly marks as public is mirrored to the
owner's own app backend and overlaid onto the release in the visitor's browser,
within seconds and without republishing.

Nothing else changes. Page code, layout and every unmarked value stay frozen.

## What the owner controls

Only the human owner can mark data and connect a backend. There is no agent
tool for it, and agent or canvas writes cannot widen what is public.

Open **More → 实时公开数据**:

1. **后端.** Enter the backend origin and check it. The panel shows the app ID
   and deployment ID from the backend itself. Enter the write token once. It is
   sent to the plugin server and never shown again.
2. **公开字段.** Tick paths in the tree of `canvas.data`, or type a JSON Pointer
   for a path that does not exist yet. The root cannot be public. Paths cannot
   contain each other. An array is one value: paths never index into it.
3. **预览.** The exact JSON the server would publish, its size, the size per
   path, and every withheld path with its reason. Path names are public too.
4. **确认.** Consent covers these paths on this backend, not today's values.
   After confirming, agent or canvas writes to those paths become public within
   seconds, without asking again, until you pause or stop. Any change to the
   paths or the backend clears the consent and needs a fresh confirmation.
5. **状态.** State, last pushed version and time, size, retry count, last error,
   next retry, withheld paths, matching canvas revision, and any shared page
   origin the backend would refuse, with the exact `board-app.json` fix.
6. **操作.** Pause, resume, or stop and clear the backend copy.

An object at a marked path, or an array containing objects at any depth, is
published only if **包含以后新增的字段** is ticked. Those are the shapes where a
later write could add keys, which would otherwise widen the public set.

A `blocked` or `retrying` channel raises the dot on the **更多** toolbar button.

### What each owner action does

| Action | Effect |
|---|---|
| 暂停推送 | Stops pushing and attesting. The backend keeps its last copy, and visitors see that updates have paused |
| 恢复推送 | Continues on the same consent; valid only from paused |
| 停止公开并清除后端副本 | Deletes the backend copy and fences late writes. The token is wiped once the backend confirms. Re-enabling needs the token and fresh consent |
| 仅本机停止（后端副本未清除） | Offered while a clear cannot complete. Wipes the token and ends retries; the backend copy may remain readable |

Narrowing takes effect at the next push. If the backend is unreachable, the
narrowed data stays on the backend until the connection returns.

## Limits

| Limit | Value |
|---|---|
| Marked paths per Board | 32 |
| Public document | 60,000 bytes (over the limit, the backend keeps its last good copy and visitors go stale) |
| Backend channels | 256, tombstones excluded |
| Authenticated writes | 4 per second per channel; a push at most every `max(1 s, bytes / 8 KB/s)` |
| Public reads | About 200 polls per second at the origin (adaptive 5 to 60 s period); 5,000 weighted reads per second before 429 |
| Visitor poll | 2 to 300 s with jitter; none while the tab is hidden |

## Connecting a backend and releases

Without a backend no channel exists and nothing leaves the machine. A release
then builds exactly as before: `board.watch` fires once and `onData` never fires.

Turn on **实时公开数据** in the publish panel to build a live release. Its origin
and paths are resolved by the plugin server from the Board's own channel and
frozen into the release as a second key:

- A page accepts only the paths frozen into it. Marks say what is sent; the
  release says what is accepted. Widening reaches an existing page only after
  one human-confirmed share update (**采用当前实时配置并更新**). Narrowing is
  immediate.
- A page published before live was turned on stays frozen until one such update.
- A loopback backend is visible only on this machine and cannot be published to
  a public site.
- Frozen values at live paths are the fallback before the first document and
  after a stop. They remain in the published files until the page is updated.

## What visitors see

| Situation | Visitor sees |
|---|---|
| Fresh | Current values, no banner |
| Publisher silent | Banner with the data's time; values stay |
| Backend unreachable or refusing the page's origin | Banner, last good or frozen values, retrying |
| Channel not found | Banner, last good or frozen values |
| Stopped | Banner, frozen values, local copy removed; checks every 5 minutes so the page resumes after re-enable |
| Native preview or a file opened from disk | Banner; never connects |

Authored page code needs no changes if it uses `board.getData()`,
`board.watch(path, fn)`, `board.onData(fn)` or the `board:data` event.
`board.getContext().live` reports `{state, asOf}`. Treat live values as
untrusted text: write them with `textContent`, never `innerHTML`.

## Backend

Set `BOARD_LIVE_WRITE_TOKEN` (32 or more random characters) in the server's
`.env` and restart. Without a valid token every live route returns 404. Only
paths in the marked set ever reach the backend; each document lives in
`<dataDir>/live/`, outside SQLite, so a database restore cannot resurrect it.
See [backend operations](app-backend-scaffold.md#live-public-data).

| Event | Effect |
|---|---|
| Code redeploy | Documents and identity survive |
| `restore` in the same data directory | Live documents untouched |
| Cold restore or a new server at the same URL | New deployment identity; old documents are deleted and the channel blocks until the owner re-confirms |
| Plugin data restored from an old backup | Stale versions block the channel; it never overwrites |
| Backend disk rolled back while the daemon runs | The next heartbeat repushes the current truth |
| Backend disk rolled back while the daemon is off | Old document served, reported as stale |

## Security and residual risks

The write token is held only in the plugin's private 0600 channel file and sent
as an `Authorization` header. It is never in Board data, a release, an agent
output, a log or an error. Visitors read one document per 128-bit channel ID;
there is no listing route, and writes require the token and refuse browser
origins. Revocation fences late writes with a higher version.

These risks remain:

1. An agent with unrestricted shell access as the same OS user can read the
   0600 file or change marks. The guarantee is that no agent tool does this,
   as with the comment inbox.
2. An agent authorized to deploy, or authored routes, can read the server token
   from `process.env`.
3. Values are agent-controlled: a secret written to a marked path is public
   within seconds. Consent text and the read-only `livePublic` field on
   `board_read` exist for this reason.
4. A compromised backend can alter public values, only inside the sandboxed
   canvas and only at the frozen paths.
5. Copies in browsers, proxies and disks can survive revocation. Stopping
   cannot recall what was already read.

Not yet verified: behaviour behind a real TLS reverse proxy or SSO, Chrome
local-network behaviour for an HTTPS page calling loopback, and Safari or
Firefox polling. Throughput figures come from loopback tests.
