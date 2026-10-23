/**
 * Live checks against real Paseo daemons. Never edits the main daemon's config.json.
 *
 *   npx tsx server/live-smoke.ts status        Plugin RPCs on the main daemon; runs the sample when a key is saved.
 *   npx tsx server/live-smoke.ts e2e --fake    Isolated `paseo daemon run` whose dictation uses a standalone proxy
 *                                              backed by a fake Gemini API. Streams the sample like the app does.
 *   npx tsx server/live-smoke.ts e2e           Same, but through the installed plugin's proxy and the real Gemini API.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import OpenAI from "openai";
import { PLUGIN_ID, sampleRpc, statusRpc, TTS_PREVIEW_TEXT, voiceSettings } from "../shared/contracts";
import { inspectWav } from "./audio";
import { applySpeechConfig, PluginStateStore } from "./daemon-config";
import { SAMPLE_EXPECTED_TEXT, sampleWav } from "./sample";
import { VoiceService } from "./service";

const PASEO = process.env.PASEO_CLI ?? "/Applications/Paseo.app/Contents/Resources/bin/paseo";
const mainHome = process.env.PASEO_HOME || join(homedir(), ".paseo");

function connect(url: string, credentialPath: string): DaemonClient {
  return new DaemonClient({
    url,
    clientId: `gemini-voice-smoke-${randomUUID()}`,
    clientType: "cli",
    appVersion: "0.12.0",
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
    localCredential: async () => (await readFile(credentialPath, "utf8")).trim(),
    webSocketFactory: (target, options) =>
      new WebSocket(target, options?.protocols, { headers: options?.headers }) as unknown as WebSocketLike,
  });
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function status(): Promise<void> {
  const lock = JSON.parse(await readFile(join(mainHome, "paseo.pid"), "utf8")) as { listen: string };
  const client = connect(`ws://${lock.listen}/ws`, join(mainHome, "local-credential"));
  await client.connect();
  try {
    const current = statusRpc.output.parse(await client.invokePluginRpc(PLUGIN_ID, statusRpc.name, {}));
    console.log(JSON.stringify(current, null, 2));
    if (current.apiKey.configured) {
      const sample = sampleRpc.output.parse(await client.invokePluginRpc(PLUGIN_ID, sampleRpc.name, {}));
      console.log(JSON.stringify(sample, null, 2));
    }
  } finally {
    await client.close();
  }
}

/** Accepts Interactions API calls, checks their shape, and answers with a fixed transcript. */
async function startFakeGemini(): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model: string;
        input: Array<{ type: string; data: string; mime_type: string }>;
        store: boolean;
      };
      requests.push(body);
      assert.equal(request.headers["x-goog-api-key"], "fake-key");
      assert.equal(body.store, false);
      if (body.model === "gemini-3.8-flash-lite-tts") {
        // One second of a 24 kHz tone as headerless L16, like Gemini TTS with mime_type audio/l16.
        const samples = Int16Array.from({ length: 24_000 }, (_, index) => Math.round(6_000 * Math.sin(index / 8)));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", data: Buffer.from(samples.buffer).toString("base64") }] }] }));
        return;
      }
      assert.equal(body.model, "gemini-3.5-transcribe");
      const wav = inspectWav(Buffer.from(body.input[0].data, "base64"));
      assert.equal(body.input[0].mime_type, "audio/wav");
      assert.equal(wav?.sampleRate, 24_000, "Paseo resamples dictation to 24 kHz for OpenAI STT");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "completed",
          steps: [{ type: "model_output", content: [{ type: "text", text: `假识别 ${wav?.seconds.toFixed(1)} 秒` }] }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/v1beta`, requests };
}

async function waitForDaemon(url: string, credentialPath: string, child: ChildProcess): Promise<DaemonClient> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated daemon exited with ${child.exitCode}`);
    const client = connect(url, credentialPath);
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`isolated daemon did not accept connections: ${String(lastError)}`);
}

/** Sends the sample as 100 ms PCM chunks, the way the app's DictationStreamSender does. */
async function dictate(client: DaemonClient, wav: Buffer): Promise<string> {
  const info = inspectWav(wav);
  assert.ok(info && info.bitsPerSample === 16 && info.channels === 1);
  const dataOffset = wav.indexOf("data") + 8;
  const pcm = wav.subarray(dataOffset);
  const format = `audio/pcm;rate=${info.sampleRate};bits=16`;
  const dictationId = randomUUID();
  await client.startDictationStream(dictationId, format);
  const chunkBytes = (info.sampleRate / 10) * 2;
  let seq = 0;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes, seq += 1) {
    client.sendDictationStreamChunk(dictationId, seq, pcm.subarray(offset, offset + chunkBytes).toString("base64"), format);
  }
  const result = await client.finishDictationStream(dictationId, seq - 1);
  return result.text;
}

async function e2e(fake: boolean): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "gemini-voice-e2e-"));
  const daemonPort = await freePort();
  let fakeGemini: Awaited<ReturnType<typeof startFakeGemini>> | null = null;
  let standalone: VoiceService | null = null;
  let child: ChildProcess | null = null;
  let client: DaemonClient | null = null;
  try {
    let proxyPort: number;
    let token: string;
    if (fake) {
      fakeGemini = await startFakeGemini();
      standalone = new VoiceService({
        home,
        dataDir: join(home, "standalone-plugin-data"),
        env: { GEMINI_API_KEY: "fake-key" },
        geminiBaseUrl: fakeGemini.url,
        workerStart: async () => null,
      });
      proxyPort = await freePort();
      await standalone.start({ ...voiceSettings.schema.parse({}), port: proxyPort });
      token = standalone.credentials.proxyToken();
    } else {
      const credentials = JSON.parse(
        await readFile(join(mainHome, "plugin-data", PLUGIN_ID, "credentials.json"), "utf8"),
      ) as { proxyToken: string; geminiApiKey?: string };
      assert.ok(credentials.geminiApiKey, "Save a Gemini API key in the plugin settings first");
      proxyPort = Number(process.env.GEMINI_VOICE_PORT ?? 6791);
      token = credentials.proxyToken;
    }
    // A minimal daemon config, then the plugin's own apply, so the daemon's strict schema checks
    // exactly the keys the plugin writes.
    const base = {
      version: 1,
      daemon: { listen: `127.0.0.1:${daemonPort}`, relay: { enabled: false }, mcp: { enabled: false } },
      pluginsEnabled: false,
    };
    await writeFile(join(home, "config.json"), `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
    applySpeechConfig({
      home,
      target: { port: proxyPort, token },
      store: new PluginStateStore(join(home, "smoke-state.json")),
      backupDir: join(home, "smoke-backups"),
    });
    if (process.env.GEMINI_VOICE_SMOKE_DROP_MODELS_DIR === "1") {
      // Control run: without providers.local.modelsDir the daemon drops its local worker and VAD.
      const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as { providers: { local?: unknown } };
      delete config.providers.local;
      await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
    }
    const written = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
      features: { voiceMode: { tts: { model: string } } };
      providers: { openai: { tts: { apiKey: string; baseUrl: string } } };
    };
    child = spawn(PASEO, ["daemon", "run", "--home", home], {
      env: { ...process.env, PASEO_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
    try {
      client = await waitForDaemon(`ws://127.0.0.1:${daemonPort}/ws`, join(home, "local-credential"), child);
    } catch (error) {
      console.error(output.join("").slice(-4_000));
      throw error;
    }
    // `enabled` only mirrors the config switch; an empty `reason` means the feature is available.
    // Voice mode needs turn detection, STT and TTS to all resolve.
    type Capability = { enabled: boolean; reason: string };
    let capabilities: { voice?: { dictation?: Capability; voice?: Capability } } | undefined;
    const ready = (capability: Capability | undefined) => capability?.enabled === true && capability.reason === "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      capabilities = (client.getLastServerInfoMessage() as { capabilities?: typeof capabilities } | null)?.capabilities;
      if (ready(capabilities?.voice?.voice) && ready(capabilities?.voice?.dictation)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(ready(capabilities?.voice?.dictation), `dictation unavailable: ${JSON.stringify(capabilities)}`);
    assert.ok(ready(capabilities?.voice?.voice), `voice mode unavailable: ${JSON.stringify(capabilities)}`);

    const started = Date.now();
    const text = await dictate(client, sampleWav());
    const dictationMs = Date.now() - started;

    // Voice mode speech uses providers.openai.tts exactly like Paseo's OpenAITTS.
    const speechStarted = Date.now();
    const tts = new OpenAI({ apiKey: written.providers.openai.tts.apiKey, baseURL: written.providers.openai.tts.baseUrl });
    const speech = Buffer.from(
      await (await tts.audio.speech.create({ model: written.features.voiceMode.tts.model, voice: "alloy", input: TTS_PREVIEW_TEXT, response_format: "pcm" })).arrayBuffer(),
    );
    console.log(
      JSON.stringify(
        {
          mode: fake ? "fake Gemini" : "real Gemini",
          capabilities: capabilities?.voice,
          dictation: { expected: SAMPLE_EXPECTED_TEXT, text, ms: dictationMs },
          speech: { bytes: speech.length, seconds: speech.length / 2 / 24_000, ms: Date.now() - speechStarted },
        },
        null,
        2,
      ),
    );
    if (fakeGemini) {
      assert.match(text, /^假识别 4\.\d 秒$/);
      assert.equal(speech.length, 48_000);
    } else {
      assert.ok(text.length > 0, "Gemini returned an empty transcript");
      assert.ok(speech.length > 24_000, "speech is shorter than half a second");
    }
  } finally {
    await client?.close().catch(() => undefined);
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child?.kill("SIGKILL");
          resolve();
        }, 20_000);
        child?.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await standalone?.stop();
    await new Promise<void>((resolve) => (fakeGemini ? fakeGemini.server.close(() => resolve()) : resolve()));
    await rm(home, { recursive: true, force: true });
  }
}

/** Dictates the sample on the main daemon with whatever STT it currently uses. Read-only. */
async function baseline(): Promise<void> {
  const lock = JSON.parse(await readFile(join(mainHome, "paseo.pid"), "utf8")) as { listen: string };
  const client = connect(`ws://${lock.listen}/ws`, join(mainHome, "local-credential"));
  await client.connect();
  try {
    const started = Date.now();
    const text = await dictate(client, sampleWav());
    console.log(JSON.stringify({ mode: "main daemon dictation", expected: SAMPLE_EXPECTED_TEXT, text, ms: Date.now() - started }, null, 2));
  } finally {
    await client.close();
  }
}

const [command, flag] = process.argv.slice(2);
if (command === "status") await status();
else if (command === "baseline") await baseline();
else if (command === "e2e") await e2e(flag === "--fake");
else {
  console.error("usage: live-smoke.ts status | baseline | e2e [--fake]");
  process.exitCode = 2;
}
