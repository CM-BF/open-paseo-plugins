import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_MODEL_ALIAS } from "../shared/contracts";
import { readJsonFile, writePrivateFileAtomic } from "./files";

type JsonObject = Record<string, unknown>;

/**
 * The only config keys this plugin writes. Everything else in config.json is left untouched.
 * The first four route dictation; the rest route voice mode speech in and out. `modelsDir` keeps
 * Paseo's local speech worker alive for voice turn detection: the daemon skips the local worker,
 * and with it the VAD, once no feature asks for local STT or TTS, unless modelsDir is set.
 */
export const SPEECH_KEYS = {
  provider: ["features", "dictation", "stt", "provider"],
  model: ["features", "dictation", "stt", "model"],
  apiKey: ["providers", "openai", "stt", "apiKey"],
  baseUrl: ["providers", "openai", "stt", "baseUrl"],
  voiceSttProvider: ["features", "voiceMode", "stt", "provider"],
  voiceSttModel: ["features", "voiceMode", "stt", "model"],
  voiceTtsProvider: ["features", "voiceMode", "tts", "provider"],
  voiceTtsModel: ["features", "voiceMode", "tts", "model"],
  ttsApiKey: ["providers", "openai", "tts", "apiKey"],
  ttsBaseUrl: ["providers", "openai", "tts", "baseUrl"],
  localModelsDir: ["providers", "local", "modelsDir"],
} as const;

type SpeechKey = keyof typeof SPEECH_KEYS;
const SPEECH_KEY_NAMES = Object.keys(SPEECH_KEYS) as SpeechKey[];
type PreviousValue = { present: false } | { present: true; value: unknown };
/** Older records only carry the four dictation keys. */
export type PreviousValues = Partial<Record<SpeechKey, PreviousValue>>;

export interface AppliedRecord {
  at: string;
  port: number;
  previous: PreviousValues;
}

interface StateFile {
  version: 1;
  applied?: AppliedRecord;
}

export interface ProxyTarget {
  port: number;
  token: string;
}

export function proxyBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPath(root: JsonObject, path: readonly string[]): PreviousValue {
  let node: unknown = root;
  for (const key of path) {
    if (!isObject(node) || !(key in node)) return { present: false };
    node = node[key];
  }
  return { present: true, value: node };
}

function setPath(root: JsonObject, path: readonly string[], value: unknown): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (!isObject(next)) node[key] = {};
    node = node[key] as JsonObject;
  }
  node[path[path.length - 1]] = value;
}

/** Deletes the key, then removes containers left empty by the deletion. */
function deletePath(root: JsonObject, path: readonly string[]): void {
  const chain: JsonObject[] = [root];
  for (const key of path.slice(0, -1)) {
    const next = chain[chain.length - 1][key];
    if (!isObject(next)) return;
    chain.push(next);
  }
  delete chain[chain.length - 1][path[path.length - 1]];
  for (let depth = chain.length - 1; depth > 0; depth -= 1) {
    if (Object.keys(chain[depth]).length > 0) break;
    delete chain[depth - 1][path[depth - 1]];
  }
}

export class PluginStateStore {
  private data: StateFile | null = null;

  constructor(readonly path: string) {}

  private load(): StateFile {
    if (this.data) return this.data;
    const raw = readJsonFile(this.path) as Partial<StateFile> | undefined;
    this.data = { version: 1, ...(raw?.applied ? { applied: raw.applied } : {}) };
    return this.data;
  }

  applied(): AppliedRecord | undefined {
    return this.load().applied;
  }

  setApplied(record: AppliedRecord | undefined): void {
    const data = this.load();
    if (record) data.applied = record;
    else delete data.applied;
    writePrivateFileAtomic(this.path, `${JSON.stringify(data, null, 2)}\n`);
  }
}

export function defaultModelsDir(home: string): string {
  return join(home, "models", "local-speech");
}

/** What every managed key should hold. An existing modelsDir is kept as is. */
function desiredValues(config: JsonObject, target: ProxyTarget, home: string): Record<SpeechKey, unknown> {
  const url = proxyBaseUrl(target.port);
  const modelsDir = getPath(config, SPEECH_KEYS.localModelsDir);
  return {
    provider: "openai",
    model: DAEMON_MODEL_ALIAS,
    apiKey: target.token,
    baseUrl: url,
    voiceSttProvider: "openai",
    voiceSttModel: DAEMON_MODEL_ALIAS,
    voiceTtsProvider: "openai",
    voiceTtsModel: DAEMON_MODEL_ALIAS,
    ttsApiKey: target.token,
    ttsBaseUrl: url,
    localModelsDir:
      modelsDir.present && typeof modelsDir.value === "string" && modelsDir.value.trim()
        ? modelsDir.value
        : defaultModelsDir(home),
  };
}

export interface SpeechInspection {
  /** Dictation and voice mode point at this plugin's proxy with the current port and token. */
  applied: boolean;
  /** Written by this plugin, but with an older port or token, or only partly (dictation only). */
  stale: boolean;
  provider: string;
  baseUrl: string | null;
  dictationDisabled: boolean;
}

export function inspectSpeechConfig(config: JsonObject, target: ProxyTarget, home: string): SpeechInspection {
  const desired = desiredValues(config, target, home);
  const applied = SPEECH_KEY_NAMES.every((key) => {
    const current = getPath(config, SPEECH_KEYS[key]);
    return current.present && current.value === desired[key];
  });
  const provider = getPath(config, SPEECH_KEYS.provider);
  const baseUrl = getPath(config, SPEECH_KEYS.baseUrl);
  const enabled = getPath(config, ["features", "dictation", "enabled"]);
  const providerId = provider.present && typeof provider.value === "string" ? provider.value.trim().toLowerCase() : "local";
  const url = baseUrl.present && typeof baseUrl.value === "string" ? baseUrl.value.trim() : null;
  const aliased = (["model", "voiceSttModel", "voiceTtsModel"] as const).some((key) => {
    const current = getPath(config, SPEECH_KEYS[key]);
    return current.present && current.value === DAEMON_MODEL_ALIAS;
  });
  return {
    applied,
    stale: !applied && aliased,
    provider: providerId,
    baseUrl: url,
    dictationDisabled: enabled.present && enabled.value === false,
  };
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function readDaemonConfig(home: string): JsonObject {
  const value = readJsonFile(configPath(home));
  if (value === undefined) throw new Error(`找不到 ${configPath(home)}`);
  if (!isObject(value)) throw new Error("config.json 不是 JSON 对象");
  return value;
}

export function configModifiedAt(home: string): Date | null {
  try {
    return statSync(configPath(home)).mtime;
  } catch {
    return null;
  }
}

const MAX_BACKUPS = 10;

function backupConfig(home: string, backupDir: string): string {
  const raw = readFileSync(configPath(home), "utf8");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(backupDir, `config-${stamp}.json`);
  writePrivateFileAtomic(path, raw);
  const backups = readdirSync(backupDir)
    .filter((name) => /^config-.*\.json$/.test(name))
    .sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS))) {
    rmSync(join(backupDir, name), { force: true });
  }
  return path;
}

function writeConfig(home: string, config: JsonObject): void {
  writePrivateFileAtomic(configPath(home), `${JSON.stringify(config, null, 2)}\n`);
}

function capturePrevious(config: JsonObject): Record<SpeechKey, PreviousValue> {
  return Object.fromEntries(SPEECH_KEY_NAMES.map((key) => [key, getPath(config, SPEECH_KEYS[key])])) as Record<
    SpeechKey,
    PreviousValue
  >;
}

/**
 * Pre-plugin values for a config this plugin already wrote. Recorded values win. A key without a
 * record is captured as it is now, unless it already holds what the plugin writes: then its
 * original is unknown and treated as absent, so a revert falls back to Paseo's default.
 */
function previousForOwnedConfig(
  config: JsonObject,
  desired: Record<SpeechKey, unknown>,
  recorded: PreviousValues | undefined,
  home: string,
): Record<SpeechKey, PreviousValue> {
  const current = capturePrevious(config);
  // Only Paseo's default models directory can be ours; a custom one was set by the user.
  const written: Record<SpeechKey, unknown> = { ...desired, localModelsDir: defaultModelsDir(home) };
  return Object.fromEntries(
    SPEECH_KEY_NAMES.map((key) => {
      const known = recorded?.[key];
      if (known) return [key, known];
      const value = current[key];
      return [key, value.present && value.value === written[key] ? { present: false } : value];
    }),
  ) as Record<SpeechKey, PreviousValue>;
}

/**
 * Points Paseo dictation at the local proxy. The daemon reads speech settings only at startup,
 * so the change takes effect after the next daemon restart.
 */
export function applySpeechConfig(options: {
  home: string;
  target: ProxyTarget;
  store: PluginStateStore;
  backupDir: string;
  now?: Date;
}): { changed: boolean; backupPath: string | null } {
  const config = readDaemonConfig(options.home);
  const inspection = inspectSpeechConfig(config, options.target, options.home);
  const existing = options.store.applied();
  if (inspection.applied && existing) return { changed: false, backupPath: null };
  const desired = desiredValues(config, options.target, options.home);
  // Keep the values from before the first apply when only our own port, token or scope changed.
  const previous =
    inspection.applied || inspection.stale
      ? previousForOwnedConfig(config, desired, existing?.previous, options.home)
      : capturePrevious(config);
  if (inspection.applied) {
    options.store.setApplied({
      at: (configModifiedAt(options.home) ?? options.now ?? new Date()).toISOString(),
      port: options.target.port,
      previous,
    });
    return { changed: false, backupPath: null };
  }
  const backupPath = backupConfig(options.home, options.backupDir);
  for (const key of SPEECH_KEY_NAMES) setPath(config, SPEECH_KEYS[key], desired[key]);
  writeConfig(options.home, config);
  options.store.setApplied({
    at: (options.now ?? new Date()).toISOString(),
    port: options.target.port,
    previous,
  });
  return { changed: true, backupPath };
}

/** Restores every managed key to its value before the first apply. */
export function revertSpeechConfig(options: {
  home: string;
  target: ProxyTarget;
  store: PluginStateStore;
  backupDir: string;
}): { changed: boolean; backupPath: string | null } {
  const config = readDaemonConfig(options.home);
  const inspection = inspectSpeechConfig(config, options.target, options.home);
  const record = options.store.applied();
  if (!inspection.applied && !inspection.stale) {
    // Someone changed speech settings since; their settings win.
    if (record) options.store.setApplied(undefined);
    return { changed: false, backupPath: null };
  }
  const backupPath = backupConfig(options.home, options.backupDir);
  const desired = desiredValues(config, options.target, options.home);
  const previous = previousForOwnedConfig(config, desired, record?.previous, options.home);
  for (const key of SPEECH_KEY_NAMES) {
    const value = previous[key];
    if (value.present) setPath(config, SPEECH_KEYS[key], value.value);
    else deletePath(config, SPEECH_KEYS[key]);
  }
  writeConfig(options.home, config);
  options.store.setApplied(undefined);
  return { changed: true, backupPath };
}

const FALSE_FLAGS = ["0", "false", "no", "n", "off"];

/** Speech env variables the daemon reads before config.json. */
export function speechEnvOverride(env: NodeJS.ProcessEnv): string | null {
  for (const name of ["PASEO_DICTATION_STT_PROVIDER", "PASEO_VOICE_STT_PROVIDER", "PASEO_VOICE_TTS_PROVIDER"]) {
    const provider = env[name]?.trim().toLowerCase();
    if (provider && provider !== "openai") return `环境变量 ${name}=${provider} 覆盖了配置文件。`;
  }
  const enabled = env.PASEO_DICTATION_ENABLED?.trim().toLowerCase();
  if (enabled && FALSE_FLAGS.includes(enabled)) return "环境变量 PASEO_DICTATION_ENABLED 关闭了听写。";
  return null;
}
