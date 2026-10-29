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
  const snapshot = (id: string) => ({ id, provider: "codex", model: "example-model", cwd: "/tmp/board-fixture", workspaceId: "wks_0123456789abcdef", status: "idle", pendingPermissions: [], activeTurn: null, thinkingOptionId: "high", archivedAt: null } as unknown as Snapshot);
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

  it("forks with frozen selection, PNG and decisions using a read-only session without a parent", async () => {
    let board = (await store.read("board"))!;
    await store.recordDecision({ boardId: board.id, expectedRevision: board.revision, eventId: "choice", decision: { id: "scope", choice: "Only support current clients", basis: "explicit", rationale: "Initial scope", evidence: [], related: [] } });
    const anchor = { boardRevision: 1, canvasRevision: 1, kind: "region" as const, rect: { x: 50, y: 40, width: 200, height: 150 }, image: { mimeType: "image/png" as const, data: "cG5n" } };
    await service.interact({ boardId: "board", intentId: "fork-1", kind: "fork", text: "Why this assumption?", anchor }); await service.drain();
    expect(sdk.create).toHaveBeenCalledTimes(1);
    const options = sdk.create.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(options).not.toHaveProperty("parent"); expect(options).toHaveProperty("idempotencyKey", "paseo-board-fork:board:fork-1");
    expect(options).toHaveProperty("config.options.sandbox_mode", "read-only");
    expect(sdk.sends[0].id).toBe("fork-agent"); expect(sdk.sends[0].options.images).toEqual([{ mimeType: "image/png", data: "cG5n" }]);
    expect(sdk.sends[0].text).toContain('"boardRevision":1'); expect(sdk.sends[0].text).toContain("Only support current clients"); expect(sdk.sends[0].text).not.toContain("cG5n");
    sdk.append("fork-agent", { type: "assistant_message", text: "This default affects compatibility; consider a fallback." }); await service.onTurnEnded("fork-agent");
    board = (await store.read("board"))!; expect(board.interactions[0].status).toBe("answered");
    await service.interact({ boardId: "board", intentId: "reply-1", kind: "reply", sourceInteractionId: "fork-1", text: "Show an alternative" }); await service.drain();
    expect(sdk.sends[1].id).toBe("fork-agent"); expect(sdk.sends[1].text).toContain("consider a fallback");
    await service.interact({ boardId: "board", intentId: "return-1", kind: "return", sourceInteractionId: "fork-1", text: "Apply the fallback" }); await service.drain();
    expect(sdk.sends[2].id).toBe("owner"); expect(sdk.sends[2].text).toContain("This default affects compatibility");
  });

  it("does not let a discussion fork overwrite the original board, while letting it build a separate free canvas", async () => {
    await service.interact({ boardId: "board", intentId: "fork-1", kind: "fork", text: "Discuss" }); await service.drain();
    const actor = { agentId: "fork-agent", cwd: "/tmp/fixture" };
    expect(await service.execute("read", { boardId: "board" }, actor)).toHaveProperty("id", "board");
    await expect(service.execute("publish", { boardId: "board", expectedRevision: 1, eventId: "bad", html: "bad" }, actor)).rejects.toThrow("does not own");
    const created = await service.execute("create", { id: "fork-board", title: "Interactive explanation", html: "<canvas></canvas>" }, actor);
    expect(created).toHaveProperty("ownerAgentId", "fork-agent");
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
