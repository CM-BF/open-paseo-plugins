import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceSettings } from "../shared/contracts";
import { GEMINI_BASE_URL, GeminiError, type GeminiTransport, geminiFetch } from "./gemini";

/** Paseo plays OpenAI `pcm` speech as 24 kHz 16-bit mono; both engines produce exactly that. */
export const TTS_SAMPLE_RATE = 24_000;
export const TTS_ATTEMPT_TIMEOUT_MS = 20_000;
const MAX_CHUNK_CHARS = 90;
const MAX_PARALLEL_CHUNKS = 3;
const SAY = "/usr/bin/say";
/** Ends in a CJK character or full-width punctuation: join without a space. */
const CJK_END = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]$/;

/**
 * Speech text arrives verbatim from the agent's speak tool. Markdown marks would be read aloud,
 * and Gemini 3.8 TTS treats `<...>` as vocal tags, so code like `Promise<void>` must lose them.
 */
export function cleanSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|\*/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits at sentence ends (Chinese and Western), then at commas for long sentences, and packs
 * pieces up to ~90 characters. Paseo hands Chinese replies over in segments of up to 260
 * characters because it only splits on ". ! ?" followed by a space.
 */
export function splitSpeechText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  // A period ends a sentence only before whitespace, so "file.ts" and "v1.2" stay whole.
  const sentences = text.split(/(?<=[。！？!?；;])|(?<=\.)\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
      continue;
    }
    let current = "";
    for (const clause of sentence.match(/[^，,、：:]+[，,、：:]*/g) ?? [sentence]) {
      if (current && current.length + clause.length > maxChars) {
        pieces.push(current);
        current = "";
      }
      if (clause.length > maxChars) {
        pieces.push(...sliceLongClause(clause, maxChars));
        continue;
      }
      current += clause;
    }
    if (current) pieces.push(current);
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + piece.length + 1 <= maxChars) {
      chunks[chunks.length - 1] = `${last}${CJK_END.test(last) ? "" : " "}${piece}`;
    } else {
      chunks.push(piece);
    }
  }
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

/** Breaks a clause with no punctuation: at spaces when it has words, else every maxChars. */
function sliceLongClause(clause: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = clause.trim();
  while (rest.length > maxChars) {
    const space = rest.lastIndexOf(" ", maxChars);
    const cut = space > maxChars / 2 ? space : maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Returns the PCM payload of a RIFF/WAVE buffer, or the buffer itself when it is raw PCM. */
export function pcmFromAudio(buffer: Buffer): Buffer {
  if (buffer.subarray(0, 4).toString("latin1") !== "RIFF") return buffer;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString("latin1");
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return buffer.subarray(offset + 8, Math.min(buffer.length, offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV audio has no data chunk");
}

export function wavFromPcm(pcm: Buffer, sampleRate = TTS_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * The TTS guide's REST examples use `speech_config`; the published OpenAPI spec calls the same
 * field `structured_speech_config`. Send the guide's name first and remember whichever works.
 */
export type SpeechConfigField = "speech_config" | "structured_speech_config";

export function buildSpeechBody(model: string, voice: string, text: string, field: SpeechConfigField): Record<string, unknown> {
  return {
    model,
    input: [{ type: "user_input", content: [{ type: "text", text }] }],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: TTS_SAMPLE_RATE },
    generation_config: { [field]: [{ voice }] },
    store: false,
  };
}

/** Concatenates every audio block in the response, stripping a WAV header if one comes back. */
export function extractSpeechAudio(response: unknown): Buffer {
  const record = (response ?? {}) as {
    steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string }> }>;
    outputs?: Array<{ type?: string; data?: string }>;
  };
  const parts = Array.isArray(record.steps)
    ? record.steps.filter((step) => !step.type || step.type === "model_output").flatMap((step) => step.content ?? [])
    : (record.outputs ?? []);
  const audio = parts
    .filter((part) => part.type === "audio" && typeof part.data === "string")
    .map((part) => pcmFromAudio(Buffer.from(part.data!, "base64")));
  if (audio.length === 0) throw new GeminiError("server", "Gemini 没有返回音频。");
  return Buffer.concat(audio);
}

let speechConfigField: SpeechConfigField = "speech_config";

export async function synthesizeGemini(transport: GeminiTransport, model: string, voice: string, text: string): Promise<Buffer> {
  try {
    return extractSpeechAudio(
      await geminiFetch(transport, "/interactions", { method: "POST", body: buildSpeechBody(model, voice, text, speechConfigField) }, model),
    );
  } catch (error) {
    if (!(error instanceof GeminiError) || error.kind !== "bad-request" || !/speech_config/i.test(error.message)) throw error;
    const rejected = speechConfigField;
    speechConfigField = rejected === "speech_config" ? "structured_speech_config" : "speech_config";
    console.error(`[gemini-voice] Gemini rejected ${rejected}; using ${speechConfigField}: ${error.message}`);
    return extractSpeechAudio(
      await geminiFetch(transport, "/interactions", { method: "POST", body: buildSpeechBody(model, voice, text, speechConfigField) }, model),
    );
  }
}

export function resetSpeechConfigFieldForTests(): void {
  speechConfigField = "speech_config";
}

export interface MacVoice {
  name: string;
  locale: string;
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

/** Parses `say -v '?'`: "Tingting             zh_CN    # 你好！我叫婷婷。" */
export function parseMacVoices(output: string): MacVoice[] {
  const voices: MacVoice[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/.exec(line);
    if (match) voices.push({ name: match[1].trim(), locale: match[2] });
  }
  return voices;
}

export async function listMacVoices(sayPath = SAY): Promise<MacVoice[]> {
  if (process.platform !== "darwin") return [];
  try {
    return parseMacVoices(await run(sayPath, ["-v", "?"], 10_000));
  } catch {
    return [];
  }
}

/** macOS built-in speech: offline, free, ~0.7 s for a sentence once warm. */
export async function synthesizeMac(voice: string, text: string, sayPath = SAY): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "gemini-voice-say-"));
  try {
    const input = join(dir, "input.txt");
    const output = join(dir, `${randomBytes(4).toString("hex")}.wav`);
    await writeFile(input, text, "utf8");
    await run(
      sayPath,
      ["-v", voice, "-f", input, "--file-format=WAVE", `--data-format=LEI16@${TTS_SAMPLE_RATE}`, "-o", output],
      TTS_ATTEMPT_TIMEOUT_MS,
    );
    return pcmFromAudio(await readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface SpeechOutcome {
  pcm: Buffer;
  engine: "gemini" | "macos";
  model: string | null;
  voice: string;
  chunks: number;
  fallbackUsed: boolean;
}

export interface SpeakerDeps {
  apiKey(): string | null;
  settings(): VoiceSettings;
  baseUrl?: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  sayPath?: string;
  timeoutMs?: number;
}

async function mapLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export class Speaker {
  constructor(private readonly deps: SpeakerDeps) {}

  private canUseMac(): boolean {
    return (this.deps.platform ?? process.platform) === "darwin";
  }

  private async gemini(chunks: string[], apiKey: string, model: string, voice: string): Promise<Buffer> {
    const pieces = await mapLimited(chunks, MAX_PARALLEL_CHUNKS, async (chunk) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? TTS_ATTEMPT_TIMEOUT_MS);
      try {
        return await synthesizeGemini(
          {
            apiKey,
            signal: controller.signal,
            baseUrl: this.deps.baseUrl ?? GEMINI_BASE_URL,
            ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
          },
          model,
          voice,
          chunk,
        );
      } finally {
        clearTimeout(timer);
      }
    });
    return Buffer.concat(pieces);
  }

  async synthesize(rawText: string): Promise<SpeechOutcome> {
    const text = cleanSpeechText(rawText);
    if (!text) throw new GeminiError("bad-request", "没有可以朗读的文字。");
    const settings = this.deps.settings();
    const chunks = splitSpeechText(text);
    const mac = async (fallbackUsed: boolean): Promise<SpeechOutcome> => ({
      pcm: Buffer.concat(await mapLimited(chunks, MAX_PARALLEL_CHUNKS, (chunk) => synthesizeMac(settings.macVoice, chunk, this.deps.sayPath))),
      engine: "macos",
      model: null,
      voice: settings.macVoice,
      chunks: chunks.length,
      fallbackUsed,
    });
    if (settings.ttsEngine === "macos" && this.canUseMac()) return mac(false);
    const apiKey = this.deps.apiKey();
    try {
      if (!apiKey) throw new GeminiError("auth", "还没有设置 Gemini API key。");
      return {
        pcm: await this.gemini(chunks, apiKey, settings.ttsModel, settings.ttsVoice),
        engine: "gemini",
        model: settings.ttsModel,
        voice: settings.ttsVoice,
        chunks: chunks.length,
        fallbackUsed: false,
      };
    } catch (error) {
      if (!this.canUseMac()) throw error;
      console.error("[gemini-voice] Gemini speech failed, using macOS speech:", (error as Error).message);
      return mac(true);
    }
  }
}
