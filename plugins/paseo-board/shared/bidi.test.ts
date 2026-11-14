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
  it("refuses public replies that contain them", () => {
    for (const text of ["谢谢 ‮evil", "⁧x⁩"]) expect(() => normalizeReplyText(text)).toThrow("回复需要 1–2000 字的纯文本。");
    expect(normalizeReplyText("مرحبا ‏ ok")).toBe("مرحبا ‏ ok");
  });
});
