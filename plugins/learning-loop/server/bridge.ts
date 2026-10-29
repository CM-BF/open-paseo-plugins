// HTTP over a unix socket in the state directory (owner-only). The stdio MCP shim that agents run
// forwards tool calls here; every call carries the agent's binding nonce.

import { chmod, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PLUGIN_VERSION } from "../shared/constants";
import { describeError } from "./files";
import type { ToolDefinition, ToolResult } from "./tools";

const MAX_BODY = 4 * 1024 * 1024;

export interface BridgeHandlers {
  tools(binding?: string | null): ToolDefinition[];
  call(name: string, args: unknown, headers: { binding: string | null; agentId: string | null; cwd: string | null }): Promise<ToolResult>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value ? value : null;
}

export class Bridge {
  private server: Server | null = null;

  constructor(private readonly handlers: BridgeHandlers) {}

  async start(socketPath: string): Promise<void> {
    await rm(socketPath, { force: true });
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error) => send(response, 500, { error: { code: "internal", message: describeError(error) } }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600).catch(() => undefined);
    this.server = server;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://bridge");
    if (request.method === "GET" && url.pathname === "/v1/health") return send(response, 200, { ok: true, version: PLUGIN_VERSION });
    if (request.method === "GET" && url.pathname === "/v1/tools") return send(response, 200, { tools: this.handlers.tools(header(request, "x-learning-binding")) });
    if (request.method === "POST" && url.pathname === "/v1/call") {
      let body: { name?: unknown; arguments?: unknown };
      try {
        body = JSON.parse(await readBody(request)) as typeof body;
      } catch (error) {
        return send(response, 400, { error: { code: "bad_request", message: describeError(error) } });
      }
      if (typeof body.name !== "string") return send(response, 400, { error: { code: "bad_request", message: "name is required" } });
      const cwdEncoded = header(request, "x-learning-cwd-enc");
      const result = await this.handlers.call(body.name, body.arguments, {
        binding: header(request, "x-learning-binding"),
        agentId: header(request, "x-learning-agent"),
        cwd: cwdEncoded ? decodeURIComponent(cwdEncoded) : null,
      });
      return send(response, 200, result);
    }
    send(response, 404, { error: { code: "not_found", message: `${request.method} ${url.pathname}` } });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
  }
}
