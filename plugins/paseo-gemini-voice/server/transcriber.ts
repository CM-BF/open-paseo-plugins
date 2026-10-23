import type { VoiceSettings } from "../shared/contracts";
import { inspectWav, isSilent } from "./audio";
import { GeminiError, type GeminiTransport, transcribe } from "./gemini";

export const ATTEMPT_TIMEOUT_MS = 15_000;

const LANGUAGE_CODES: Readonly<Record<VoiceSettings["languages"], string[]>> = {
  auto: [],
  "zh-en": ["cmn-Hans-CN", "en-US"],
  zh: ["cmn-Hans-CN"],
  en: ["en-US"],
};

const PLACEHOLDER = /^[[(（【<]\s*[^\])）】>]{0,24}[\])）】>]$/;
const PLACEHOLDER_WORDS = /silence|no speech|inaudible|noise|music|blank|静音|无声|噪音|杂音|音乐|空白|听不清/i;

/** Drops "[silence]"-style placeholders and normalizes whitespace. */
export function cleanTranscript(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (PLACEHOLDER.test(trimmed) && PLACEHOLDER_WORDS.test(trimmed)) return "";
  return trimmed;
}

export interface TranscriptionInput {
  audio: Buffer;
  mimeType: string;
}

export interface TranscriptionOutcome {
  text: string;
  model: string | null;
  fallbackUsed: boolean;
  audioSeconds: number;
  skippedSilence: boolean;
}

/** Kinds that the other model might not share: a missing model, its own quota, or an outage. */
const FALLBACK_KINDS = new Set(["model", "quota", "server", "network", "timeout", "bad-request"]);

export interface TranscriberDeps {
  apiKey(): string | null;
  settings(): VoiceSettings;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class Transcriber {
  constructor(private readonly deps: TranscriberDeps) {}

  async run(input: TranscriptionInput): Promise<TranscriptionOutcome> {
    const wav = inspectWav(input.audio);
    const audioSeconds = wav?.seconds ?? 0;
    if (isSilent(wav)) {
      return { text: "", model: null, fallbackUsed: false, audioSeconds, skippedSilence: true };
    }
    const apiKey = this.deps.apiKey();
    if (!apiKey) throw new GeminiError("auth", "还没有设置 Gemini API key：在 Paseo 设置 → 插件 → Gemini 语音输入里填写。");
    const settings = this.deps.settings();
    const models = [settings.model];
    if (settings.fallbackModel && settings.fallbackModel !== settings.model) models.push(settings.fallbackModel);
    const audioBase64 = input.audio.toString("base64");
    let lastError: unknown;
    for (const [index, model] of models.entries()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? ATTEMPT_TIMEOUT_MS);
      const transport: GeminiTransport = {
        apiKey,
        signal: controller.signal,
        ...(this.deps.baseUrl ? { baseUrl: this.deps.baseUrl } : {}),
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      };
      try {
        const raw = await transcribe(transport, {
          model,
          audioBase64,
          mimeType: input.mimeType,
          mode: settings.mode,
          languageCodes: LANGUAGE_CODES[settings.languages],
          vocabulary: settings.vocabulary,
        });
        return { text: cleanTranscript(raw), model, fallbackUsed: index > 0, audioSeconds, skippedSilence: false };
      } catch (error) {
        lastError = error;
        const canFallBack = error instanceof GeminiError && FALLBACK_KINDS.has(error.kind);
        if (!canFallBack || index === models.length - 1) break;
        console.error(`[gemini-voice] ${model} failed, trying ${models[index + 1]}:`, (error as Error).message);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}
