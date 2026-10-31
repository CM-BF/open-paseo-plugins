import type { z } from "zod";
import type { Board, ReadInputSchema } from "../shared/contracts";
import { describeAuthoring } from "./authored-source";

const excerpt = (text: string | undefined, limit: number) => text === undefined ? undefined : ({ text: text.slice(0, limit), truncated: text.length > limit, totalCharacters: text.length });
const pending = new Set(["saved", "sending", "delivered", "processing"]);

/** Compact persisted evidence. This intentionally makes no claim about a live browser. */
export function inspectBoard(board: Board, input: z.output<typeof ReadInputSchema>) {
  const limit = input.recentLimit;
  let dataBudget = 32768;
  const data = (input.dataPaths ?? []).map(path => {
    let value: unknown = board.canvas.data;
    const parts = path === "" ? [] : path.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    for (const part of parts) {
      if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part) || (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(part))) return { path, exists: false };
      value = (value as Record<string, unknown>)[part];
    }
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > Math.min(16384, dataBudget)) return { path, exists: true, omitted: true, bytes, reason: "Value exceeds compact-read budget; use a narrower path or view:full." };
    dataBudget -= bytes;
    return { path, exists: true, value, bytes };
  });
  const selected = input.interactionIds
    ? input.interactionIds.flatMap(id => { const item = board.interactions.find(value => value.id === id); return item ? [item] : []; })
    : [...board.interactions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0, limit);
  const interactions = selected.map(item => ({
    id: item.id, status: item.status, agentId: item.agentId, sourceInteractionId: item.sourceInteractionId,
    responseRevision: item.responseRevision ?? 0, responseSource: item.responseSource, updatedAt: item.updatedAt,
    question: excerpt(item.text, 1200), response: excerpt(item.response, 2400), error: excerpt(item.error, 800),
    resultReferences: item.resultReferences.slice(0, 12).map(value => value.slice(0, 1000)),
    resultReferencesTruncated: item.resultReferences.length > 12 || item.resultReferences.some(value => value.length > 1000),
    anchor: item.anchor ? {
      kind: item.anchor.kind, selector: item.anchor.selector, rect: item.anchor.rect,
      boardRevision: item.anchor.boardRevision, canvasRevision: item.anchor.canvasRevision,
      quote: excerpt(item.anchor.text, 1200), hasImage: !!item.anchor.image,
    } : undefined,
    responseCanvas: item.responseCanvas ? { revision: item.responseCanvas.revision, documentVersion: item.responseCanvas.documentVersion } : undefined,
  }));
  // Only replay source when explicitly requested; ordinary status checks avoid HTML parsing.
  const source = input.selector ? describeAuthoring(board.canvas, input.selector) : undefined;
  const keys = Object.keys(board.canvas.data);
  let keyBudget = 4000;
  const dataKeys = keys.filter(key => {
    const size = Buffer.byteLength(key);
    if (size > Math.min(500, keyBudget)) return false;
    keyBudget -= size;
    return true;
  }).slice(0, 100);
  return {
    view: "inspect", id: board.id, title: board.title, revision: board.revision, updatedAt: board.updatedAt,
    ownerAgentId: board.ownerAgentId, sideAgentId: board.sideAgentId,
    canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion },
    observation: { source: "persistent-store", liveBrowser: "not-observed", note: "Data and authored source are stored evidence, not live DOM, pixels, or proof that render code succeeded. Use view:full for complete authoring, decisions, original images and history." },
    data, dataKeys, dataKeyCount: keys.length, dataKeysOmitted: keys.length - dataKeys.length,
    interactions, interactionCount: board.interactions.length, pendingCount: board.interactions.filter(item => pending.has(item.status)).length,
    missingInteractionIds: input.interactionIds?.filter(id => !selected.some(item => item.id === id)) ?? [],
    updates: board.updates.slice(-limit), retainedUpdateCount: board.updates.length,
    unreadUpdateCount: board.updates.filter(item => !board.seenUpdateIds.includes(item.id)).length,
    feeds: [...(board.feeds ?? [])].sort((a, b) => (b.lastAcceptedAt ?? b.openedAt).localeCompare(a.lastAcceptedAt ?? a.openedAt)).slice(0, limit).map(source => ({
      sourceId: source.sourceId, path: source.path, generation: source.generation, actorAgentId: source.actorAgentId,
      mode: source.mode, capacity: source.capacity, recordCount: source.recordCount, recordBytes: source.recordBytes,
      closed: source.closed, seq: source.seq, openedAt: source.openedAt, lastAcceptedAt: source.lastAcceptedAt,
      lastAck: source.lastAck, lastError: source.lastError,
    })),
    feedCount: board.feeds?.length ?? 0,
    decisionCount: board.decisions.length,
    source: source ? {
      selector: input.selector, canvasBase: source.canvasBase, replay: { complete: source.replay.complete, appliedPatchCount: source.replay.appliedPatchIds.length, failedPatch: source.replay.failedPatch },
      target: source.target ? excerpt(source.target.html, 24000) : null, note: source.note,
    } : undefined,
  };
}
