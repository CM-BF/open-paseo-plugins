import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PLUGIN_ID } from "../shared/contracts";
import { resolveAudioMime } from "./audio";
import { GeminiError, type GeminiErrorKind } from "./gemini";
import { parseBoundary, parseMultipart } from "./multipart";
import { wavFromPcm } from "./tts";

/** Gemini accepts inline requests up to 20 MB; base64 adds a third. */
export const MAX_BODY_BYTES = 15 * 1024 * 1024;
const RETRY_LISTEN_MS = 2_000;

export interface ProxyTranscription {
  text: string;
  audioSeconds: number;
}

export interface ProxyDeps {
  authorize(token: string | undefined): boolean;
  transcribe(input: { audio: Buffer; mimeType: string }): Promise<ProxyTranscription>;
  /** Returns 24 kHz 16-bit mono PCM, the OpenAI `pcm` format Paseo plays. */
  speak(input: { text: string }): Promise<{ pcm: Buffer }>;
}

const MAX_SPEECH_BODY_BYTES = 256 * 1024;

export interface ProxyStatus {
  listening: boolean;
  port: number;
  error: string | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
  ) {
    super(message);
  }
}

const STATUS_BY_KIND: Readonly<Record<GeminiErrorKind, number>> = {
  auth: 401,
  quota: 429,
  model: 400,
  "bad-request": 400,
  server: 502,
  network: 502,
  timeout: 504,
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // The daemon's OpenAI SDK would otherwise retry 429/5xx twice and stall the dictation.
    "x-should-retry": "false",
  });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, message: string, type: string): void {
  sendJson(response, status, { error: { message, type, code: null } });
}

function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // Keep draining so the error response still reaches the caller.
      if (size <= limit) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > limit) reject(new HttpError(413, "请求太大。"));
      else resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match?.[1]?.trim();
}

/**
 * OpenAI-compatible `/v1/audio/transcriptions` on 127.0.0.1. Paseo's dictation uses its OpenAI
 * speech provider against this address; each request is transcribed by Gemini.
 */
export class TranscriptionProxy {
  private server: Server | null = null;
  private port = 0;
  private listening = false;
  private error: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(private readonly deps: ProxyDeps) {}

  status(): ProxyStatus {
    return { listening: this.listening, port: this.port, error: this.error };
  }

  /** Listens on the port, retrying while another process (an old plugin instance) holds it. */
  async start(port: number): Promise<void> {
    await this.stop();
    const generation = ++this.generation;
    this.port = port;
    await this.tryListen(generation);
  }

  private tryListen(generation: number): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((request, response) => {
        void this.handle(request, response);
      });
      server.requestTimeout = 60_000;
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeAllListeners();
        if (generation !== this.generation) return resolve();
        this.listening = false;
        this.error =
          error.code === "EADDRINUSE" ? `端口 ${this.port} 被其他程序占用，正在重试。` : `本地转发启动失败：${error.message}`;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (generation === this.generation) void this.tryListen(generation);
        }, RETRY_LISTEN_MS);
        resolve();
      };
      server.once("error", onError);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", onError);
        if (generation !== this.generation) {
          server.close();
          return resolve();
        }
        server.on("error", (error) => console.error("[gemini-voice] proxy error", error));
        this.server = server;
        this.listening = true;
        this.error = null;
        const address = server.address();
        if (address && typeof address === "object") this.port = address.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const server = this.server;
    this.server = null;
    this.listening = false;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** OpenAI `audio.speech.create`: JSON in, raw audio out. Paseo always asks for `pcm`. */
  private async handleSpeech(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: { input?: unknown; response_format?: unknown };
    try {
      body = JSON.parse((await readBody(request, MAX_SPEECH_BODY_BYTES)).toString("utf8")) as typeof body;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "朗读请求不是合法的 JSON。");
    }
    if (typeof body.input !== "string" || body.input.trim().length === 0) throw new HttpError(400, "没有要朗读的文字。");
    const format = typeof body.response_format === "string" ? body.response_format : "mp3";
    if (format !== "pcm" && format !== "wav") throw new HttpError(400, `不支持的 response_format：${format}，只支持 pcm 和 wav。`);
    const { pcm } = await this.deps.speak({ text: body.input });
    const audio = format === "wav" ? wavFromPcm(pcm) : pcm;
    response.writeHead(200, {
      "content-type": format === "wav" ? "audio/wav" : "audio/pcm",
      "content-length": audio.length,
    });
    response.end(audio);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true, service: PLUGIN_ID });
        return;
      }
      if (url.pathname !== "/v1/audio/transcriptions" && url.pathname !== "/v1/audio/speech") {
        throw new HttpError(404, `未知路径 ${url.pathname}`);
      }
      if (request.method !== "POST") throw new HttpError(405, "只支持 POST。");
      if (!this.deps.authorize(bearer(request))) {
        throw new HttpError(401, "本地转发令牌不匹配：在 Gemini 语音设置里重新写入配置。", "authentication_error");
      }
      if (url.pathname === "/v1/audio/speech") {
        await this.handleSpeech(request, response);
        return;
      }
      const boundary = parseBoundary(request.headers["content-type"]);
      if (!boundary) throw new HttpError(400, "请求必须是 multipart/form-data。");
      const parts = parseMultipart(await readBody(request), boundary);
      const file = parts.find((part) => part.name === "file");
      if (!file || file.data.length === 0) throw new HttpError(400, "请求里没有音频文件。");
      const format = parts.find((part) => part.name === "response_format")?.data.toString("utf8").trim() || "json";
      if (!["json", "text", "verbose_json"].includes(format)) {
        throw new HttpError(400, `不支持的 response_format：${format}`);
      }
      const mimeType = resolveAudioMime(file.filename, file.contentType, file.data);
      const result = await this.deps.transcribe({ audio: file.data, mimeType });
      if (format === "text") {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(result.text);
        return;
      }
      if (format === "verbose_json") {
        sendJson(response, 200, { task: "transcribe", text: result.text, duration: result.audioSeconds, segments: [] });
        return;
      }
      sendJson(response, 200, { text: result.text });
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message, error.type);
      } else if (error instanceof GeminiError) {
        sendError(response, STATUS_BY_KIND[error.kind], error.message, `gemini_${error.kind.replace("-", "_")}`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[gemini-voice] transcription failed", error);
        sendError(response, 500, `识别失败：${message}`, "server_error");
      }
    }
  }
}
