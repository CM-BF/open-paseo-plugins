import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { Board } from "../shared/contracts";
import type { InboxActor, InboxScope } from "../shared/inbox";
import {
  PUBLIC_TEXT, inboxPublicPageRpc, inboxPublicStateRpc, inboxPublicThreadsRpc, inboxPublicVisitorRpc,
  type InboxPublicMessage, type InboxPublicResult, type InboxPublicSourceView, type InboxPublicThread, type InboxPublicThreads,
} from "../shared/inbox-public";
import type { Paseo } from "./sdk";
import type { InboxStore } from "./inbox-store";
import type { InboxConnections } from "./inbox-sync";
import { PublicStateOutbox } from "./inbox-public";
import { publicStateOf, type PublicLedger } from "./inbox-public-ledger";

/**
 * Public comment threads on the plugin server (public-threads DESIGN §5.4, §12 A3, A11): the owner's thread view
 * and moderation RPCs (human only, never MCP or CLI), the public-state outbox, and the release hooks that register
 * public releases on the inbox-connected backend. contribute.ts wires this with one call.
 */
const HUMAN: InboxActor = { kind: "user", id: "paseo-client" };
const FLUSH_BUDGET_MS = 10_000;
const scopeOf = (input: InboxScope): InboxScope => ({ boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt });

export interface PublicThreadsOptions {
  inbox: InboxStore; connections: InboxConnections; log(line: string): void;
  ready(): Promise<void>; capture(paseo: Paseo): void;
  /** Tests only: the outbox clock. */
  clock?: ConstructorParameters<typeof PublicStateOutbox>[0]["clock"];
}

/** Registers the RPCs and starts the outbox once the plugin is ready. Returns the disposer. */
export function registerPublicThreads(server: Pick<PluginServerContext, "handle">, options: PublicThreadsOptions): () => void {
  const { inbox, connections } = options;
  const outbox = new PublicStateOutbox({ inbox, connections, log: options.log, clock: options.clock });
  void options.ready().then(() => outbox.start()).catch(error => options.log(`public outbox failed to start: ${String(error)}`));
  const settle = async (scope: InboxScope) => { await Promise.race([outbox.flush(scope), new Promise(resolve => setTimeout(resolve, FLUSH_BUDGET_MS))]); };
  const enter = async (paseo: Paseo) => { options.capture(paseo); await options.ready(); };

  server.handle(inboxPublicThreadsRpc, async (input, { paseo }) => { await enter(paseo); return publicThreads(inbox, connections, scopeOf(input)); });
  server.handle(inboxPublicStateRpc, async (input, { paseo }): Promise<InboxPublicResult> => {
    await enter(paseo);
    const scope = scopeOf(input);
    await inbox.setPublicState(input, HUMAN);
    await settle(scope);
    const record = (await inbox.publicLedger(scope, HUMAN)).records.find(item => item.sourceId === input.sourceId && item.externalId === input.externalId);
    if (!record) throw new Error("这条公开评论不在收件箱的记录里。");
    const state = publicStateOf(record), ledger = await inbox.publicLedger(scope, HUMAN);
    return { ...statusOf(state.error, Boolean(state.pending)), revision: ledger.revision, state };
  });
  const action = (kind: "pause" | "hide-visitor") => async (input: Parameters<InboxStore["setPublicAction"]>[0], { paseo }: { paseo: Paseo }): Promise<InboxPublicResult> => {
    await enter(paseo);
    const scope = scopeOf(input), { action: recorded } = await inbox.setPublicAction(input, kind, HUMAN);
    await settle(scope);
    const ledger = await inbox.publicLedger(scope, HUMAN), current = ledger.actions.find(item => item.id === recorded.id);
    return { ...statusOf(current?.error, Boolean(current?.pending)), revision: ledger.revision, ...(current?.changed !== undefined ? { changed: current.changed } : {}) };
  };
  server.handle(inboxPublicPageRpc, action("pause"));
  server.handle(inboxPublicVisitorRpc, action("hide-visitor"));
  return () => outbox.close();
}
const statusOf = (error: string | undefined, pending: boolean): Pick<InboxPublicResult, "status" | "message"> =>
  error ? { status: "failed", message: PUBLIC_TEXT.failed(error) } : pending ? { status: "syncing", message: PUBLIC_TEXT.syncing } : { status: "applied", message: PUBLIC_TEXT.applied };

/** The thread view: the backend's moderation listing per source, with the inbox's wanted state and ledger IDs merged in. */
export async function publicThreads(inbox: InboxStore, connections: InboxConnections, scope: InboxScope): Promise<InboxPublicThreads> {
  const ledger = await inbox.publicLedger(scope, HUMAN);
  const results = await connections.moderation(scope);
  const sources: InboxPublicSourceView[] = results.map(({ source, listing, error, unsupported }) => {
    const base = { sourceId: source.sourceId, label: source.label.slice(0, 200) };
    if (!listing) return { ...base, state: unsupported ? "unsupported" as const : "error" as const, error: unsupported ? "后端版本过旧，不支持公开评论：在应用目录运行 paseo-board-app update-runtime，然后重新部署。" : (error ?? "未知错误").slice(0, 300), publicThreads: false, pages: [], threads: [], total: 0, truncated: false };
    const message = (item: { id: string; by?: string; hidden?: boolean; withdrawn?: true; resolved?: boolean }): Pick<InboxPublicMessage, "commentId" | "state"> => {
      if (item.by !== undefined && item.by !== "visitor") return {};
      const commentId = ledger.commentIds[`${source.sourceId}\0${item.id}`];
      const record = ledger.records.find(entry => entry.sourceId === source.sourceId && entry.externalId === item.id);
      const state = record ? publicStateOf(record) : { hidden: item.hidden === true, resolved: item.resolved === true, ...(item.withdrawn ? { withdrawn: true as const } : {}) };
      return { ...(commentId ? { commentId } : {}), state };
    };
    const threads: InboxPublicThread[] = listing.threads.map(thread => ({
      ...thread, by: "visitor" as const, ...(thread.anchor ? { anchor: cleanAnchor(thread.anchor) } : {}), ...message(thread),
      replies: thread.replies.map(item => ({ ...item, ...message(item) })),
    }));
    return { ...base, state: "ok" as const, error: null, publicThreads: listing.publicThreads, pages: pagesOf(ledger, source.sourceId, listing.pages), threads, total: listing.total, truncated: listing.truncated };
  });
  return { revision: ledger.revision, sources };
}
function cleanAnchor(anchor: Record<string, unknown>) {
  const out: Record<string, string | number> = {};
  for (const key of ["selector", "quote", "prefix", "suffix"]) if (typeof anchor[key] === "string") out[key] = (anchor[key] as string).slice(0, key === "quote" ? 1_000 : key === "selector" ? 500 : 64);
  for (const key of ["start", "end"]) if (Number.isSafeInteger(anchor[key]) && (anchor[key] as number) >= 0) out[key] = anchor[key] as number;
  return out;
}
function pagesOf(ledger: PublicLedger, sourceId: string, pages: Array<{ page: string; paused: boolean }>) {
  const byPage = new Map(pages.map(page => [page.page, { page: page.page, paused: page.paused, pending: false, error: null as string | null }]));
  for (const action of ledger.actions) {
    if (action.sourceId !== sourceId || action.kind !== "pause") continue;
    const entry = byPage.get(action.page) ?? { page: action.page, paused: false, pending: false, error: null };
    if (action.pending || action.error) Object.assign(entry, { paused: action.value, pending: Boolean(action.pending), error: action.error ?? null });
    byPage.set(action.page, entry);
  }
  return [...byPage.values()].slice(0, 500);
}

/** Publication hooks: the Board's inbox sources (identity match) and release registration through them (§12 A2, A10). */
export function publicReleaseHooks(connections: InboxConnections) {
  const scope = (board: Board) => ({ boardId: board.id, expectedCreatedAt: board.createdAt });
  return {
    sources: (board: Board) => connections.list(scope(board)),
    register: (board: Board, deploymentId: string, releaseId: string, on: boolean) => connections.publicRelease(scope(board), deploymentId, releaseId, on),
  };
}
