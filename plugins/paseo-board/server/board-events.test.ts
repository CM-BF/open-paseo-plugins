import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BoardCommitNotice } from "./board-events";
import { BoardEventHub } from "./board-events";
import { BoardStore } from "./store";

describe("durable Board events and compact summaries", () => {
  let directory: string;
  let notices: BoardCommitNotice[];
  let store: BoardStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "board-events-"));
    notices = [];
    store = new BoardStore(directory, { onCommit: notice => notices.push(notice) });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const create = (store: BoardStore, id = "one") => store.create({ id, title: id, html: "<section id='content'>Original</section>" });

  it("publishes only durable changes, including attention at the same content revision", async () => {
    const board = await create(store);
    const changed = await store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: { revision: 1, documentVersion: 1 }, eventId: "update", patch: { id: "patch", selector: "#content", operation: "append", html: "New" } });
    await expect(store.publish({ boardId: board.id, expectedRevision: 0, eventId: "bad" })).rejects.toThrow();
    await store.markUpdatesSeen({ boardId: board.id, updateIds: ["update"] });
    await store.markUpdatesSeen({ boardId: board.id, updateIds: ["update"] });
    await store.updateExtraction(board.id, { cursor: "operational checkpoint" });
    expect(notices.map(notice => notice.reason)).toEqual(["content", "content", "attention"]);
    expect(notices[1].summary).toMatchObject({ revision: changed.revision, unreadUpdateCount: 1 });
    expect(notices[2].summary).toMatchObject({ revision: changed.revision, unreadUpdateCount: 0 });
    expect(JSON.stringify(notices)).not.toContain("Original");
    expect(JSON.stringify(notices)).not.toContain("operational checkpoint");
  });

  it("shares same-directory summary changes across instances without reading canvases for list", async () => {
    await create(store);
    const second = new BoardStore(directory);
    await second.init();
    await store.rename({ boardId: "one", expectedTitle: "one", title: "Renamed", eventId: "rename" });
    expect(await second.list()).toMatchObject([{ title: "Renamed", status: "idle" }]);
    // The compact index remains readable without materializing the authored source.
    await rm(join(directory, "boards", "one.json"));
    expect(await second.list()).toMatchObject([{ title: "Renamed" }]);
    expect(notices.at(-1)?.reason).toBe("metadata");
  });

  it("initializes only the owned partition and filters its shared index", async () => {
    await create(store, "left"); await create(store, "right");
    const partition = new BoardStore(directory, { ownsBoard: id => id === "left" });
    await partition.init();
    expect((await partition.list()).map(board => board.id)).toEqual(["left"]);
  });

  it("projects interaction state without treating an open idle feed as running work", async () => {
    await create(store);
    await store.feed({ action: "open", boardId: "one", sourceId: "live", requestId: "open", path: "/feed", expectedGeneration: 0 });
    expect((await store.list())[0].status).toBe("idle");
    await store.addInteraction({ boardId: "one", intentId: "ask", kind: "question", text: "Work" });
    expect((await store.list())[0].status).toBe("processing");
    await store.updateInteraction("one", "ask", { status: "failed" });
    expect((await store.list())[0].status).toBe("error");
    await store.updateInteraction("one", "ask", { status: "answered", response: "Done" });
    expect((await store.list())[0].status).toBe("idle");
  });

  it("does not turn a listener failure into a failed committed write or duplicate notice", async () => {
    const failing = new BoardStore(directory, { onCommit: () => { throw new Error("Listener failed"); } });
    await expect(create(failing)).resolves.toMatchObject({ revision: 1 });
    const rename = { boardId: "one", expectedTitle: "one", title: "New", eventId: "rename" };
    await store.rename(rename); await store.rename(rename);
    expect(notices).toHaveLength(1);
    expect((await store.read("one"))?.title).toBe("New");
  });

  it("recovers bounded sequence gaps and restarts with compact snapshots", async () => {
    const hub = new BoardEventHub({ epoch: "first", retention: 2 });
    const remove = hub.subscribe(event => { event.summary.title = "Listener-local mutation"; });
    await create(store);
    hub.seed(await store.list());
    const baseline = hub.snapshot();
    expect(baseline.cursor.sequence).toBe(0);
    hub.accept(notices[0]);
    await store.saveState({ boardId: "one", state: { draft: "saved" } }); hub.accept(notices.at(-1)!);
    expect(hub.changesSince(baseline.cursor)).toMatchObject({ mode: "delta", changes: [{ cursor: { sequence: 1 } }, { cursor: { sequence: 2 } }] });
    await store.saveState({ boardId: "one", state: { draft: "changed" } }); hub.accept(notices.at(-1)!);
    expect(hub.changesSince(baseline.cursor)).toMatchObject({ mode: "snapshot", boards: [{ title: "one" }] });
    expect(hub.changesSince({ epoch: "old", sequence: 3 }).mode).toBe("snapshot");
    expect(hub.changesSince({ epoch: "first", sequence: 99 }).mode).toBe("snapshot");
    expect(hub.accept(notices[0])).toBeUndefined();
    remove();
    expect(hub.snapshot().cursor.sequence).toBe(3);
  });
});
