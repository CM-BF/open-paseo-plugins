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
noninteractive. Arguments are individually shell-quoted. No SSH secrets are
stored in the plan or sent to a browser.

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

## Native comment export protocol

`comments.enabled` defaults to false. Enabling it allows visitors to create
comments through `POST /_board/comments`, with a stable `Idempotency-Key` header
(8–128 ASCII letters/digits/dot/underscore/colon/hyphen). Reusing the key with
another payload returns 409; retrying the same comment returns its original ID.
The body is strict:

```json
{
  "text": "A comment, at most 8000 characters",
  "authorName": "Optional self-reported name, at most 160 characters",
  "pageUrl": "https://example.internal/page",
  "anchor": {"label": "Optional label", "selector": "#optional-selector"}
}
```

The optional URL is HTTP(S), contains no credentials and is at most 2000
characters. Anchor label and selector are limited to 200 and 500 characters.
Names are visitor-supplied labels, not authenticated identity. The scaffold
records these comments; it does not send agent messages or publish replies.

Export additionally requires a private `BOARD_INBOX_EXPORT_TOKEN` of at least 32
characters. `GET /_board/comments?cursor=0&limit=50` uses
`Authorization: Bearer TOKEN`. With no token, export is disabled. Responses are:

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

Pagination is ascending, bounded at 100, and advances only over returned rows.
An empty result retains the cursor. Deployment identity is stored in durable data
and survives code releases, migrations and ordinary restart. Restoring an older
database in the same intact data directory preserves the comment sequence's high
water mark, so new comments remain ahead of an already imported Board cursor.
If the old database or identity is missing, a cold restore creates a new
deployment identity and returns `newCommentSourceRequired: true`. Register it as
a new Board source; the previous source's imported comments remain retained.
This prevents a historical backup from impersonating a continuous comment stream.
Read/triage permission in Board is separate from the export token. Neither
permits changing the app nor posting a public response.

## Verification

Run `node --test backend/checks.mjs`. These checks use actual Node HTTP, SQLite,
WAL backup/restore and the remote controller in a temporary local directory.
They do not connect to a remote SSH server or claim a deployment on the work
computer. Live remote network, proxy/SSO and reboot behavior require a separately
authorized target.

The implementation was checked on 2026-11-08 with Node 23.11 and the installed
Paseo Helper's Node runtime: ten backend checks passed on each. The checks also
cover migration-history tampering, restoring behind an already imported comment
cursor, IPv6 control, managing a deployed app after local source edits, and a
failed new entry after a successful migration. The latter retains the previous
current-release pointer, new schema, safety backup and failed release for an
explicit recovery decision. A later durability-only change to JSON/identity
fsync passed the two affected backup/comment checks. No live plugin installation
or remote server deployment was performed by this test suite.
