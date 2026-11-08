import { describe, expect, it } from "vitest";
import { messageShortcut } from "./message-shortcuts";

describe("message shortcut destinations", () => {
  const key = (modifiers: number, name = "Enter") => messageShortcut({ key: name, altKey: Boolean(modifiers & 1), ctrlKey: Boolean(modifiers & 2), metaKey: Boolean(modifiers & 4), shiftKey: Boolean(modifiers & 8) });
  it("stages Enter, preserves newline, and routes explicit send chords", () => {
    expect(key(0)).toBe("stage");
    expect(key(8)).toBeNull();
    expect(key(1)).toBe("side");
    expect(key(9)).toBe("new-side");
    expect(key(2)).toBe("main");
    expect(key(4)).toBe("main");
  });
  it("does not send for the retired Side chords or command-shift text editing", () => {
    for (const modifiers of [3, 5, 7, 10, 11, 12, 13, 14, 15]) expect(key(modifiers)).toBeNull();
    expect(key(0, "Escape")).toBeNull();
    expect(key(4, "a")).toBeNull();
  });
});
