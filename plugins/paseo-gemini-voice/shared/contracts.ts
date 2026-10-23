import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const PLUGIN_ID = "paseo-gemini-voice";
export const DEFAULT_PORT = 6791;
export const TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
export const FALLBACK_MODEL = "gemini-3.5-flash-lite";
export const TTS_MODEL = "gemini-3.8-flash-lite-tts";
export const DEFAULT_TTS_VOICE = "Kore";
export const DEFAULT_MAC_VOICE = "Tingting";
/** Sent by the daemon as the OpenAI `model` field; the proxy picks the real Gemini model. */
export const DAEMON_MODEL_ALIAS = "paseo-gemini-voice";

export const MODEL_OPTIONS = [
  { value: "gemini-3.5-transcribe", label: "Gemini 3.5 Transcribe（推荐）" },
  { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
] as const;

export const FALLBACK_OPTIONS = [
  ...MODEL_OPTIONS,
  { value: "", label: "不使用备用模型" },
] as const;

export const MODE_OPTIONS = [
  { value: "smart", label: "整理：去掉口头禅和改口" },
  { value: "verbatim", label: "逐字" },
] as const;

export const LANGUAGE_OPTIONS = [
  { value: "auto", label: "自动识别（中英混说）" },
  { value: "zh-en", label: "提示：普通话和英语" },
  { value: "zh", label: "提示：普通话" },
  { value: "en", label: "提示：英语" },
] as const;

export const TTS_ENGINE_OPTIONS = [
  { value: "gemini", label: "Gemini（声音自然，需要联网）" },
  { value: "macos", label: "macOS 本地（离线、免费、更快）" },
] as const;

export const TTS_MODEL_OPTIONS = [
  { value: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash-Lite TTS（快，推荐）" },
  { value: "gemini-3.8-flash-tts", label: "Gemini 3.8 Flash TTS（更细腻）" },
] as const;

/** Gemini's 30 prebuilt voices with the style the docs give each one. */
export const TTS_VOICE_OPTIONS = [
  ["Kore", "坚定"],
  ["Aoede", "轻松"],
  ["Leda", "年轻"],
  ["Zephyr", "明亮"],
  ["Puck", "轻快"],
  ["Charon", "知性"],
  ["Fenrir", "激昂"],
  ["Orus", "坚定"],
  ["Callirrhoe", "随和"],
  ["Autonoe", "明亮"],
  ["Enceladus", "气声"],
  ["Iapetus", "清晰"],
  ["Umbriel", "随和"],
  ["Algieba", "圆润"],
  ["Despina", "圆润"],
  ["Erinome", "清晰"],
  ["Algenib", "沙哑"],
  ["Rasalgethi", "知性"],
  ["Laomedeia", "欢快"],
  ["Achernar", "柔和"],
  ["Alnilam", "坚定"],
  ["Schedar", "平稳"],
  ["Gacrux", "成熟"],
  ["Pulcherrima", "直率"],
  ["Achird", "友好"],
  ["Zubenelgenubi", "随意"],
  ["Vindemiatrix", "温柔"],
  ["Sadachbia", "活泼"],
  ["Sadaltager", "博学"],
  ["Sulafat", "温暖"],
].map(([value, style]) => ({ value, label: `${value} · ${style}` }));

export const TTS_PREVIEW_TEXT = "你好，我是 Paseo 的语音助手。我们可以用中文聊天，也可以夹着 English 说。";

/** Terms speech models often mishear in coding conversations. Users can edit the list. */
export const DEFAULT_VOCABULARY = [
  "Paseo",
  "Claude",
  "Claude Code",
  "Codex",
  "Gemini",
  "Anthropic",
  "OpenAI",
  "GPT",
  "TypeScript",
  "JavaScript",
  "React Native",
  "Node.js",
  "npm",
  "GitHub",
  "pull request",
  "commit",
  "rebase",
  "worktree",
  "daemon",
  "plugin",
  "MCP",
  "SDK",
  "API",
  "JSON",
  "YAML",
  "Flowly",
  "kanban",
  "Hermes",
  "Expo",
  "Vitest",
  "Zod",
  "Electron",
  "macOS",
  "iOS",
  "Android",
];

export const ModeSchema = z.enum(["smart", "verbatim"]);
export const LanguagesSchema = z.enum(["auto", "zh-en", "zh", "en"]);

export const voiceSettings = defineSettings({
  id: "voice",
  scope: "host",
  version: 1,
  schema: z.object({
    model: z.string().trim().min(1).default(TRANSCRIBE_MODEL),
    fallbackModel: z.string().trim().default(FALLBACK_MODEL),
    mode: ModeSchema.default("smart"),
    languages: LanguagesSchema.default("auto"),
    vocabulary: z.array(z.string().trim().min(1).max(120)).max(1000).default(DEFAULT_VOCABULARY),
    port: z.number().int().min(1024).max(65535).default(DEFAULT_PORT),
    ttsEngine: z.enum(["gemini", "macos"]).default("gemini"),
    ttsModel: z.string().trim().min(1).default(TTS_MODEL),
    ttsVoice: z.string().trim().min(1).default(DEFAULT_TTS_VOICE),
    macVoice: z.string().trim().min(1).default(DEFAULT_MAC_VOICE),
  }),
});

export type VoiceSettings = z.output<typeof voiceSettings.schema>;

const LastRequestSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  source: z.enum(["dictation", "sample"]),
  model: z.string().nullable(),
  fallbackUsed: z.boolean(),
  audioSeconds: z.number(),
  latencyMs: z.number(),
  textPreview: z.string().nullable(),
  error: z.string().nullable(),
});

const LastSpeechSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  source: z.enum(["voice", "preview"]),
  engine: z.enum(["gemini", "macos"]).nullable(),
  model: z.string().nullable(),
  voice: z.string().nullable(),
  fallbackUsed: z.boolean(),
  chars: z.number(),
  chunks: z.number(),
  audioSeconds: z.number(),
  latencyMs: z.number(),
  error: z.string().nullable(),
});

export const DictationStateSchema = z.enum([
  "active",
  "pending-restart",
  "not-applied",
  "foreign",
  "overridden",
  "error",
]);

export const StatusSchema = z.object({
  apiKey: z.object({
    configured: z.boolean(),
    source: z.enum(["plugin", "env"]).nullable(),
    hint: z.string().nullable(),
  }),
  proxy: z.object({
    listening: z.boolean(),
    port: z.number(),
    url: z.string(),
    error: z.string().nullable(),
  }),
  dictation: z.object({
    state: DictationStateSchema,
    detail: z.string(),
    appliedAt: z.string().nullable(),
    workerStartedAt: z.string().nullable(),
    canApply: z.boolean(),
    canRevert: z.boolean(),
  }),
  last: LastRequestSchema.nullable(),
  lastSpeech: LastSpeechSchema.nullable(),
  counters: z.object({
    requests: z.number(),
    failures: z.number(),
    audioSeconds: z.number(),
  }),
});

export type VoiceStatus = z.output<typeof StatusSchema>;
export type LastRequest = z.output<typeof LastRequestSchema>;
export type LastSpeech = z.output<typeof LastSpeechSchema>;

const CheckResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

export const statusRpc = defineRpc({
  name: "voice.status",
  input: z.object({}),
  output: StatusSchema,
});

export const saveKeyRpc = defineRpc({
  name: "voice.key.save",
  input: z.object({ apiKey: z.string().trim().min(10).max(400) }),
  output: z.object({ hint: z.string(), check: CheckResultSchema }),
});

export const clearKeyRpc = defineRpc({
  name: "voice.key.clear",
  input: z.object({}),
  output: z.object({ cleared: z.boolean() }),
});

export const checkRpc = defineRpc({
  name: "voice.check",
  input: z.object({}),
  output: CheckResultSchema,
});

export const sampleRpc = defineRpc({
  name: "voice.sample",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    expected: z.string(),
    text: z.string(),
    model: z.string().nullable(),
    latencyMs: z.number(),
    error: z.string().nullable(),
  }),
});

export const speechPreviewRpc = defineRpc({
  name: "voice.tts.preview",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    /** Base64 WAV, played on the client with playAudio. */
    audio: z.string().nullable(),
    engine: z.enum(["gemini", "macos"]).nullable(),
    model: z.string().nullable(),
    voice: z.string().nullable(),
    fallbackUsed: z.boolean(),
    latencyMs: z.number(),
    error: z.string().nullable(),
  }),
});

export const macVoicesRpc = defineRpc({
  name: "voice.tts.mac-voices",
  input: z.object({}),
  output: z.object({ voices: z.array(z.object({ name: z.string(), locale: z.string() })) }),
});

export const applyConfigRpc = defineRpc({
  name: "voice.config.apply",
  input: z.object({}),
  output: StatusSchema,
});

export const revertConfigRpc = defineRpc({
  name: "voice.config.revert",
  input: z.object({}),
  output: StatusSchema,
});
