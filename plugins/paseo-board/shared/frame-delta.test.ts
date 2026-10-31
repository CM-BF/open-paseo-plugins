import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFrameDelta, dataChanges, emptyFrameDelta, equalJson, transportSnapshot, type FrameDelta, type TransportSnapshot } from "./frame-delta";
import type { CanvasPatch } from "./contracts";

// Execute the exact standalone factory injected into the real iframe, without a DOM mock.
type Received = { snapshot: TransportSnapshot; changedPaths: string[] | null; patches: CanvasPatch[] } | null;
type Receiver = { snapshot(next: unknown, version: number): Received; delta(value: unknown): Received };
const createReceiver = new Function(`return (${readFileSync(new URL("./assets/frame-delta.txt", import.meta.url), "utf8")})`)() as
  (initial: TransportSnapshot, request: (value: unknown) => void) => Receiver;
const initial = (): TransportSnapshot => ({ boardRevision: 1, canvas: { revision: 1, documentVersion: 2, data: { left: { n: 1 }, right: { n: 2 } }, patches: [] }, userState: { draft: "saved" }, theme: { scheme: "light", tokens: { "host-background": "#fff" } } });
const patch = (id: string): CanvasPatch => ({ id, selector: "#target", operation: "append", html: `<b>${id}</b>` });
const changed = (base: TransportSnapshot, data: Record<string, unknown>, patches = base.canvas.patches): TransportSnapshot => ({ ...base, boardRevision: base.boardRevision + 1, canvas: { ...base.canvas, revision: base.canvas.revision + 1, data, patches } });
const delta = (a: TransportSnapshot, b: TransportSnapshot, version: number) => createFrameDelta(a, b, version)!;
const setup = () => {
  const first = initial(), requests: unknown[] = [];
  const receiver = createReceiver(first, value => requests.push(value));
  receiver.snapshot(first, 1);
  return { first, requests, receiver };
};

describe("host frame deltas", () => {
  it("transfers changed JSON pointers, escapes keys, removes values and ignores object key ordering", () => {
    expect(dataChanges({ same: { a: 1, b: 2 }, gone: 4, "a/b": { "~": 1 } }, { same: { b: 2, a: 1 }, "a/b": { "~": 2 } })).toEqual([
      { op: "remove", path: "/gone" }, { op: "set", path: "/a~1b/~0", value: 2 },
    ]);
    expect(equalJson({ a: undefined }, { b: undefined })).toBe(false);
  });
  it("uses compact tails only for a proved unchanged prefix, including object-valued records", () => {
    const records = Array.from({ length: 100 }, (_, id) => ({ id, value: `record ${id}` }));
    expect(dataChanges({ records }, { records: [...records.map(row => ({ ...row })), { id: 100, value: "new" }] })).toEqual([
      { op: "append", path: "/records", offset: 100, values: [{ id: 100, value: "new" }] },
    ]);
    for (const next of [records.slice(1), records.map((row, i) => i === 50 ? { ...row, value: "mutated" } : row), [{ id: 0, value: "different" }, ...records.slice(1), { id: 100, value: "new" }]]) {
      expect(dataChanges({ records }, { records: next })[0].op).toBe("set");
    }
  });
  it("sends only new patches and changed state/theme, and omits HTML even for recovery", () => {
    const a = initial(); a.canvas.patches = [patch("old")];
    const b = changed(a, { ...a.canvas.data, count: 3 }, [...a.canvas.patches, patch("new")]);
    const result = delta(a, b, 7);
    expect(result.base).toEqual({ version: 7, documentVersion: 2, boardRevision: 1, canvasRevision: 1, patchCount: 1 });
    expect(result.patches.map(p => p.id)).toEqual(["new"]);
    expect(result).not.toHaveProperty("theme"); expect(result).not.toHaveProperty("userState");
    expect(transportSnapshot({ ...b, canvas: { ...b.canvas, html: "large HTML" } }).canvas).not.toHaveProperty("html");
    expect(emptyFrameDelta(delta(a, structuredClone(a), 1))).toBe(true);
    expect(createFrameDelta(a, { ...b, canvas: { ...b.canvas, patches: [patch("changed")] } }, 7)).toBeNull();
    expect(createFrameDelta(a, { ...b, canvas: { ...b.canvas, documentVersion: 3 } }, 7)).toBeNull();
    const stateTheme = delta(a, { ...a, userState: { draft: "new" }, theme: { scheme: "dark", tokens: {} } }, 1);
    expect(stateTheme.userState).toEqual({ draft: "new" }); expect(stateTheme.theme?.scheme).toBe("dark");
  });
  it("keeps ordinary transfer small for a large retained data/HTML/patch history", () => {
    const a = initial(); a.canvas.data = { records: Array.from({ length: 20000 }, (_, id) => ({ id, text: "x".repeat(80) })), counter: 1 };
    a.canvas.patches = Array.from({ length: 30 }, (_, id) => ({ ...patch(`old-${id}`), html: "x".repeat(10000) }));
    const b = changed(a, { ...a.canvas.data, counter: 2 });
    const fullBytes = Buffer.byteLength(JSON.stringify({ ...b, canvas: { ...b.canvas, html: "x".repeat(1000000) } }));
    const deltaBytes = Buffer.byteLength(JSON.stringify(delta(a, b, 1)));
    expect(fullBytes).toBeGreaterThan(3000000); expect(deltaBytes).toBeLessThan(400);
  });
});

describe("iframe received baseline", () => {
  it("applies atomically with structural sharing while the displayed snapshot stays frozen", () => {
    const { first, receiver, requests } = setup();
    const second = changed(first, { ...first.canvas.data, left: { n: 3 } }, [patch("one")]);
    const received = receiver.delta(delta(first, second, 1))!;
    expect(received.snapshot).toEqual(second);
    expect(received.snapshot.canvas.data.right).toBe(first.canvas.data.right);
    expect(first.canvas.data.left).toEqual({ n: 1 }); expect(first.canvas.patches).toEqual([]);
    const third = changed(second, { ...second.canvas.data, left: { n: 4 } }, [...second.canvas.patches, patch("two")]);
    expect(receiver.delta(delta(second, third, 2))?.snapshot).toEqual(third);
    expect(received.snapshot.canvas.data.left).toEqual({ n: 3 }); expect(requests).toEqual([]);
  });
  it("ignores duplicate and old out-of-order deliveries without replaying patches", () => {
    const { first, receiver, requests } = setup();
    const second = changed(first, { n: 2 }, [patch("one")]);
    const d = delta(first, second, 1);
    expect(receiver.delta(d)?.patches).toEqual([patch("one")]);
    expect(receiver.delta(d)).toBeNull();
    const third = changed(second, { n: 3 }, [...second.canvas.patches, patch("two")]);
    expect(receiver.delta(delta(second, third, 2))?.snapshot).toEqual(third);
    expect(receiver.delta(d)).toBeNull(); expect(receiver.snapshot(first, 1)).toBeNull(); expect(requests).toEqual([]);
  });
  it("detects a genuine missing version and waits for one full recovery before accepting more deltas", () => {
    const { first, receiver, requests } = setup();
    const second = changed(first, { n: 2 }, [patch("one")]);
    const third = changed(second, { n: 3 }, [...second.canvas.patches, patch("two")]);
    // Transport version 2 is actually omitted; receive version 3 first.
    expect(receiver.delta(delta(second, third, 2))).toBeNull();
    expect(receiver.delta(delta(first, second, 1))).toBeNull();
    expect(receiver.delta(delta(second, third, 2))).toBeNull(); expect(requests).toHaveLength(1);
    expect(receiver.snapshot(third, 4)?.patches.map(p => p.id)).toEqual(["one", "two"]);
    const fourth = changed(third, { n: 4 });
    expect(receiver.delta(delta(third, fourth, 4))?.snapshot).toEqual(fourth);
  });
  it.each(["version", "documentVersion", "boardRevision", "canvasRevision", "patchCount"])("rejects a mismatched %s baseline", key => {
    const { first, receiver, requests } = setup();
    const d = delta(first, changed(first, { n: 2 }), 1);
    (d.base as unknown as Record<string, number>)[key] += 1;
    expect(receiver.delta(d)).toBeNull(); expect(requests).toHaveLength(1);
  });
  it.each(["/__proto__/polluted", "/left/constructor", "/left/prototype", "/a~2b", "/missing/child", "left"])("rejects unsafe or invalid pointers atomically: %s", path => {
    const { first, receiver, requests } = setup();
    const d = delta(first, changed(first, { n: 2 }), 1);
    d.data = [{ op: "set", path: "/left/n", value: 99 }, { op: "set", path, value: true }];
    expect(receiver.delta(d)).toBeNull(); expect(first.canvas.data.left).toEqual({ n: 1 }); expect(requests).toHaveLength(1);
    expect(({} as any).polluted).toBeUndefined();
  });
  it("rejects wrong array offsets, malformed JSON, invalid themes and duplicate patch ids", () => {
    for (const mutate of [
      (d: FrameDelta) => { d.data = [{ op: "append", path: "/left", offset: 0, values: [1] }]; },
      (d: FrameDelta) => { d.data = [{ op: "set", path: "/left", value: Infinity }]; },
      (d: FrameDelta) => { d.theme = { scheme: "light", tokens: { "host-x": "url(https://evil)" } }; },
      (d: FrameDelta) => { d.patches = [patch("one"), patch("one")]; },
    ]) {
      const { first, receiver, requests } = setup(); const d = delta(first, changed(first, { n: 2 }), 1); mutate(d);
      expect(receiver.delta(d)).toBeNull(); expect(requests).toHaveLength(1);
    }
  });
  it("accepts remove patches without unused HTML and rejects malformed recovery data atomically", () => {
    const { first, receiver, requests } = setup();
    const second = changed(first, { n: 2 });
    const d = delta(first, second, 1);
    d.patches = [{ id: "remove", selector: "#target", operation: "remove" } as CanvasPatch];
    expect(receiver.delta(d)?.patches[0]).toEqual({ id: "remove", selector: "#target", operation: "remove" });
    const broken = { ...second, canvas: { ...second.canvas, data: { n: Infinity } } };
    expect(receiver.snapshot(broken, 3)).toBeNull();
    expect(receiver.snapshot({ ...second, userState: { date: new Date() } }, 3)).toBeNull();
    expect(requests).toHaveLength(1);
    expect(receiver.snapshot(second, 3)?.snapshot).toEqual(second);
  });
  it("accepts escaped object keys, compact arrays and safe root JSON with prototype-named properties", () => {
    const { first, receiver } = setup();
    const second = changed(first, { rows: Array.from({ length: 10 }, (_, n) => n), "a/b": { "~": 1 } });
    receiver.delta(delta(first, second, 1));
    const third = changed(second, { rows: [...second.canvas.data.rows as number[], 10, 11], "a/b": { "~": 2 } });
    expect(receiver.delta(delta(second, third, 2))?.snapshot.canvas.data).toEqual(third.canvas.data);
    const fourth = changed(third, JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}'));
    expect(receiver.delta(delta(third, fourth, 3))?.snapshot.canvas.data).toEqual(fourth.canvas.data);
    expect(({} as any).polluted).toBeUndefined();
  });
  it("starts a reconnect at a fresh transport version and validates the document", () => {
    const first = initial(), requests: unknown[] = [];
    const receiver = createReceiver(first, value => requests.push(value));
    expect(receiver.snapshot({ ...first, canvas: { ...first.canvas, documentVersion: 1 } }, 1)).toBeNull();
    expect(receiver.snapshot(first, 1)?.snapshot).toEqual(first);
    expect(receiver.delta(delta(first, changed(first, { n: 3 }), 1))?.snapshot.canvas.data).toEqual({ n: 3 });
    expect(requests).toHaveLength(1);
  });
});
