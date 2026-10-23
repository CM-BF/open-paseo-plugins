import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { voiceSettings, type VoiceSettings } from "../shared/contracts";
import { fakeFetch, jsonResponse, tempDir } from "./test-helpers";
import {
  buildSpeechBody,
  cleanSpeechText,
  extractSpeechAudio,
  parseMacVoices,
  pcmFromAudio,
  resetSpeechConfigFieldForTests,
  Speaker,
  splitSpeechText,
  synthesizeGemini,
  synthesizeMac,
  wavFromPcm,
} from "./tts";

const defaults = voiceSettings.schema.parse({});

function pcm(...samples: number[]): Buffer {
  return Buffer.from(Int16Array.from(samples).buffer);
}

function audioResponse(data: Buffer): Response {
  return jsonResponse(200, {
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/l16", data: data.toString("base64") }] }],
  });
}

/** A stand-in for /usr/bin/say that writes a fixed WAV to the -o path. */
function fakeSay(samples: Buffer): string {
  const dir = tempDir("gemini-voice-fake-say");
  const wav = join(dir, "out.wav");
  writeFileSync(wav, wavFromPcm(samples));
  const script = join(dir, "say");
  writeFileSync(
    script,
    `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\ncp "${wav}" "$out"\n`,
  );
  chmodSync(script, 0o755);
  return script;
}

afterEach(() => resetSpeechConfigFieldForTests());

describe("speech text", () => {
  it("drops markdown marks and angle brackets that Gemini would read as vocal tags", () => {
    expect(cleanSpeechText("**好的**，`Promise<void>` 已经改好。\n# 标题")).toBe("好的，Promise void 已经改好。 标题");
  });

  it("splits Chinese replies at sentence ends and packs them into short chunks", () => {
    const text = "我看了一下这个问题。原因是缓存没有失效，所以页面一直显示旧数据。我已经改好了，并且加了测试！要我顺便提交吗？";
    const chunks = splitSpeechText(text, 30);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
    expect(chunks.length).toBeGreaterThan(2);
  });

  it("keeps spaces between English sentences and splits long clauses", () => {
    expect(splitSpeechText("Done. Tests pass! Ship it?", 12)).toEqual(["Done.", "Tests pass!", "Ship it?"]);
    const long = "一".repeat(50) + "，" + "二".repeat(50);
    expect(splitSpeechText(long, 40).every((chunk) => chunk.length <= 40)).toBe(true);
  });
});

describe("audio helpers", () => {
  it("round-trips PCM through WAV", () => {
    const samples = pcm(1, -2, 3);
    expect(Buffer.compare(pcmFromAudio(wavFromPcm(samples)), samples)).toBe(0);
    expect(Buffer.compare(pcmFromAudio(samples), samples)).toBe(0);
  });

  it("parses `say -v ?` output", () => {
    expect(
      parseMacVoices("Tingting            zh_CN    # 你好！我叫婷婷。\nEddy (Chinese (China mainland)) zh_CN    # 你好！我叫Eddy。\n"),
    ).toEqual([
      { name: "Tingting", locale: "zh_CN" },
      { name: "Eddy (Chinese (China mainland))", locale: "zh_CN" },
    ]);
  });
});

describe("Gemini speech", () => {
  it("asks for 24 kHz L16 with the chosen voice and no storage", () => {
    expect(buildSpeechBody("gemini-3.8-flash-lite-tts", "Kore", "你好", "speech_config")).toEqual({
      model: "gemini-3.8-flash-lite-tts",
      input: [{ type: "user_input", content: [{ type: "text", text: "你好" }] }],
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: "Kore" }] },
      store: false,
    });
  });

  it("reads raw L16 and WAV-wrapped audio", () => {
    expect(Buffer.compare(extractSpeechAudio({ steps: [{ type: "model_output", content: [{ type: "audio", data: pcm(5).toString("base64") }] }] }), pcm(5))).toBe(0);
    const wav = wavFromPcm(pcm(7, 8)).toString("base64");
    expect(Buffer.compare(extractSpeechAudio({ steps: [{ content: [{ type: "audio", data: wav }] }] }), pcm(7, 8))).toBe(0);
    expect(() => extractSpeechAudio({ steps: [{ type: "model_output", content: [{ type: "text", text: "no" }] }] })).toThrow(/音频/);
  });

  it("switches to structured_speech_config when the API rejects speech_config", async () => {
    const fetch = fakeFetch([
      jsonResponse(400, { error: { message: 'Invalid JSON payload received. Unknown name "speech_config" at \'generation_config\'' } }),
      audioResponse(pcm(9)),
      audioResponse(pcm(10)),
    ]);
    await synthesizeGemini({ apiKey: "k", fetch: fetch.impl }, "gemini-3.8-flash-lite-tts", "Kore", "你好");
    await synthesizeGemini({ apiKey: "k", fetch: fetch.impl }, "gemini-3.8-flash-lite-tts", "Kore", "再见");
    expect(fetch.calls.map((call) => Object.keys(call.body?.generation_config as object))).toEqual([
      ["speech_config"],
      ["structured_speech_config"],
      ["structured_speech_config"],
    ]);
  });
});

describe("Speaker", () => {
  function speaker(fetch: typeof globalThis.fetch, settings: Partial<VoiceSettings> = {}, options: { platform?: NodeJS.Platform; sayPath?: string } = {}) {
    return new Speaker({ apiKey: () => "k", settings: () => ({ ...defaults, ...settings }), fetch, timeoutMs: 500, ...options });
  }

  it("synthesizes chunks in parallel and keeps their order", async () => {
    const sentences = ["第一段".repeat(20) + "。", "第二段".repeat(20) + "。", "第三段".repeat(20) + "。"];
    // Replies finish out of order: the first chunk is the slowest.
    const fetch = fakeFetch(
      [30, 0, 15].map((delay, index) => async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return audioResponse(pcm(index + 1));
      }),
    );
    const outcome = await speaker(fetch.impl).synthesize(sentences.join(""));
    expect(outcome).toMatchObject({ engine: "gemini", model: "gemini-3.8-flash-lite-tts", voice: "Kore", chunks: 3, fallbackUsed: false });
    expect(fetch.calls.map((call) => (call.body?.input as Array<{ content: Array<{ text: string }> }>)[0].content[0].text)).toEqual(sentences);
    expect(Buffer.compare(outcome.pcm, Buffer.concat([pcm(1), pcm(2), pcm(3)]))).toBe(0);
  });

  it("falls back to macOS speech when Gemini fails", async () => {
    const fetch = fakeFetch([jsonResponse(429, { error: { message: "quota" } })]);
    const outcome = await speaker(fetch.impl, {}, { platform: "darwin", sayPath: fakeSay(pcm(4, 4)) }).synthesize("你好");
    expect(outcome).toMatchObject({ engine: "macos", voice: "Tingting", fallbackUsed: true });
    expect(Buffer.compare(outcome.pcm, pcm(4, 4))).toBe(0);
  });

  it("uses macOS speech directly when chosen", async () => {
    const fetch = fakeFetch([]);
    const outcome = await speaker(fetch.impl, { ttsEngine: "macos", macVoice: "Meijia" }, { platform: "darwin", sayPath: fakeSay(pcm(2)) }).synthesize("你好");
    expect(outcome).toMatchObject({ engine: "macos", voice: "Meijia", fallbackUsed: false });
    expect(fetch.calls).toHaveLength(0);
  });

  it("reports Gemini errors where macOS speech is unavailable", async () => {
    const fetch = fakeFetch([jsonResponse(403, { error: { message: "denied" } })]);
    await expect(speaker(fetch.impl, {}, { platform: "linux" }).synthesize("你好")).rejects.toMatchObject({ kind: "auth" });
  });

  it.runIf(process.platform === "darwin")("produces 24 kHz speech with the real macOS voice", async () => {
    const audio = await synthesizeMac("Tingting", "你好，Paseo。");
    expect(audio.length).toBeGreaterThan(24_000);
  });
});
