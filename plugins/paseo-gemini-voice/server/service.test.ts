import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { voiceSettings } from "../shared/contracts";
import { SAMPLE_EXPECTED_TEXT } from "./sample";
import { VoiceService } from "./service";
import { fakeFetch, interactionResponse, jsonResponse, makeWav, tempDir, tone } from "./test-helpers";

const services: VoiceService[] = [];

function setup(options: { workerStart?: Date | null; env?: NodeJS.ProcessEnv; replies?: Parameters<typeof fakeFetch>[0] } = {}) {
  const home = tempDir("gemini-voice-service");
  writeFileSync(join(home, "config.json"), `${JSON.stringify({ version: 1, pluginsEnabled: true }, null, 2)}\n`, { mode: 0o600 });
  const gemini = fakeFetch(options.replies ?? []);
  const service = new VoiceService({
    home,
    env: options.env ?? {},
    fetch: gemini.impl,
    workerStart: async () => options.workerStart ?? null,
  });
  services.push(service);
  return { home, service, gemini };
}

const settings = { ...voiceSettings.schema.parse({}), port: 0 };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(async () => {
  while (services.length > 0) await services.pop()!.stop();
});

describe("VoiceService", () => {
  it("keeps the key private and reports only a hint", async () => {
    const { service, home } = setup({ replies: [jsonResponse(200, {}), jsonResponse(200, {})] });
    await service.start(settings);
    const saved = await service.saveKey("AIzaSyExampleExampleExample1234");
    expect(saved).toEqual({ hint: "AIza…1234", check: { ok: true, message: expect.stringContaining("gemini-3.5-transcribe：可用") } });
    const status = await service.status();
    expect(status.apiKey).toEqual({ configured: true, source: "plugin", hint: "AIza…1234" });
    expect(JSON.stringify(status)).not.toContain("AIzaSyExample");
    const credentials = join(home, "plugin-data", "paseo-gemini-voice", "credentials.json");
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
    expect(service.clearKey()).toEqual({ cleared: true });
    expect((await service.status()).apiKey.configured).toBe(false);
  });

  it("falls back to GEMINI_API_KEY from the daemon environment", async () => {
    const { service } = setup({ env: { GEMINI_API_KEY: "AIzaFromEnvironment0000" } });
    await service.start(settings);
    expect((await service.status()).apiKey).toMatchObject({ configured: true, source: "env" });
  });

  it("moves from not applied to pending restart to active", async () => {
    const fixed = { ...settings, port: await freePort() };
    const { service, home } = setup({ workerStart: new Date("2026-01-01T00:00:00Z") });
    await service.start(fixed);
    expect((await service.status()).dictation).toMatchObject({ state: "not-applied", canApply: true, canRevert: false });
    const applied = await service.applyConfig();
    expect(applied.dictation).toMatchObject({ state: "pending-restart", canApply: false, canRevert: true });
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.providers.openai.stt.baseUrl).toBe(`http://127.0.0.1:${fixed.port}/v1`);
    await service.stop();

    // A daemon worker started after the apply has loaded the new speech settings.
    const restarted = new VoiceService({ home, env: {}, workerStart: async () => new Date(Date.now() + 1_000) });
    services.push(restarted);
    await restarted.start(fixed);
    expect((await restarted.status()).dictation.state).toBe("active");

    const reverted = await restarted.revertConfig();
    expect(reverted.dictation.state).toBe("not-applied");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({ version: 1, pluginsEnabled: true });
  });

  it("counts the daemon's first authenticated request as active", async () => {
    const { service, home } = setup({
      workerStart: new Date("2026-01-01T00:00:00Z"),
      replies: [jsonResponse(200, interactionResponse("测试一下 Gemini 语音输入"))],
    });
    service.credentials.setApiKey("AIzaSyExampleExampleExample1234");
    await service.start(settings);
    const status = await service.applyConfig();
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const client = new OpenAI({ apiKey: config.providers.openai.stt.apiKey, baseURL: status.proxy.url });
    const file = join(home, "clip.wav");
    writeFileSync(file, makeWav(tone(1.5)));
    const { createReadStream } = await import("node:fs");
    const result = await client.audio.transcriptions.create({ file: createReadStream(file), model: "paseo-gemini-voice", language: "en" });
    expect(result.text).toBe("测试一下 Gemini 语音输入");
    const after = await service.status();
    expect(after.dictation.state).toBe("active");
    expect(after.last).toMatchObject({ ok: true, source: "dictation", model: "gemini-3.5-transcribe", textPreview: "测试一下 Gemini 语音输入" });
    expect(after.counters).toMatchObject({ requests: 1, failures: 0 });
  });

  it("speaks voice mode replies through Gemini TTS for the daemon", async () => {
    const speech = Buffer.from(Int16Array.from([100, -100, 200, -200]).buffer);
    const { service, home, gemini } = setup({
      workerStart: new Date("2026-01-01T00:00:00Z"),
      replies: [jsonResponse(200, { status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", data: speech.toString("base64") }] }] })],
    });
    service.credentials.setApiKey("AIzaSyExampleExampleExample1234");
    await service.start(settings);
    const status = await service.applyConfig();
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.providers.openai.tts.baseUrl).toBe(status.proxy.url);
    // The same call Paseo's OpenAITTS makes with providers.openai.tts.
    const client = new OpenAI({ apiKey: config.providers.openai.tts.apiKey, baseURL: config.providers.openai.tts.baseUrl });
    const response = await client.audio.speech.create({ model: config.features.voiceMode.tts.model, voice: "alloy", input: "**好的**，我来处理。", response_format: "pcm" });
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), speech)).toBe(0);
    const body = gemini.calls[0].body as { model: string; input: Array<{ content: Array<{ text: string }> }> };
    expect(body.model).toBe("gemini-3.8-flash-lite-tts");
    expect(body.input[0].content[0].text).toBe("好的，我来处理。");
    const after = await service.status();
    expect(after.dictation.state).toBe("active");
    expect(after.lastSpeech).toMatchObject({ ok: true, source: "voice", engine: "gemini", voice: "Kore", chunks: 1 });
  });

  it("returns a playable WAV for the speech preview", async () => {
    const speech = Buffer.alloc(4_800);
    const { service } = setup({
      replies: [jsonResponse(200, { status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", data: speech.toString("base64") }] }] })],
    });
    service.credentials.setApiKey("AIzaSyExampleExampleExample1234");
    await service.start(settings);
    const preview = await service.speechPreview();
    expect(preview).toMatchObject({ ok: true, engine: "gemini", model: "gemini-3.8-flash-lite-tts", voice: "Kore", error: null });
    const wav = Buffer.from(preview.audio!, "base64");
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav.length).toBe(44 + speech.length);
    expect((await service.status()).lastSpeech?.source).toBe("preview");
  });

  it("reports env overrides", async () => {
    const { service } = setup({ env: { PASEO_DICTATION_STT_PROVIDER: "local" } });
    await service.start(settings);
    const status = await service.applyConfig();
    expect(status.dictation).toMatchObject({ state: "overridden", canRevert: true });
  });

  it("runs the bundled sample through Gemini", async () => {
    const { service, gemini } = setup({ replies: [jsonResponse(200, interactionResponse("用 TypeScript 写一个 Paseo 插件"))] });
    service.credentials.setApiKey("AIzaSyExampleExampleExample1234");
    await service.start(settings);
    const result = await service.sample();
    expect(result).toMatchObject({ ok: true, expected: SAMPLE_EXPECTED_TEXT, text: "用 TypeScript 写一个 Paseo 插件", model: "gemini-3.5-transcribe" });
    const input = (gemini.calls[0].body as { input: Array<{ mime_type: string }> }).input[0];
    expect(input.mime_type).toBe("audio/wav");
    expect((await service.status()).last?.source).toBe("sample");
  });

  it("reports a sample failure without throwing", async () => {
    const { service } = setup();
    await service.start(settings);
    const result = await service.sample();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/API key/);
  });
});
