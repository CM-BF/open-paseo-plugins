import { describe, expect, it } from "vitest";
import { interactionLocationNote, WHOLE_CANVAS_NOTE } from "./interaction-location";

describe("discussion location note", () => {
  it("is neutral for a whole-canvas reference instead of reporting a component that was never referenced", () => {
    // Toolbar 发消息 (and board.ask without a reference) send { kind: "board" } without a position; the frame reports "snapshot" for it.
    expect(interactionLocationNote("snapshot", { kind: "board" })).toBe(WHOLE_CANVAS_NOTE);
    expect(interactionLocationNote("snapshot", undefined)).toBe(WHOLE_CANVAS_NOTE);
    expect(WHOLE_CANVAS_NOTE).not.toMatch(/未定位|失败|找不到/);
  });

  it("keeps the existing notes for references to specific content", () => {
    expect(interactionLocationNote("snapshot", { kind: "text" })).toBe("未定位到当前组件 · 可查看原始引用");
    expect(interactionLocationNote("snapshot", { kind: "element" })).toBe("未定位到当前组件 · 可查看原始引用");
    expect(interactionLocationNote("collapsed", { kind: "element" })).toBe("组件当前不可见 · 标记跟随可见外层");
    expect(interactionLocationNote("ancestor", { kind: "text" })).toBe("原内容不可见 · 标记暂随可见外层");
    expect(interactionLocationNote("hidden", { kind: "region" })).toBe("组件当前隐藏 · 可从侧栏请求定位");
    expect(interactionLocationNote("component", { kind: "point" })).toBeUndefined();
    expect(interactionLocationNote("component", { kind: "board" })).toBeUndefined();
  });
});
