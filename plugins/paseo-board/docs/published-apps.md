# Published Board pages with an authored backend

The frontend and backend are ordinary authored application code. Board exports
the frozen frontend; `paseo-board-app` supplies an editable backend project and
its lifecycle commands. GitHub Pages (public or Enterprise) serves static files;
an independently deployed HTTP(S) application stores shared data.

## Configure and call an API

In the native publishing panel, enter each approved **backend API origin**, such
as `https://api.example.internal`. Leave the list empty for a static page.
The API origins become part of the immutable release hash and manifest. They
allow API calls, not remote scripts or styles. The resource setting controls
embedded resources versus the existing CDN list independently.

The release CLI accepts `--api-origins /absolute/api-origins.json`, whose content
is a JSON array of exact origins. Up to eight HTTPS origins are allowed; HTTP
localhost/127.0.0.1/[::1] is supported for local testing. No wildcards, paths,
credentials, query strings or fragments belong in this list.

Authored published code uses the general `board.request` capability:

```js
const response = await board.request('https://api.example.internal/api/records', {
  method: 'POST',
  headers: {'Content-Type': 'application/json', 'Idempotency-Key': operationId},
  body: JSON.stringify({text: input.value})
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const saved = await response.json();
```

This is not a predefined set of operations: the author defines the route,
schema, authorization, queries and response in `routes.mjs`, `storage.mjs` and
numbered SQL migrations. The result exposes `status`, `ok`, a header object and
async `text()` / `json()` methods. Requests accept text bodies up to 256 KiB,
responses up to 1 MiB, at most 16 concurrent calls and a 15-second network limit.
There are no automatic retries. A lost response can follow a committed write;
use application-level idempotency and retain the exact operation before retrying.

The outer published page performs the request so the backend receives the
actual website's CORS origin. The authored canvas remains an opaque sandbox.
Add that exact website origin to the scaffold's `origins` array. Requests omit
cookies, do not follow redirects and do not supply Paseo or export credentials.
Applications may supply their own visitor authorization header; never embed a
server, SSH or inbox-export secret in a public artifact. Proxy/SSO redirects
must be handled by an explicit application authentication flow, not silently
followed by this transport.

The native publishing preview and a file opened from disk have no trusted HTTP(S)
origin and cannot call the backend. `board.request` is a published-viewer API;
authoring code should show a clear published-only state when it is unavailable.
For real integration testing, serve the exported files over HTTP(S). A local
scaffold frontend can instead use ordinary `fetch` directly.

The sandbox and CORS boundaries follow the browser's [iframe sandbox
rules](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
and [Fetch credential behavior](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch).

## Visitor comments and the native inbox

Enable the scaffold's optional comment intake, then use the optional editable
comment form or submit `POST /_board/comments` from authored code through the
same API transport. Preserve a stable `Idempotency-Key` and exact comment payload
until acknowledged. In a published Board, `board.getState()` / `board.saveState()`
provide visitor-local persistence; direct iframe session storage is unavailable.
This visitor state is not the shared application database.

The Board owner privately registers the separate export URL and token under
**More → Comment inbox → Backend sources** and explicitly syncs a page. Neither
the export token nor the host's private data enters the published frontend.
Read and triage grants are initially off. A visitor comment never becomes an
owner instruction, triggers an agent, deploys code or publishes a response.

See [backend operations](app-backend-scaffold.md) and
[native inbox permissions](comment-inbox.md).
