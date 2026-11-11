import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_LIMITS, LiveMarksSchema, type LiveMark } from "../shared/live-data";
import { LivePathSchema } from "../shared/release-contracts";
import { projectLive, sortLiveMarks } from "./live-projection";
import { BoardStorePool } from "./store-pool";

const mark = (path: string, subtree = false): LiveMark => ({ path, subtree });

describe("public projection", () => {
  it("publishes only marked paths and reports withheld ones with their reasons", () => {
    const data = { live: { n: 1, text: "ok" }, PRIVATE_DATA: "PRIVATE_DATA", list: [{ a: 1 }], scalar: 3 };
    const projected = projectLive(data, [mark("/live/n"), mark("/live/text"), mark("/missing"), mark("/scalar/below"), mark("/list/0/a")]);
    expect(JSON.parse(projected.body!)).toEqual({ "/live/n": 1, "/live/text": "ok" });
    expect(projected.withheld).toEqual([{ path: "/list/0/a", reason: "non-object-parent" }, { path: "/missing", reason: "absent" }, { path: "/scalar/below", reason: "non-object-parent" }]);
    expect(projected.body).not.toContain("PRIVATE_DATA");
    expect(projected.pathBytes).toEqual({ "/live/n": 1, "/live/text": 4 });
    expect(projected.bytes).toBe(Buffer.byteLength(projected.body!));
  });

  it("publishes objects, and arrays holding objects at any depth, only with explicit subtree consent", () => {
    const data = { object: { a: 1 }, flat: [1, "two", null, [3]], objects: [{ added: "later" }], nested: [[{ deep: true }]], empty: {} };
    const plain = projectLive(data, ["/object", "/flat", "/objects", "/nested", "/empty"].map(path => mark(path)));
    expect(JSON.parse(plain.body!)).toEqual({ "/flat": data.flat });
    expect(plain.withheld.map(item => [item.path, item.reason])).toEqual([["/empty", "object-without-subtree"], ["/nested", "object-without-subtree"], ["/object", "object-without-subtree"], ["/objects", "object-without-subtree"]]);
    const consented = projectLive(data, ["/object", "/objects", "/nested"].map(path => mark(path, true)));
    expect(JSON.parse(consented.body!)).toEqual({ "/object": data.object, "/objects": data.objects, "/nested": data.nested });
    expect(consented.withheld).toEqual([]);
  });

  it("computes the same digest whatever the key or mark order", () => {
    const one = projectLive({ a: { x: 1, y: 2 }, b: 3 }, [mark("/a", true), mark("/b")]);
    const two = projectLive({ b: 3, a: { y: 2, x: 1 } }, [mark("/b"), mark("/a", true)]);
    expect(one.digest).toMatch(/^[a-f0-9]{64}$/); expect(two.digest).toBe(one.digest); expect(two.body).toBe(one.body);
    expect(projectLive({ a: { x: 1, y: 3 }, b: 3 }, [mark("/a", true), mark("/b")]).digest).not.toBe(one.digest);
    expect(sortLiveMarks([mark("/b"), mark("/a")]).map(item => item.path)).toEqual(["/a", "/b"]);
  });

  it("is over limit past the byte or depth cap, without a body or digest", () => {
    const large = projectLive({ value: "x".repeat(LIVE_LIMITS.documentBytes) }, [mark("/value")]);
    expect(large).toMatchObject({ overLimit: true, withheld: [], pathBytes: { "/value": LIVE_LIMITS.documentBytes + 2 } });
    expect(large).not.toHaveProperty("body"); expect(large).not.toHaveProperty("digest");
    expect(projectLive({ value: "x".repeat(LIVE_LIMITS.documentBytes - 16) }, [mark("/value")]).overLimit).toBe(false);
    const nest = (levels: number): unknown => levels ? [nest(levels - 1)] : [];
    // Document depth 1 + the 63 arrays nested inside /deep is exactly the backend's limit.
    expect(projectLive({ deep: nest(62) }, [mark("/deep")]).overLimit).toBe(false);
    expect(projectLive({ deep: nest(63) }, [mark("/deep")]).overLimit).toBe(true);
  });

  it("validates paths like a data patch and refuses overlapping marks", () => {
    for (const valid of ["/a", "/a/b", "/a~1b", "/~0"]) expect(LivePathSchema.safeParse(valid).success).toBe(true);
    for (const invalid of ["", "a", "/a~", "/a~2", "/__proto__", "/a/constructor", `/${"a".repeat(500)}`, `/${"a/".repeat(64)}a`]) expect(LivePathSchema.safeParse(invalid).success).toBe(false);
    expect(LiveMarksSchema.safeParse([]).success).toBe(false);
    expect(LiveMarksSchema.safeParse([mark("/a"), mark("/b")]).success).toBe(true);
    for (const overlapping of [[mark("/a"), mark("/a")], [mark("/a"), mark("/a/b")], [mark("/a/b/c"), mark("/a/b")]]) expect(LiveMarksSchema.safeParse(overlapping).success).toBe(false);
    expect(LiveMarksSchema.safeParse(Array.from({ length: 33 }, (_, index) => mark(`/k${index}`))).success).toBe(false);
  });
});

describe("projection inside the worker", () => {
  let directory: string, store: BoardStorePool;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "board-live-worker-")); store = new BoardStorePool(directory, { workers: 1 }); });
  afterEach(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });

  it("runs in the worker and returns only the allow-listed projection", async () => {
    const board = await store.create({ id: "worker", title: "Worker", ownerAgentId: "owner", data: { live: 1, secret: "PRIVATE_DATA" } });
    const worker = store.diagnostics()[0].pid;
    const result = await store.projectPublic("worker", board.createdAt, [mark("/live"), mark("/absent")]);
    expect(worker).toBeDefined(); expect(worker).not.toBe(process.pid); expect(store.diagnostics()[0].pid).toBe(worker);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DATA");
    expect(result).toMatchObject({ createdAt: board.createdAt, canvasRevision: board.canvas.revision, bytes: result!.body!.length, overLimit: false, withheld: [{ path: "/absent", reason: "absent" }] });
    expect(JSON.parse(result!.body!)).toEqual({ "/live": 1 });
  });

  it("projects nothing for a replaced or missing Board", async () => {
    await store.create({ id: "replaced", title: "Replaced", ownerAgentId: "owner", data: { live: "PUBLIC_VALUE" } });
    const stale = await store.projectPublic("replaced", "1999-01-01T00:00:00.000Z", [mark("/live")]);
    expect(stale).toMatchObject({ bytes: 0, overLimit: false, withheld: [], pathBytes: {} });
    expect(stale).not.toHaveProperty("body"); expect(JSON.stringify(stale)).not.toContain("PUBLIC_VALUE");
    expect(await store.projectPublic("no-such-board", "1999-01-01T00:00:00.000Z", [mark("/live")])).toBeNull();
  });
});
