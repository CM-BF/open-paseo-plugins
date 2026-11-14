# Editable application backends

The Board app scaffold supplies lifecycle machinery. Application routes, schema,
queries and storage adapters remain ordinary source files owned by the authoring
agent. The generated records route is a small executable example that can be
replaced; it is not a predefined voting, form or database product.

## Local app

Requires Node 22.13 or later; Node 24 LTS is recommended. The runtime uses built-in
HTTP and SQLite modules and does not need an npm install.

```sh
node scripts/board-app.mjs init --dir /absolute/path/my-app --id my-app
node /absolute/path/my-app/board-app.mjs migrate --dir /absolute/path/my-app
node /absolute/path/my-app/board-app.mjs start --dir /absolute/path/my-app
```

`routes.mjs` exports `route(context)`, returning true when it handles a request.
The context includes `request`, `response`, parsed `url`, `db`, the author's
`storage` object, parsed `config`, `readJson()` and `json(status, value)`.
`storage.mjs` exports `createStorage(db)` and can return any application-specific
interface. `migrations/*.sql` supplies immutable, numbered schema changes. The
author can change the app's schema and add endpoints without changing Board.

`public/` is served as the static frontend. `/public-config.json` contains only
the explicitly authored `board-app.json.public` object. Secrets belong in the
server's `.env`, never in that public object or frontend files. A Pages build can
ship the frontend and an explicit public config with an HTTPS `apiBase`; the
backend's `origins` array must list each exact allowed HTTP(S) origin. There are
no wildcard origins, cross-origin credentials or implicit export of environment
variables. CORS controls browser access, not user authentication. App authors must
add their application's authentication/authorization to their routes or deploy
behind the company's authenticated proxy.

The listener defaults to `127.0.0.1:8787`. Node serves HTTP; an existing reverse
proxy supplies HTTPS, DNS, internal SSO and any ingress limits. Browsers use
HTTP(S) to reach it. SSH is the deployment/operations transport and is not exposed
to frontend visitors.

## Storage operations

Durable data defaults to a private sibling directory, never inside uploaded app
source. An owner marker binds that directory to the app. A runtime lock prevents
two scaffold servers, migrations or restores from using it concurrently.

```sh
node board-app.mjs status --dir .
node board-app.mjs stop --dir .
node board-app.mjs migrate --dir .
node board-app.mjs backup --dir . --out ../backups/my-app.sqlite
node board-app.mjs restore --dir . --from ../backups/my-app.sqlite --confirm BACKUP_SHA256
```

Stop before migration or restore. All pending SQL migrations and their history
entries commit in one transaction. Failed migrations roll back together; applied
files cannot be changed, removed or inserted before existing history. Connection
and transaction-control SQL is rejected; migrations use transactional DDL/DML.
The author may still extend the storage adapter for more specialized databases,
but must supply the corresponding backup/migration operational behavior.

Backup uses SQLite `VACUUM INTO`, so committed WAL records are included while the
server remains live. It validates integrity and writes an app identity and
SHA-256 sidecar. Restore requires the matching reviewed digest, a stopped app and
matching identity; it first saves a safety backup of the current database.
Restoring data does not silently select an older application release or run down
migrations. Logs and lock files are kept on failed operations for reconciliation.
The owner must inspect a stale lock and its recorded process before removal.

## SSH deployment

```sh
node board-app.mjs ssh plan --dir . --host my-internal-server --root /srv/my-user/my-app --out ../deploy-plan.json
node board-app.mjs ssh deploy --plan ../deploy-plan.json --confirm PLAN_SHA256
node board-app.mjs ssh status --plan ../deploy-plan.json
node board-app.mjs ssh logs --plan ../deploy-plan.json
node board-app.mjs ssh stop --plan ../deploy-plan.json --confirm PLAN_SHA256
node board-app.mjs ssh migrate --plan ../deploy-plan.json --confirm PLAN_SHA256
node board-app.mjs ssh start --plan ../deploy-plan.json --confirm PLAN_SHA256
node board-app.mjs ssh backup --plan ../deploy-plan.json --confirm PLAN_SHA256
```

The plan records target alias, absolute remote root, app identity, complete source
file inventory and hashes, controller hash and deployment operations. Executing
deployment verifies the exact reviewed source again. Operational commands keep
using the deployed release's plan even when local source edits continue; they
validate the remote owner/current release and do not require the old source tree.
They execute the installed controller, never code supplied inside a plan. The user's existing SSH config and
agent provide authentication. Host-key verification stays strict and SSH is
noninteractive. The reviewed controller travels as a base64 module behind a fixed
loader, preserving JavaScript escapes under POSIX, Zsh and Fish login shells;
request JSON travels separately over stdin. No SSH secrets are stored in the plan
or sent to a browser.

Only `deployFiles` are uploaded, with hard rejection of `.env`, keys, SQLite files
and symlinks. Do not put secrets into ordinary source files. An empty remote root
is claimed with an owner marker; an existing nonempty unowned directory or
mismatched marker is refused. Releases remain separate from `shared/data`,
`shared/.env`, logs and backups. Deploy uploads a new release, stops the exact
owned app through its private local control endpoint, backs up existing data,
migrates transactionally, starts and health-checks the new app, and then records
the new current release. Existing releases are retained.

After an uncertain SSH failure, inspect `status`, logs, locks and the remote
release before retrying. There is no automatic retry, rollback of successful
migrations, reuse of an uncertain process ID or deletion of another app's files.
Process control validates the running instance and uses a local-only token;
it does not signal an arbitrary PID. Boot-time supervision, TLS and reverse
proxy configuration are explicit external infrastructure prerequisites, not
hidden changes made by the scaffold.

## Native comments: visitor threads, owner replies and export

`comments.enabled` defaults to false; while it is false every `/_board/comments*`
route answers 404 with code `comments_disabled`. Comments never change the app.
Replies are posted only by the Board owner's host with the private
`BOARD_INBOX_EXPORT_TOKEN`. A visitor can list only their own comments and the
replies to them, using an anonymous secret their browser keeps. Published Board
pages with **访客可以框选评论** turned on use these routes directly; an authored
page can also use them through `mountComments` (below) or its own code.

| Method and path | Who | Purpose |
|---|---|---|
| `POST /_board/comments` | any listed browser origin | create a comment |
| `GET /_board/comments/mine?page=URL` | the visitor (`X-Board-Visitor`) | that visitor's threads and replies |
| `GET /_board/comments?cursor=&limit=[&format=2]` | owner token | export for the Board inbox |
| `POST /_board/comments/<externalId>/replies` | owner token, never a browser | public reply to one comment |
| `GET /_board/health` | anyone | identity and capabilities |

Errors are JSON `{"error": "message", "code": "code"}`:

| Code | Status | Meaning |
|---|---|---|
| `invalid_input` | 400 | body, header, cursor or query fails the rules below |
| `visitor_invalid` | 400 | `X-Board-Visitor` is not 64 lowercase hex characters, or is missing on `mine` |
| `unauthorized` | 401 | wrong owner token |
| `browser_forbidden` | 403 | an owner reply carried an `Origin` header |
| `comments_disabled` | 404 | `comments.enabled` is false |
| `export_disabled` | 404 | no `BOARD_INBOX_EXPORT_TOKEN` of 32+ characters is set |
| `comment_not_found` | 404 | the reply targets an unknown comment |
| `not_found` | 404 | any other `/_board/comments/*` path |
| `method_not_allowed` | 405 | wrong method on a comment route |
| `idempotency_conflict` | 409 | the `Idempotency-Key` already belongs to another payload or visitor |
| `reply_limit` | 409 | the comment already has 20 replies |
| `payload_too_large` / `unsupported_media_type` | 413 / 415 | body over 64 KiB, or not `application/json` |
| `rate_limited` | 429 | a limit below was reached; `Retry-After` gives the seconds to wait |
| `storage_full` | 507 | the stored-bytes cap or 200,000 replies were reached |

### Posting a comment

`POST /_board/comments` needs a stable `Idempotency-Key` header (8–128 ASCII
letters, digits, dot, underscore, colon or hyphen) and accepts an optional
`X-Board-Visitor` header: 64 lowercase hex characters generated randomly in the
visitor's browser. The server stores only `sha256("board-visitor:v1:" + secret)`.
The body is strict:

```json
{
  "text": "第二步看不懂",
  "authorName": "Optional self-reported name",
  "pageUrl": "https://cm-bf.github.io/pages/boards/s0123456789abcdef0123/",
  "anchor": {
    "label": "结果", "selector": "#result", "quote": "第二步", "prefix": "首先，", "suffix": "的意思",
    "start": 3, "end": 6, "releaseId": "release-<64 hex>"
  }
}
```

The same rules apply when a comment is posted and to every stored row an export
returns (rows from older runtimes included):

| Field | Rule | When posting | In exports |
|---|---|---|---|
| `text` | trimmed (`String.prototype.trim`, so U+3000 too); 1–8,000 characters, 1–2,000 with `X-Board-Visitor` | 400 | trimmed |
| `authorName` | string of at most 160 characters without control characters; trimmed; dropped when blank | 400 | omitted when invalid |
| `pageUrl` | at most 2,000 characters; an HTTP(S) URL without credentials; stored as its normalized `href` | 400 | normalized, omitted when invalid |
| `anchor` | object with only the keys below; serialized at most 2,000 characters | 400 | omitted when invalid |
| other keys | not allowed | 400 | never returned |

Anchor keys, all optional: `label` (≤ 200), `selector` (≤ 500), `quote` (1–1,000),
`prefix` and `suffix` (≤ 64 each), `start` and `end` (integers, `0 ≤ start < end ≤
10,000,000`, both or neither, only with `quote`, and `end − start` equal to the
quote's length) and `releaseId` (`release-` plus 64 lowercase hex). The older
`{label, selector}` anchor stays valid. `anchorProblem(anchor)` and
`normalizeCommentInput(body, {visitor})` in `backend/comments.mjs` implement these
rules; `scripts/fixtures/page-comments-contract.json` pins them with cases shared
by the page, the inbox and this runtime.

A new comment returns 201 `{deploymentId, comment, replayed: false}`, where
`comment` is the normalized comment plus `externalId` and `createdAt`. Retrying
with the same key, the same normalized payload and the same visitor header (or
again none) returns 200 with the original comment and `replayed: true`; anything
else is a 409. Replays skip the posting limits. An intent recorded by an earlier
runtime still replays with its original body.

### Visitor threads

`GET /_board/comments/mine` requires `X-Board-Visitor`. The optional `page`
parameter (an HTTP(S) URL, normalized like `pageUrl`) keeps only that page:
pages are compared by origin plus path, with a trailing `index.html` ignored and
no query or fragment. The response lists the visitor's newest 30 threads, each
with at most 20 replies, oldest first:

```json
{
  "deploymentId": "uuid",
  "threads": [{
    "id": "<externalId>", "text": "…", "authorName": "…", "createdAt": "…", "pageUrl": "…", "anchor": {},
    "status": "replied",
    "replies": [{"id": "<replyId>", "text": "…", "authorKind": "agent", "createdAt": "…"}]
  }]
}
```

`status` is `replied` once a reply exists, otherwise `received` once the owner's
export cursor has passed the comment, otherwise `sent`. Internal triage state,
labels and notes never reach this route. Comments posted without the header,
including all comments from runtimes before this one, never appear here. The
response stops adding threads at 500,000 JSON characters and always contains at
least one thread.

### Owner replies

```http
POST /_board/comments/<externalId>/replies
Authorization: Bearer <BOARD_INBOX_EXPORT_TOKEN>
Idempotency-Key: ir-<48 hex>
Content-Type: application/json

{"text": "谢谢指出，第二步的意思是……", "authorKind": "agent"}
```

The checks run in this order: any `Origin` header is refused (403, so a browser can
never post a reply); a missing or short token gives 404 and a wrong one 401; the
ID must look like a UUID; `text` is trimmed, 1–2,000 characters, with no control
characters except newline and tab; `authorKind` is `owner` (default) or `agent`.
The same key with the same comment, text and kind replays with 200; with anything
else it is a 409. Then the comment must exist, have fewer than 20 replies, and the
app must hold fewer than 200,000 replies. The 201 response is
`{deploymentId, replayed: false, reply: {replyId, commentExternalId, text, authorKind, createdAt, idempotencyKey}}`.
The Board inbox posts replies only from the owner's host, with the token it
already keeps for export; the token never reaches agents, Board content or pages.

### Owner export

Export requires `BOARD_INBOX_EXPORT_TOKEN` of at least 32 characters.
`GET /_board/comments?cursor=0&limit=50` uses `Authorization: Bearer TOKEN`; with
no token, export answers 404. Without `format=2` the response keeps the original
shape, which older Board plugins parse:

```json
{
  "deploymentId": "stable-durable-uuid",
  "cursor": "0",
  "nextCursor": "2",
  "comments": [
    {"externalId": "uuid", "text": "Comment", "createdAt": "2026-11-08T00:00:00.000Z"}
  ]
}
```

In this format the anchor is reduced to its `label` and `selector` (and left out
when it has neither), and nothing else is added. With `format=2` the response is
`{deploymentId, format: 2, cursor, nextCursor, comments}`, and each comment also
carries its full anchor and, for comments posted with a visitor secret, a
`visitorTag`: `sha256("tag\0" + visitorHash)` cut to 12 hex characters. The tag
groups one visitor's comments without revealing the secret or its hash.

Pagination is ascending by sequence, at most 100 rows, and stops before the rows
would pass 90,000 JSON characters (always at least one row); it advances only over
returned rows and an empty result keeps the cursor. The `cursor` an owner sends
is what it has already imported: each authenticated export records it, capped at
the newest comment, and `mine` reports those comments as `received`.

Deployment identity is stored in durable data and survives code releases,
migrations and ordinary restart. Restoring an older database in the same intact
data directory preserves the comment sequence's high water mark, so new comments
remain ahead of an already imported Board cursor. If the old database or identity
is missing, a cold restore creates a new deployment identity and returns
`newCommentSourceRequired: true`. Register it as a new Board source; the previous
source's imported comments remain retained. This prevents a historical backup from
impersonating a continuous comment stream. Read and triage permission in Board are
separate from the export token, and nothing a visitor posts changes the app.

### Health

`GET /_board/health` returns
`{status, id, appKey, deploymentId, instanceId, live, comments, clientIp}`:

- `appKey` is `sha256("board-app-key\0" + owner)` cut to 16 hex characters, where
  `owner` is the UUID in `.board-app-owner.json`. It stays the same across
  redeploys, restores and address changes, and differs for every scaffolded app.
  Published pages key the visitor's secret by it and check it before their first
  request.
- `comments` is `2` when comment threads are enabled with this runtime and `0`
  when comments are disabled; older runtimes omit it.
- `clientIp` describes how this request's address was found: `socket`,
  `forwarded` (from a trusted proxy) or `proxied-unconfigured` (forwarded headers
  arrived from a peer that is not listed in `comments.trustedProxies`, so they were
  ignored and every visitor shares the proxy's limits).

### Abuse limits and client addresses

Limits apply to comment routes from browsers; the owner's export and reply routes
are token authenticated and skip them. Windows are fixed minutes and hours kept in
memory, so a restart resets them. A refused request gets 429 `rate_limited` with
`Retry-After`, and spends nothing.

| `comments.limits` key | Default | Counts |
|---|---|---|
| `requestsPerIpMinute` | 300 | every `/_board/comments*` request from one address, including replays, `mine` and preflight |
| `postPerIpMinute` / `postPerIpHour` | 10 / 60 | new comments per address |
| `postPerVisitorMinute` / `postPerVisitorHour` | 5 / 30 | new comments per visitor secret |
| `postGlobalMinute` / `postGlobalHour` | 120 / 1,000 | new comments in total |
| `postPerPageDay` | 500 | new comments for one page since 00:00 UTC |
| `minePerVisitorMinute` / `minePerIpMinute` | 12 / 600 | `mine` requests |
| `maxStoredBytes` | 268,435,456 | UTF-8 bytes of stored comment text, names, URLs and anchors (507 when full) |

Each value must be a positive integer of at most ten times its default; an
unknown key or invalid value stops `start` with an error. Per-address and global
counters never drop live entries: when 50,000 addresses are already counted, a new
address gets 429 until the window ends. Per-visitor counters drop their oldest
entries instead.

The address is the socket peer. When the peer is listed in
`comments.trustedProxies` (at most 16 exact IP addresses; default `127.0.0.1`,
`::1` and `::ffff:127.0.0.1`, which covers a reverse proxy on the same machine),
the server walks `X-Forwarded-For` from right to left and takes the first address
that is not a trusted proxy, or uses `X-Real-IP` when there is no
`X-Forwarded-For`. Forwarded headers from any other peer are ignored. IPv6
addresses are counted by their /64 prefix. Behind a reverse proxy on another
machine, list that proxy's address:

```json
"comments": {
  "enabled": true,
  "trustedProxies": ["10.0.0.5"],
  "limits": { "postPerPageDay": 200 }
}
```

Browsers reach comment routes with exact-origin CORS as for any route: add each
page origin to `origins`. The preflight allows `Content-Type`, `Idempotency-Key`,
`Authorization` and `X-Board-Visitor`, and comment responses let the page read
`Retry-After`. The runtime does not answer browser private-network permission
requests; reachability is decided by where the owner deploys the app.

### Schema upgrade and existing deployments

The runtime keeps its own tables (`_board_comments`, `_board_comment_replies`,
`_board_runtime_meta`) outside author migrations. At start, in one transaction, it
upgrades a database from comment schema 1 to 2: it adds the visitor and page
columns and their indexes, the reply table, the export acknowledgement and a
stored-bytes counter computed from existing rows. The upgrade runs once, keeps all
existing comments (they export as before and never appear in `mine`), and rolls
back as a whole on error. A database marked with a newer schema stops `start`
with "This database was upgraded by a newer Board runtime; update this app's
runtime before starting." An older runtime started on an upgraded database still
accepts and exports comments; it ignores replies.

An app created before visitor threads keeps its old runtime until the owner
refreshes it with the installed launcher and deploys through the reviewed path:

```sh
paseo-board-app update-runtime --dir /absolute/app
node /absolute/app/board-app.mjs ssh plan --dir /absolute/app --host <alias> --root <remote-root> --out ../plan.json
node /absolute/app/board-app.mjs ssh deploy --plan ../plan.json --confirm <digest>
```

The upgrade happens when the deployed app starts. Comment intake must already be
on (`comments.enabled: true`) and every page origin listed in `origins`.
`update-runtime` changes only `.board/runtime`; it does not refresh the app's own
copy of the visitor helper in `public/board-comments.js`.

### Optional visitor form

The optional `public/board-comments.js` module supplies a native form with freely
editable CSS classes. It is not automatically displayed. After enabling comments
and configuring the API origin, an agent can wire it into any authored page:

```js
import { mountComments } from './board-comments.js';
mountComments(document.querySelector('#comments'), { apiBase: 'https://api.example.internal', pageUrl: location.href, anchor: { selector: '#chart' } });
```

Its note tells visitors that comments go to the page's author and may be handled
by the author's AI assistant, and that names are self-reported. It posts without
a visitor secret, so its comments are not listed by `mine`.

The form uses a stable idempotency key and freezes a submitted payload until it
receives its matching receipt. An explicit retry reuses that key, including after
reload when session storage is available. It never automatically retries, shares
the export token with visitors or treats a self-reported name as verified identity.

The optional `request(url, options)` adapter defaults to `fetch` and accepts a
response with `ok`, `status` and async `json()`. A published Board can pass
`request: (url, options) => board.request(url, options)` so the approved published
page performs the HTTP request. The optional synchronous `storage` adapter has
`getItem`, `setItem` and `removeItem`, defaulting to session storage; `null` disables
persistence. An opaque published canvas can preserve its pending comment in
visitor-local Board state without reading iframe session storage:

```js
const storage = {
  getItem(key) { return board.getState().commentIntents?.[key] ?? null; },
  setItem(key, value) {
    const state = board.getState();
    board.saveState({...state, commentIntents: {...state.commentIntents, [key]: value}});
  },
  removeItem(key) {
    const state = board.getState(), intents = {...state.commentIntents};
    delete intents[key];
    board.saveState({...state, commentIntents: intents});
  }
};
mountComments(document.querySelector('#comments'), {
  apiBase: 'https://api.example.internal',
  request: (url, options) => board.request(url, options),
  storage
});
```

The published Board must include the form source in its authored script; adding
an API origin does not allow loading an external module. See
[published frontend setup](published-apps.md) for API origins and CORS. State
adapters must preserve unrelated visitor state. They do not store comments in the
shared application database; the HTTP endpoint does that.

## Live public data

Set `BOARD_LIVE_WRITE_TOKEN` in the server's `.env` (32 to 512 printable ASCII
characters) and restart the app to enable the live routes. Generate it yourself;
it is not an agent task. Enter the same value once in the Board's owner panel
(More → 实时公开数据); see [live public data](live-data.md). Without a valid
token every live route returns 404 and no `live/` directory is created.
`/_board/health` reports `live: 1` when the routes exist and `live: 0` when
they do not; a runtime older than this feature omits the field.

An existing project keeps the runtime copied at its creation, and its own
`board-app.mjs` cannot update that copy. Use the installed launcher:

```sh
paseo-board-app update-runtime --dir /absolute/path/my-app
```

It checks the app's identity without creating a data directory, stages every
file, then renames them. It changes only `.board/runtime`, and never routes,
storage, migrations or data. Then run the normal reviewed `ssh plan` / `ssh deploy`.

Routes under `/_board/live/<channelId>`:

- `GET` is public, answered from memory, and returns 204 when `?v=<dep8>.<seq>`
  matches the current version, otherwise the document. It carries
  `Board-Live: f=<0|1|g>, p=<seconds>`.
- `PUT` and `DELETE` need `Authorization: Bearer TOKEN` and refuse any `Origin`
  header. The publisher is the only intended writer.

Add every page origin to `origins`, as for any API. The owner panel probes this
and shows the exact fix for a shared page the backend would refuse. Each document is one
file in `<dataDir>/live/`, outside SQLite: redeploys and same-directory restores
keep it, and a cold restore deletes it and asks the owner to re-confirm. Malformed
files are skipped and logged and never stop the app.

## Verification

Run `node --test backend/checks.mjs`. These checks use actual Node HTTP, SQLite,
WAL backup/restore and the remote controller in a temporary local directory.
They do not connect to a remote SSH server or claim a deployment on the work
computer. Live remote network, proxy/SSO and reboot behavior require a separately
authorized target.

The generated SSH command also runs through available local `sh`, `zsh` and
`fish` shells, exercising the actual controller plus quotes, backslashes, Unicode,
newlines and separate request input. Direct Node execution and captured SSH argv
alone do not cover a remote account's shell parsing. The opt-in
`node backend/ssh-protocol-check.mjs /absolute/new/evidence-directory` additionally
starts an isolated loopback sshd with temporary keys/config, deploys only its own
app and stops its processes afterward; it does not change the user's SSH config.

Visitor threads (2026-11-13) added 24 checks, 64 in total, all passing on Node
23.11. They run every case of the shared contract fixture against real HTTP, and
cover the schema upgrade from a database written with the previous runtime's SQL,
that SQL still working on an upgraded database, export compatibility with the
previous plugin's page schema, `mine` isolation and status, owner replies, every
limit with `Retry-After`, trusted proxies and IPv6 /64 keys, config validation,
CORS headers, backup and restore, and `update-runtime` followed by the first start
of the copied runtime. No browser, Board plugin or remote server is involved.

The implementation was checked on 2026-11-08 with Node 23.11 and the installed
Paseo Helper's Node runtime: ten backend checks passed on each. The checks also
cover migration-history tampering, restoring behind an already imported comment
cursor, IPv6 control, managing a deployed app after local source edits, and a
failed new entry after a successful migration. The latter retains the previous
current-release pointer, new schema, safety backup and failed release for an
explicit recovery decision. A later durability-only change to JSON/identity
fsync passed the two affected backup/comment checks. No live plugin installation
or remote server deployment was performed by this test suite.

A separate isolated real SSH acceptance subsequently passed six checks: public
key handshake, reviewed deployment and health, live backup, management after local
source edits, redeployment preserving data/identity, and logs/final stop. It used
an owned loopback sshd and the account's Fish login shell. Its final receipt
confirmed the app stopped, sshd stopped and temporary private keys removed. The
original raw-source shell parsing failure and its cleanup reconciliation remain
recorded separately; no work computer, real remote network, system SSH settings
or primary Paseo daemon was involved.
