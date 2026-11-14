import { describe, expect, it } from "vitest";
import { replyGuardReason } from "./reply-guard";

const guard = (text: string, endpoint: string) => replyGuardReason(text, { tokens: [], endpoints: [endpoint], env: {} });

describe("reply guard: backend addresses (DESIGN §11.3)", () => {
  it("lets ordinary words through when the endpoint has a single-label host name", () => {
    for (const [endpoint, text] of [
      ["https://api/_board/comments", "这个 API 的用法见第二节。"],
      ["https://api/_board/comments", "It is a rapid fix."],
      ["https://board/_board/comments", "谢谢你对这个 Board 的反馈！"],
      ["https://comments/_board/comments", "Thanks for the comments!"],
      ["http://localhost:8787/_board/comments", "在 localhost 上预览时也能看到。"],
    ]) expect(guard(text, endpoint), `${endpoint} ${text}`).toBeNull();
    expect(guard("后端在 https://api/_board/comments", "https://api/_board/comments")).toBe("后端地址");
  });

  it("matches a dotted host name or IP literal only as a whole host", () => {
    const endpoint = "https://api.example.internal/_board/comments";
    for (const text of ["地址是 api.example.internal", "见 https://API.Example.Internal/x", "(api.example.internal)", "api.example.internal。"]) expect(guard(text, endpoint), text).toBe("后端地址");
    for (const text of ["myapi.example.internal 不是它", "api.example.internals", "api.example.internal-2", "api.example.internal.evil.test"]) expect(guard(text, endpoint), text).toBeNull();
    expect(guard("服务在 127.0.0.1 上", "http://127.0.0.1:8787/_board/comments")).toBe("后端地址");
    expect(guard("版本 127.0.0.10", "http://127.0.0.1:8787/_board/comments")).toBeNull();
    expect(guard("地址 [::1]:8787", "http://[::1]:8787/_board/comments")).toBe("后端地址");
    expect(guard("fe80::1234 是别的地址", "http://[::1]:8787/_board/comments")).toBeNull();
  });
});
