// Host-side "/" forwarding for Boards that use the built-in liquid-glass palette. Pure decisions
// only; client/web.ts owns the DOM listener. Paseo's own shortcuts run in its capture-phase
// window handler and prevent default, so a bubble-phase listener that ignores prevented events,
// every modifier chord and "?" never pre-empts a Paseo binding.

export interface PresetKeyEvent {
  key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean;
  repeat?: boolean; isComposing?: boolean; keyCode?: number; defaultPrevented: boolean; target?: unknown;
}
type ElementLike = {
  tagName?: string; isContentEditable?: boolean; parentElement?: ElementLike | null;
  getAttribute?(name: string): string | null; closest?(selector: string): unknown; contains?(node: unknown): boolean;
};
export interface PresetKeyDocument { activeElement: unknown; body?: unknown; documentElement?: unknown; visibilityState?: string; hidden?: boolean }

// Surfaces that own typing or their own keyboard model (mirrors Paseo's focus scopes).
const BLOCKING_SURFACES = [
  ".xterm", "[data-testid='terminal-surface']", "[data-testid='message-input-root']", "[data-testid^='command-center']",
  "[role='dialog']", "[role='alertdialog']", "[aria-modal='true']", "[role='menu']", "[role='listbox']",
].join(",");
const EDITABLE_ROLES = /^(?:textbox|searchbox|combobox|spinbutton)$/;

function blocks(candidate: unknown): boolean {
  const el = candidate as ElementLike | null | undefined;
  if (!el || typeof el !== "object") return false;
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "IFRAME") return true;
  if (el.isContentEditable) return true;
  if (EDITABLE_ROLES.test(el.getAttribute?.("role") || "")) return true;
  return Boolean(el.closest?.(BLOCKING_SURFACES));
}

/** True only for a bare, unhandled "/" that is not text entry anywhere in the host. */
export function presetKeyIntent(event: PresetKeyEvent, doc: PresetKeyDocument): boolean {
  if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.repeat || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return false;
  if (doc.visibilityState !== undefined ? doc.visibilityState !== "visible" : doc.hidden === true) return false;
  const target = event.target as ElementLike | null | undefined;
  return ![target, target?.parentElement, doc.activeElement].some(blocks);
}

/**
 * Whose "/" this is. Focus inside this Board's own screen root (toolbar, rail, footer) always
 * qualifies. Focus on nothing (body) qualifies only when the Board is the route screen; a
 * Board shown as an agent/workspace panel beside chat or terminals never takes a body "/".
 */
export function presetFocusAllowed(active: unknown, frame: unknown, fromBody: boolean, doc: PresetKeyDocument): boolean {
  if (!active || active === doc.body || active === doc.documentElement) return fromBody;
  const root = (frame as ElementLike | null)?.closest?.("[data-testid=\"board-screen\"]") as ElementLike | null | undefined;
  return Boolean(root && (root === active || root.contains?.(active)));
}
