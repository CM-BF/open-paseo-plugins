import { describe, expect, it } from "vitest";
import { elapsed, formatDuration, formatTokens } from "./format";

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(4_200)).toBe("4s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(3_726_000)).toBe("1h 02m");
  });

  it("formats tokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(3_375)).toBe("3.4k");
    expect(formatTokens(48_000)).toBe("48k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });

  it("measures elapsed time up to now while running", () => {
    expect(elapsed("2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z", 0)).toBe("30s");
    expect(elapsed("2026-01-01T00:00:00Z", null, Date.parse("2026-01-01T00:02:00Z"))).toBe("2m 00s");
    expect(elapsed(null, null, 0)).toBeNull();
  });
});
