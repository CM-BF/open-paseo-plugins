import { describe, expect, it } from "vitest";
import type { LiveMark } from "../shared/live-data";
import { addLiveMark, liveFields, liveIsArray, liveIsLoopback, liveMarksKey, liveMarksNarrowed, liveMayGrowKeys, liveNeedsSubtree, liveReleasable, liveSummary, liveValueAt, liveWithheldText, overlappingLiveMark, publicDataAtLivePaths, removeLiveMark, setLiveMarkSubtree, sharePageOrigins, LIVE_RUNTIME_OUTDATED } from "./live-status";

const live = (state: string) => ({ channel: null, status: { state, seq: 0, attempts: 0, withheld: [] } }) as unknown as Parameters<typeof liveSummary>[0];
const mark = (path: string, subtree = false): LiveMark => ({ path, subtree });

describe("liveSummary", () => {
  it("raises attention only for states the owner has to act on", () => {
    expect(liveSummary(live("blocked")).attention).toBe(true);
    expect(liveSummary(live("retrying")).attention).toBe(true);
    for (const state of ["off", "pending", "syncing", "live", "paused", "too-large", "revoking", "revoked"]) expect(liveSummary(live(state)).attention).toBe(false);
    expect(liveSummary()).toEqual({ attention: false, detail: "把勾选的字段实时公开到分享页" });
  });
  it("only a ready or paused channel can back a release", () => {
    const channel = (state: string) => ({ state }) as never;
    expect(liveReleasable(channel("ready"))).toBe(true); expect(liveReleasable(channel("paused"))).toBe(true);
    for (const state of ["pending", "blocked", "revoking", "revoked"]) expect(liveReleasable(channel(state))).toBe(false);
    expect(liveReleasable(null)).toBe(false);
  });
  it("names withheld reasons for the owner", () => {
    expect(liveWithheldText({ path: "/a", reason: "absent" })).toContain("不存在");
    expect(liveWithheldText({ path: "/a", reason: "object-without-subtree" })).toContain("包含以后新增的字段");
    expect(liveWithheldText({ path: "/a", reason: "non-object-parent" })).toContain("上级不是对象");
  });
});

describe("field tree and marks", () => {
  const data = { a: { "b/c": 1, "d~e": "x" }, list: [{ id: 1 }], plain: [1, [2]], "__proto__x": 2, n: null };
  it("walks objects, keeps arrays whole and escapes pointer segments", () => {
    const { fields, truncated } = liveFields(data);
    expect(truncated).toBe(false);
    expect(fields.map(field => field.path)).toEqual(["/a", "/a/b~1c", "/a/d~0e", "/list", "/plain", "/__proto__x", "/n"]);
    expect(fields.find(field => field.path === "/list")).toMatchObject({ kind: "array", depth: 0 });
    expect(fields.find(field => field.path === "/a/b~1c")).toMatchObject({ depth: 1, kind: "value", summary: "1" });
  });
  it("marks a large tree as truncated instead of rendering it all", () => {
    const big = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`k${index}`, index]));
    const { fields, truncated } = liveFields(big);
    expect(fields).toHaveLength(300); expect(truncated).toBe(true);
    expect(liveFields(["root array"]).fields).toEqual([]);
  });
  it("resolves paths through objects only, like the server projection", () => {
    expect(liveValueAt(data, "/a/b~1c")).toEqual({ found: true, value: 1 });
    expect(liveValueAt(data, "/list/0")).toEqual({ found: false });
    expect(liveValueAt(data, "/missing")).toEqual({ found: false });
  });
  it("requires the subtree tick exactly where the server would withhold", () => {
    expect(liveNeedsSubtree(data, mark("/a"))).toBe(true);
    expect(liveNeedsSubtree(data, mark("/list"))).toBe(true);
    expect(liveNeedsSubtree(data, mark("/plain"))).toBe(false);
    expect(liveNeedsSubtree(data, mark("/n"))).toBe(false);
    expect(liveNeedsSubtree(data, mark("/a", true))).toBe(false);
    expect(liveNeedsSubtree(data, mark("/missing"))).toBe(false);
    expect(liveMayGrowKeys(data, mark("/n"))).toBe(false);
    expect(liveMayGrowKeys(data, mark("/missing"))).toBe(true);
    expect(liveIsArray(data, "/plain")).toBe(true); expect(liveIsArray(data, "/a")).toBe(false);
  });
  it("refuses overlapping, invalid and excess paths with a reason", () => {
    expect(addLiveMark([mark("/a/b")], "/a")).toContain("重叠");
    expect(addLiveMark([mark("/a")], "/a/b")).toContain("重叠");
    expect(addLiveMark([], "no-slash")).toContain("JSON Pointer");
    expect(addLiveMark([], "/__proto__")).toContain("JSON Pointer");
    expect(addLiveMark(Array.from({ length: 32 }, (_, index) => mark(`/k${index}`)), "/next")).toContain("32");
    expect(addLiveMark([mark("/a")], "/b")).toEqual([mark("/a"), mark("/b")]);
    expect(addLiveMark([mark("/a")], "/a")).toEqual([mark("/a")]);
  });
  it("reports overlap, edits subtree and detects narrowing", () => {
    expect(overlappingLiveMark([mark("/a")], "/a/b")).toBe("/a");
    expect(overlappingLiveMark([mark("/a/b")], "/a")).toBe("/a/b");
    expect(overlappingLiveMark([mark("/ab")], "/a")).toBeUndefined();
    expect(setLiveMarkSubtree([mark("/a")], "/a", true)).toEqual([mark("/a", true)]);
    expect(removeLiveMark([mark("/a"), mark("/b")], "/a")).toEqual([mark("/b")]);
    expect(liveMarksNarrowed([mark("/a"), mark("/b")], [mark("/a")])).toBe(true);
    expect(liveMarksNarrowed([mark("/a")], [mark("/a"), mark("/b")])).toBe(false);
    expect(liveMarksKey([mark("/b"), mark("/a")])).toBe(liveMarksKey([mark("/a"), mark("/b")]));
  });
});

describe("page origins and frozen public data", () => {
  it("extracts exact, deduplicated, valid origins from share links", () => {
    expect(sharePageOrigins(["https://x.github.io/site/a/", "https://x.github.io/other", undefined, "http://evil.example/page", "not a url"])).toEqual(["https://x.github.io"]);
    expect(sharePageOrigins(Array.from({ length: 12 }, (_, index) => `https://s${index}.example/p`))).toHaveLength(8);
  });
  it("detects frozen values at live paths and tolerates invalid JSON", () => {
    expect(publicDataAtLivePaths('{"live":{"x":1}}', ["/live/x"])).toBe(true);
    expect(publicDataAtLivePaths('{"live":{}}', ["/live/x"])).toBe(false);
    expect(publicDataAtLivePaths("not json", ["/live/x"])).toBe(false);
  });
  it("recognises loopback origins and tolerates a bad value", () => {
    expect(liveIsLoopback("http://127.0.0.1:8787")).toBe(true);
    expect(liveIsLoopback("https://api.example.com")).toBe(false);
    expect(liveIsLoopback("garbage")).toBe(false);
    expect(LIVE_RUNTIME_OUTDATED).toBe(-1);
  });
});
