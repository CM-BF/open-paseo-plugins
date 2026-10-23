import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { LastRequest, LastSpeech, VoiceSettings, VoiceStatus } from "../shared/contracts";
import { TTS_PREVIEW_TEXT, voiceSettings } from "../shared/contracts";
import { CredentialStore, keyHint } from "./credentials";
import {
  applySpeechConfig,
  configModifiedAt,
  inspectSpeechConfig,
  PluginStateStore,
  proxyBaseUrl,
  readDaemonConfig,
  revertSpeechConfig,
  speechEnvOverride,
} from "./daemon-config";
import { checkModel, GeminiError } from "./gemini";
import { paseoHome, pluginDataDir } from "./paths";
import { TranscriptionProxy } from "./proxy";
import { SAMPLE_EXPECTED_TEXT, SAMPLE_SHA256, sampleWav } from "./sample";
import { Transcriber, type TranscriptionOutcome } from "./transcriber";
import { listMacVoices, type MacVoice, Speaker, type SpeechOutcome, TTS_SAMPLE_RATE, wavFromPcm } from "./tts";

const DEFAULT_SETTINGS: VoiceSettings = voiceSettings.schema.parse({});
const PREVIEW_CHARS = 160;

/** Start time of the daemon worker that spawned this plugin, from `ps`. Null when unavailable. */
export function readProcessStart(pid: number): Promise<Date | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" }, timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(null);
      const parsed = Date.parse(stdout.trim());
      resolve(Number.isFinite(parsed) ? new Date(parsed) : null);
    });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface VoiceServiceOptions {
  home?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  geminiBaseUrl?: string;
  fetch?: typeof fetch;
  workerStart?: () => Promise<Date | null>;
  platform?: NodeJS.Platform;
  sayPath?: string;
}

export class VoiceService {
  readonly home: string;
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  readonly credentials: CredentialStore;
  private readonly state: PluginStateStore;
  private readonly transcriber: Transcriber;
  private readonly speaker: Speaker;
  readonly proxy: TranscriptionProxy;
  private settings: VoiceSettings = DEFAULT_SETTINGS;
  private last: LastRequest | null = null;
  private lastSpeech: LastSpeech | null = null;
  private counters = { requests: 0, failures: 0, audioSeconds: 0 };
  /** The daemon sent an authenticated request, so it runs with this plugin's speech config. */
  private seenDaemonRequest = false;
  private workerStart: Promise<Date | null> | null = null;
  private readonly readWorkerStart: () => Promise<Date | null>;

  constructor(private readonly options: VoiceServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? paseoHome(this.env);
    this.dataDir = options.dataDir ?? pluginDataDir(this.home);
    this.credentials = new CredentialStore(join(this.dataDir, "credentials.json"), this.env);
    this.state = new PluginStateStore(join(this.dataDir, "state.json"));
    this.readWorkerStart = options.workerStart ?? (() => readProcessStart(process.ppid));
    this.transcriber = new Transcriber({
      apiKey: () => this.credentials.apiKey()?.key ?? null,
      settings: () => this.settings,
      ...(options.geminiBaseUrl ? { baseUrl: options.geminiBaseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.speaker = new Speaker({
      apiKey: () => this.credentials.apiKey()?.key ?? null,
      settings: () => this.settings,
      ...(options.geminiBaseUrl ? { baseUrl: options.geminiBaseUrl } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.sayPath ? { sayPath: options.sayPath } : {}),
    });
    this.proxy = new TranscriptionProxy({
      authorize: (token) => this.credentials.matchesProxyToken(token),
      transcribe: async ({ audio, mimeType }) => {
        this.seenDaemonRequest = true;
        const outcome = await this.record("dictation", () => this.transcriber.run({ audio, mimeType }));
        return { text: outcome.text, audioSeconds: outcome.audioSeconds };
      },
      speak: async ({ text }) => {
        this.seenDaemonRequest = true;
        const outcome = await this.recordSpeech("voice", text);
        return { pcm: outcome.pcm };
      },
    });
  }

  async start(settings: VoiceSettings): Promise<void> {
    this.settings = settings;
    this.credentials.proxyToken();
    await this.proxy.start(settings.port);
  }

  async updateSettings(settings: VoiceSettings): Promise<void> {
    const portChanged = settings.port !== this.settings.port;
    this.settings = settings;
    if (portChanged) await this.proxy.start(settings.port);
  }

  async stop(): Promise<void> {
    await this.proxy.stop();
  }

  private async record(source: LastRequest["source"], run: () => Promise<TranscriptionOutcome>): Promise<TranscriptionOutcome> {
    const started = Date.now();
    try {
      const outcome = await run();
      if (!outcome.skippedSilence) {
        this.counters.requests += 1;
        this.counters.audioSeconds += outcome.audioSeconds;
        this.last = {
          at: new Date().toISOString(),
          ok: true,
          source,
          model: outcome.model,
          fallbackUsed: outcome.fallbackUsed,
          audioSeconds: Math.round(outcome.audioSeconds * 10) / 10,
          latencyMs: Date.now() - started,
          textPreview: outcome.text.slice(0, PREVIEW_CHARS),
          error: null,
        };
      }
      return outcome;
    } catch (error) {
      this.counters.requests += 1;
      this.counters.failures += 1;
      this.last = {
        at: new Date().toISOString(),
        ok: false,
        source,
        model: null,
        fallbackUsed: false,
        audioSeconds: 0,
        latencyMs: Date.now() - started,
        textPreview: null,
        error: errorText(error),
      };
      throw error;
    }
  }

  private async recordSpeech(source: LastSpeech["source"], text: string): Promise<SpeechOutcome> {
    const started = Date.now();
    try {
      const outcome = await this.speaker.synthesize(text);
      this.lastSpeech = {
        at: new Date().toISOString(),
        ok: true,
        source,
        engine: outcome.engine,
        model: outcome.model,
        voice: outcome.voice,
        fallbackUsed: outcome.fallbackUsed,
        chars: text.length,
        chunks: outcome.chunks,
        audioSeconds: Math.round((outcome.pcm.length / 2 / TTS_SAMPLE_RATE) * 10) / 10,
        latencyMs: Date.now() - started,
        error: null,
      };
      return outcome;
    } catch (error) {
      this.lastSpeech = {
        at: new Date().toISOString(),
        ok: false,
        source,
        engine: null,
        model: null,
        voice: null,
        fallbackUsed: false,
        chars: text.length,
        chunks: 0,
        audioSeconds: 0,
        latencyMs: Date.now() - started,
        error: errorText(error),
      };
      throw error;
    }
  }

  private target() {
    const proxy = this.proxy.status();
    return { port: proxy.listening ? proxy.port : this.settings.port, token: this.credentials.proxyToken() };
  }

  private async dictationStatus(): Promise<VoiceStatus["dictation"]> {
    this.workerStart ??= this.readWorkerStart();
    const worker = await this.workerStart;
    const record = this.state.applied();
    const base = { appliedAt: record?.at ?? null, workerStartedAt: worker?.toISOString() ?? null };
    let inspection;
    try {
      inspection = inspectSpeechConfig(readDaemonConfig(this.home), this.target(), this.home);
    } catch (error) {
      return { ...base, state: "error", detail: `读取 Paseo 配置失败：${errorText(error)}`, canApply: false, canRevert: false };
    }
    if (inspection.applied) {
      const override =
        speechEnvOverride(this.env) ??
        (inspection.dictationDisabled ? "config.json 里关闭了听写（features.dictation.enabled 为 false）。" : null);
      if (override) return { ...base, state: "overridden", detail: override, canApply: false, canRevert: true };
      const appliedTime = record ? Date.parse(record.at) : (configModifiedAt(this.home)?.getTime() ?? null);
      const restarted = worker !== null && appliedTime !== null && worker.getTime() > appliedTime;
      if (this.seenDaemonRequest || restarted) {
        return {
          ...base,
          state: "active",
          detail: "听写和语音对话已改用 Gemini，可以说中文，也可以中英混说。",
          canApply: false,
          canRevert: true,
        };
      }
      return {
        ...base,
        state: "pending-restart",
        detail: "配置已写入，重启一次 Daemon 后生效：设置 → 主机 → 重启 Daemon。正在运行的 Agent 会继续运行。",
        canApply: false,
        canRevert: true,
      };
    }
    if (inspection.stale) {
      return {
        ...base,
        state: "not-applied",
        detail: "配置是本插件以前写入的（旧端口、旧令牌，或者还没包含语音对话），需要重新写入。",
        canApply: true,
        canRevert: true,
      };
    }
    if (inspection.provider === "openai") {
      return {
        ...base,
        state: "foreign",
        detail: `听写目前使用另一个 OpenAI 兼容接口${inspection.baseUrl ? `（${inspection.baseUrl}）` : ""}。写入后改用 Gemini，可以随时恢复。`,
        canApply: true,
        canRevert: false,
      };
    }
    return {
      ...base,
      state: "not-applied",
      detail: "听写和语音对话目前使用 Paseo 自带的本地模型，只支持英语。",
      canApply: true,
      canRevert: false,
    };
  }

  async status(): Promise<VoiceStatus> {
    const key = this.credentials.apiKey();
    const proxy = this.proxy.status();
    return {
      apiKey: { configured: key !== null, source: key?.source ?? null, hint: key ? keyHint(key.key) : null },
      proxy: { ...proxy, url: proxyBaseUrl(proxy.port || this.settings.port) },
      dictation: await this.dictationStatus(),
      last: this.last,
      lastSpeech: this.lastSpeech,
      counters: { ...this.counters, audioSeconds: Math.round(this.counters.audioSeconds) },
    };
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    const key = this.credentials.apiKey();
    if (!key) return { ok: false, message: "还没有设置 Gemini API key。" };
    const models = [this.settings.model, this.settings.fallbackModel].filter(
      (model, index, all): model is string => Boolean(model) && all.indexOf(model) === index,
    );
    const lines: string[] = [];
    let primaryOk = false;
    for (const [index, model] of models.entries()) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        await checkModel(
          {
            apiKey: key.key,
            signal: controller.signal,
            ...(this.options.geminiBaseUrl ? { baseUrl: this.options.geminiBaseUrl } : {}),
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          },
          model,
        );
        lines.push(`${model}：可用`);
        if (index === 0) primaryOk = true;
      } catch (error) {
        lines.push(`${model}：${errorText(error)}`);
        if (error instanceof GeminiError && error.kind === "auth") break;
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: primaryOk, message: lines.join("\n") };
  }

  async saveKey(apiKey: string): Promise<{ hint: string; check: { ok: boolean; message: string } }> {
    this.credentials.setApiKey(apiKey);
    return { hint: keyHint(apiKey.trim()), check: await this.check() };
  }

  clearKey(): { cleared: boolean } {
    return { cleared: this.credentials.clearApiKey() };
  }

  async sample(): Promise<{ ok: boolean; expected: string; text: string; model: string | null; latencyMs: number; error: string | null }> {
    const audio = sampleWav();
    if (createHash("sha256").update(audio).digest("hex") !== SAMPLE_SHA256) {
      return { ok: false, expected: SAMPLE_EXPECTED_TEXT, text: "", model: null, latencyMs: 0, error: "内置示例音频已损坏。" };
    }
    const started = Date.now();
    try {
      const outcome = await this.record("sample", () => this.transcriber.run({ audio, mimeType: "audio/wav" }));
      return { ok: true, expected: SAMPLE_EXPECTED_TEXT, text: outcome.text, model: outcome.model, latencyMs: Date.now() - started, error: null };
    } catch (error) {
      return { ok: false, expected: SAMPLE_EXPECTED_TEXT, text: "", model: null, latencyMs: Date.now() - started, error: errorText(error) };
    }
  }

  async speechPreview(): Promise<{
    ok: boolean;
    audio: string | null;
    engine: SpeechOutcome["engine"] | null;
    model: string | null;
    voice: string | null;
    fallbackUsed: boolean;
    latencyMs: number;
    error: string | null;
  }> {
    const started = Date.now();
    try {
      const outcome = await this.recordSpeech("preview", TTS_PREVIEW_TEXT);
      return {
        ok: true,
        audio: wavFromPcm(outcome.pcm).toString("base64"),
        engine: outcome.engine,
        model: outcome.model,
        voice: outcome.voice,
        fallbackUsed: outcome.fallbackUsed,
        latencyMs: Date.now() - started,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        audio: null,
        engine: null,
        model: null,
        voice: null,
        fallbackUsed: false,
        latencyMs: Date.now() - started,
        error: errorText(error),
      };
    }
  }

  async macVoices(): Promise<{ voices: MacVoice[] }> {
    return { voices: await listMacVoices(this.options.sayPath) };
  }

  async applyConfig(): Promise<VoiceStatus> {
    applySpeechConfig({ home: this.home, target: this.target(), store: this.state, backupDir: join(this.dataDir, "backups") });
    return this.status();
  }

  async revertConfig(): Promise<VoiceStatus> {
    revertSpeechConfig({ home: this.home, target: this.target(), store: this.state, backupDir: join(this.dataDir, "backups") });
    return this.status();
  }
}
