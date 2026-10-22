import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { unlink } from "node:fs/promises";
import { PLUGIN_VERSION } from "../shared/ids";
import type { BindingStore } from "./bindings";
import { ServiceError, type WorkflowService } from "./service";
import { describeError, log } from "./util";

const MAX_BODY = 2 * 1024 * 1024;

export interface BridgeOptions {
  service: WorkflowService;
  bindings: BindingStore;
}

/**
 * The HTTP-over-unix-socket endpoint the MCP shim and the CLI call. The socket lives in the
 * plugin's 0700 state directory, so only the daemon's user can reach it.
 */
export class Bridge {
  private server: Server | null = null;
  listening = false;
  error: string | null = null;

  constructor(private readonly options: BridgeOptions) {}

  async start(socketPath: string): Promise<void> {
    await unlink(socketPath).catch(() => undefined);
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        log(`bridge request failed: ${describeError(error)}`);
        send(response, 500, { error: { code: "internal", message: describeError(error) } });
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    }).then(
      () => {
        this.listening = true;
        this.error = null;
      },
      (error) => {
        this.error = describeError(error);
        log(`bridge could not listen on ${socketPath}: ${this.error}`);
      },
    );
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = false;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async callerId(request: IncomingMessage): Promise<string | null> {
    const nonce = header(request, "x-dynamic-workflow-binding");
    if (nonce) {
      await this.options.bindings.load();
      const binding = this.options.bindings.get(nonce);
      if (binding) return binding.agentId;
    }
    return header(request, "x-dynamic-workflow-agent");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://bridge");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      send(response, 200, { ok: true, version: PLUGIN_VERSION });
      return;
    }
    const match = /^\/v1\/tools\/([a-z_]+)$/.exec(url.pathname);
    if (request.method !== "POST" || !match) {
      send(response, 404, { error: { code: "not_found", message: `No route ${request.method} ${url.pathname}` } });
      return;
    }
    const body = await readJson(request);
    const args = (body && typeof body === "object" ? (body as { arguments?: unknown }).arguments : undefined) ?? {};
    const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const agentId = await this.callerId(request);
    try {
      const text = await this.dispatch(match[1] ?? "", input, agentId);
      send(response, 200, { text });
    } catch (error) {
      const code = error instanceof ServiceError ? error.code : "error";
      send(response, error instanceof ServiceError ? 400 : 500, { error: { code, message: describeError(error) } });
    }
  }

  private async dispatch(tool: string, input: Record<string, unknown>, agentId: string | null): Promise<string> {
    const { service } = this.options;
    const requireAgent = (): string => {
      if (!agentId) {
        throw new ServiceError(
          "unknown_agent",
          "Cannot tell which Paseo agent is calling. Run this from a Paseo agent created after the plugin was installed (its MCP server or PASEO_AGENT_ID identifies it).",
        );
      }
      return agentId;
    };
    switch (tool) {
      case "workflow":
        return service.launch(requireAgent(), {
          ...(typeof input.script === "string" ? { script: input.script } : {}),
          ...(typeof input.scriptPath === "string" ? { scriptPath: input.scriptPath } : {}),
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(input.args !== undefined ? { args: input.args } : {}),
          ...(typeof input.resumeFromRunId === "string" ? { resumeFromRunId: input.resumeFromRunId } : {}),
        });
      case "workflow_status": {
        const wait = typeof input.waitSeconds === "number" && Number.isFinite(input.waitSeconds) ? Math.min(50, Math.max(0, input.waitSeconds)) : 0;
        return service.status(agentId, typeof input.runId === "string" && input.runId ? input.runId : undefined, wait);
      }
      case "workflow_stop": {
        if (typeof input.runId !== "string" || !input.runId) throw new ServiceError("invalid_request", "runId is required");
        return service.stop(input.runId, { agentId: requireAgent() });
      }
      case "workflow_reference":
        return service.reference();
      default:
        throw new ServiceError("not_found", `Unknown tool ${tool}`);
    }
  }
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ServiceError("too_large", "Request body is larger than 2 MB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ServiceError("invalid_request", "Request body is not JSON"));
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}
