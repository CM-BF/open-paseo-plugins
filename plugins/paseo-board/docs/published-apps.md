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

## Live public data

The owner can mark Board data as public under **More → 实时公开数据** and turn on
the switch of the same name in the publishing panel. The release freezes the
backend origin and paths; the viewer polls that one document and overlays its
values onto the frozen data. Authored code needs no changes if it reads through
`board.getData()`, `board.watch`, `board.onData` or the `board:data` event; write
live values with `textContent`. Without a live channel a release behaves exactly
as before: `board.watch` fires once and `onData` never fires.

The backend origin must allow each page's exact origin, as for any API. A page
stays frozen until one confirmed share update adopts a new path set. A loopback
backend cannot be published to a public site. See
[live public data](live-data.md) for the owner's flow, limits and residual risks.

## 访客框选评论 (visitor text-selection comments)

A published page can let visitors select any text and comment on it, as on the
working Board. The owner turns this on per release; pages without it are
byte-identical to pages built before the feature.

**What visitors see.** After a selection settles for a moment, a small **评论**
button appears next to it (below it on touch screens). Right-clicking inside a
selection that already existed opens the composer directly; Shift + right-click
keeps the browser menu, and the ContextMenu key or Shift+F10 works from the
keyboard. The composer quotes the passage and has an optional name (remembered),
the comment text (at most 2,000 characters), **发送** and **取消**.
⌘/Ctrl + Enter sends; Esc closes it and keeps the draft for this browser tab.
After sending, **我的评论 n** appears at the bottom left and a numbered marker
sits at the end of each passage the visitor commented on. The badge reports new
replies (**我的评论 n · m 条新回复**); the panel lists the visitor's own threads
with their status (**已发送，等待作者查看**, **作者已收到**, **已回复**) and
replies labelled **作者回复** or **作者的 AI 助手回复**. **在页面中定位** scrolls
back to the passage, **再评论这段** comments on it again, and a thread whose
passage no longer exists is listed as **原文已修改，页面上找不到这段文字**.
**清除本机的评论身份** forgets this browser's anonymous identity.

**Where it never activates.** Inputs, textareas, selects, buttons,
contenteditable regions and ARIA text boxes, menus, sliders, list boxes and
combo boxes are excluded, as is anything inside `data-board-comments="off"`
(on `<html>` or `<body>` it turns the feature off for the whole page). With
nothing selected, links and controls keep their native menus, and an authored
`contextmenu` handler that calls `preventDefault()` owns its region. Authored
`board.request` calls and the scaffold's `mountComments` form keep working
unchanged.

**Owner setup.** The backend is a `paseo-board-app` application with
`comments.enabled: true` and the publishing website's exact origin in `origins`.
In the publishing panel turn on **访客可以框选评论** and enter the backend
address: an HTTPS origin with an optional path prefix, such as
`https://api.example.com` or `https://example.com/board-api` (no trailing slash).
The panel prefills the first ready, enabled source from **更多 → 评论收件箱 →
后端来源**. **检查后端** reads the backend's `/_board/health` from this computer
and reports whether comment threads are available, which share-link origins are
missing from `origins`, and whether a reverse proxy needs
`comments.trustedProxies`. An older runtime reports **后端版本过旧**: run
`paseo-board-app update-runtime --dir /absolute/app` and redeploy it through the
reviewed SSH path. A release is created only when the check passes at that
moment; the panel reads the app key from the backend. The address is the owner's
deployment decision: a loopback address only works on the computer that runs the
backend, and an internal hostname on a public github.com site is visible in the
page code and unreachable from outside the company network, so the panel asks
for **我确认把这个地址写进公开网页** first.

The release CLI takes `--comments-api <api-base>` on `export` and fills the app
key from the backend after the same check.

**Release mechanics.** The release stores `comments: {apiBase, appKey}` in its
hash input, manifest and private settings and uses viewer version 4 (with or
without live data). Only the backend's origin is added to the outer page's
`connect-src`; it is not added to `apiOrigins`, so authored code gains no new
network access. Share updates inherit the setting; **用面板中的评论设置更新**
applies the panel's setting (a new address, or 关闭) to an existing share link.
The visitor identity is keyed by the app key, so moving the same app to a new
address keeps visitors' threads; switching to another app does not, and the
panel says so (**换成了另一个评论后端应用**).

**Privacy and network behaviour.**

- The trusted outer page owns the composer, the visitor secret and every request.
  The authored canvas frame only reports selections and draws markers in a closed
  shadow root; it never receives the secret, comment text or reply text, and a
  frame message cannot open the composer without a real user gesture.
- The visitor identity is a random 256-bit secret in `localStorage` under
  `paseo-board-visitor:v2:<appKey>`, together with the remembered name and reply
  counts. No comment text, reply text, quote or URL is kept there; the thread
  cache and drafts live in `sessionStorage`. Other pages on the same site origin
  (for example every repository of one `github.io` account) can read that
  secret; the panel states this.
- A first-time visitor's page makes no request until they send. Before the first
  request of a page load the page checks `/_board/health` (same app key, comment
  threads available). Visitors with threads on the page refresh them every
  15 s ± 20 % while the page is visible and on focus, at least 10 s apart, with
  backoff on errors and `Retry-After`. Requests omit cookies and referrer and do
  not follow redirects. The host's preview never contacts the backend.
- Comment text, names, URLs and anchors are untrusted visitor data. The page
  renders every visitor and reply text as plain text.

**Page ↔ backend contract.** `POST {apiBase}/_board/comments` with
`Idempotency-Key` (`pc-<uuid>`, reused for retries) and `X-Board-Visitor`, body
`{text, authorName?, pageUrl, anchor}`; `GET {apiBase}/_board/comments/mine?page=`
with `X-Board-Visitor`; `GET {apiBase}/_board/health`. The anchor carries
`label`, `selector`, `quote`, `prefix`, `suffix`, `start`, `end` and `releaseId`
(DESIGN §4.1). The shared case list is `scripts/fixtures/page-comments-contract.json`.

## Visitor comments and the native inbox

Enable the scaffold's optional comment intake. Then either turn on
**访客可以框选评论** when publishing, or use the optional editable comment form
or submit `POST /_board/comments` from authored code through the same API
transport. Authored code should preserve a stable `Idempotency-Key` and the exact
comment payload until acknowledged. In a published Board, `board.getState()` /
`board.saveState()` provide visitor-local persistence; direct iframe session
storage is unavailable. This visitor state is not the shared application
database.

The Board owner privately registers the separate export URL and token under
**More → Comment inbox → Backend sources**; connected sources sync
automatically. Neither the export token nor the host's private data enters the
published frontend. Read and triage grants are initially off. A visitor comment
never becomes an owner instruction or deploys code. Only after the owner
confirms automatic handling in the inbox does the plugin hand new comments to
that Board's dedicated comment assistant, whose replies the visitor sees on the
page.

See [backend operations](app-backend-scaffold.md) and
[native inbox permissions](comment-inbox.md).
