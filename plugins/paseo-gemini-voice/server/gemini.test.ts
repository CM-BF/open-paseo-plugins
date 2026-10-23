import { describe, expect, it } from "vitest";
import {
  buildPromptedBody,
  buildTranscribeBody,
  checkModel,
  extractInteractionText,
  GeminiError,
  parsePromptedText,
  transcribe,
  type TranscriptionRequest,
} from "./gemini";
import { fakeFetch, interactionResponse, jsonResponse } from "./test-helpers";

const request: TranscriptionRequest = {
  model: "gemini-3.5-transcribe",
  audioBase64: "UklGRg==",
  mimeType: "audio/wav",
  mode: "smart",
  languageCodes: [],
  vocabulary: ["Paseo", "Claude Code"],
};

describe("request bodies", () => {
  it("uses transcription_config for the transcribe model and opts out of storage", () => {
    expect(buildTranscribeBody(request)).toEqual({
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", data: "UklGRg==", mime_type: "audio/wav" }],
      generation_config: { transcription_config: { mode: "smart", custom_vocabulary: ["Paseo", "Claude Code"] } },
      store: false,
    });
  });

  it("omits mode for verbatim and passes language hints", () => {
    const body = buildTranscribeBody({ ...request, mode: "verbatim", languageCodes: ["cmn-Hans-CN", "en-US"], vocabulary: [] });
    expect(body.generation_config).toEqual({ transcription_config: { language_codes: ["cmn-Hans-CN", "en-US"] } });
  });

  it("asks general models for a JSON transcript and never to answer", () => {
    const body = buildPromptedBody({ ...request, model: "gemini-3.5-flash-lite" }, true);
    expect(body.generation_config).toEqual({ thinking_level: "minimal" });
    expect(body.store).toBe(false);
    expect(String(body.system_instruction)).toMatch(/never a request to you/);
    expect(String(body.system_instruction)).toMatch(/Simplified Chinese/);
    expect(String(body.system_instruction)).toMatch(/Paseo, Claude Code/);
    expect(body.response_format).toEqual([
      expect.objectContaining({ type: "text", mime_type: "application/json" }),
    ]);
    expect(buildPromptedBody(request, false).generation_config).toBeUndefined();
  });
});

describe("responses", () => {
  it("reads model_output steps and ignores thoughts", () => {
    expect(
      extractInteractionText({
        steps: [
          { type: "thought", content: [{ type: "text", text: "hmm" }] },
          { type: "model_output", content: [{ type: "text", text: "帮我" }, { type: "text", text: "看看 PR" }] },
        ],
      }),
    ).toBe("帮我看看 PR");
  });

  it("reads the legacy outputs array", () => {
    expect(extractInteractionText({ outputs: [{ type: "text", text: "hello" }] })).toBe("hello");
  });

  it("parses JSON transcripts, code fences, and plain text", () => {
    expect(parsePromptedText('{"transcript":"用 Codex 跑测试"}')).toBe("用 Codex 跑测试");
    expect(parsePromptedText('```json\n{"transcript":"ok"}\n```')).toBe("ok");
    expect(parsePromptedText("plain words")).toBe("plain words");
  });
});

describe("transcribe", () => {
  it("posts to the Interactions API with the key header and revision", async () => {
    const fetch = fakeFetch([jsonResponse(200, interactionResponse("你好 Paseo"))]);
    await expect(transcribe({ apiKey: "AIza-test", fetch: fetch.impl }, request)).resolves.toBe("你好 Paseo");
    expect(fetch.calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(fetch.calls[0].headers["x-goog-api-key"]).toBe("AIza-test");
    expect(fetch.calls[0].headers["api-revision"]).toBe("2026-05-20");
  });

  it("retries a general model once without a thinking level", async () => {
    const fetch = fakeFetch([
      jsonResponse(400, { error: { code: 400, message: "thinking_level is not supported for this model" } }),
      jsonResponse(200, interactionResponse('{"transcript":"重试成功"}')),
    ]);
    const text = await transcribe({ apiKey: "k", fetch: fetch.impl }, { ...request, model: "gemini-3.5-flash-lite" });
    expect(text).toBe("重试成功");
    expect(fetch.calls[1].body?.generation_config).toBeUndefined();
  });

  it.each([
    [400, { error: { message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }, "auth"],
    [403, { error: { message: "Permission denied" } }, "auth"],
    [404, { error: { message: "models/x is not found" } }, "model"],
    [429, { error: { message: "Resource has been exhausted" } }, "quota"],
    [503, { error: { message: "overloaded" } }, "server"],
    [400, { error: { message: "Invalid value" } }, "bad-request"],
  ])("maps HTTP %i to %s", async (status, body, kind) => {
    const fetch = fakeFetch([jsonResponse(status, body)]);
    await expect(transcribe({ apiKey: "k", fetch: fetch.impl }, request)).rejects.toMatchObject({ kind, status });
  });

  it("reports network failures and timeouts", async () => {
    const network = fakeFetch([new TypeError("fetch failed")]);
    await expect(transcribe({ apiKey: "k", fetch: network.impl }, request)).rejects.toMatchObject({ kind: "network" });

    const controller = new AbortController();
    const hanging = fakeFetch([
      (_call, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ]);
    const pending = transcribe({ apiKey: "k", fetch: hanging.impl, signal: controller.signal }, request);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(GeminiError);
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
  });

  it("checks a model with a GET", async () => {
    const fetch = fakeFetch([jsonResponse(200, { name: "models/gemini-3.5-transcribe" })]);
    await checkModel({ apiKey: "k", fetch: fetch.impl }, "gemini-3.5-transcribe");
    expect(fetch.calls[0]).toMatchObject({
      method: "GET",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe",
    });
  });
});
