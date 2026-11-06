import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ServiceJournal } from "./journal";
import { BoardBridge } from "./bridge";
import { CompositionSources, compositionSnapshot } from "./composition";
import { SourceReadResultSchema, type BoardRef } from "../shared/composition";
import type { Board } from "../shared/contracts";
const local = { hostId: "local", boardId: "source" }, remote = { hostId: "remote", boardId: "source" };
const owner = { agentId: "parent-owner", cwd: "/tmp" };
describe("composition source capabilities", () => {
  let dir: string, store: BoardStore, sources: CompositionSources, service: BoardService, journal: ServiceJournal;
  let clock: number, sourceCreatedAt: string;
  beforeEach(async () => {
    clock = Date.parse("2026-11-05T12:00:00.000Z"); dir = await mkdtemp(join(tmpdir(), "board-composition-"));
    store = new BoardStore(join(dir, "boards")); await store.init();
    await store.create({ id: "parent", ownerAgentId: owner.agentId, title: "Monitor", html: '<main>Monitor</main>' });
    await store.create({ id: "source", ownerAgentId: "source-owner", title: "Source", html: '<h1>Source result</h1><script>secretExecutable()</script>', data: { result: { complete: true } } });
    sourceCreatedAt = (await store.read("source"))!.createdAt;
    sources = new CompositionSources(join(dir, "composition"), store, async () => "local", () => clock);
    journal = new ServiceJournal(join(dir, "service.json")); await journal.init();
    service = new BoardService(store, journal, () => {}); service.useComposition(sources);
  });
  afterEach(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }); });
  async function snapshot() { return compositionSnapshot((await store.read("source"))!, "remote", new Date(clock).toISOString()); }
  const select = (ref: BoardRef) => ({ ...ref, sourceCreatedAt });
  async function grant(refs: BoardRef[] = [remote]) { return sources.set({ boardId: "parent", expectedRevision: 0, sources: refs.map(select) }); }
  it("denies absent grants/foreign actors, exposes no agent grant operation and does not grant writes", async () => {
    await expect(service.execute("read_source", { boardId: "parent", source: local }, owner)).rejects.toMatchObject({ code: "source_not_authorized" });
    await grant([local]);
    await expect(service.execute("sources", { boardId: "parent" }, { ...owner, agentId: "other" })).rejects.toMatchObject({ code: "source_access_denied" });
    await expect(service.execute("read", { boardId: "source" }, owner)).rejects.toThrow("does not own");
    await journal.bind("parent-token", owner); const bridge = new BoardBridge(service);
    expect(await bridge.dispatch(JSON.stringify({ protocol: 1, client: "mcp", binding: "parent-token", operation: "set_sources", input: { boardId: "parent", sources: [remote] } }))).toMatchObject({ ok: false });
    expect(await bridge.dispatch(JSON.stringify({ protocol: 1, client: "mcp", binding: "parent-token", operation: "read_source", input: { boardId: "parent", source: local } }))).toMatchObject({ ok: true, result: { provenance: "local-store", freshness: "read-now", snapshot: { text: "Source result" } } });
    expect((await sources.list("parent")).sources.map(item => item.ref)).toEqual([local]);
  });
  it("excludes ordinary comment participants while permitting the parent's fork", async () => {
    const parent = (await store.read("parent"))!;
    const interaction = { id: "question", kind: "question", text: "Question", status: "answered", agentId: "participant", resultReferences: [], createdAt: new Date(clock).toISOString(), updatedAt: new Date(clock).toISOString() } as Board["interactions"][number];
    const reader = { read: async (id: string) => id === "parent" ? { ...parent, interactions: [interaction] } : store.read(id) };
    const scoped = new BoardService(reader as unknown as BoardStore, journal, () => {}); scoped.useComposition(sources); await grant([local]);
    expect(await scoped.execute("read", { boardId: "parent" }, { ...owner, agentId: "participant" })).toMatchObject({ id: "parent" });
    await expect(scoped.execute("sources", { boardId: "parent" }, { ...owner, agentId: "participant" })).rejects.toMatchObject({ code: "source_access_denied" });
    interaction.kind = "fork";
    expect(await scoped.execute("read_source", { boardId: "parent", source: local }, { ...owner, agentId: "participant" })).toMatchObject({ availability: "available" }); await scoped.dispose();
  });
  it("directly reads fresh same-host data while remote observations remain explicitly cached", async () => {
    await grant([local, remote]); const captured = await snapshot();
    await sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: captured }); clock += 60_000;
    expect(SourceReadResultSchema.parse(await sources.read({ boardId: "parent", source: remote }))).toMatchObject({ provenance: "client-observed-cache", stale: true, freshness: "cached-not-live", ageMs: 60_000, receivedAt: captured.observedAt, snapshot: { coverage: { historyComplete: false, liveBrowserObserved: false } } });
    const current = (await store.read("source"))!;
    await store.publish({ boardId: "source", eventId: "new-data", expectedRevision: current.revision, canvasBase: { revision: current.canvas.revision, documentVersion: current.canvas.documentVersion }, data: { result: { complete: false } } });
    expect(await sources.read({ boardId: "parent", source: local })).toMatchObject({ freshness: "read-now", stale: false, snapshot: { revision: current.revision + 1 } });
    expect((await sources.read({ boardId: "parent", source: remote })).snapshot?.revision).toBe(captured.revision);
  });
  it("survives restart, rejects in-flight sync after revocation and cannot resurrect revoked evidence", async () => {
    await grant(); await sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: await snapshot() });
    const reopened = new CompositionSources(join(dir, "composition"), store, async () => "local", () => clock);
    expect(await reopened.read({ boardId: "parent", source: remote })).toEqual(await sources.read({ boardId: "parent", source: remote }));
    await reopened.set({ boardId: "parent", expectedRevision: 1, sources: [] });
    const persisted = JSON.parse(await readFile(join(dir, "composition", "parent.json"), "utf8"));
    expect(persisted.sources).toEqual([]); expect(JSON.stringify(persisted)).not.toContain("Source result");
    await expect(service.execute("read_source", { boardId: "parent", source: remote }, owner)).rejects.toMatchObject({ code: "source_not_authorized" });
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: await snapshot() })).rejects.toMatchObject({ code: "revision_conflict" });
    await reopened.set({ boardId: "parent", expectedRevision: 2, sources: [select(remote)] });
    expect(await reopened.read({ boardId: "parent", source: remote })).toMatchObject({ availability: "not-yet-observed", freshness: "unavailable" });
    const original = (await store.read("parent"))!;
    const recreated = new CompositionSources(join(dir, "composition"), { read: async () => ({ ...original, createdAt: "2030-01-01T00:00:00.000Z" }) }, async () => "local");
    expect(await recreated.list("parent")).toMatchObject({ revision: 0, sources: [] });
  });
  it("does not transfer a local-source grant to a recreated equal-ID Board", async () => {
    await grant([local]);
    const current = (await store.read("source"))!;
    const recreated = new CompositionSources(join(dir, "composition"), { read: id => id === "source" ? Promise.resolve({ ...current, createdAt: "2030-01-01T00:00:00.000Z" }) : store.read(id) }, async () => "local");
    await expect(recreated.read({ boardId: "parent", source: local })).rejects.toMatchObject({ code: "source_identity_changed" });
  });
  it("binds the user's selected creation identity before the first remote observation", async () => {
    const accepted = await grant();
    expect(accepted.sources).toEqual([{ ref: remote, grantedAt: new Date(clock).toISOString(), sourceCreatedAt }]);
    const newer = { ...await snapshot(), createdAt: "2030-01-01T00:00:00.000Z" };
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: newer })).rejects.toMatchObject({ code: "source_identity_changed" });
    expect((await sources.list("parent")).sources[0].snapshot).toBeUndefined();
    const receipt = await sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: await snapshot() });
    expect(receipt.sourceCreatedAt).toBe(sourceCreatedAt);
    await expect(sources.set({ boardId: "parent", expectedRevision: 1, sources: [{ ...local, sourceCreatedAt: newer.createdAt }] })).rejects.toMatchObject({ code: "source_identity_changed" });
  });
  it("fails closed for an old unbound grant until the user confirms the source identity", async () => {
    await grant();
    const file = join(dir, "composition", "parent.json"), stored = JSON.parse(await readFile(file, "utf8"));
    delete stored.sources[0].sourceCreatedAt; await writeFile(file, JSON.stringify(stored));
    expect((await sources.list("parent")).sources[0].sourceCreatedAt).toBeUndefined();
    await expect(sources.read({ boardId: "parent", source: remote })).rejects.toMatchObject({ code: "source_identity_unbound" });
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: await snapshot() })).rejects.toMatchObject({ code: "source_identity_unbound" });
    expect(await sources.set({ boardId: "parent", expectedRevision: 1, sources: [select(remote)] })).toMatchObject({ revision: 2, sources: [{ sourceCreatedAt }] });
    expect(await sources.sync({ boardId: "parent", expectedSourcesRevision: 2, ref: remote, snapshot: await snapshot() })).toMatchObject({ sourceCreatedAt });
  });
  it("does not fall back to a saved observation when a same-host source has been removed", async () => {
    await grant([local]);
    await sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: local, snapshot: { ...await snapshot(), sourceRef: local } });
    const missing = new CompositionSources(join(dir, "composition"), { read: id => id === "source" ? Promise.resolve(null) : store.read(id) }, async () => "local");
    expect(await missing.read({ boardId: "parent", source: local })).toMatchObject({ availability: "source-missing", provenance: "local-store", freshness: "unavailable" });
    expect((await missing.read({ boardId: "parent", source: local })).snapshot).toBeUndefined();
    await missing.set({ boardId: "parent", expectedRevision: 1, sources: [] });
    expect(JSON.parse(await readFile(join(dir, "composition", "parent.json"), "utf8")).sources).toEqual([]);
    await expect(missing.read({ boardId: "parent", source: local })).rejects.toMatchObject({ code: "source_not_authorized" });
  });
  it("fences concurrent grant changes and rejects duplicate/self/oversized sets", async () => {
    const outcomes = await Promise.allSettled([grant([remote]), grant([local])]); expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    await expect(sources.set({ boardId: "parent", expectedRevision: 1, sources: [select(remote), select(remote)] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(sources.set({ boardId: "parent", expectedRevision: 1, sources: [select({ hostId: "local", boardId: "parent" })] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(sources.set({ boardId: "parent", expectedRevision: 1, sources: Array.from({ length: 33 }, (_, index) => select({ hostId: "remote", boardId: `source-${index}` })) })).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("rejects ref substitution, older source versions and equal-revision canvas mismatch", async () => {
    await grant(); const captured = await snapshot();
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: { ...captured, sourceRef: local } })).rejects.toMatchObject({ code: "source_mismatch" });
    await sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: captured });
    for (const older of [{ ...captured, observedAt: "2020-01-01T00:00:00.000Z" }, { ...captured, revision: captured.revision - 1 }]) await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: older })).rejects.toMatchObject({ code: "stale_source" });
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: { ...captured, canvasRevision: captured.canvasRevision + 1 } })).rejects.toMatchObject({ code: "source_version_mismatch" });
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: { ...captured, createdAt: "2030-01-01T00:00:00.000Z" } })).rejects.toMatchObject({ code: "source_identity_changed" });
    expect((await sources.read({ boardId: "parent", source: remote })).snapshot).toEqual(captured);
  });
  it("refuses mismatched coverage and oversized serialized snapshots while preserving the last receipt", async () => {
    await grant(); const captured = await snapshot();
    const accepted = await sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: captured });
    const updates = Array.from({ length: 12 }, (_, i) => ({ id: `update-${i}`, at: captured.observedAt, kind: "patch" as const, boardRevision: captured.revision, canvasRevision: captured.canvasRevision, documentVersion: captured.documentVersion, selectors: Array.from({ length: 12 }, () => "字".repeat(1000)) }));
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: { ...captured, updates, coverage: { ...captured.coverage, updates: { included: 12, total: 12, truncated: false } } } })).rejects.toMatchObject({ code: "size_limit" });
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: { ...captured, data: [{ key: "test", json: "not JSON" }], coverage: { ...captured.coverage, data: { included: 1, total: 1, truncated: false } } } })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await sources.list("parent")).sources[0].snapshot).toEqual(accepted);
  });
  it("projects complete authored documents after patches without leaking code or base-only text", async () => {
    const board = (await store.read("source"))!;
    board.canvas.html = '<!DOCTYPE html><html><head><title>Metadata</title><style>secretStyle</style></head><body><h1 id="heading">Before</h1><script>secretCode</script></body></html>';
    board.canvas.patches = [{ id: "edit", selector: "#heading", operation: "replace", html: '<h1 id="heading">After</h1>' }];
    const captured = compositionSnapshot(board, "remote", new Date(clock).toISOString());
    expect(captured.text).toBe("After"); expect(captured.coverage.text.replayComplete).toBe(true);
  });
  it("retains partial replay and update coverage rather than claiming complete source content", async () => {
    const board = (await store.read("source"))!;
    board.canvas.patches = [{ id: "runtime-only", operation: "append", selector: "#runtime-generated", html: "<b>new</b>" }];
    const captured = compositionSnapshot(board, "remote", new Date(clock).toISOString());
    expect(captured.text).toBe(""); expect(captured.coverage.text.replayComplete).toBe(false); expect(captured.coverage.historyComplete).toBe(false);
    board.canvas.patches = [];
    board.updates = Array.from({ length: 30 }, (_, i) => ({ id: `u-${i}`, eventId: `u-${i}`, at: captured.observedAt, kind: "patch", boardRevision: board.revision, canvasRevision: board.canvas.revision, documentVersion: board.canvas.documentVersion, targets: [{ selector: "#target" }] }));
    const recent = compositionSnapshot(board, "remote", new Date(clock).toISOString());
    expect(recent.updates.map(update => update.id)).toEqual(board.updates.slice(-12).map(update => update.id));
    expect(recent.coverage.updates).toEqual({ included: 12, total: 30, truncated: true });
  });
  it("bounds static text/data and preserves honest coverage without executing source scripts", async () => {
    const board = (await store.read("source"))!;
    board.canvas.html = `<main>${"字".repeat(40000)}</main><script>doNotRun()</script>`; board.canvas.data = { large: "x".repeat(100000), small: 42 };
    const captured = compositionSnapshot(board, "remote", new Date(clock).toISOString());
    expect(captured.text).toHaveLength(16000); expect(captured.data).toEqual([{ key: "small", json: "42" }]);
    expect(captured.coverage).toMatchObject({ historyComplete: false, liveBrowserObserved: false, text: { included: 16000, total: 40000, truncated: true }, data: { included: 1, total: 2, truncated: true } });
    await grant();
    await expect(sources.sync({ boardId: "parent", expectedSourcesRevision: 1, ref: remote, snapshot: { ...captured, coverage: { ...captured.coverage, text: { ...captured.coverage.text, included: 1 } } } })).rejects.toMatchObject({ code: "invalid_input" });
    const unbound = new CompositionSources(join(dir, "composition"), store, async () => undefined);
    await expect(unbound.inspect("source")).rejects.toMatchObject({ code: "host_identity_unavailable" }); expect((await sources.inspect("source")).sourceRef).toEqual(local);
  });
});
