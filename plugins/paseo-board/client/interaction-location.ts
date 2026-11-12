import type { Anchor } from "../shared/contracts";
import type { InteractionLocation } from "../shared/frame-contract";

/** Shown above a discussion started for the whole canvas: toolbar 发消息, `board.ask` without a reference, or a legacy item with no reference. */
export const WHOLE_CANVAS_NOTE = "针对整个画布";
const LOCATION_NOTES: Record<Exclude<InteractionLocation, "component">, string> = {
  collapsed: "组件当前不可见 · 标记跟随可见外层",
  ancestor: "原内容不可见 · 标记暂随可见外层",
  hidden: "组件当前隐藏 · 可从侧栏请求定位",
  snapshot: "未定位到当前组件 · 可查看原始引用",
};

/**
 * The note above the selected discussion, from the frame's marker location. A whole-canvas reference never pointed
 * at a component, so the frame's `snapshot` fallback for it is not a failure and must not read like one.
 */
export function interactionLocationNote(location: InteractionLocation, anchor: Pick<Anchor, "kind"> | undefined): string | undefined {
  if (location === "component") return undefined;
  if (location === "snapshot" && (!anchor || anchor.kind === "board")) return WHOLE_CANVAS_NOTE;
  return LOCATION_NOTES[location];
}
