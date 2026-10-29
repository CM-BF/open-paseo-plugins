import { describe, expect, it } from "vitest";
import { readFrameEvent } from "./frame-protocol";

describe("settings frame bridge", () => {
  it("rejects unrelated frames, malformed requests and unbounded payloads", () => {
    expect(readFrameEvent({ channel: "other", type: "close" })).toBeNull();
    expect(readFrameEvent({ channel: "cindy-companion", type: "request", id: "", op: "profile.update" })).toBeNull();
    expect(readFrameEvent({ channel: "cindy-companion", type: "request", id: "1", op: "profile.update", args: "x".repeat(2 * 1024 * 1024) })).toBeNull();
  });
  it("passes original settings operations without changing their data", () => {
    const request = { channel: "cindy-companion", type: "request", id: "save-1", op: "profile.update", args: { identitySource: "你好\nCindy" } };
    expect(readFrameEvent(request)).toEqual(request);
  });
});
