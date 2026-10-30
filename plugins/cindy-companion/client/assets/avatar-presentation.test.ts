import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { avatarPresentation } from "./avatar-presentation";

describe("original Cindy avatar presentation", () => {
  it.each([
    ["cindy", "12923c15beac4d20e2e12135e71cd2054e99c7aa3327645f0e042373e631dbcd"],
    ["dash", "84360ff6981153c097b267675066dd3bb54f82d1eaf7a8280dc4a72bf0d7d9d7"],
    ["lizi", "3cfec87963fa30d5faefa9986e78bfc7821c1d970f4f2061b1380f546de462f6"],
  ])("preserves the original %s PNG bytes", (name, hash) => {
    const result = avatarPresentation({ avatar: ` CINDY://AVATAR/PRESET/${name.toUpperCase()} ` }, "dark");
    expect(result.uri).toMatch(/^data:image\/png;base64,/);
    const bytes = Buffer.from(result.uri!.split(",")[1], "base64");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
  });
  it("keeps gallery uploads and single graphemes; invalid avatars fall back to a whole name grapheme", () => {
    const upload = "data:image/png;base64,aGVsbG8=";
    expect(avatarPresentation({ avatar: upload }, "dark").uri).toBe(upload);
    expect(avatarPresentation({ avatar: "🌸" }, "dark").glyph).toBe("🌸");
    expect(avatarPresentation({ avatar: "cindy://avatar/unknown", name: "🧑🏽‍💻 Alex" }, "dark").glyph).toBe("🧑🏽‍💻");
    expect(avatarPresentation({ avatar: "many letters", name: "cindy" }, "dark").glyph).toBe("C");
  });
  it("uses the original appearance-specific hue tokens", () => {
    expect(avatarPresentation({ avatarColor: "violet" }, "dark").backgroundColor).toBe("#322b48");
    expect(avatarPresentation({ avatarColor: "violet" }, "light").backgroundColor).toBe("#e3ddf3");
  });
});
