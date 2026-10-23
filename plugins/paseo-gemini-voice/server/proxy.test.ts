import { createReadStream, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiError } from "./gemini";
import { TranscriptionProxy } from "./proxy";
import { makeWav, tempDir, tone } from "./test-helpers";

const TOKEN = "t".repeat(43);
const proxies: TranscriptionProxy[] = [];

type Deps = ConstructorParameters<typeof TranscriptionProxy>[0];

async function startProxy(transcribe: Deps["transcribe"], speak: Deps["speak"] = vi.fn()) {
  const proxy = new TranscriptionProxy({ authorize: (token) => token === TOKEN, transcribe, speak });
  proxies.push(proxy);
  await proxy.start(0);
  const { port, listening } = proxy.status();
  expect(listening).toBe(true);
  return { proxy, base: `http://127.0.0.1:${port}` };
}

function wavFile(): { path: string; bytes: Buffer } {
  const bytes = makeWav(tone(1));
  const path = join(tempDir("gemini-voice-proxy"), "audio-test.wav");
  writeFileSync(path, bytes);
  return { path, bytes };
}

afterEach(async () => {
  while (proxies.length > 0) await proxies.pop()!.stop();
});

describe("TranscriptionProxy with the OpenAI SDK used by Paseo", () => {
  it("answers the daemon's transcription request", async () => {
    const seen: Array<{ audio: Buffer; mimeType: string }> = [];
    const { base } = await startProxy(async (input) => {
      seen.push(input);
      return { text: "用 Claude Code 写测试", audioSeconds: 1 };
    });
    const { path, bytes } = wavFile();
    const client = new OpenAI({ apiKey: TOKEN, baseURL: `${base}/v1` });
    // Same call as Paseo's OpenAISTT: file stream, language, model, prompt, json.
    const response = await client.audio.transcriptions.create({
      file: createReadStream(path),
      language: "en",
      model: "paseo-gemini-voice",
      prompt: "Transcribe only what the speaker says.",
      response_format: "json",
    });
    expect(response.text).toBe("用 Claude Code 写测试");
    expect(seen).toHaveLength(1);
    expect(seen[0].mimeType).toBe("audio/wav");
    expect(Buffer.compare(seen[0].audio, bytes)).toBe(0);
  });

  it("rejects a wrong token", async () => {
    const transcribe = vi.fn();
    const { base } = await startProxy(transcribe);
    const client = new OpenAI({ apiKey: "wrong", baseURL: `${base}/v1`, maxRetries: 0 });
    await expect(
      client.audio.transcriptions.create({ file: createReadStream(wavFile().path), model: "x" }),
    ).rejects.toMatchObject({ status: 401 });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("returns Gemini errors without letting the SDK retry", async () => {
    const transcribe = vi.fn(async () => {
      throw new GeminiError("quota", "Gemini 额度或频率达到上限：Resource has been exhausted", 429);
    });
    const { base } = await startProxy(transcribe);
    const client = new OpenAI({ apiKey: TOKEN, baseURL: `${base}/v1` });
    const error = await client.audio.transcriptions
      .create({ file: createReadStream(wavFile().path), model: "x" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect((error as InstanceType<typeof OpenAI.APIError>).status).toBe(429);
    expect((error as Error).message).toContain("Gemini 额度或频率达到上限");
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("supports text and verbose_json formats", async () => {
    const { base } = await startProxy(async () => ({ text: "hello", audioSeconds: 2.5 }));
    const client = new OpenAI({ apiKey: TOKEN, baseURL: `${base}/v1` });
    const text = await client.audio.transcriptions.create({
      file: createReadStream(wavFile().path),
      model: "x",
      response_format: "text",
    });
    expect(text).toBe("hello");
    const verbose = await client.audio.transcriptions.create({
      file: createReadStream(wavFile().path),
      model: "x",
      response_format: "verbose_json",
    });
    expect(verbose).toMatchObject({ text: "hello", duration: 2.5 });
  });

  it("serves a health check and rejects unknown paths", async () => {
    const { base } = await startProxy(vi.fn());
    await expect(fetch(`${base}/healthz`).then((response) => response.json())).resolves.toEqual({
      ok: true,
      service: "paseo-gemini-voice",
    });
    expect((await fetch(`${base}/v1/chat/completions`, { method: "POST" })).status).toBe(404);
  });

  it("answers the daemon's speech request with raw PCM", async () => {
    const pcm = Buffer.from(Int16Array.from([0, 1000, -1000, 32000]).buffer);
    const speak = vi.fn(async () => ({ pcm }));
    const { base } = await startProxy(vi.fn(), speak);
    const client = new OpenAI({ apiKey: TOKEN, baseURL: `${base}/v1` });
    // Same call as Paseo's OpenAITTS: model, voice, input, response_format pcm, body read as a stream.
    const response = await client.audio.speech.create({
      model: "paseo-gemini-voice",
      voice: "alloy",
      input: "好的，我来看看这个 bug。",
      response_format: "pcm",
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    expect(Buffer.compare(Buffer.concat(chunks), pcm)).toBe(0);
    expect(speak).toHaveBeenCalledWith({ text: "好的，我来看看这个 bug。" });
  });

  it("wraps speech in WAV on request and rejects compressed formats", async () => {
    const { base } = await startProxy(vi.fn(), async () => ({ pcm: Buffer.alloc(480) }));
    const client = new OpenAI({ apiKey: TOKEN, baseURL: `${base}/v1`, maxRetries: 0 });
    const wav = Buffer.from(await (await client.audio.speech.create({ model: "x", voice: "alloy", input: "hi", response_format: "wav" })).arrayBuffer());
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    await expect(client.audio.speech.create({ model: "x", voice: "alloy", input: "hi", response_format: "mp3" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      new OpenAI({ apiKey: "wrong", baseURL: `${base}/v1`, maxRetries: 0 }).audio.speech.create({ model: "x", voice: "alloy", input: "hi" }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("waits for a busy port and then listens", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    const proxy = new TranscriptionProxy({ authorize: () => true, transcribe: vi.fn(), speak: vi.fn() });
    proxies.push(proxy);
    await proxy.start(port);
    expect(proxy.status()).toMatchObject({ listening: false, port });
    expect(proxy.status().error).toMatch(/占用/);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await vi.waitFor(() => expect(proxy.status().listening).toBe(true), { timeout: 6_000, interval: 100 });
  });
});
