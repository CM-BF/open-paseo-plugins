import { describe, expect, it } from "vitest";
import type { Interaction } from "../shared/contracts";
import type { DraftStorage } from "./draft-store";
import { createSideContextStore, SIDE_CONTEXT_PREFIX, sideContextKey, sideProvenance } from "./side-context";

function memory() {
  const data = new Map<string, string>();
  const storage: DraftStorage = { get length() { return data.size; }, key: index => [...data.keys()][index] ?? null, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
  return { data, storage };
}
const history = (overrides: Partial<NonNullable<Interaction["inheritedHistory"]>> = {}): NonNullable<Interaction["inheritedHistory"]> => ({
  sourceAgentId: "owner", capturedAt: "2026-11-11T00:00:00.000Z", messages: 42, entries: 60, omitted: false, ownerBusy: false, chars: 9000, digest: "a".repeat(64), state: "sent", ...overrides,
});
const fork = (overrides: Partial<Interaction> = {}): Interaction => ({ id: "fork", kind: "fork", text: "Q", status: "delivered", resultReferences: [], createdAt: "now", updatedAt: "now", sideContext: "owner-history", ...overrides });

describe("new-Side choice preference", () => {
  it("defaults to blank and remembers only the history choice per host and Board", () => {
    const { data, storage } = memory();
    const board = createSideContextStore({ hostId: "host", boardId: "board" }, storage);
    expect(board.read()).toBe("blank");
    board.write("owner-history");
    expect(createSideContextStore({ hostId: "host", boardId: "board" }, storage).read()).toBe("owner-history");
    expect(createSideContextStore({ hostId: "host", boardId: "other" }, storage).read()).toBe("blank");
    expect(createSideContextStore({ hostId: "other-host", boardId: "board" }, storage).read()).toBe("blank");
    expect([...data.keys()]).toEqual([`${SIDE_CONTEXT_PREFIX}["host","board"]`]);
    expect(JSON.parse(data.get(sideContextKey("host", "board"))!)).toEqual({ v: 1, choice: "owner-history" });
    board.write("blank");
    expect(data.size).toBe(0); expect(board.read()).toBe("blank");
  });

  it("reads corrupt or unknown records as blank without throwing", () => {
    const { data, storage } = memory(), key = sideContextKey("host", "corrupt");
    for (const raw of ["{not json", JSON.stringify({ v: 2, choice: "owner-history" }), JSON.stringify({ v: 1, choice: "fork-everything" }), "null"]) {
      data.set(key, raw);
      expect(createSideContextStore({ hostId: "host", boardId: "corrupt" }, storage).read()).toBe("blank");
    }
  });

  it("keeps the visible choice in memory when storage is unavailable or refuses writes", () => {
    const missing = createSideContextStore({ hostId: "hermes", boardId: "board" }, null);
    expect(missing.read()).toBe("blank"); missing.write("owner-history"); expect(missing.read()).toBe("owner-history");
    missing.write("blank"); expect(missing.read()).toBe("blank");
    const { storage } = memory();
    const failing: DraftStorage = { ...storage, getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("quota"); } };
    const store = createSideContextStore({ hostId: "host", boardId: "quota" }, failing);
    expect(store.read()).toBe("blank"); store.write("owner-history"); expect(store.read()).toBe("owner-history");
  });
});

describe("Side provenance", () => {
  it("claims history only for Sides created with it and reflects the first-send outcome", () => {
    expect(sideProvenance(fork({ sideContext: undefined }))).toBeUndefined();
    expect(sideProvenance(fork({ sideContext: "blank" }))).toBeUndefined();
    expect(sideProvenance(fork({ kind: "reply" }))).toBeUndefined();
    expect(sideProvenance(fork())).toBe("带主 agent 记录 · 读取中");
    expect(sideProvenance(fork({ status: "failed" }))).toBe("带主 agent 记录 · 未建立（没有创建 Side）");
    expect(sideProvenance(fork({ inheritedHistory: history() }))).toBe("带主 agent 记录 · 42 条消息");
    expect(sideProvenance(fork({ inheritedHistory: history({ omitted: true }) }))).toBe("带主 agent 记录 · 最近 42 条消息 · 更早的未带上");
    expect(sideProvenance(fork({ inheritedHistory: history({ entries: 0, messages: 0 }) }))).toBe("带主 agent 记录 · 主 agent 暂无可带的记录");
    expect(sideProvenance(fork({ inheritedHistory: history({ ownerBusy: true }) }))).toBe("带主 agent 记录 · 42 条消息 · 含主 agent 进行中的一轮");
    expect(sideProvenance(fork({ inheritedHistory: history({ state: "frozen" }) }))).toBe("带主 agent 记录 · 42 条消息 · 待送达");
    expect(sideProvenance(fork({ inheritedHistory: history({ state: "uncertain" }) }))).toBe("带主 agent 记录 · 42 条消息 · 未确认送达（这个 Side 可能没有拿到记录）");
    expect(sideProvenance(fork({ inheritedHistory: history({ state: "not_sent" }) }))).toBe("带主 agent 记录 · 42 条消息 · 未送达（这个 Side 没有拿到记录）");
  });
});
