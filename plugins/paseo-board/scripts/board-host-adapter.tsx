// Test-only RN/Paseo view adapter. This keeps actual BoardView/query/frame code under test;
// it is intentionally not evidence of behavior in the native Paseo host.
import { createElement, useCallback, useLayoutEffect, useRef } from "react";
const global = globalThis as any;
export const Platform = { OS: "web" };
function styles(value: any): any {
  const source = typeof value === "function" ? value({ pressed: false }) : Array.isArray(value) ? Object.assign({}, ...value) : value;
  const next = { ...source };
  if (typeof next.lineHeight === "number") next.lineHeight = `${next.lineHeight}px`;
  for (const [name, axis] of [["paddingHorizontal", ["paddingLeft", "paddingRight"]], ["paddingVertical", ["paddingTop", "paddingBottom"]], ["marginHorizontal", ["marginLeft", "marginRight"]], ["marginVertical", ["marginTop", "marginBottom"]]] as any) {
    if (next[name] !== undefined) { for (const property of axis) next[property] = next[name]; delete next[name]; }
  }
  for (const name of ["shadowColor", "shadowOffset", "shadowOpacity", "shadowRadius", "elevation", "textAlignVertical"]) delete next[name];
  if (Object.keys(next).some(name => /^border.*Width$/.test(name))) next.borderStyle = "solid";
  return next;
}
function element(tag: string, props: any, defaults: any = {}) {
  const { children, style, onLayout, onPress, accessibilityLabel, accessibilityRole, accessibilityState, testID, numberOfLines, selectable, resizeMode, source, contentContainerStyle, onChangeText, editable, multiline, placeholderTextColor, ...rest } = props;
  const ref = useRef<any>(null);
  const callback = useRef(onLayout); callback.current = onLayout;
  useLayoutEffect(() => {
    if (!onLayout || !ref.current) return;
    const fire = () => { const rect = ref.current.getBoundingClientRect(); callback.current?.({ nativeEvent: { layout: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } }); };
    const observer = new global.ResizeObserver(fire); observer.observe(ref.current); fire(); return () => observer.disconnect();
  }, [!!onLayout]);
  const next: any = { ...rest, ref, style: { ...defaults, ...styles(style) }, "data-testid": testID, "aria-label": accessibilityLabel, role: accessibilityRole, onClick: onPress };
  if (accessibilityState) { next["aria-disabled"] = accessibilityState.disabled; next["aria-selected"] = accessibilityState.selected; }
  if (onChangeText) next.onChange = (event: any) => onChangeText(event.target.value);
  if (editable === false) next.disabled = true;
  if (tag === "img") { next.src = source?.uri; return createElement(tag, next); }
  if (numberOfLines === 1) Object.assign(next.style, { overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" });
  return createElement(tag, next, contentContainerStyle ? createElement("div", { style: { display: "flex", flexDirection: "column", ...styles(contentContainerStyle) } }, children) : children);
}
export function View(props: any) { return element("div", props, { display: "flex", flexDirection: "column", position: "relative", boxSizing: "border-box", minWidth: 0, flexShrink: 0 }); }
export function Text(props: any) { return element("span", props, { boxSizing: "border-box", whiteSpace: "pre-wrap" }); }
export function Pressable(props: any) { return element("button", props, { display: "flex", boxSizing: "border-box", font: "inherit", cursor: "pointer" }); }
export function Image(props: any) { return element("img", props, { objectFit: "contain" }); }
export function ScrollView(props: any) { return element("div", props, { overflow: "auto", minHeight: 0 }); }
export function TextInput(props: any) { return element(props.multiline ? "textarea" : "input", props); }
export function Markdown({ children }: any) { return createElement("div", { "data-fixture-markdown": true, style: { whiteSpace: "pre-wrap" } }, children); }
export function Icon() { return null; }
export function Modal({ open, title, children, onOpenChange }: any) {
  if (!open) return null;
  return createElement("div", { role: "dialog", "data-fixture-modal": true, "aria-label": title, style: { position: "fixed", inset: 50, zIndex: 100, background: "white", border: "1px solid black", padding: 20, overflow: "auto" } }, createElement("button", { onClick: () => onOpenChange(false), "aria-label": "关闭窗口" }, "关闭"), children);
}
Modal.Content = ({ children }: any) => createElement("div", null, children);
export function defineRpc(config: any) { return config; }
export function usePaseo() { return { agents: { list: async () => ({ entries: [] }) } }; }
export function useRpc(definition: any) { return useCallback((input: any) => global.hostFixture.rpc(definition.name, input), [definition.name]); }
export async function openExternalUrl(url: string) { global.hostFixture.links.push(url); }
