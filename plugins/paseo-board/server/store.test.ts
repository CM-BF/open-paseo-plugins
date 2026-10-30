import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";

describe("BoardStore", () => {
  let root: string;
  let store: BoardStore;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-board-store-"));
    store = new BoardStore(root);
    await store.init();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function board() {
    return store.create({ id: "test", title: "A free canvas", html: "<main id='a'>Hello</main>", data: { count: 1 } });
  }

  it("records only committed main canvas changes with exact versions and explicit data locations", async () => {
    let current = await board();
    expect(current.updates).toEqual([]);
    current = await store.publish({ boardId: "test", expectedRevision: current.revision, eventId: "patch-located", patch: { id: "patch-target", selector: "#a", operation: "remove" } }, "owner");
    expect(current.updates).toEqual([{ id: "patch-located", eventId: "patch-located", at: current.updatedAt, boardRevision: current.revision, canvasRevision: current.canvas.revision, documentVersion: 1, kind: "patch", targets: [{ selector: "#a", operation: "remove", patchId: "patch-target" }], actorAgentId: "owner" }]);
    current = await store.publish({ boardId: "test", expectedRevision: current.revision, eventId: "data-located", data: { count: 2 }, focusSelectors: ["#graph", "#caption", "#graph"] }, "fork");
    expect(current.updates.at(-1)).toMatchObject({ kind: "data", targets: [{ selector: "#graph" }, { selector: "#caption" }], actorAgentId: "fork" });
    current = await store.emit({ boardId: "test", eventId: "data-unlocated", source: "shell", summary: "silent", data: { count: 3 } });
    expect(current.updates.at(-1)).toMatchObject({ kind: "data", targets: [] });
    expect(current.updates.at(-1)).not.toHaveProperty("actorAgentId");
    current = await store.publish({ boardId: "test", expectedRevision: current.revision, eventId: "new-document", html: "<main>New</main>" });
    expect(current.updates.at(-1)).toMatchObject({ kind: "document", targets: [], documentVersion: 2, canvasRevision: current.canvas.revision, boardRevision: current.revision });
    const updates = current.updates;
    const canvasRevision = current.canvas.revision;
    current = await store.publish({ boardId: "test", expectedRevision: current.revision, eventId: "unchanged-data-publish", data: { count: 3 }, focusSelectors: ["#graph"] });
    current = await store.emit({ boardId: "test", eventId: "unchanged-data-emit", source: "shell", summary: "same reading", data: { count: 3 }, focusSelectors: ["#graph"] });
    expect(current.canvas.revision).toBe(canvasRevision); expect(current.updates).toEqual(updates);
    await store.addInteraction({ boardId: "test", intentId: "question", kind: "question", text: "Explain" }, "owner");
    current = (await store.read("test"))!;
    await store.publish({ boardId: "test", expectedRevision: current.revision, eventId: "receipt", interactionResult: { id: "question", status: "processing" }, decisions: [{ id: "choice", basis: "explicit", choice: "Use a stable reference" }] });
    await store.respond({ boardId: "test", interactionId: "question", eventId: "answer", expectedResponseRevision: 1, response: "Local answer", html: "<svg></svg>" });
    await store.emit({ boardId: "test", eventId: "fact-only", source: "shell", summary: "No data change" });
    await store.saveState({ boardId: "test", state: { draft: "keep" } });
    await store.updateExtraction("test", { cursor: "checked" });
    expect((await store.read("test"))!.updates).toEqual(updates);
    current = (await store.read("test"))!;
    await expect(store.publish({ boardId: "test", expectedRevision: current.revision, eventId: "rolled-back", data: { count: 99 }, interactionResult: { id: "missing", status: "processing" } })).rejects.toMatchObject({ code: "not_found" });
    expect((await store.read("test"))!.updates).toEqual(updates);
    for (const request of [{ focusSelectors: ["#a"] }, { data: {}, focusSelectors: Array(13).fill("#a") }, { data: {}, html: "new", focusSelectors: ["#a"] }]) {
      await expect(store.publish({ boardId: "test", expectedRevision: current.revision, eventId: "bad-focus", ...request })).rejects.toHaveProperty("code", "invalid_input");
    }
    await expect(store.emit({ boardId: "test", eventId: "bad-emit-focus", source: "shell", summary: "bad", focusSelectors: ["#a"] })).rejects.toHaveProperty("code", "invalid_input");
  });

  it("serializes canvas locations, deduplicates retries and preserves per-update attention across restart", async () => {
    let current = await board();
    const request = { boardId: "test", expectedRevision: current.revision, eventId: "original", data: { count: 2 }, focusSelectors: ["#a"] };
    const results = await Promise.allSettled([store.publish(request, "writer-a"), store.publish({ ...request, eventId: "competitor" }, "writer-b")]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "revision_conflict" } });
    current = (await store.read("test"))!;
    const first = current.updates[0];
    await store.publish(request, "writer-b"); // A replay must not rewrite the first committer's attribution.
    const emit = { boardId: "test", eventId: "second", source: "shell", summary: "new", data: { count: 3 }, focusSelectors: ["#a"] };
    await Promise.all([store.emit(emit, "writer-b"), store.emit(emit, "writer-b")]);
    current = (await store.read("test"))!;
    expect(current.updates).toHaveLength(2);
    expect(current.updates[0]).toEqual(first);
    expect(current.updates.map(item => item.boardRevision)).toEqual([2, 3]);
    const path = join(root, "boards", "test.json");
    const before = JSON.parse(await readFile(path, "utf8"));
    const marked = await store.markUpdatesSeen({ boardId: "test", updateIds: ["second", "second", "future"] });
    expect(marked.seenUpdateIds).toEqual(["second"]);
    expect(marked.revision).toBe(current.revision); expect(marked.updatedAt).toBe(current.updatedAt);
    expect(marked.canvas).toEqual(current.canvas); expect(marked.userState).toEqual(current.userState);
    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.history).toEqual(before.history); expect(after.receipts).toEqual(before.receipts);
    const file = await readFile(path, "utf8");
    await store.markUpdatesSeen({ boardId: "test", updateIds: ["second"] });
    expect(await readFile(path, "utf8")).toBe(file);
    const reopened = new BoardStore(root);
    expect((await reopened.read("test"))!.seenUpdateIds).toEqual(["second"]);
    expect((await reopened.list())[0]).toMatchObject({ unreadUpdateCount: 1, latestUpdateRevision: 3 });
    // A mark cannot invalidate a publisher's CAS or pre-acknowledge an unknown future ID.
    current = await reopened.publish({ boardId: "test", expectedRevision: current.revision, eventId: "future", data: { count: 4 } });
    await Promise.all([store.markUpdatesSeen({ boardId: "test", updateIds: ["original"] }), reopened.markUpdatesSeen({ boardId: "test", updateIds: ["second"] })]);
    expect((await store.read("test"))!.seenUpdateIds).toEqual(["original", "second"]);
    expect((await reopened.list())[0]).toMatchObject({ unreadUpdateCount: 1, latestUpdateRevision: current.revision });
    await store.create({ id: "other", title: "Separate" });
    await store.markUpdatesSeen({ boardId: "other", updateIds: ["future"] });
    expect((await store.read("test"))!.seenUpdateIds).toEqual(["original", "second"]);
  });

  it("bounds retained locations and seen IDs together and loads legacy boards without a synthetic update", async () => {
    await board();
    const path = join(root, "boards", "test.json");
    const legacy = JSON.parse(await readFile(path, "utf8")); delete legacy.board.updates; delete legacy.board.seenUpdateIds;
    await writeFile(path, JSON.stringify(legacy));
    expect((await new BoardStore(root).read("test"))!).toMatchObject({ updates: [], seenUpdateIds: [] });
    expect((await store.list())[0]).toMatchObject({ unreadUpdateCount: 0, latestUpdateRevision: 0 });
    for (let n = 0; n < 82; n++) {
      await store.emit({ boardId: "test", eventId: `location-${n}`, source: "shell", summary: "progress", data: { count: n } });
      if (n < 2) await store.markUpdatesSeen({ boardId: "test", updateIds: [`location-${n}`] });
    }
    const current = (await new BoardStore(root).read("test"))!;
    expect(current.updates).toHaveLength(80); expect(current.updates[0].id).toBe("location-2"); expect(current.updates.at(-1)!.id).toBe("location-81");
    expect(current.seenUpdateIds).toEqual([]);
    expect((await store.list())[0]).toMatchObject({ unreadUpdateCount: 80, latestUpdateRevision: current.revision });
  });

  it("recovers canvas, patches, data, user state, history and dedup after restart", async () => {
    const initial = await board();
    const request = { boardId: initial.id, expectedRevision: initial.revision, eventId: "patch-1", patch: { id: "patch-one", selector: "#a", operation: "append" as const, html: "<input>" } };
    const patched = await store.publish(request);
    expect(patched.canvas.documentVersion).toBe(initial.canvas.documentVersion);
    expect(patched.canvas.html).toBe(initial.canvas.html);
    await store.emit({ boardId: initial.id, eventId: "shell-result", source: "shell", summary: "count", data: { count: 2 } });
    await store.saveState({ boardId: initial.id, state: { input: "user typing" } });
    const reopened = new BoardStore(root);
    await reopened.init();
    const restored = (await reopened.read(initial.id))!;
    expect(restored.canvas.patches).toEqual(patched.canvas.patches);
    expect(restored.canvas.data.count).toBe(2);
    expect(restored.userState.input).toBe("user typing");
    expect((await reopened.publish(request)).revision).toBe(restored.revision);
    expect(restored.events.filter(event => event.id === "patch-1")).toHaveLength(1);
  });

  it("serializes competing writes and never overwrites concurrent user state", async () => {
    const initial = await board();
    const results = await Promise.allSettled([
      store.publish({ boardId: initial.id, expectedRevision: initial.revision, eventId: "writer-a", data: { a: 1 } }),
      store.publish({ boardId: initial.id, expectedRevision: initial.revision, eventId: "writer-b", data: { b: 2 } }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "revision_conflict" } });
    const current = (await store.read(initial.id))!;
    await store.saveState({ boardId: initial.id, state: { slider: 0.7 } });
    await expect(store.publish({ boardId: initial.id, expectedRevision: current.revision, eventId: "stale", html: "new" })).rejects.toMatchObject({ code: "revision_conflict" });
    expect((await store.read(initial.id))!.userState.slider).toBe(0.7);
  });

  it("shares one queue across store instances within a process", async () => {
    const initial = await board();
    const second = new BoardStore(root);
    await second.init();
    const results = await Promise.allSettled([
      store.publish({ boardId: initial.id, expectedRevision: initial.revision, eventId: "a", data: { a: 1 } }),
      second.publish({ boardId: initial.id, expectedRevision: initial.revision, eventId: "b", data: { b: 2 } }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });

  it("deduplicates concurrent events and rejects altered payload or operation", async () => {
    const initial = await board();
    const event = { boardId: initial.id, eventId: "one", source: "shell", summary: "done", data: { x: 1, nested: { a: 2, b: 3 } } };
    const [a, b] = await Promise.all([store.emit(event), store.emit(event)]);
    expect(a.revision).toBe(b.revision);
    expect((await store.emit({ ...event, data: { nested: { b: 3, a: 2 }, x: 1 } })).revision).toBe(a.revision);
    await expect(store.emit({ ...event, summary: "different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(store.publish({ boardId: initial.id, expectedRevision: a.revision, eventId: "one", data: {} })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("records only actual observation changes and never invents a rationale", async () => {
    const initial = await board();
    const observation = { id: "budget", name: "Budget", value: 8, evidence: { kind: "command" as const, reference: "run --budget=8" } };
    await store.emit({ boardId: initial.id, eventId: "observe-a", source: "shell", summary: "first", observation });
    await store.emit({ boardId: initial.id, eventId: "observe-b", source: "shell", summary: "same", observation });
    expect((await store.read(initial.id))!.decisions).toHaveLength(0);
    const change = { boardId: initial.id, eventId: "observe-c", source: "shell", summary: "changed", observation: { ...observation, value: 4 } };
    const updated = await store.emit(change);
    expect(updated.decisions).toHaveLength(1);
    expect(updated.decisions[0].basis).toBe("observed");
    expect(updated.decisions[0].rationale).toBeUndefined();
    expect(updated.decisions[0].choice).toContain("8");
    expect(updated.decisions[0].choice).toContain("4");
    await store.emit(change);
    expect((await store.read(initial.id))!.decisions).toHaveLength(1);
  });

  it("preserves the patch replay journal until an explicit full-document replacement", async () => {
    let current = await board();
    for (const id of ["a", "b"]) {
      current = await store.publish({ boardId: current.id, expectedRevision: current.revision, eventId: id, patch: { id, selector: "#a", operation: "append", html: id } });
    }
    const version = current.canvas.documentVersion;
    current = await store.publish({ boardId: current.id, expectedRevision: current.revision, eventId: "data", data: { count: 3 } });
    expect(current.canvas.patches.map(patch => patch.id)).toEqual(["a", "b"]);
    expect(current.canvas.documentVersion).toBe(version);
    current = await store.publish({ boardId: current.id, expectedRevision: current.revision, eventId: "reset", html: "replacement" });
    expect(current.canvas.patches).toEqual([]);
    expect(current.canvas.documentVersion).toBe(version + 1);
    const stored = JSON.parse(await readFile(join(root, "boards", "test.json"), "utf8"));
    expect(stored.history.some((entry: { payload: { patch?: { id: string } } }) => entry.payload.patch?.id === "a")).toBe(true);
    expect(stored.receipts.length).toBeGreaterThanOrEqual(5);
  });

  it("persists anchored interactions, tracks outcomes and requires result references for applied", async () => {
    const initial = await board();
    const input = { boardId: initial.id, intentId: "intent", kind: "change" as const, text: "Add here", anchor: { boardRevision: initial.revision, canvasRevision: initial.canvas.revision, kind: "point" as const, rect: { x: 10, y: 20, width: 0, height: 0 } } };
    const interaction = await store.addInteraction(input, "agent-1");
    expect(interaction.status).toBe("saved");
    await store.updateInteraction(initial.id, interaction.id, { status: "sending" });
    await store.updateInteraction(initial.id, interaction.id, { status: "delivered" });
    expect((await store.addInteraction(input, "agent-1")).status).toBe("delivered");
    await expect(store.addInteraction({ ...input, text: "different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(store.updateInteraction(initial.id, interaction.id, { status: "applied" })).rejects.toMatchObject({ code: "invalid_input" });
    await store.updateInteraction(initial.id, interaction.id, { status: "applied", resultReferences: ["canvas:2"], response: "Added" });
    await expect(store.updateInteraction(initial.id, interaction.id, { status: "processing" })).rejects.toMatchObject({ code: "invalid_transition" });
    expect((await store.read(initial.id))!.interactions[0]).toMatchObject({ status: "applied", resultReferences: ["canvas:2"] });
  });

  it("commits publish, decision and interaction outcomes as one transaction", async () => {
    const initial = await board();
    await store.addInteraction({ boardId: initial.id, intentId: "question", kind: "question", text: "Why?" });
    const before = (await store.read(initial.id))!;
    const input = { boardId: initial.id, expectedRevision: before.revision, eventId: "answer", html: "answer", interactionResult: { id: "question", status: "applied" as const } };
    await expect(store.publish(input)).rejects.toMatchObject({ code: "invalid_input" });
    expect(await store.read(initial.id)).toEqual(before);
    const result = await store.publish({ ...input, interactionResult: { ...input.interactionResult, resultReferences: ["answer.html"] } });
    expect(result.canvas.html).toBe("answer");
    expect(result.interactions[0].status).toBe("applied");
  });

  it("exposes corrupt storage instead of treating it as an empty board", async () => {
    await board();
    await writeFile(join(root, "boards", "test.json"), "{ broken");
    await expect(store.read("test")).rejects.toMatchObject({ code: "corrupt_storage" });
    await expect(new BoardStore(root).init()).rejects.toMatchObject({ code: "corrupt_storage" });
  });

  it("rejects unsafe IDs, symlink files and non-JSON or oversized payloads", async () => {
    await expect(store.create({ id: "../escape", title: "bad" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.read("..")).rejects.toMatchObject({ code: "invalid_input" });
    await board();
    await symlink(join(root, "boards", "test.json"), join(root, "boards", "link.json"));
    await expect(store.read("link")).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(store.emit({ boardId: "test", eventId: "bad-json", source: "test", summary: "bad", data: { value: NaN } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.saveState({ boardId: "test", state: { huge: "x".repeat(2_100_000) } })).rejects.toMatchObject({ code: "size_limit" });
  });

  it("snapshots input before queuing and returns detached values", async () => {
    const initial = await board();
    const input = { boardId: initial.id, eventId: "snapshot", source: "test", summary: "snapshot", data: { nested: { value: 1 } } };
    const pending = store.emit(input);
    input.data.nested.value = 99;
    const result = await pending;
    expect(result.canvas.data.nested).toEqual({ value: 1 });
    (result.canvas.data.nested as { value: number }).value = 42;
    expect((await store.read(initial.id))!.canvas.data.nested).toEqual({ value: 1 });
  });

  it("keeps decision replacement history and prevents cyclic replacement", async () => {
    let current = await board();
    current = await store.recordDecision({ boardId: current.id, expectedRevision: current.revision, eventId: "decision-a", decision: { id: "a", basis: "explicit", choice: "Use A", rationale: "A is simpler" } });
    current = await store.recordDecision({ boardId: current.id, expectedRevision: current.revision, eventId: "decision-b", decision: { id: "b", basis: "explicit", choice: "Use B", supersedes: "a" } });
    expect(current.decisions.find(item => item.id === "a")?.status).toBe("superseded");
    await expect(store.recordDecision({ boardId: current.id, expectedRevision: current.revision, eventId: "cycle", decision: { id: "a", basis: "explicit", choice: "A again", supersedes: "b" } })).rejects.toMatchObject({ code: "invalid_input" });
    current = await store.recordDecision({ boardId: current.id, expectedRevision: current.revision, eventId: "revise", decision: { id: "a", basis: "observed", choice: "A was observed" } });
    expect(current.decisions.find(item => item.id === "a")?.rationale).toBeUndefined();
  });

  it("persists extraction cursors without affecting canvas or user state", async () => {
    const initial = await board();
    await store.saveState({ boardId: initial.id, state: { left: "kept" } });
    await store.saveState({ boardId: initial.id, state: { right: "also kept" } });
    const current = await store.updateExtraction(initial.id, { cursor: "message-4", note: "assistant messages only" });
    expect(current.userState).toEqual({ left: "kept", right: "also kept" });
    expect(current.canvas).toEqual(initial.canvas);
    expect((await new BoardStore(root).read(initial.id))!.extraction.cursor).toBe("message-4");
    expect((await store.updateExtraction(initial.id, { cursor: "message-4" })).revision).toBe(current.revision);
  });

  it("checkpoints many extraction pages without invalidating a publish or growing content history", async () => {
    const initial = await board();
    const path = join(root, "boards", `${initial.id}.json`);
    const before = JSON.parse(await readFile(path, "utf8"));
    const checkpoints = Array.from({ length: 24 }, (_, index) => ({
      agentId: "owner", cursor: `message-${index}`, lastCheckedAt: new Date(index * 1000).toISOString(), note: "Assistant text checked",
    }));
    await Promise.all(checkpoints.map(checkpoint => store.updateExtraction(initial.id, checkpoint)));
    const checkpointed = (await store.read(initial.id))!;
    expect(checkpointed.revision).toBe(initial.revision);
    expect(checkpointed.updatedAt).toBe(initial.updatedAt);
    expect(checkpointed.events).toEqual(initial.events);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.history).toEqual(before.history);
    expect(persisted.receipts).toEqual(before.receipts);

    const restored = new BoardStore(root);
    await restored.init();
    expect((await restored.read(initial.id))!.extraction).toEqual(checkpoints.at(-1));
    const publish = { boardId: initial.id, expectedRevision: initial.revision, eventId: "real-update", data: { count: 2 } };
    const updated = await restored.publish(publish);
    expect(updated.revision).toBe(initial.revision + 1);
    expect(updated.extraction).toEqual(checkpoints.at(-1));
    expect((await restored.publish(publish)).revision).toBe(updated.revision);
    const decided = await restored.recordDecision({ boardId: initial.id, expectedRevision: updated.revision, eventId: "real-decision", decision: { id: "scope", basis: "explicit", choice: "Keep the existing scope" } });
    expect(decided.revision).toBe(updated.revision + 1);
    const final = JSON.parse(await readFile(path, "utf8"));
    expect(final.history).toHaveLength(decided.revision);
    expect(final.receipts).toHaveLength(before.receipts.length + 2);
    await expect(new BoardStore(root).init()).resolves.toBeUndefined();
  });

  it("serializes operational checkpoints with a concurrent content publication without losing either", async () => {
    const initial = await board();
    await Promise.all([
      store.updateExtraction(initial.id, { cursor: "before-publication", note: "Checkpoint" }),
      store.publish({ boardId: initial.id, expectedRevision: initial.revision, eventId: "concurrent-publish", html: "<main>New content</main>" }),
      store.updateExtraction(initial.id, { cursor: "after-publication" }),
    ]);
    const current = (await new BoardStore(root).read(initial.id))!;
    expect(current.revision).toBe(initial.revision + 1);
    expect(current.canvas.html).toBe("<main>New content</main>");
    expect(current.extraction).toEqual({ cursor: "after-publication", note: "Checkpoint" });
  });

  it("accepts maximum-length safe board IDs and detects duplicate event identities", async () => {
    const initial = await store.create({ id: "a".repeat(160), title: "long ID" });
    expect((await store.read(initial.id))!.id).toBe(initial.id);
    await expect(store.emit({ boardId: initial.id, eventId: initial.events[0].id, source: "test", summary: "collision" })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("detects syntactically valid but inconsistent durable receipts", async () => {
    await board();
    const path = join(root, "boards", "test.json");
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.receipts[0].fingerprint = "wrong";
    await writeFile(path, JSON.stringify(stored));
    await expect(new BoardStore(root).init()).rejects.toMatchObject({ code: "corrupt_storage" });
  });

  it("distinguishes an answered question from an applied change", async () => {
    const initial = await board();
    await store.addInteraction({ boardId: initial.id, intentId: "question", kind: "question", text: "Why?" });
    await expect(store.updateInteraction(initial.id, "question", { status: "answered" })).rejects.toMatchObject({ code: "invalid_input" });
    const answered = await store.updateInteraction(initial.id, "question", { status: "answered", response: "Here is the explanation." });
    expect(answered.resultReferences).toEqual([]);
    expect((await store.list())[0].pendingCount).toBe(0);
    await expect(store.updateInteraction(initial.id, "question", { status: "processing" })).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(store.updateInteraction(initial.id, "question", { status: "applied" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps a returned fork suggestion and its anchor frozen while the source evolves", async () => {
    const initial = await board();
    const anchor = { kind: "text" as const, text: "Original quoted text", boardRevision: initial.revision, canvasRevision: initial.canvas.revision };
    await store.addInteraction({ boardId: initial.id, intentId: "fork", kind: "fork", text: "Explain this", anchor }, "discussion-agent");
    await store.updateInteraction(initial.id, "fork", { status: "answered", response: "The original suggestion" });
    await store.addInteraction({ boardId: initial.id, intentId: "return", kind: "return", sourceInteractionId: "fork", text: "Adopt the original suggestion", anchor });
    await store.updateInteraction(initial.id, "fork", { response: "A later revised suggestion" });
    const current = (await store.read(initial.id))!;
    await store.publish({ boardId: initial.id, expectedRevision: current.revision, eventId: "new-canvas", html: "A different layout" });
    const reopened = (await new BoardStore(root).read(initial.id))!;
    const returned = reopened.interactions.find(item => item.id === "return")!;
    expect(returned).toMatchObject({ text: "Adopt the original suggestion", anchor, sourceInteractionId: "fork", status: "saved" });
    expect(reopened.interactions.find(item => item.id === "fork")?.response).toBe("A later revised suggestion");
  });
});
