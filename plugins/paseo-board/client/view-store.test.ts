import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasViewState } from "../shared/frame-contract";
import type { DraftStorage } from "./draft-store";
import { BOARD_VIEW_MAX_BYTES, BOARD_VIEW_MAX_RECORDS, BOARD_VIEW_STORAGE_KEY, createBoardViewStore, type BoardEntryScope, type BoardViewTab } from "./view-store";

function storage() {
  const values = new Map<string, string>();
  const db: DraftStorage = {
    get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); },
  };
  return { db, values };
}
const agent: BoardEntryScope = { hostId: "host", surface: "agent", workspaceId: "workspace", agentId: "agent" };
const view = (y = 410): CanvasViewState => ({ documentVersion: 2, canvasRevision: 7, x: 30, y, anchor: { selector: "#section", offsetX: 5, offsetY: -40 }, scrolls: [{ selector: "#log", x: 12, y: 90 }] });

describe("local Board navigation hints", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("remembers selection and an explicit Back through a fresh store, isolated by every entry scope field", () => {
    const { db } = storage(), first = createBoardViewStore(db);
    first.writeLastBoard(agent, { kind: "board", boardId: "selected" });
    expect(createBoardViewStore(db).readLastBoard(agent)).toEqual({ kind: "board", boardId: "selected" });
    for (const scope of [
      { ...agent, hostId: "other" }, { ...agent, workspaceId: "other" }, { ...agent, agentId: "other" },
      { ...agent, surface: "workspace" as const }, { ...agent, surface: "screen" as const },
    ]) expect(first.readLastBoard(scope)).toBeUndefined();
    first.writeLastBoard(agent, { kind: "index" });
    expect(createBoardViewStore(db).readLastBoard(agent)).toEqual({ kind: "index" });
  });

  it("uses valid tab state before the fallback, validates its scope, and preserves other tab fields", () => {
    const { db } = storage(), store = createBoardViewStore(db);
    let state: unknown = { anotherSetting: 3 };
    const tab: BoardViewTab = { get state() { return state; }, setState: next => { state = next; } };
    store.writeLastBoard(agent, { kind: "board", boardId: "tab-choice" }, tab);
    store.writeLastBoard(agent, { kind: "board", boardId: "fallback-choice" });
    expect(store.readLastBoard(agent, tab)).toEqual({ kind: "board", boardId: "tab-choice" });
    expect(state).toMatchObject({ anotherSetting: 3 });
    expect(store.readLastBoard({ ...agent, agentId: "different" }, tab)).toBeUndefined();
    const otherTab = { state, setState: (_next: unknown) => {} };
    store.writeLastBoard(agent, { kind: "index" }, tab);
    expect(store.readLastBoard(agent, tab)).toEqual({ kind: "index" });
    expect(store.readLastBoard(agent, otherTab)).toEqual({ kind: "board", boardId: "tab-choice" });
  });

  it("falls back to memory when tab state or browser persistence is refused, then persists the latest choice after recovery", () => {
    const { db, values } = storage(), store = createBoardViewStore(db);
    store.writeLastBoard(agent, { kind: "board", boardId: "old-on-disk" });
    const save = db.setItem;
    db.setItem = () => { throw Error("QuotaExceededError"); };
    const tab: BoardViewTab = { state: undefined, setState: () => { throw Error("host unavailable"); } };
    expect(() => store.writeLastBoard(agent, { kind: "index" }, tab)).not.toThrow();
    expect(store.readLastBoard(agent, tab)).toEqual({ kind: "index" });
    expect(createBoardViewStore(db).readLastBoard(agent)).toEqual({ kind: "board", boardId: "old-on-disk" });
    db.setItem = save;
    store.writeBoardView("host", "board", view(), false);
    expect(createBoardViewStore(db).readLastBoard(agent)).toEqual({ kind: "index" });
    expect(values.size).toBe(1);
    const native = createBoardViewStore(null);
    native.writeLastBoard(agent, { kind: "board", boardId: "memory" });
    expect(native.readLastBoard(agent)).toEqual({ kind: "board", boardId: "memory" });
  });

  it("keeps Back after a refused or delayed same-tab write across remount wrappers without overriding other tabs", () => {
    const { db } = storage(), store = createBoardViewStore(db);
    let state: unknown;
    const original: BoardViewTab = { get state() { return state; }, setState: next => { state = next; } };
    store.writeLastBoard(agent, { kind: "board", boardId: "old-board" }, original);
    const oldState = state;
    const refused = () => { throw Error("host rejected update"); };
    store.writeLastBoard(agent, { kind: "index" }, { state: oldState, setState: refused });
    expect(store.readLastBoard(agent, { state: oldState, setState: refused })).toEqual({ kind: "index" });
    expect(store.readLastBoard(agent, { state: oldState, setState: () => {} })).toEqual({ kind: "board", boardId: "old-board" });
    expect(store.readLastBoard({ ...agent, agentId: "another" }, { state: oldState, setState: refused })).toBeUndefined();
    let delayed: unknown;
    const writeDelayed: BoardViewTab["setState"] = next => { delayed = next; };
    store.writeLastBoard(agent, { kind: "index" }, { state: oldState, setState: writeDelayed });
    expect(store.readLastBoard(agent, { state: oldState, setState: writeDelayed })).toEqual({ kind: "index" });
    expect(store.readLastBoard(agent, { state: delayed, setState: writeDelayed })).toEqual({ kind: "index" });
    // Once the host acknowledged our write, a later intentional host change wins.
    expect(store.readLastBoard(agent, { state: oldState, setState: writeDelayed })).toEqual({ kind: "board", boardId: "old-board" });
  });

  it("keeps the exact zero position and follow choice, isolates hosts/Boards/versions, and returns detached values", () => {
    const { db } = storage(), store = createBoardViewStore(db), current = view(0);
    store.writeBoardView("host", "board", current, false);
    current.scrolls[0].y = 999;
    const fresh = createBoardViewStore(db), restored = fresh.readBoardView("host", "board", 2)!;
    expect(restored).toEqual({ view: view(0), follow: false });
    restored.view.scrolls[0].y = 777;
    expect(fresh.readBoardView("host", "board", 2)?.view.scrolls[0].y).toBe(90);
    expect(fresh.readBoardView("other", "board", 2)).toBeUndefined();
    expect(fresh.readBoardView("host", "other", 2)).toBeUndefined();
    expect(fresh.readBoardView("host", "board", 3)).toBeUndefined();
    store.writeBoardView("host", "board", { ...view(), documentVersion: 3 }, true);
    expect(fresh.readBoardView("host", "board", 2)).toBeUndefined();
    expect(fresh.readBoardView("host", "board", 3)?.follow).toBe(true);
  });

  it("rejects corrupt, oversized, mismatched and invalid geometry without touching drafts or throwing", () => {
    const { db, values } = storage();
    values.set("@paseo:board-drafts:private", "leave unchanged");
    for (const raw of ["{", JSON.stringify({ version: 99, records: [] }), "x".repeat(BOARD_VIEW_MAX_BYTES)]) {
      values.set(BOARD_VIEW_STORAGE_KEY, raw);
      expect(createBoardViewStore(db).readBoardView("host", "board", 2)).toBeUndefined();
      expect(values.get(BOARD_VIEW_STORAGE_KEY)).toBe(raw);
    }
    const store = createBoardViewStore(db);
    store.writeBoardView("host", "board", { ...view(), y: Infinity }, true);
    expect(store.readBoardView("host", "board", 2)).toBeUndefined();
    store.writeLastBoard({ ...agent, agentId: undefined }, { kind: "board", boardId: "invalid" });
    expect(store.readLastBoard(agent)).toBeUndefined();
    values.set(BOARD_VIEW_STORAGE_KEY, JSON.stringify({ version: 1, records: [{ kind: "view", hostId: "host", boardId: "board", view: { ...view(), scrolls: [{ selector: "#log", x: NaN, y: 1 }] }, follow: true }] }));
    expect(createBoardViewStore(db).readBoardView("host", "board", 2)).toBeUndefined();
    expect(values.get("@paseo:board-drafts:private")).toBe("leave unchanged");
  });

  it("bounds record count and total bytes, replacing a Board's old view without growing the store", () => {
    const { db, values } = storage(), store = createBoardViewStore(db);
    values.set("unrelated", "preserved");
    for (let n = 0; n <= BOARD_VIEW_MAX_RECORDS; n++) store.writeLastBoard({ ...agent, agentId: "agent-" + n }, { kind: "board", boardId: "board-" + n });
    expect(JSON.parse(values.get(BOARD_VIEW_STORAGE_KEY)!).records).toHaveLength(BOARD_VIEW_MAX_RECORDS);
    expect(store.readLastBoard({ ...agent, agentId: "agent-0" })).toBeUndefined();
    expect(store.readLastBoard({ ...agent, agentId: "agent-64" })).toEqual({ kind: "board", boardId: "board-64" });
    const large = { ...view(), scrolls: Array.from({ length: 24 }, (_, n) => ({ selector: "#" + "a".repeat(400) + n, x: 0, y: 20 })) };
    for (let n = 0; n < BOARD_VIEW_MAX_RECORDS; n++) store.writeBoardView("host", "board-" + n, large, true);
    expect(values.get(BOARD_VIEW_STORAGE_KEY)!.length * 2).toBeLessThanOrEqual(BOARD_VIEW_MAX_BYTES);
    expect(store.readBoardView("host", "board-63", 2)).toEqual({ view: large, follow: true });
    for (let n = 0; n < 20; n++) store.writeBoardView("host", "board-63", view(n), true);
    store.flush();
    expect(JSON.parse(values.get(BOARD_VIEW_STORAGE_KEY)!).records.filter((item: { kind: string; boardId?: string }) => item.kind === "view" && item.boardId === "board-63")).toHaveLength(1);
    expect(values.get("unrelated")).toBe("preserved");
  });

  it("merges independent fresh-store writes and preserves memory during read failures", () => {
    const { db } = storage(), first = createBoardViewStore(db), second = createBoardViewStore(db);
    first.writeBoardView("host", "a", view(1), true);
    second.writeBoardView("host", "b", view(2), false);
    expect(first.readBoardView("host", "b", 2)?.view.y).toBe(2);
    const read = db.getItem;
    db.getItem = () => { throw Error("SecurityError"); };
    first.writeBoardView("host", "a", view(3), false);
    expect(first.readBoardView("host", "a", 2)?.view.y).toBe(3);
    db.getItem = read;
    first.writeLastBoard(agent, { kind: "index" });
    expect(second.readBoardView("host", "a", 2)?.view.y).toBe(3);
    expect(second.readBoardView("host", "b", 2)?.view.y).toBe(2);
  });

  it("coalesces scrolling in memory, flushes the last position on hide/release, and removes lifecycle listeners", () => {
    vi.useFakeTimers();
    const listeners = new Map<string, Set<() => void>>();
    const target = {
      addEventListener(name: string, listener: () => void) { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); },
      removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
    };
    const document = { ...target, hidden: false };
    vi.stubGlobal("window", { ...target, document });
    const { db } = storage(), reads = vi.spyOn(db, "getItem"), writes = vi.spyOn(db, "setItem");
    const external = new Set<(key: string | null) => void>();
    db.subscribe = callback => { external.add(callback); return () => { external.delete(callback); }; };
    const store = createBoardViewStore(db), release = store.retain();
    store.writeBoardView("host", "board", view(1), true);
    expect(writes).toHaveBeenCalledTimes(1);
    const readCount = reads.mock.calls.length;
    for (let n = 2; n <= 40; n++) store.writeBoardView("host", "board", view(n), true);
    expect(store.readBoardView("host", "board", 2)?.view.y).toBe(40);
    expect(reads).toHaveBeenCalledTimes(readCount);
    expect(writes).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(writes).toHaveBeenCalledTimes(2);
    store.writeBoardView("host", "board", view(40), true);
    vi.advanceTimersByTime(500);
    expect(writes).toHaveBeenCalledTimes(2);
    store.writeBoardView("host", "board", view(41), true);
    store.writeBoardView("host", "board", view(42), true);
    document.hidden = true;
    for (const callback of listeners.get("visibilitychange") ?? []) callback();
    expect(createBoardViewStore(db).readBoardView("host", "board", 2)?.view.y).toBe(42);
    document.hidden = false;
    store.writeBoardView("host", "board", view(43), true);
    for (const callback of listeners.get("pagehide") ?? []) callback();
    expect(createBoardViewStore(db).readBoardView("host", "board", 2)?.view.y).toBe(43);
    store.writeBoardView("host", "board", view(44), true);
    release(); release();
    expect(createBoardViewStore(db).readBoardView("host", "board", 2)?.view.y).toBe(44);
    expect(external.size).toBe(0);
    expect([...listeners.values()].every(set => set.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("persists a final position received after the last owner left without waiting for the scroll timer", () => {
    vi.useFakeTimers();
    const { db } = storage(), store = createBoardViewStore(db), release = store.retain();
    store.writeBoardView("host", "board", view(0), false);
    release();
    vi.advanceTimersByTime(30);
    // The detached frame's valid final message arrives after lifecycle cleanup.
    store.writeBoardView("host", "board", view(125), false);
    store.flush();
    expect(createBoardViewStore(db).readBoardView("host", "board", 2)).toEqual({ view: view(125), follow: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconciles external changes only when notified and merges pending local positions into the next flush", () => {
    vi.useFakeTimers();
    const { db, values } = storage(), external = new Set<(key: string | null) => void>();
    db.subscribe = callback => { external.add(callback); return () => { external.delete(callback); }; };
    const store = createBoardViewStore(db), release = store.retain();
    store.writeBoardView("host", "a", view(1), true);
    store.writeBoardView("host", "a", view(2), true);
    const remote = storage(), remoteStore = createBoardViewStore(remote.db);
    remoteStore.writeBoardView("host", "b", view(8), false);
    values.set(BOARD_VIEW_STORAGE_KEY, remote.values.get(BOARD_VIEW_STORAGE_KEY)!);
    for (const callback of external) callback(BOARD_VIEW_STORAGE_KEY);
    expect(store.readBoardView("host", "b", 2)?.view.y).toBe(8);
    expect(store.readBoardView("host", "a", 2)?.view.y).toBe(2);
    vi.advanceTimersByTime(500);
    const fresh = createBoardViewStore(db);
    expect(fresh.readBoardView("host", "a", 2)?.view.y).toBe(2);
    expect(fresh.readBoardView("host", "b", 2)?.view.y).toBe(8);
    release();
    values.set(BOARD_VIEW_STORAGE_KEY, remote.values.get(BOARD_VIEW_STORAGE_KEY)!);
    const leaveAgain = store.retain();
    expect(store.readBoardView("host", "a", 2)).toBeUndefined();
    leaveAgain();
  });
});
