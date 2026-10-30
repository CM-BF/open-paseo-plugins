import type { Board, FeedAck, FeedInput, FeedResult, FeedState } from "../shared/contracts";
import { FeedInputSchema } from "../shared/contracts";
import { pointer } from "./data-patch";
import { assertJson, BoardStoreError, canonicalJson, fingerprint, parseInput } from "./store-format";

export const FEED_VALUE_LIMIT = 256_000;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export function feedValue(data: Board["canvas"]["data"], path: string): { exists: boolean; value?: unknown } {
  let value: unknown = data;
  for (const part of pointer(path)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new BoardStoreError("data_conflict", "Feed paths cannot traverse arrays or non-object parents", { path });
    if (!own(value, part)) return { exists: false };
    value = (value as Record<string, unknown>)[part];
  }
  return { exists: true, value };
}
function assign(data: Board["canvas"]["data"], path: string, value: unknown): void {
  const parts = pointer(path);
  let parent = data;
  for (const part of parts.slice(0, -1)) {
    if (!own(parent, part)) parent[part] = {};
    const next = parent[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new BoardStoreError("data_conflict", "Feed parent changed to a non-object", { path });
    parent = next as typeof parent;
  }
  parent[parts.at(-1)!] = structuredClone(value);
}
function overlapping(left: string, right: string): boolean {
  const a = pointer(left), b = pointer(right);
  return a.slice(0, Math.min(a.length, b.length)).every((part, index) => b[index] === part);
}
function assertSourceActor(source: FeedState, actor?: string): void {
  if (actor && source.actorAgentId !== actor) throw new BoardStoreError("forbidden", "This source belongs to another writer; ask its owner to close it or use another source and non-overlapping path");
}
export function parseFeed(input: FeedInput): ReturnType<typeof FeedInputSchema.parse> {
  const parsed = parseInput(FeedInputSchema, input);
  if (parsed.action === "set") {
    assertJson(parsed.value, "Feed value");
    if (Buffer.byteLength(JSON.stringify(parsed.value)) > FEED_VALUE_LIMIT) throw new BoardStoreError("size_limit", `Feed values must be at most ${FEED_VALUE_LIMIT} bytes`);
  }
  return parsed;
}
export type FeedChange = { result: FeedResult; changed: boolean; dataChanged?: boolean; eventId?: string; targets?: string[] };
/** Called under the Board's existing serialized, atomic envelope transaction. */
export function changeFeed(board: Board, input: ReturnType<typeof parseFeed>, at: string, actorAgentId?: string): FeedChange {
  const sources = board.feeds ??= [];
  let source = sources.find(item => item.sourceId === input.sourceId);
  if (input.action === "status") {
    if (!source) throw new BoardStoreError("not_found", "Feed source does not exist");
    return { result: { source }, changed: false };
  }
  if (source) assertSourceActor(source, actorAgentId);
  const ack = (generation: number, seq: number): FeedAck => ({ boardId: board.id, sourceId: input.sourceId, generation, seq, revision: board.revision + 1, canvasRevision: board.canvas.revision, acceptedAt: at });
  if (input.action === "open") {
    pointer(input.path);
    const digest = fingerprint("feed-open", { ...input, actorAgentId });
    if (source?.openRequestId === input.requestId) {
      if (source.openFingerprint !== digest) throw new BoardStoreError("idempotency_conflict", "Feed open request ID already identifies another configuration");
      if (source.closed) throw new BoardStoreError("source_closed", "This generation was closed; explicitly open a new generation");
      return { result: { source, ack: source.openAck }, changed: false };
    }
    if ((source?.generation ?? 0) !== input.expectedGeneration) throw new BoardStoreError("generation_conflict", "Feed generation changed; inspect before explicitly replacing it", { currentGeneration: source?.generation ?? 0 });
    const conflict = sources.find(item => !item.closed && item.sourceId !== input.sourceId && overlapping(item.path, input.path));
    if (conflict) throw new BoardStoreError("path_conflict", "Another active source owns this path or its ancestor/descendant", { sourceId: conflict.sourceId, path: conflict.path });
    if (!source && sources.length >= 64) throw new BoardStoreError("size_limit", "A Board can retain at most 64 feed identities");
    const generation = input.expectedGeneration + 1;
    const openAck = ack(generation, 0);
    const next: FeedState = { sourceId: input.sourceId, path: input.path, generation, actorAgentId, closed: false, seq: 0, openedAt: at,
      focusSelectors: input.focusSelectors, openRequestId: input.requestId, openFingerprint: digest, openAck,
      valueFingerprint: fingerprint("feed-value", feedValue(board.canvas.data, input.path)), receipts: [] };
    if (source) sources[sources.indexOf(source)] = next; else sources.push(next);
    return { result: { source: next, ack: openAck }, changed: true };
  }
  if (!source) throw new BoardStoreError("not_found", "Open the feed source first");
  if (source.generation !== input.generation) throw new BoardStoreError("generation_conflict", "This producer generation has been replaced", { currentGeneration: source.generation });
  if (input.action === "close") {
    if (source.closed) return { result: { source }, changed: false };
    source.closed = true;
    return { result: { source }, changed: true };
  }
  if (source.closed) throw new BoardStoreError("source_closed", "This producer generation is closed");
  const digest = fingerprint("feed-set", input);
  const previous = source.receipts.find(item => item.seq === input.seq);
  if (previous) {
    if (previous.fingerprint !== digest) throw new BoardStoreError("idempotency_conflict", "A feed sequence identifies one immutable value and attention policy", { seq: input.seq });
    return { result: { source, ack: previous.ack }, changed: false };
  }
  if (input.seq !== source.seq + 1) throw new BoardStoreError("sequence_conflict", "Feed writes must use the next sequence; old receipts outside the retained window are not replayed", { expectedSeq: source.seq + 1, receivedSeq: input.seq });
  if (source.valueFingerprint !== fingerprint("feed-value", feedValue(board.canvas.data, source.path))) throw new BoardStoreError("data_conflict", "This feed path was edited outside its source; inspect and explicitly reopen a generation before overwriting it", { path: source.path });
  const dataChanged = canonicalJson(feedValue(board.canvas.data, source.path)) !== canonicalJson({ exists: true, value: input.value });
  if (dataChanged) { assign(board.canvas.data, source.path, input.value); board.canvas.revision++; }
  const accepted = ack(source.generation, input.seq);
  source.seq = input.seq;
  source.lastAck = accepted;
  source.lastAcceptedAt = at;
  delete source.lastError;
  source.valueFingerprint = fingerprint("feed-value", { exists: true, value: input.value });
  source.receipts.push({ seq: input.seq, fingerprint: digest, ack: accepted });
  source.receipts = source.receipts.slice(-32);
  return { result: { source, ack: accepted }, changed: true, dataChanged,
    eventId: `feed:${fingerprint("feed-event", { sourceId: source.sourceId, generation: source.generation, seq: input.seq }).slice(0, 40)}`,
    targets: input.attention === "milestone" ? input.focusSelectors ?? source.focusSelectors : undefined };
}
