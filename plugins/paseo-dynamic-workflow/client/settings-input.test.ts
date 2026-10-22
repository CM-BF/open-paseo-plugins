import { describe, expect, it } from "vitest";
import { parseInteger } from "./settings-input";

describe("settings numeric drafts", () => {
  it("rejects unfinished and out-of-range drafts without treating blank as zero", () => {
    expect(parseInteger("", 0, 16)).toBeNull();
    expect(parseInteger(" ", 0, 16)).toBeNull();
    expect(parseInteger("20", 0, 16)).toBeNull();
    expect(parseInteger("1.5", 0, 16)).toBeNull();
    expect(parseInteger("0", 0, 16)).toBe(0);
    expect(parseInteger("12", 0, 16)).toBe(12);
    expect(parseInteger("1000", 1, 1000)).toBe(1000);
  });
});
