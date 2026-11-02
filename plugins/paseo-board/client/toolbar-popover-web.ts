// Guarded browser-only behavior. Native menus use the host's Modal instead.
import { useLayoutEffect, useRef, useState } from "react";
type Event = { isTrusted?: boolean; key?: string; keyCode?: number; isComposing?: boolean; defaultPrevented?: boolean; target?: { closest?(selector: string): unknown }; preventDefault?(): void; stopPropagation?(): void };
const runtime = globalThis as unknown as {
  window?: { innerHeight: number; addEventListener(name: string, callback: (event: Event) => void, capture?: boolean): void; removeEventListener(name: string, callback: (event: Event) => void, capture?: boolean): void };
  document?: { activeElement?: { tagName?: string }; querySelector(selector: string): { getBoundingClientRect(): { bottom: number } } | null };
};
export function useToolbarPopover(open: boolean, onClose: () => void, containerId: string): number {
  const close = useRef(onClose); close.current = onClose;
  const [height, setHeight] = useState(360);
  useLayoutEffect(() => {
    const browser = runtime.window, page = runtime.document;
    if (!open || !browser || !page) return;
    let active = true;
    let composing = false, compositionEnded = 0;
    const selector = `[data-testid="${containerId}"]`;
    const measure = () => {
      const bottom = page.querySelector(selector)?.getBoundingClientRect().bottom ?? 48;
      setHeight(Math.max(96, Math.min(460, browser.innerHeight - bottom - 12)));
    };
    const pointer = (event: Event) => { if (event.isTrusted && !event.target?.closest?.(selector)) close.current(); };
    const compositionStart = () => { composing = true; };
    const compositionEnd = () => { composing = false; compositionEnded = Date.now(); };
    const key = (event: Event) => {
      if (composing || event.isComposing || event.keyCode === 229 || Date.now() - compositionEnded < 50) return;
      if (event.isTrusted && !event.defaultPrevented && event.key === "Escape") { event.preventDefault?.(); event.stopPropagation?.(); close.current(); }
    };
    const blur = () => { setTimeout(() => { if (active && page.activeElement?.tagName === "IFRAME") close.current(); }, 0); };
    measure(); browser.addEventListener("resize", measure); browser.addEventListener("pointerdown", pointer, true);
    browser.addEventListener("keydown", key); browser.addEventListener("blur", blur);
    browser.addEventListener("compositionstart", compositionStart); browser.addEventListener("compositionend", compositionEnd);
    return () => { active = false; browser.removeEventListener("resize", measure); browser.removeEventListener("pointerdown", pointer, true); browser.removeEventListener("keydown", key); browser.removeEventListener("blur", blur); browser.removeEventListener("compositionstart", compositionStart); browser.removeEventListener("compositionend", compositionEnd); };
  }, [open, containerId]);
  return height;
}
