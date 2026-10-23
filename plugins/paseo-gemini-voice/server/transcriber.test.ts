import { describe, expect, it } from "vitest";
import { voiceSettings, type VoiceSettings } from "../shared/contracts";
import { cleanTranscript, Transcriber } from "./transcriber";
import { fakeFetch, interactionResponse, jsonResponse, makeWav, tone } from "./test-helpers";

const defaults = voiceSettings.schema.parse({});
const speech = makeWav(tone(1.2));

function transcriber(fetch: typeof globalThis.fetch, settings: Partial<VoiceSettings> = {}, apiKey: string | null = "k") {
  return new Transcriber({
    apiKey: () => apiKey,
    settings: () => ({ ...defaults, ...settings }),
    fetch,
    timeoutMs: 200,
  });
}

describe("Transcriber", () => {
  it("uses gemini-3.5-transcribe with the default settings", async () => {
    const fetch = fakeFetch([jsonResponse(200, interactionResponse("  帮我 review 一下这个 PR。 \n"))]);
    const outcome = await transcriber(fetch.impl).run({ audio: speech, mimeType: "audio/wav" });
    expect(outcome).toMatchObject({ text: "帮我 review 一下这个 PR。", model: "gemini-3.5-transcribe", fallbackUsed: false });
    expect(outcome.audioSeconds).toBeCloseTo(1.2, 2);
    const body = fetch.calls[0].body as { generation_config: { transcription_config: Record<string, unknown> } };
    expect(body.generation_config.transcription_config.mode).toBe("smart");
    expect(body.generation_config.transcription_config.custom_vocabulary).toContain("Paseo");
    expect(body.generation_config.transcription_config.language_codes).toBeUndefined();
  });

  it("skips silence without calling Gemini", async () => {
    const fetch = fakeFetch([]);
    const outcome = await transcriber(fetch.impl).run({ audio: makeWav(new Int16Array(48_000)), mimeType: "audio/wav" });
    expect(outcome).toMatchObject({ text: "", skippedSilence: true });
    expect(fetch.calls).toHaveLength(0);
  });

  it("falls back to the general model when the transcribe model is unavailable", async () => {
    const fetch = fakeFetch([
      jsonResponse(404, { error: { message: "not found" } }),
      jsonResponse(200, interactionResponse('{"transcript":"备用模型的结果"}')),
    ]);
    const outcome = await transcriber(fetch.impl).run({ audio: speech, mimeType: "audio/wav" });
    expect(outcome).toMatchObject({ text: "备用模型的结果", model: "gemini-3.5-flash-lite", fallbackUsed: true });
    expect(fetch.calls[1].body?.model).toBe("gemini-3.5-flash-lite");
  });

  it("falls back after a timeout", async () => {
    const fetch = fakeFetch([
      (_call, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      jsonResponse(200, interactionResponse('{"transcript":"ok"}')),
    ]);
    const outcome = await transcriber(fetch.impl).run({ audio: speech, mimeType: "audio/wav" });
    expect(outcome.fallbackUsed).toBe(true);
  });

  it("does not retry another model with a rejected key", async () => {
    const fetch = fakeFetch([jsonResponse(403, { error: { message: "denied" } })]);
    await expect(transcriber(fetch.impl).run({ audio: speech, mimeType: "audio/wav" })).rejects.toMatchObject({ kind: "auth" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("does not fall back when disabled", async () => {
    const fetch = fakeFetch([jsonResponse(429, { error: { message: "quota" } })]);
    await expect(
      transcriber(fetch.impl, { fallbackModel: "" }).run({ audio: speech, mimeType: "audio/wav" }),
    ).rejects.toMatchObject({ kind: "quota" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("explains a missing key", async () => {
    const fetch = fakeFetch([]);
    await expect(transcriber(fetch.impl, {}, null).run({ audio: speech, mimeType: "audio/wav" })).rejects.toThrow(/API key/);
  });

  it("maps language hints", async () => {
    const fetch = fakeFetch([jsonResponse(200, interactionResponse("x"))]);
    await transcriber(fetch.impl, { languages: "zh-en", mode: "verbatim" }).run({ audio: speech, mimeType: "audio/wav" });
    expect((fetch.calls[0].body as { generation_config: unknown }).generation_config).toMatchObject({
      transcription_config: { language_codes: ["cmn-Hans-CN", "en-US"] },
    });
  });
});

describe("cleanTranscript", () => {
  it.each(["[silence]", "(no speech)", "（静音）", "[音乐]", "<noise>"])("drops the placeholder %s", (placeholder) => {
    expect(cleanTranscript(placeholder)).toBe("");
  });
  it("keeps real text that happens to use brackets", () => {
    expect(cleanTranscript("[TODO] 修一下 bug")).toBe("[TODO] 修一下 bug");
    expect(cleanTranscript("第一行\n\n\n\n第二行")).toBe("第一行\n\n第二行");
  });
});
