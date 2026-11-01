// Test-only RN/Paseo view adapter. This keeps actual BoardView/query/frame code under test;
// it is intentionally not evidence of behavior in the native Paseo host.
import { Component, createContext, createElement, useCallback, useContext, useLayoutEffect, useRef } from "react";
// @ts-expect-error ReactDOM is used only by the browser fixture.
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
const global = globalThis as any;
export const Platform = { OS: new URLSearchParams(global.location?.search).has("native-toolbar") ? "ios" : "web" };
// Web fixtures use document.visibilityState; the native import still needs a shape.
export const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
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
// The SDK compact/native Modal.Content escapes the caller's React tree through
// IsolatedBottomSheetModal. It bridges QueryClient/SDK runtime, not plugin-owned
// contexts. A DOM createPortal would incorrectly retain ColorContext and conceal
// the production failure. This isolated root intentionally models that boundary.
const FixtureModalContext = createContext<any>(null);
class FixtureModalBoundary extends Component<any, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  componentDidCatch(error: Error) { (global.fixtureModalErrors ??= []).push(error.message); }
  render() { return this.state.error ? createElement("div", { "data-fixture-modal-error": true }, this.state.error) : this.props.children; }
}
export function Modal({ open, title, children, onOpenChange }: any) {
  return createElement(FixtureModalContext.Provider, { value: { open, title, onOpenChange } }, children);
}
Modal.Content = function FixtureModalContent({ children }: any) {
  const modal = useContext(FixtureModalContext), query = useQueryClient();
  const root = useRef<any>(null);
  useLayoutEffect(() => {
    if (!modal.open) return;
    const node = global.document.createElement("div"); node.dataset.fixtureModalRoot = "isolated";
    global.document.body.appendChild(node); root.current = createRoot(node);
    return () => { const previous = root.current; root.current = null; global.queueMicrotask(() => { previous.unmount(); node.remove(); }); };
  }, [modal.open]);
  useLayoutEffect(() => {
    if (!root.current || !modal.open) return;
    root.current.render(createElement(QueryClientProvider, { client: query }, createElement(FixtureModalBoundary, null,
      createElement("div", { role: "dialog", "data-fixture-modal": true, "aria-label": modal.title, style: { position: "fixed", inset: 50, zIndex: 100, background: "white", border: "1px solid black", padding: 20, overflow: "auto", font: "14px system-ui" } },
        createElement("button", { onClick: () => modal.onOpenChange(false), "aria-label": "关闭窗口" }, "关闭"), children))));
  }, [modal.open, modal.title, modal.onOpenChange, children, query]);
  return null;
};
export function defineRpc(config: any) { return config; }
export function usePaseo() { return { agents: { list: async () => ({ entries: [] }) } }; }
export function useRpc(definition: any) { return useCallback((input: any) => global.hostFixture.rpc(definition.name, input), [definition.name]); }
export async function openExternalUrl(url: string) { global.hostFixture.links.push(url); }
