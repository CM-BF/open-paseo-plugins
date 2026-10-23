import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** PCM16 mono WAV, the format Paseo's OpenAI speech provider uploads. */
export function makeWav(samples: Int16Array, sampleRate = 24_000): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
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
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function tone(seconds: number, amplitude = 8_000, sampleRate = 24_000): Int16Array {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * index) / sampleRate));
  }
  return samples;
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function interactionResponse(text: string): unknown {
  return {
    id: "v1_test",
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

/** A fetch stand-in for the Gemini API that records requests and replies from a queue. */
export function fakeFetch(replies: Array<Response | Error | ((call: RecordedCall, signal?: AbortSignal) => Promise<Response>)>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected Gemini request");
    if (reply instanceof Error) throw reply;
    if (typeof reply === "function") return reply(call, (init?.signal ?? undefined) as AbortSignal | undefined);
    return reply;
  }) as typeof fetch;
  return { impl, calls };
}
