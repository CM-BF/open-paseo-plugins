import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoardStore } from "./store";
import { BoardService } from "./service";
import { ServiceJournal, deliveryKey } from "./journal";
import type { Paseo, Snapshot, TimelineEntry, TimelinePage } from "./sdk";
import { extractCandidates } from "./extraction";

function fakeSdk() {
  const histories = new Map<string, TimelineEntry[]>();
  const snapshots = new Map<string, Snapshot>();
  const subscribers = new Map<string, (value: unknown) => void>();
  const snapshot = (id: string) => ({ id, provider: "codex", model: "example-model", cwd: "/tmp/board-fixture", workspaceId: "wks_0123456789abcdef", status: "idle", pendingPermissions: [], activeTurn: null, thinkingOptionId: "high", currentModeId: "auto-review", features: [{ type: "select", id: "service_tier", value: "priority", label: "Speed", options: [] }, { type: "toggle", id: "plan_mode", value: false, label: "Plan" }], archivedAt: null } as unknown as Snapshot);
  snapshots.set("owner", snapshot("owner")); snapshots.set("fork-agent", snapshot("fork-agent"));
  const sends: Array<{ id: string; text: string; options: Record<string, unknown> }> = [];
  const send = vi.fn(async (id: string, text: string, options: Record<string, unknown>) => {
    sends.push({ id, text, options });
    append(id, { type: "user_message", text, clientMessageId: options.messageId as string });
  });
  const append = (id: string, item: TimelineEntry["item"]) => {
    const entries = histories.get(id) ?? []; const seq = entries.length + 1;
    entries.push({ item, provider: "codex", seqStart: seq, seqEnd: seq, timestamp: new Date(Date.now() + 1000).toISOString(), sourceSeqRanges: [], collapsed: [] }); histories.set(id, entries);
  };
  const handles = new Map<string, unknown>();
  const ref = (id: string) => {
    if (handles.has(id)) return handles.get(id);
    const handle = { id,
      refresh: vi.fn(async () => snapshots.has(id) ? { agent: snapshots.get(id), project: null } : null),
      current: () => snapshots.get(id),
      send: (text: string, options: Record<string, unknown>) => send(id, text, options),
      timeline: {
        subscribe: vi.fn((callback: (value: unknown) => void) => {
          subscribers.set(id, callback); const off = Object.assign(() => subscribers.delete(id), { ready: Promise.resolve(), release: async () => { subscribers.delete(id); } }); return off;
        }),
        refetch: vi.fn(async (options: { cursor?: { seq: number } }) => {
          const entries = (histories.get(id) ?? []).filter((entry) => entry.seqEnd > (options.cursor?.seq ?? 0));
          return { entries, epoch: "epoch-1", reset: false, staleCursor: false, hasOlder: false, hasNewer: false, endCursor: entries.length ? { epoch: "epoch-1", seq: entries.at(-1)!.seqEnd } : null, error: null } as TimelinePage;
        }),
      },
    }; handles.set(id, handle); return handle;
  };
  const create = vi.fn(async (_options: Record<string, unknown>) => ref("fork-agent"));
  const api = { agents: { ref, create }, workspaces: { ref: () => ({ agents: { create } }) }, providers: { listModes: vi.fn(async () => ({ modes: [{ id: "plan_mode", label: "Plan" }] })) } } as unknown as Paseo;
  return { api, append, snapshots, subscribers, send, sends, create, histories };
}

describe("BoardService SDK adapter", () => {
  let dir: string; let store: BoardStore; let journal: ServiceJournal; let service: BoardService; let sdk: ReturnType<typeof fakeSdk>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "board-service-")); store = new BoardStore(dir); await store.init(); journal = new ServiceJournal(join(dir, "service.json")); await journal.init();
    sdk = fakeSdk(); service = new BoardService(store, journal, () => undefined); service.capture(sdk.api);
    await store.create({ id: "board", title: "自由画布", ownerAgentId: "owner", workspaceId: "wks_0123456789abcdef", html: '<main id="target">Existing visualization</main>', data: { temperature: 10 } });
  });
  afterEach(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }); });

  it("persists a user intent before send, deduplicates replay and never calls completion application", async () => {
    const input = { boardId: "board", intentId: "ask-1", kind: "question" as const, text: "Explain this curve" };
    const result = await service.interact(input); expect(result.status).toBe("saved");
    await service.drain();
    expect(sdk.sends).toHaveLength(1); expect(sdk.sends[0].options.activeTurnBehavior).toBe("steer");
    expect((await store.read("board"))!.interactions[0].status).toBe("delivered");
    await service.interact(input); await service.drain(); expect(sdk.sends).toHaveLength(1);
    await expect(service.interact({ ...input, text: "different" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    sdk.append("owner", { type: "assistant_message", text: "The curve shows the observed data." });
    await service.onTurnEnded("owner");
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "answered", response: "The curve shows the observed data.", resultReferences: [] });
  });

  it("queues an intent while the owner is busy and delivers after the owning turn ends", async () => {
    sdk.snapshots.set("owner", { ...sdk.snapshots.get("owner")!, status: "running" });
    await service.interact({ boardId: "board", intentId: "change-1", kind: "change", text: "Add an animation here" }); await service.drain();
    expect(sdk.sends).toHaveLength(0); expect((await store.read("board"))!.interactions[0].status).toBe("saved");
    sdk.snapshots.set("owner", { ...sdk.snapshots.get("owner")!, status: "idle" });
    await service.onTurnEnded("owner"); await service.drain(); expect(sdk.sends).toHaveLength(1);
    sdk.append("owner", { type: "assistant_message", text: "Received, I am working on it." }); await service.onTurnEnded("owner");
    expect((await store.read("board"))!.interactions[0].status).toBe("processing");
  });

  it("settles unsent intents already applied in the owner's current turn and releases the FIFO queue", async () => {
    sdk.snapshots.set("owner", { ...sdk.snapshots.get("owner")!, status: "running" });
    const first = { boardId: "board", intentId: "already-applied-1", kind: "change" as const, text: "Close on outside click" };
    const second = { ...first, intentId: "already-applied-2", text: "Animate while processing" };
    await service.interact(first); await service.interact(second); await service.drain();
    for (const input of [first, second]) {
      const board = (await store.read("board"))!;
      await service.execute("publish", { boardId: "board", expectedRevision: board.revision, eventId: `apply-${input.intentId}`, interactionResult: { id: input.intentId, status: "applied", response: "Implemented during the current turn", resultReferences: ["#target"] } }, { agentId: "owner", cwd: dir });
      expect(journal.get(deliveryKey("board", input.intentId))!.state).toBe("saved");
    }
    sdk.snapshots.set("owner", { ...sdk.snapshots.get("owner")!, status: "idle" });
    await service.interact({ ...first, intentId: "next", text: "The next actual request" });
    await service.drain();
    expect(sdk.sends).toHaveLength(1);
    expect(sdk.sends[0].text).toContain("intent=next]");
    for (const input of [first, second]) expect(journal.get(deliveryKey("board", input.intentId))).toMatchObject({ state: "settled", awaitingTurn: false });
    await service.interact(first); await service.interact(second); await service.reconcile(); await service.drain();
    expect(sdk.sends).toHaveLength(1);
    await service.dispose(); journal = new ServiceJournal(join(dir, "service.json")); await journal.init();
    service = new BoardService(store, journal, () => undefined); service.capture(sdk.api);
    await service.reconcile(); await service.drain();
    expect(sdk.sends).toHaveLength(1);
    expect((await store.read("board"))!.interactions.slice(0, 2).map(item => item.status)).toEqual(["applied", "applied"]);
    expect(journal.get("board/already-applied-1")!.state).toBe("settled");
  });

  it("reconciles an unsent terminal intent without pretending that it was delivered", async () => {
    sdk.snapshots.set("owner", { ...sdk.snapshots.get("owner")!, status: "running" });
    await service.interact({ boardId: "board", intentId: "handled", kind: "question", text: "Already answered" }); await service.drain();
    await service.execute("respond", { boardId: "board", interactionId: "handled", eventId: "answer-now", expectedResponseRevision: 0, response: "Answered during the current turn" }, { agentId: "owner", cwd: dir });
    await service.reconcile(); await service.reconcile(); await service.drain();
    expect(journal.get("board/handled")).toMatchObject({ state: "settled", awaitingTurn: false });
    expect(sdk.sends).toHaveLength(0);
    expect((await store.read("board"))!.interactions[0].status).toBe("answered");
  });

  it("forks with frozen selection, PNG and decisions using inherited session settings without a parent", async () => {
    let board = (await store.read("board"))!;
    await store.recordDecision({ boardId: board.id, expectedRevision: board.revision, eventId: "choice", decision: { id: "scope", choice: "Only support current clients", basis: "explicit", rationale: "Initial scope", evidence: [], related: [] } });
    const anchor = { boardRevision: 1, canvasRevision: 1, kind: "region" as const, rect: { x: 50, y: 40, width: 200, height: 150 }, image: { mimeType: "image/png" as const, data: "cG5n" } };
    await service.interact({ boardId: "board", intentId: "fork-1", kind: "fork", text: "Why this assumption?", anchor }); await service.drain();
    expect(sdk.create).toHaveBeenCalledTimes(1);
    const options = sdk.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(options).not.toHaveProperty("parent"); expect(options).toHaveProperty("idempotencyKey", "paseo-board-fork:board:fork-1");
    expect(options).toHaveProperty("config.modeId", "auto-review");
    expect(options).toHaveProperty("config.provider", "codex/example-model");
    expect(options).toHaveProperty("config.thinkingOptionId", "high");
    expect(options).toHaveProperty("config.featureValues", { service_tier: "priority", plan_mode: false });
    expect(options).not.toHaveProperty("config.options");
    expect(options).toHaveProperty("config.systemPrompt", expect.stringContaining("perform it directly"));
    expect(options).toHaveProperty("config.systemPrompt", expect.not.stringContaining("not authorization to execute"));
    expect(sdk.sends[0].text).toContain('interactionId="fork-1"');
    expect(sdk.sends[0].text).toContain("board_respond");
    expect(sdk.sends[0].id).toBe("fork-agent"); expect(sdk.sends[0].options.images).toEqual([{ mimeType: "image/png", data: "cG5n" }]);
    expect(sdk.sends[0].text).toContain('"boardRevision":1'); expect(sdk.sends[0].text).toContain("Only support current clients"); expect(sdk.sends[0].text).not.toContain("cG5n");
    sdk.append("fork-agent", { type: "assistant_message", text: "This default affects compatibility; consider a fallback." }); await service.onTurnEnded("fork-agent");
    board = (await store.read("board"))!; expect(board.interactions[0].status).toBe("answered");
    await service.interact({ boardId: "board", intentId: "reply-1", kind: "reply", sourceInteractionId: "fork-1", text: "Show an alternative" }); await service.drain();
    expect(sdk.sends[1].id).toBe("fork-agent"); expect(sdk.sends[1].text).toContain("consider a fallback");
    expect((await store.read("board"))!.interactions[1].anchor).toEqual(anchor);
    expect(sdk.sends[1].text).toContain('interactionId="reply-1"');
    await service.interact({ boardId: "board", intentId: "return-1", kind: "return", sourceInteractionId: "fork-1", text: "Apply the fallback" }); await service.drain();
    expect(sdk.sends[2].id).toBe("owner"); expect(sdk.sends[2].text).toContain("This default affects compatibility");
  });

  it("lets a fork directly patch the shared canvas and keeps its applied receipt through fallback and restart", async () => {
    await service.interact({ boardId: "board", intentId: "fork-1", kind: "fork", text: "Add an animation here" }); await service.drain();
    const actor = { agentId: "fork-agent", cwd: dir };
    const original = (await store.read("board"))!;
    const input = { boardId: "board", expectedRevision: original.revision, eventId: "fork-patch", ownerAgentId: "owner", patch: { id: "animation", selector: "#target", operation: "append" as const, html: '<canvas id="animation"></canvas>' }, interactionResult: { id: "fork-1", status: "applied" as const, response: "Added the animation directly to this Board.", resultReferences: ["#animation"] } };
    const updated = await service.execute("publish", input, actor);
    expect(updated).toMatchObject({ ownerAgentId: "owner", canvas: { revision: original.canvas.revision + 1, patches: [input.patch] }, interactions: [{ id: "fork-1", status: "applied", resultReferences: ["#animation"] }] });
    expect(sdk.sends).toHaveLength(1); expect(sdk.sends[0].id).toBe("fork-agent");
    expect(sdk.sends[0].text).toContain("perform it and update this Board without requiring a return");
    expect(sdk.sends[0].text).toContain("board_publish");
    sdk.append("fork-agent", { type: "assistant_message", text: "A later generic chat completion" });
    await service.onTurnEnded("fork-agent");
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "applied", response: input.interactionResult.response });
    await service.dispose(); journal = new ServiceJournal(join(dir, "service.json")); await journal.init();
    service = new BoardService(store, journal, () => undefined); service.capture(sdk.api); await service.reconcile(); await service.drain();
    expect((await store.read("board"))!.interactions[0].status).toBe("applied");
    const restored = (await store.read("board"))!;
    expect(await service.execute("publish", { boardId: "board", expectedRevision: restored.revision, eventId: "after-restart", data: { restoredFork: true } }, actor)).toHaveProperty("canvas.data.restoredFork", true);
  });

  it("allows fork decisions and external updates but keeps ownership and unrelated boards isolated", async () => {
    await service.interact({ boardId: "board", intentId: "fork-1", kind: "fork", text: "Update this" }); await service.drain();
    const actor = { agentId: "fork-agent", cwd: dir };
    const board = (await store.read("board"))!;
    const decided = await service.execute("decision", { boardId: "board", expectedRevision: board.revision, eventId: "fork-choice", decision: { id: "animation-speed", choice: "Use adjustable playback", basis: "explicit", rationale: "Keep the explanation inspectable", authorAgentId: "owner" } }, actor);
    expect(decided).toHaveProperty("decisions.0.authorAgentId", "fork-agent");
    expect(await service.execute("emit", { boardId: "board", eventId: "fork-event", source: "fork-async-shell", summary: "Result ready", data: { result: 42 } }, actor)).toHaveProperty("canvas.data.result", 42);
    for (const nextOwner of ["fork-agent", "someone-else"]) {
      await expect(service.execute("publish", { boardId: "board", expectedRevision: (await store.read("board"))!.revision, eventId: `steal-${nextOwner}`, ownerAgentId: nextOwner }, actor)).rejects.toThrow("Only the user");
    }
    await store.create({ id: "unrelated", title: "Another Board", ownerAgentId: "owner" });
    for (const operation of ["read", "publish", "decision", "emit"] as const) {
      await expect(service.execute(operation, { boardId: "unrelated" }, actor)).rejects.toThrow("does not own");
    }
    expect((await store.read("board"))!.ownerAgentId).toBe("owner");
    expect(await service.execute("create", { id: "fork-owned", title: "Another canvas" }, actor)).toHaveProperty("ownerAgentId", "fork-agent");
  });

  it("keeps shared edits revision-checked and restricts receipts to their assigned agent", async () => {
    await service.interact({ boardId: "board", intentId: "fork-1", kind: "fork", text: "Update this" }); await service.drain();
    await store.addInteraction({ boardId: "board", intentId: "owner-question", kind: "question", text: "For the owner" }, "owner");
    const actor = { agentId: "fork-agent", cwd: dir };
    const original = (await store.read("board"))!;
    await service.execute("publish", { boardId: "board", expectedRevision: original.revision, eventId: "owner-edit", data: { owner: true } }, { agentId: "owner", cwd: dir });
    await expect(service.execute("publish", { boardId: "board", expectedRevision: original.revision, eventId: "fork-stale", data: { fork: true } }, actor)).rejects.toHaveProperty("code", "revision_conflict");
    const current = (await store.read("board"))!;
    await expect(service.execute("decision", { boardId: "board", expectedRevision: original.revision, eventId: "fork-stale-choice", decision: { id: "stale", choice: "Stale choice", basis: "explicit" } }, actor)).rejects.toHaveProperty("code", "revision_conflict");
    await expect(service.execute("publish", { boardId: "board", expectedRevision: current.revision, eventId: "wrong-receipt", data: { wrong: true }, interactionResult: { id: "owner-question", status: "applied", resultReferences: ["#target"] } }, actor)).rejects.toThrow("assigned");
    await expect(service.execute("respond", { boardId: "board", interactionId: "owner-question", expectedResponseRevision: 0, eventId: "wrong-response", response: "Impersonated answer" }, actor)).rejects.toThrow("assigned");
    expect((await store.read("board"))!.revision).toBe(current.revision);
    expect(await service.execute("publish", { boardId: "board", expectedRevision: current.revision, eventId: "fork-current", data: { fork: true } }, actor)).toHaveProperty("canvas.data", { temperature: 10, owner: true, fork: true });
  });

  it("does not grant shared mutation rights from an ordinary assigned question", async () => {
    await store.addInteraction({ boardId: "board", intentId: "legacy-question", kind: "question", text: "Prior assignee" }, "previous-owner");
    const actor = { agentId: "previous-owner", cwd: dir };
    expect(await service.execute("read", { boardId: "board" }, actor)).toHaveProperty("id", "board");
    await expect(service.execute("publish", { boardId: "board", expectedRevision: (await store.read("board"))!.revision, eventId: "legacy-write", data: { wrong: true } }, actor)).rejects.toThrow("does not own");
  });

  it("persists assigned visual answers without changing the canvas and rejects cross-interaction writes", async () => {
    await service.interact({ boardId: "board", intentId: "fork-1", kind: "fork", text: "Explain visually" }); await service.drain();
    const actor = { agentId: "fork-agent", cwd: dir };
    const original = (await store.read("board"))!.canvas;
    const htmlFile = join(dir, "reply.html"); await writeFile(htmlFile, '<button id="play">Play</button><script>window.replyRuns=1</script>');
    const input = { boardId: "board", interactionId: "fork-1", eventId: "answer-1", expectedResponseRevision: 0, response: "A visual explanation", htmlFile, data: { speed: 1 } };
    const response = await service.execute("respond", input, actor);
    expect(response).toMatchObject({ id: "fork-1", status: "answered", responseSource: "explicit", responseRevision: 1, responseCanvas: { revision: 1, documentVersion: 1, data: { speed: 1 } } });
    expect((await store.read("board"))!.canvas).toEqual(original);
    expect(await service.execute("respond", input, actor)).toEqual(response);
    await expect(service.execute("respond", { ...input, eventId: "stale-answer" }, actor)).rejects.toHaveProperty("code", "revision_conflict");
    await expect(service.execute("respond", { ...input, eventId: "foreign-answer" }, { agentId: "other", cwd: dir })).rejects.toThrow("assigned");
    await expect(service.execute("respond", { ...input, eventId: "owner-answer" }, { agentId: "owner", cwd: dir })).rejects.toThrow("assigned");
    await expect(service.execute("publish", { boardId: "board", expectedRevision: (await store.read("board"))!.revision, eventId: "owner-overwrite", interactionResult: { id: "fork-1", status: "processing", response: "Replace fork answer" } }, { agentId: "owner", cwd: dir })).rejects.toThrow("assigned");
    const updated = await service.execute("respond", { boardId: "board", interactionId: "fork-1", eventId: "answer-data", expectedResponseRevision: 1, response: "A faster explanation", data: { speed: 2 } }, actor);
    expect(updated).toMatchObject({ responseRevision: 2, responseCanvas: { revision: 2, documentVersion: 1, html: expect.stringContaining("replyRuns"), data: { speed: 2 } } });
    sdk.append("fork-agent", { type: "assistant_message", text: "Chat fallback must not replace the explicit answer." });
    await service.onTurnEnded("fork-agent");
    await service.dispose(); journal = new ServiceJournal(join(dir, "service.json")); await journal.init();
    service = new BoardService(store, journal, () => undefined); service.capture(sdk.api); await service.reconcile(); await service.drain();
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "answered", response: "A faster explanation", responseRevision: 2 });
  });

  it("lets the assigned owner answer a question with an independent visual response", async () => {
    await service.interact({ boardId: "board", intentId: "question", kind: "question", text: "Explain" }); await service.drain();
    const response = await service.execute("respond", { boardId: "board", interactionId: "question", eventId: "owner-response", expectedResponseRevision: 0, response: "Explanation", html: "<canvas></canvas>" }, { agentId: "owner", cwd: dir });
    expect(response).toHaveProperty("status", "answered");
    expect((await store.read("board"))!.canvas.html).toContain("Existing visualization");
  });

  it("preserves an explicit working response and reports a missing final submission when the turn ends", async () => {
    await service.interact({ boardId: "board", intentId: "fork", kind: "fork", text: "Explain" }); await service.drain();
    await service.execute("respond", { boardId: "board", interactionId: "fork", eventId: "working", expectedResponseRevision: 0, status: "processing", response: "Constructing the animation" }, { agentId: "fork-agent", cwd: dir });
    sdk.append("fork-agent", { type: "assistant_message", text: "Unstructured commentary." }); await service.onTurnEnded("fork-agent");
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "failed", response: "Constructing the animation", responseSource: "explicit", error: expect.stringContaining("尚未提交最终回答") });
  });

  it("keeps an owner's published async work processing after its current turn ends", async () => {
    await service.interact({ boardId: "board", intentId: "async", kind: "question", text: "Run and explain later" }); await service.drain();
    const board = (await store.read("board"))!;
    await service.execute("publish", { boardId: "board", expectedRevision: board.revision, eventId: "async-working", interactionResult: { id: "async", status: "processing", response: "Waiting for async-shell" } }, { agentId: "owner", cwd: dir });
    await service.onTurnEnded("owner");
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "processing", responseMethod: "publish", response: "Waiting for async-shell" });
  });

  it.each(["failed", "canceled"] as const)("preserves explicit partial content when the discussion turn is %s", async outcome => {
    await service.interact({ boardId: "board", intentId: "partial", kind: "fork", text: "Explain" }); await service.drain();
    await service.execute("respond", { boardId: "board", interactionId: "partial", eventId: "partial-working", expectedResponseRevision: 0, status: "processing", response: "Partial explanation", html: "<p>Partial visual</p>" }, { agentId: "fork-agent", cwd: dir });
    await service.onTurnEnded("fork-agent", outcome);
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "failed", response: "Partial explanation", responseCanvas: { html: "<p>Partial visual</p>" }, error: expect.any(String) });
  });

  it("uses streamed turn outcome events even if the lifecycle hook is missed", async () => {
    await service.interact({ boardId: "board", intentId: "event", kind: "fork", text: "Explain" }); await service.drain();
    sdk.append("fork-agent", { type: "assistant_message", text: "The completed answer" });
    const ended = vi.spyOn(service, "onTurnEnded");
    sdk.subscribers.get("fork-agent")!({ event: { type: "turn_completed", provider: "codex", turnId: "event-turn" } });
    expect(ended).toHaveBeenCalledWith("fork-agent", "completed", "event-turn");
    await ended.mock.results[0].value;
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "answered", response: "The completed answer" });
  });

  it("retains late final text when completion races a canonical history update", async () => {
    await service.interact({ boardId: "board", intentId: "late", kind: "question", text: "Explain" }); await service.drain();
    sdk.append("owner", { type: "assistant_message", text: "Initial" }); await service.onTurnEnded("owner");
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "answered", response: "Initial" });
    const entry = sdk.histories.get("owner")!.at(-1)!; entry.item = { type: "assistant_message", text: "Initial, now complete." }; entry.seqEnd++;
    await service.syncHistory("owner");
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "answered", response: "Initial, now complete." });
  });

  it("recovers an answer arriving after the turn-end event without leaving a permanent pending marker", async () => {
    await service.interact({ boardId: "board", intentId: "late-empty", kind: "question", text: "Explain" }); await service.drain();
    await service.onTurnEnded("owner");
    expect((await store.read("board"))!.interactions[0].status).toBe("failed");
    sdk.append("owner", { type: "assistant_message", text: "Canonical final arrived late." }); await service.syncHistory("owner");
    expect((await store.read("board"))!.interactions[0]).toMatchObject({ status: "answered", response: "Canonical final arrived late." });
    expect((await store.read("board"))!.interactions[0].error).toBeUndefined();
  });

  it("preserves an unknown send result and reconciles only actual matching message evidence", async () => {
    sdk.send.mockImplementationOnce(async (id, text, options) => { sdk.append(id, { type: "user_message", text, clientMessageId: options.messageId as string }); throw new Error("connection reset after acceptance"); });
    await service.interact({ boardId: "board", intentId: "unknown-1", kind: "change", text: "Change this" }); await service.drain();
    expect(journal.get(deliveryKey("board", "unknown-1"))?.state).toBe("unknown");
    await service.reconcile(); await service.drain(); expect(sdk.send).toHaveBeenCalledTimes(1);
    await service.syncHistory("owner");
    expect(journal.get(deliveryKey("board", "unknown-1"))?.state).toBe("delivered");
    expect((await store.read("board"))!.interactions[0].status).toBe("processing");
  });

  it("pulls missed history incrementally, ignores user/hidden-reasoning messages and deduplicates candidate decisions", async () => {
    sdk.append("owner", { type: "user_message", text: "I decided to skip compatibility." });
    sdk.append("owner", { type: "reasoning", text: "I decided to skip the cost checks." });
    sdk.append("owner", { type: "assistant_message", text: "I decided to only support new clients to limit compatibility scope." });
    await service.syncHistory("owner");
    let board = (await store.read("board"))!; expect(board.decisions).toHaveLength(1); expect(board.decisions[0]).toMatchObject({ basis: "inferred", authorAgentId: "owner" }); expect(board.decisions[0].rationale).toBeUndefined();
    expect(board.decisions[0].evidence[0]).toMatchObject({ kind: "message", excerpt: "I decided to only support new clients to limit compatibility scope." });
    await service.syncHistory("owner"); expect((await store.read("board"))!.decisions).toHaveLength(1);
    await service.dispose();
    const restored = new ServiceJournal(join(dir, "service.json")); await restored.init(); service = new BoardService(store, restored, () => undefined); service.capture(sdk.api);
    sdk.append("owner", { type: "assistant_message", text: "我决定只采样一部分数据，以限制预算。" }); await service.syncHistory("owner");
    board = (await store.read("board"))!; expect(board.decisions).toHaveLength(2); expect(board.extraction.cursor).toContain('"seq":4');
  });

  it("does not capture an unrelated subsequent chat reply as a board answer", async () => {
    await service.interact({ boardId: "board", intentId: "ask-1", kind: "question", text: "Explain" }); await service.drain();
    sdk.append("owner", { type: "assistant_message", text: "Board answer." });
    sdk.append("owner", { type: "user_message", text: "Unrelated chat question" });
    sdk.append("owner", { type: "assistant_message", text: "Unrelated chat answer." });
    await service.onTurnEnded("owner");
    expect((await store.read("board"))!.interactions[0].response).toBe("Board answer.");
  });

  it("loads HTML from files and preserves conflict validation through the agent adapter", async () => {
    const path = join(dir, "canvas.html"); await writeFile(path, '<input value="working">');
    const board = (await store.read("board"))!;
    const updated = await service.execute("publish", { boardId: "board", expectedRevision: board.revision, eventId: "html-file", htmlFile: path });
    expect(updated).toHaveProperty("canvas.html", '<input value="working">');
    await expect(service.execute("publish", { boardId: "board", expectedRevision: 1, eventId: "stale", data: { value: 1 } })).rejects.toHaveProperty("code", "revision_conflict");
  });

  it("recovers a saved interaction whose legacy delivery journal write was interrupted", async () => {
    await store.addInteraction({ boardId: "board", intentId: "orphan", kind: "question", text: "Persisted before journal" }, "owner");
    await service.dispose(); journal = new ServiceJournal(join(dir, "service.json")); await journal.init();
    service = new BoardService(store, journal, () => undefined); service.capture(sdk.api);
    await service.reconcile(); await service.drain(); expect(sdk.sends).toHaveLength(1);
  });

  it("recovers the new write-ahead intent when the board projection was interrupted", async () => {
    const projected = vi.spyOn(store, "addInteraction").mockRejectedValueOnce(new Error("interrupted projection"));
    await expect(service.interact({ boardId: "board", intentId: "intent-first", kind: "question", text: "Durable intent first" })).rejects.toThrow("interrupted");
    expect(journal.get("board/intent-first")?.prompt).toContain("Durable intent first"); expect(sdk.sends).toHaveLength(0);
    projected.mockRestore(); await service.reconcile(); await service.drain();
    expect(sdk.sends).toHaveLength(1); expect((await store.read("board"))!.interactions[0].text).toBe("Durable intent first");
  });

  it("does not duplicate a response after interruption before history cursor commit", async () => {
    await service.interact({ boardId: "board", intentId: "replay", kind: "question", text: "Explain" }); await service.drain();
    sdk.append("owner", { type: "assistant_message", text: "Exactly one answer." });
    const original = journal.progress.bind(journal); journal.progress = async () => { throw new Error("simulated journal write failure"); };
    await expect(service.syncHistory("owner")).rejects.toThrow("simulated");
    expect((await store.read("board"))!.interactions[0].response).toBe("Exactly one answer.");
    journal.progress = original; await service.dispose(); journal = new ServiceJournal(join(dir, "service.json")); await journal.init();
    service = new BoardService(store, journal, () => undefined); service.capture(sdk.api);
    await service.syncHistory("owner"); expect((await store.read("board"))!.interactions[0].response).toBe("Exactly one answer.");
  });

  it("releases a delivery after a missed end event without claiming that an idle agent succeeded", async () => {
    await service.interact({ boardId: "board", intentId: "first", kind: "question", text: "First" }); await service.drain(); await service.dispose();
    sdk.append("owner", { type: "assistant_message", text: "Finished while stopped." });
    journal = new ServiceJournal(join(dir, "service.json")); await journal.init(); service = new BoardService(store, journal, () => undefined); service.capture(sdk.api);
    await service.syncHistory("owner");
    const first = (await store.read("board"))!.interactions[0]; expect(first.status).toBe("failed"); expect(first.error).toContain("完成结果未知");
    await service.interact({ boardId: "board", intentId: "second", kind: "question", text: "Second" }); await service.reconcile(); await service.drain(); expect(sdk.sends).toHaveLength(2);
  });

  it("does not complete a failed partial answer when an unrelated later turn succeeds", async () => {
    await service.interact({ boardId: "board", intentId: "failed", kind: "question", text: "First" }); await service.drain();
    sdk.append("owner", { type: "assistant_message", text: "This is a partial answer before failure." }); await service.onTurnEnded("owner", "failed");
    sdk.append("owner", { type: "user_message", text: "An unrelated ordinary chat turn" }); sdk.append("owner", { type: "assistant_message", text: "The other task completed." });
    await service.onTurnEnded("owner", "completed"); expect((await store.read("board"))!.interactions[0].status).toBe("failed");
  });

  it("attributes decisions to the active board instead of copying them into every board owned by the agent", async () => {
    await store.create({ id: "other", title: "Other project", ownerAgentId: "owner" });
    await service.interact({ boardId: "board", intentId: "specific", kind: "question", text: "Choose a scope here" }); await service.drain();
    sdk.append("owner", { type: "assistant_message", text: "I decided to only support new clients to limit compatibility scope." }); await service.syncHistory("owner");
    expect((await store.read("board"))!.decisions).toHaveLength(1); expect((await store.read("other"))!.decisions).toHaveLength(0);
    sdk.append("owner", { type: "user_message", text: "Unattributed ordinary conversation" }); sdk.append("owner", { type: "assistant_message", text: "I decided to skip some data to limit the budget." }); await service.syncHistory("owner");
    expect((await store.read("board"))!.decisions).toHaveLength(1); expect((await store.read("other"))!.decisions).toHaveLength(0);
  });

  it("returns exactly the selected later reply and supports continuing a reply chain", async () => {
    await service.interact({ boardId: "board", intentId: "fork", kind: "fork", text: "Discuss" }); await service.drain();
    sdk.append("fork-agent", { type: "assistant_message", text: "Original option A." }); await service.onTurnEnded("fork-agent");
    await service.interact({ boardId: "board", intentId: "reply", kind: "reply", sourceInteractionId: "fork", text: "Consider B" }); await service.drain();
    sdk.append("fork-agent", { type: "assistant_message", text: "Corrected option B." }); await service.onTurnEnded("fork-agent");
    await service.interact({ boardId: "board", intentId: "return-reply", kind: "return", sourceInteractionId: "reply", text: "Apply this correction" }); await service.drain();
    expect(sdk.sends.at(-1)?.id).toBe("owner"); expect(sdk.sends.at(-1)?.text).toContain('"response":"Corrected option B."');
    await service.interact({ boardId: "board", intentId: "reply-again", kind: "reply", sourceInteractionId: "reply", text: "Clarify B" }); await service.drain(); expect(sdk.sends.at(-1)?.id).toBe("fork-agent");
  });

  it("replaces a projected message interval instead of duplicating its old prefix", async () => {
    await service.interact({ boardId: "board", intentId: "merge", kind: "question", text: "Explain" }); await service.drain();
    sdk.append("owner", { type: "assistant_message", text: "Hello" }); await service.syncHistory("owner");
    const entry = sdk.histories.get("owner")!.at(-1)!; entry.item = { type: "assistant_message", text: "Hello world" }; entry.seqEnd = 3;
    await service.syncHistory("owner"); expect((await store.read("board"))!.interactions[0].response).toBe("Hello world");
  });

  it("checks owner identity again after saving the sending receipt and before SDK send", async () => {
    const original = journal.put.bind(journal); let rebound = false;
    journal.put = async (delivery) => {
      await original(delivery);
      if (delivery.state === "sending" && !rebound) { rebound = true; const board = (await store.read("board"))!; await store.publish({ boardId: board.id, expectedRevision: board.revision, eventId: "new-owner", ownerAgentId: "different-owner" }); }
    };
    await service.interact({ boardId: "board", intentId: "handoff", kind: "change", text: "Apply change" }); await service.drain();
    expect(sdk.sends).toHaveLength(0); expect((await store.read("board"))!.interactions[0].error).toContain("负责人已变更");
  });

  it("keeps empty history polling read-only and does not inspect unrelated lifecycle agents", async () => {
    const before = (await store.read("board"))!.revision;
    await service.syncHistory("owner"); await service.syncHistory("owner"); await service.onTurnEnded("unrelated");
    expect((await store.read("board"))!.revision).toBe(before);
  });

  it("serializes simultaneous same-ID intents before any external side effect", async () => {
    const input = { boardId: "board", intentId: "race", kind: "question" as const, text: "Original intent" };
    const results = await Promise.allSettled([service.interact(input), service.interact({ ...input, text: "Different payload" })]); await service.drain();
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]); expect(sdk.sends).toHaveLength(1); expect(sdk.sends[0].text).toContain("Original intent"); expect(sdk.sends[0].text).not.toContain("Different payload");
  });

  it("preserves FIFO for distinct intents when a new request arrives during turn settlement", async () => {
    await service.interact({ boardId: "board", intentId: "first", kind: "question", text: "First" }); await service.drain();
    await service.interact({ boardId: "board", intentId: "second", kind: "question", text: "Second" }); await service.drain(); expect(sdk.sends).toHaveLength(1);
    sdk.append("owner", { type: "assistant_message", text: "First answer." });
    let resume!: () => void; let reached!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; }); const release = new Promise<void>((resolve) => { resume = resolve; });
    const original = journal.patch.bind(journal);
    journal.patch = async (key, update) => { const result = await original(key, update); if (key === "board/first" && update.outcome === "completed") { reached(); await release; } return result; };
    const ending = service.onTurnEnded("owner"); await paused;
    await service.interact({ boardId: "board", intentId: "third", kind: "question", text: "Third" }); await service.drain(); resume(); await ending; await service.drain();
    expect(sdk.sends[1]?.text).toContain("intent=second]"); expect(sdk.sends).toHaveLength(2);
  });
});

describe("decision evidence extraction", () => {
  it("rejects quoted examples, code, user attribution and ordinary progress", () => {
    const item = { item: { type: "assistant_message", text: 'The user decided to only support new clients.\n根据你的要求，我决定只支持新版。\n> I decided to skip compatibility.\n```\nI decided to skip the budget check.\n```\nI will inspect the files now.' }, seqStart: 1, seqEnd: 1 } as TimelineEntry;
    expect(extractCandidates("owner", "epoch", item)).toEqual([]);
  });
});
