/**
 * Test support only: a contract-faithful fake of the paseo-board-app owner API used by the inbox
 * (DESIGN §4.5.4 owner reply, §11.10 export v1/v2). It never runs in the plugin server.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeRow { seq: number; externalId: string; text: string; createdAt: string; authorName?: string; pageUrl?: string; anchor?: Record<string, unknown>; visitorTag?: string }
export interface FakeReply { replyId: string; commentExternalId: string; text: string; authorKind: "owner" | "agent"; createdAt: string; idempotencyKey: string }
export type FakeFailure = "network" | "500" | "429" | "401" | "403" | "404-old" | "404-export" | "404-export-disabled" | "404-comments-disabled" | "409-key" | "409-limit" | "mismatch";
export interface FakeBackend {
  url: string; endpoint: string; token: string; deploymentId: string;
  rows: FakeRow[]; replies: Map<string, { hash: string; reply: FakeReply }>;
  requests: Array<{ method: string; url: string; authorization?: string; key?: string; origin?: string; body?: unknown }>;
  /** Failures consumed one per matching request, in order. */
  failExport: FakeFailure[]; failReply: FakeFailure[];
  /** Answer exports in the 4b94741 v1 shape regardless of `format`. */
  legacy: boolean;
  /** Optional raw override for the next export body (malformed envelopes, rows the fake would never store). */
  rawExport: unknown[];
  holdReplies?: Promise<void>;
  /** Milliseconds added to the backend clock (negative: the owner's server runs behind the host). */
  skewMs: number;
  add(row: Partial<FakeRow> & { text: string }): FakeRow;
  close(): Promise<void>;
}
const UUID = /^[\da-f-]{36}$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function startFakeBackend(options: { token?: string; deploymentId?: string; now?: () => string } = {}): Promise<FakeBackend> {
  const token = options.token ?? "fake-export-token-0123456789abcdef0123456789";
  const deploymentId = options.deploymentId ?? "00000000-0000-4000-8000-00000000d001";
  const now = options.now ?? (() => new Date(Date.now() + backend.skewMs).toISOString());
  let seq = 0;
  const backend: FakeBackend = {
    url: "", endpoint: "", token, deploymentId, rows: [], replies: new Map(), requests: [], failExport: [], failReply: [], legacy: false, rawExport: [], skewMs: 0,
    add(row) { const stored: FakeRow = { seq: ++seq, externalId: row.externalId ?? randomUUID(), createdAt: row.createdAt ?? now(), ...row } as FakeRow; backend.rows.push(stored); return stored; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const fail = (res: ServerResponse, failure: FakeFailure | undefined): boolean => {
    if (!failure) return false;
    if (failure === "network") { res.socket?.destroy(); return true; }
    if (failure === "500") json(res, 500, { error: "boom", code: "internal" });
    else if (failure === "429") json(res, 429, { error: "slow down", code: "rate_limited" }, { "retry-after": "42" });
    else if (failure === "401") json(res, 401, { error: "A valid comment-export token is required", code: "unauthorized" });
    else if (failure === "403") json(res, 403, { error: "forbidden", code: "browser_forbidden" });
    else if (failure === "404-old") json(res, 404, { error: "Not found" });
    else if (failure === "404-export") json(res, 404, { error: "Comment export is disabled", code: "comments_disabled" });
    else if (failure === "404-export-disabled") json(res, 404, { error: "Comment export is disabled", code: "export_disabled" });
    else if (failure === "404-comments-disabled") json(res, 404, { error: "Comments are disabled", code: "comments_disabled" });
    else if (failure === "409-key") json(res, 409, { error: "conflict", code: "idempotency_conflict" });
    else if (failure === "409-limit") json(res, 409, { error: "limit", code: "reply_limit" });
    else return false;
    return true;
  };
  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${token}`;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    backend.requests.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, key: req.headers["idempotency-key"] as string | undefined, origin: req.headers.origin, body });
    if (req.method === "GET" && url.pathname === "/_board/comments") {
      if (fail(res, backend.failExport.shift())) return;
      if (!authorized(req)) return json(res, 401, { error: "A valid comment-export token is required", code: "unauthorized" });
      const cursor = url.searchParams.get("cursor") ?? "0", limit = Number(url.searchParams.get("limit") ?? "50");
      if (backend.rawExport.length) return json(res, 200, backend.rawExport.shift());
      const rows = backend.rows.filter(row => row.seq > Number(cursor)).slice(0, limit);
      const nextCursor = rows.length ? String(rows.at(-1)!.seq) : cursor;
      if (backend.legacy || url.searchParams.get("format") !== "2") {
        const comments = rows.map(({ seq: _seq, visitorTag: _tag, anchor, ...row }) => {
          const projected = anchor && (anchor.label !== undefined || anchor.selector !== undefined) ? { ...(anchor.label !== undefined ? { label: anchor.label } : {}), ...(anchor.selector !== undefined ? { selector: anchor.selector } : {}) } : undefined;
          return { ...row, ...(projected ? { anchor: projected } : {}) };
        });
        return json(res, 200, { deploymentId, cursor, nextCursor, comments });
      }
      return json(res, 200, { deploymentId, format: 2, cursor, nextCursor, comments: rows.map(({ seq: _seq, ...row }) => row) });
    }
    const match = /^\/_board\/comments\/([^/]+)\/replies$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      if (backend.holdReplies) await backend.holdReplies;
      const failure = backend.failReply.shift();
      if (failure === "mismatch") return json(res, 201, { deploymentId: "another-deployment", replayed: false, reply: { replyId: randomUUID(), commentExternalId: "x", text: "x", authorKind: "agent", createdAt: now(), idempotencyKey: "x" } });
      if (fail(res, failure)) return;
      if (req.headers.origin) return json(res, 403, { error: "Browser requests cannot reply", code: "browser_forbidden" });
      if (!authorized(req)) return json(res, 401, { error: "A valid comment-export token is required", code: "unauthorized" });
      const externalId = decodeURIComponent(match[1]);
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return json(res, 400, { error: "Idempotency-Key", code: "invalid_input" });
      const input = body as { text?: unknown; authorKind?: unknown };
      if (!input || typeof input !== "object" || Object.keys(input).some(name => !["text", "authorKind"].includes(name)) || typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 2000) return json(res, 400, { error: "Reply text", code: "invalid_input" });
      const text = input.text.trim(), authorKind = input.authorKind === "agent" ? "agent" : "owner";
      const hash = digest(JSON.stringify({ comment: externalId, text, authorKind }));
      const previous = backend.replies.get(key);
      if (previous) return previous.hash === hash ? json(res, 200, { deploymentId, replayed: true, reply: previous.reply }) : json(res, 409, { error: "Idempotency-Key reused", code: "idempotency_conflict" });
      if (!UUID.test(externalId) || !backend.rows.some(row => row.externalId === externalId)) return json(res, 404, { error: "Unknown comment", code: "comment_not_found" });
      if ([...backend.replies.values()].filter(item => item.reply.commentExternalId === externalId).length >= 20) return json(res, 409, { error: "Too many replies", code: "reply_limit" });
      const reply: FakeReply = { replyId: randomUUID(), commentExternalId: externalId, text, authorKind, createdAt: now(), idempotencyKey: key };
      backend.replies.set(key, { hash, reply });
      return json(res, 201, { deploymentId, replayed: false, reply });
    }
    json(res, 404, { error: "Not found", code: "not_found" });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  backend.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  backend.endpoint = `${backend.url}/_board/comments`;
  return backend;
}
