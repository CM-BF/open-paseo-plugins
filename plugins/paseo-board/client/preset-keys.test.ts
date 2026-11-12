import { describe, expect, it } from "vitest";
import { presetFocusAllowed, presetKeyIntent, type PresetKeyEvent } from "./preset-keys";

type Fake = { tagName: string; isContentEditable?: boolean; role?: string; within?: string[]; parentElement?: Fake | null; getAttribute(name: string): string | null; closest(selector: string): unknown; contains?(node: unknown): boolean };
// Structural element: `within` lists the blocking-surface selector fragments it sits inside.
const el = (tagName: string, options: { editable?: boolean; role?: string; within?: string[] } = {}): Fake => ({
  tagName, isContentEditable: options.editable, parentElement: null,
  getAttribute: name => (name === "role" ? options.role ?? null : null),
  closest: selector => ((options.within ?? []).some(part => selector.includes(part)) ? {} : null),
});
const body = el("BODY");
const doc = (activeElement: unknown = body, visibilityState = "visible") => ({ activeElement, body, documentElement: el("HTML"), visibilityState });
const key = (fields: Partial<PresetKeyEvent> = {}): PresetKeyEvent => ({ key: "/", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, target: body, ...fields });

describe("liquid-glass '/' forwarding intent", () => {
  it("accepts a bare slash from the body or a focused host button", () => {
    expect(presetKeyIntent(key(), doc())).toBe(true);
    const button = el("BUTTON");
    expect(presetKeyIntent(key({ target: button }), doc(button))).toBe(true);
  });
  it("accepts the slash key as 「、」 or 「／」 from a Chinese IME in punctuation mode", () => {
    expect(presetKeyIntent(key({ key: "、", code: "Slash" }), doc())).toBe(true);
    expect(presetKeyIntent(key({ key: "／", code: "Slash" }), doc())).toBe(true);
    // Only from the slash key, and never while composing.
    expect(presetKeyIntent(key({ key: "、", code: "Comma" }), doc())).toBe(false);
    expect(presetKeyIntent(key({ key: "、", code: "Slash", isComposing: true }), doc())).toBe(false);
    expect(presetKeyIntent(key({ key: "、", code: "Slash", target: el("INPUT") }), doc(el("INPUT")))).toBe(false);
  });
  it("never takes chords, '?', repeats, IME, handled keys or hidden pages", () => {
    for (const fields of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { key: "?" }, { key: "k", metaKey: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
      expect(presetKeyIntent(key(fields), doc()), JSON.stringify(fields)).toBe(false);
    }
    expect(presetKeyIntent(key(), doc(body, "hidden"))).toBe(false);
  });
  it("never takes text entry or surfaces that own the keyboard", () => {
    const blocked = [
      el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", { editable: true }), el("DIV", { role: "textbox" }), el("DIV", { role: "searchbox" }), el("DIV", { role: "combobox" }),
      el("IFRAME"), el("DIV", { within: [".xterm"] }), el("DIV", { within: ["terminal-surface"] }), el("DIV", { within: ["message-input-root"] }),
      el("BUTTON", { within: ["command-center"] }), el("BUTTON", { within: ["role='dialog'"] }), el("LI", { within: ["role='menu'"] }), el("LI", { within: ["role='listbox'"] }), el("BUTTON", { within: ["aria-modal"] }),
    ];
    for (const target of blocked) expect(presetKeyIntent(key({ target }), doc(target)), `${target.tagName} ${target.role ?? ""}`).toBe(false);
    // Also when only the focused element (not the event target) is editable.
    expect(presetKeyIntent(key(), doc(el("INPUT")))).toBe(false);
  });
});

describe("liquid-glass '/' forwarding scope", () => {
  const button = el("BUTTON"), outside = el("BUTTON");
  const root = { contains: (node: unknown) => node === button };
  const frame = { closest: (selector: string) => (selector.includes("board-screen") ? root : null) };
  it("follows focus inside this Board's own screen root", () => {
    expect(presetFocusAllowed(button, frame, false, doc(button))).toBe(true);
    expect(presetFocusAllowed(outside, frame, true, doc(outside))).toBe(false);
  });
  it("takes a body-level '/' only for the route screen", () => {
    expect(presetFocusAllowed(body, frame, true, doc())).toBe(true);
    expect(presetFocusAllowed(null, frame, true, doc(null))).toBe(true);
    expect(presetFocusAllowed(body, frame, false, doc())).toBe(false);
  });
  it("takes focus left on Paseo's Boards sidebar row only for the route screen", () => {
    const row = { ...el("DIV", { role: "button" }), closest: (selector: string) => (selector.includes("plugin-sidebar-paseo-board-boards") ? {} : null) };
    const otherRow = { ...el("DIV", { role: "button" }), closest: (selector: string) => (selector.includes("plugin-sidebar-other-plugin") ? {} : null) };
    expect(presetFocusAllowed(row, frame, true, doc(row))).toBe(true);
    expect(presetFocusAllowed(row, frame, false, doc(row))).toBe(false);
    expect(presetFocusAllowed(otherRow, frame, true, doc(otherRow))).toBe(false);
  });
  it("refuses frames outside any Board screen root", () => {
    expect(presetFocusAllowed(button, { closest: () => null }, true, doc(button))).toBe(false);
  });
});
