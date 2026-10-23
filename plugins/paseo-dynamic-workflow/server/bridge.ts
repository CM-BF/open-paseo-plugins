import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { unlink } from "node:fs/promises";
import { PLUGIN_VERSION } from "../shared/ids";
import type { BindingStore } from "./bindings";
import type { AgentAccessStore } from "./agent-access";
import { toolDefinitions } from "./scripts";
import { ServiceError, type WorkflowService } from "./service";
import { describeError, log } from "./util";

const MAX_BODY = 2 * 1024 * 1024;

export interface BridgeOptions {
  service: WorkflowService;
  bindings: BindingStore;
  access: AgentAccessStore;
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
        throw error;
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
      return binding?.agentId ?? null;
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
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      send(response, error instanceof ServiceError && error.code === "too_large" ? 413 : 400,
        { error: { code: error instanceof ServiceError ? error.code : "invalid_request", message: describeError(error) } });
      return;
    }
    const args = (body && typeof body === "object" ? (body as { arguments?: unknown }).arguments : undefined) ?? {};
    const input = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const agentId = await this.callerId(request);
    try {
      if (match[1] === "list") {
        send(response, 200, { tools: agentId && this.options.access.enabled(agentId) ? toolDefinitions() : [] });
        return;
      }
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
    const requireEnabledAgent = (): string => {
      const id = requireAgent();
      if (!this.options.access.enabled(id)) {
        throw new ServiceError("workflow_disabled", "Dynamic workflows are disabled for this agent. Open this agent's Dynamic workflows panel and enable workflows for this agent, then retry.");
      }
      return id;
    };
    switch (tool) {
      case "workflow":
        return service.launch(requireEnabledAgent(), {
          ...(typeof input.script === "string" ? { script: input.script } : {}),
          ...(typeof input.scriptPath === "string" ? { scriptPath: input.scriptPath } : {}),
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(input.args !== undefined ? { args: input.args } : {}),
          ...(typeof input.resumeFromRunId === "string" ? { resumeFromRunId: input.resumeFromRunId } : {}),
        });
      case "workflow_status": {
        const wait = typeof input.waitSeconds === "number" && Number.isFinite(input.waitSeconds) ? Math.min(50, Math.max(0, input.waitSeconds)) : 0;
        return service.status(requireAgent(), typeof input.runId === "string" && input.runId ? input.runId : undefined, wait);
      }
      case "workflow_stop": {
        if (typeof input.runId !== "string" || !input.runId) throw new ServiceError("invalid_request", "runId is required");
        return service.stop(input.runId, { agentId: requireAgent() });
      }
      case "workflow_reference":
        requireEnabledAgent();
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
        chunks.length = 0;
        request.resume();
        return;
      }
      if (size <= MAX_BODY) chunks.push(chunk);
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
