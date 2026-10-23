import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySpeechConfig,
  inspectSpeechConfig,
  PluginStateStore,
  revertSpeechConfig,
  speechEnvOverride,
} from "./daemon-config";
import { tempDir } from "./test-helpers";

const TOKEN = "proxy-token-0123456789-abcdefghijklmnop";

const BASE_CONFIG = {
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    mcp: { injectIntoAgents: true },
    cors: { allowedOrigins: ["https://app.paseo.sh"] },
    relay: { enabled: true },
  },
  app: { baseUrl: "https://app.paseo.sh" },
  pluginsEnabled: true,
  plugins: { "paseo-gemini-voice": { source: "directory", path: "/plugins/paseo-gemini-voice", enabled: true } },
};

function setup(config: unknown = BASE_CONFIG) {
  const home = tempDir("gemini-voice-home");
  const dataDir = join(home, "plugin-data", "paseo-gemini-voice");
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const store = new PluginStateStore(join(dataDir, "state.json"));
  const options = (port = 6791) => ({ home, target: { port, token: TOKEN }, store, backupDir: join(dataDir, "backups") });
  const read = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as Record<string, any>;
  const write = (value: unknown) => writeFileSync(join(home, "config.json"), JSON.stringify(value));
  return { home, dataDir, store, options, read, write };
}

describe("applySpeechConfig", () => {
  it("routes dictation and voice mode through the proxy and leaves everything else alone", () => {
    const { home, dataDir, store, options, read } = setup();
    expect(applySpeechConfig(options()).changed).toBe(true);
    const config = read();
    expect(config.features).toEqual({
      dictation: { stt: { provider: "openai", model: "paseo-gemini-voice" } },
      voiceMode: {
        stt: { provider: "openai", model: "paseo-gemini-voice" },
        tts: { provider: "openai", model: "paseo-gemini-voice" },
      },
    });
    expect(config.providers).toEqual({
      openai: {
        stt: { apiKey: TOKEN, baseUrl: "http://127.0.0.1:6791/v1" },
        tts: { apiKey: TOKEN, baseUrl: "http://127.0.0.1:6791/v1" },
      },
      // Keeps Paseo's local worker (voice turn detection) once no feature uses local STT or TTS.
      local: { modelsDir: join(home, "models", "local-speech") },
    });
    const { features: _features, providers: _providers, ...rest } = config;
    expect(rest).toEqual(BASE_CONFIG);
    expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dataDir, "backups"))).toHaveLength(1);
    expect(inspectSpeechConfig(config, { port: 6791, token: TOKEN }, home).applied).toBe(true);
    expect(store.applied()?.previous.voiceTtsProvider).toEqual({ present: false });
  });

  it("is idempotent", () => {
    const { options } = setup();
    applySpeechConfig(options());
    expect(applySpeechConfig(options()).changed).toBe(false);
  });

  it("round-trips through revert to the original file contents", () => {
    const { options, read } = setup();
    applySpeechConfig(options());
    expect(revertSpeechConfig(options()).changed).toBe(true);
    expect(read()).toEqual(BASE_CONFIG);
  });

  it("restores another OpenAI endpoint, a custom models directory and unrelated speech keys", () => {
    const custom = {
      ...BASE_CONFIG,
      features: {
        dictation: { stt: { provider: "openai", model: "gpt-4o-transcribe", language: "zh" } },
        voiceMode: { llm: { provider: "claude", model: "haiku" }, tts: { provider: "local", speakerId: 3 } },
      },
      providers: {
        openai: { apiKey: "sk-shared", stt: { apiKey: "sk-stt", baseUrl: "https://api.openai.com/v1" } },
        local: { modelsDir: "/Volumes/models" },
      },
    };
    const { home, options, read } = setup(custom);
    expect(inspectSpeechConfig(read(), { port: 6791, token: TOKEN }, home)).toMatchObject({
      applied: false,
      stale: false,
      provider: "openai",
    });
    applySpeechConfig(options());
    const applied = read();
    expect(applied.features.dictation.stt).toEqual({ provider: "openai", model: "paseo-gemini-voice", language: "zh" });
    expect(applied.features.voiceMode.llm).toEqual({ provider: "claude", model: "haiku" });
    expect(applied.features.voiceMode.tts).toEqual({ provider: "openai", model: "paseo-gemini-voice", speakerId: 3 });
    expect(applied.providers.openai.apiKey).toBe("sk-shared");
    expect(applied.providers.local.modelsDir).toBe("/Volumes/models");
    revertSpeechConfig(options());
    expect(read()).toEqual(custom);
  });

  it("keeps the original values across a port change", () => {
    const { home, options, read } = setup();
    applySpeechConfig(options(6791));
    const moved = options(6800);
    expect(inspectSpeechConfig(read(), moved.target, home)).toMatchObject({ applied: false, stale: true });
    applySpeechConfig(moved);
    expect(read().providers.openai.tts.baseUrl).toBe("http://127.0.0.1:6800/v1");
    revertSpeechConfig(moved);
    expect(read()).toEqual(BASE_CONFIG);
  });

  it("upgrades a dictation-only apply from an earlier version", () => {
    const original = { ...BASE_CONFIG, features: { voiceMode: { enabled: true } } };
    const { home, dataDir, options, read, write } = setup(original);
    // What the first version wrote: the four dictation keys and a four-key record.
    write({
      ...original,
      features: { voiceMode: { enabled: true }, dictation: { stt: { provider: "openai", model: "paseo-gemini-voice" } } },
      providers: { openai: { stt: { apiKey: TOKEN, baseUrl: "http://127.0.0.1:6791/v1" } } },
    });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "state.json"),
      JSON.stringify({
        version: 1,
        applied: {
          at: "2026-10-23T00:00:00.000Z",
          port: 6791,
          previous: {
            provider: { present: false },
            model: { present: false },
            apiKey: { present: false },
            baseUrl: { present: false },
          },
        },
      }),
    );
    const fresh = { ...options(), store: new PluginStateStore(join(dataDir, "state.json")) };
    expect(inspectSpeechConfig(read(), fresh.target, home)).toMatchObject({ applied: false, stale: true });
    expect(applySpeechConfig(fresh).changed).toBe(true);
    expect(read().features.voiceMode).toMatchObject({ enabled: true, tts: { provider: "openai" } });
    revertSpeechConfig(fresh);
    expect(read()).toEqual(original);
  });

  it("does not overwrite speech settings changed after the apply", () => {
    const { store, options, read, write } = setup();
    applySpeechConfig(options());
    const edited = read();
    edited.features = { dictation: { stt: { provider: "local", model: "parakeet-tdt-0.6b-v3-int8" } } };
    delete edited.providers;
    write(edited);
    expect(revertSpeechConfig(options()).changed).toBe(false);
    expect(read()).toEqual(edited);
    expect(store.applied()).toBeUndefined();
  });

  it("falls back to defaults when the apply record is lost, keeping a custom models directory", () => {
    const { dataDir, options, read, write } = setup();
    applySpeechConfig(options());
    write({ ...read(), providers: { ...read().providers, local: { modelsDir: "/Volumes/models" } } });
    writeFileSync(join(dataDir, "state.json"), "{}");
    const fresh = { ...options(), store: new PluginStateStore(join(dataDir, "state.json")) };
    expect(applySpeechConfig(fresh).changed).toBe(false);
    expect(fresh.store.applied()?.previous.baseUrl).toEqual({ present: false });
    revertSpeechConfig(fresh);
    expect(read()).toEqual({ ...BASE_CONFIG, providers: { local: { modelsDir: "/Volumes/models" } } });
  });

  it("reports a broken config file", () => {
    const { home, options } = setup();
    writeFileSync(join(home, "config.json"), "{ not json");
    expect(() => applySpeechConfig(options())).toThrow();
  });
});

describe("speechEnvOverride", () => {
  it("flags env variables that beat config.json", () => {
    expect(speechEnvOverride({ PASEO_DICTATION_STT_PROVIDER: "local" })).toMatch(/PASEO_DICTATION_STT_PROVIDER/);
    expect(speechEnvOverride({ PASEO_VOICE_TTS_PROVIDER: "local" })).toMatch(/PASEO_VOICE_TTS_PROVIDER/);
    expect(speechEnvOverride({ PASEO_DICTATION_ENABLED: "false" })).toMatch(/关闭/);
    expect(speechEnvOverride({ PASEO_DICTATION_STT_PROVIDER: "openai" })).toBeNull();
    expect(speechEnvOverride({})).toBeNull();
  });
});
