import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z, type ZodType } from "zod";
import { MCP_SERVER, PLUGIN_VERSION } from "../shared/ids";
import { describeError, log } from "./util";

// The agents reach the plugin's tools through a loopback MCP server: stateless JSON-RPC over
// streamable HTTP with JSON answers, which Claude and Codex both accept. Each agent gets its own
// URL and a bearer token signed with a secret only this host knows; a check-in's token stops
// working when its run ends.

const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY = 1024 * 1024;

export type McpRole = "assistant" | "checkin";

export interface McpCaller {
  role: McpRole;
  agentId: string;
  /** The check-in run; null for the assistant. */
  runId: string | null;
}

export interface McpTool {
  name: string;
  description: string;
  input: ZodType;
  roles: readonly McpRole[];
  /** Claude defers tool descriptions behind tool search unless asked to load them. */
  alwaysLoad?: boolean;
  run(args: never, caller: McpCaller): Promise<string> | string;
}

export function defineTool<Schema extends ZodType>(tool: Omit<McpTool, "input" | "run"> & { input: Schema; run(args: z.output<Schema>, caller: McpCaller): Promise<string> | string }): McpTool {
  return tool as unknown as McpTool;
}

export interface HttpMcpServer {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

export interface RelayOptions {
  secret(): string;
  port(): number | null;
  savePort(port: number): void;
  tools: readonly McpTool[];
  /** Whether this agent (and run) may still call: the current assistant, or a check-in in flight. */
  authorize(caller: McpCaller): boolean;
  instructions(role: McpRole): string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export class McpRelay {
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private boundPort: number | null = null;

  constructor(private readonly options: RelayOptions) {}

  /** Starts listening, on the previous port when it is free so saved agent configs keep working. */
  start(): Promise<number> {
    this.listening ??= (async () => {
      const server = createServer((request, response) => void this.handle(request, response));
      const listen = (port: number) =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            resolve((server.address() as { port: number }).port);
          });
        });
      const previous = this.options.port();
      let port: number;
      try {
        port = await listen(previous ?? 0);
      } catch (error) {
        log(`port ${previous} is taken (${describeError(error)}); the assistant needs a reload to reach its tools`);
        port = await listen(0);
      }
      this.server = server;
      this.boundPort = port;
      if (port !== previous) this.options.savePort(port);
      return port;
    })();
    return this.listening;
  }

  get port(): number | null {
    return this.boundPort;
  }

  async serverFor(caller: McpCaller): Promise<HttpMcpServer> {
    const port = await this.start();
    const path = caller.role === "assistant" ? `/mcp/assistant/${caller.agentId}` : `/mcp/checkin/${caller.runId}/${caller.agentId}`;
    return { type: "http", url: `http://127.0.0.1:${port}${path}`, headers: { Authorization: `Bearer ${this.token(caller)}` } };
  }

  /** Exact-tool preapprovals for Paseo's toolPolicy. */
  grants(role: McpRole): { kind: "mcp"; server: string; tool: string }[] {
    return this.options.tools.filter((tool) => tool.roles.includes(role)).map((tool) => ({ kind: "mcp" as const, server: MCP_SERVER, tool: tool.name }));
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private token(caller: McpCaller): string {
    return createHmac("sha256", this.options.secret()).update(`${caller.role}:${caller.runId ?? ""}:${caller.agentId}`).digest("hex");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const caller = parsePath(request.url ?? "");
      if (!caller) return send(response, 404, { error: "Not found" });
      if (!tokenMatches(this.token(caller), request.headers.authorization)) return send(response, 401, { error: "Unauthorized" });
      if (request.method === "GET") {
        // No server-to-client stream: tools answer each request directly.
        response.writeHead(405, { Allow: "POST, DELETE" }).end();
        return;
      }
      if (request.method === "DELETE") return send(response, 200, {});
      if (request.method !== "POST") return send(response, 405, { error: "Method not allowed" });
      if (!this.options.authorize(caller)) {
        return send(response, 403, { error: caller.role === "checkin" ? "This check-in has ended." : "This agent is no longer the assistant." });
      }
      const body = JSON.parse(await readBody(request)) as JsonRpcRequest | JsonRpcRequest[];
      const messages = Array.isArray(body) ? body : [body];
      const answers = (await Promise.all(messages.map((message) => this.answer(message, caller)))).filter((answer): answer is JsonRpcResponse => answer !== null);
      if (answers.length === 0) {
        response.writeHead(202).end();
        return;
      }
      send(response, 200, Array.isArray(body) ? answers : answers[0]);
    } catch (error) {
      send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: describeError(error) } });
    }
  }

  private async answer(message: JsonRpcRequest, caller: McpCaller): Promise<JsonRpcResponse | null> {
    const id = message.id ?? null;
    if (message.id === undefined || message.id === null) {
      if (message.method?.startsWith("notifications/")) return null;
    }
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message: text } });
    const tools = this.options.tools.filter((tool) => tool.roles.includes(caller.role));
    switch (message.method) {
      case "initialize": {
        const requested = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : PROTOCOL_VERSION;
        return ok({
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER, version: PLUGIN_VERSION },
          instructions: this.options.instructions(caller.role),
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: inputSchema(tool.input),
            ...(tool.alwaysLoad ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
          })),
        });
      case "tools/call": {
        const tool = tools.find((entry) => entry.name === message.params?.name);
        if (!tool) return fail(-32602, `Unknown tool ${String(message.params?.name)}`);
        const parsed = tool.input.safeParse(message.params?.arguments ?? {});
        if (!parsed.success) return ok({ content: [{ type: "text", text: `Invalid arguments. ${issues(parsed.error)}` }], isError: true });
        try {
          const text = await tool.run(parsed.data as never, caller);
          return ok({ content: [{ type: "text", text }] });
        } catch (error) {
          return ok({ content: [{ type: "text", text: describeError(error) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${String(message.method)}`);
    }
  }
}

function parsePath(url: string): McpCaller | null {
  const path = url.split("?")[0] ?? "";
  const assistant = /^\/mcp\/assistant\/([\w-]{1,100})$/.exec(path);
  if (assistant) return { role: "assistant", agentId: assistant[1]!, runId: null };
  const checkin = /^\/mcp\/checkin\/([\w-]{1,100})\/([\w-]{1,100})$/.exec(path);
  if (checkin) return { role: "checkin", runId: checkin[1]!, agentId: checkin[2]! };
  return null;
}

function tokenMatches(expected: string, header: string | undefined): boolean {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function inputSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return rest;
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}
