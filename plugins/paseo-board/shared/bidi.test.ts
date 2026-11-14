import { describe, expect, it } from "vitest";
import { BIDI_CONTROL, showBidiControls } from "./bidi";
import { normalizeReplyText } from "../server/inbox-sync";

describe("bidi controls in visitor text and replies", () => {
  it("shows embedding, override and isolate controls as visible markers and leaves other text alone", () => {
    expect(showBidiControls("第二行 ‮evil‬")).toBe("第二行 [U+202E]evil[U+202C]");
    expect(showBidiControls("⁦a⁩ ‪b‭")).toBe("[U+2066]a[U+2069] [U+202A]b[U+202D]");
    // Directional marks and zero-width characters are shown too (public-threads §12 A5); ordinary RTL text is unchanged.
    expect(showBidiControls("مرحبا ‏ שלום 你好")).toBe("مرحبا [U+200F] שלום 你好");
    expect(showBidiControls("a​b⁠c﻿d؜e‎")).toBe("a[U+200B]b[U+2060]c[U+FEFF]d[U+061C]e[U+200E]");
    expect(showBidiControls("مرحبا שלום")).toBe("مرحبا שלום");
    expect(BIDI_CONTROL.test("plain")).toBe(false);
  });
  it("shows every invisible format character, tag-character text and variation-selector runs, but keeps emoji and ideograph variants (review fix)", () => {
    const hidden = ["\u2061", "\u2062", "\u2064", "\u206A", "\u00AD", "\u180E", "\u034F", "\u3164", "\uFFA0", "\u115F", "\u{E0041}", "\u{E0001}", "\u{1D173}", "\u{1BCA0}", "\uFFF9"];
    for (const char of hidden) expect(showBidiControls(`a${char}b`), char.codePointAt(0)!.toString(16)).toBe(`a[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]b`);
    // "IGNORE ALL" spelled in tag characters becomes visible, character by character.
    const smuggled = Array.from("IGNORE", c => String.fromCodePoint(0xE0000 + c.charCodeAt(0))).join("");
    expect(showBidiControls(`好${smuggled}`)).toBe("好[U+E0049][U+E0047][U+E004E][U+E004F][U+E0052][U+E0045]");
    expect(showBidiControls("x\uFE00\uFE01\u{E0100}y")).toBe("x[U+FE00][U+FE01][U+E0100]y");
    for (const text of ["❤️ 很好", "葛\u{E0100}城", "👍🏽", "家庭 👨‍👩‍👧".replace(/\u200D/g, "")]) expect(showBidiControls(text)).toBe(text);
  });
  it("refuses public replies that contain them", () => {
    for (const text of ["谢谢 ‮evil", "⁧x⁩"]) expect(() => normalizeReplyText(text)).toThrow("回复需要 1–2000 字的纯文本。");
    expect(normalizeReplyText("مرحبا ‏ ok")).toBe("مرحبا ‏ ok");
  });
});
