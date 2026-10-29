import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { BoardService } from "./service";

const RequestSchema = z.object({ protocol: z.literal(1), operation: z.enum(["list", "read", "create", "publish", "decision", "emit"]), input: z.record(z.string(), z.unknown()), binding: z.string().optional(), client: z.enum(["cli", "mcp"]) });
const LIMIT = 8_000_000;

/** Owner-only Unix socket. MCP calls additionally bind to the launching agent. */
export class BoardBridge {
  private service: BoardService;
  private server?: Server;
  private sockets = new Set<Socket>();
  private path?: string;
  private stopped = false;
  constructor(service: BoardService) { this.service = service; }
  async start(path: string): Promise<void> {
    if (this.stopped) return;
    if (Buffer.byteLength(path) > 100) throw new Error("Board socket path exceeds Unix socket limit; use a shorter PASEO_HOME");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(path);
      if (!info.isSocket()) throw new Error("Refusing to replace a non-socket Board endpoint");
      const alive = await new Promise<boolean>((resolve) => {
        const probe = createConnection(path);
        probe.setTimeout(500);
        probe.once("connect", () => { probe.destroy(); resolve(true); });
        probe.once("error", (error) => { probe.destroy(); resolve(!["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")); });
        probe.once("timeout", () => { probe.destroy(); resolve(true); });
      });
      if (alive) throw new Error("A Board service is already listening at this path");
      await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (this.stopped) return;
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
    this.path = path;
    await chmod(path, 0o600);
    if (this.stopped) await this.close();
  }
  private accept(socket: Socket): void {
    this.sockets.add(socket);
    let chunks: Buffer[] = [];
    let bytes = 0;
    let submitted = false;
    socket.setTimeout(15000, () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      if (submitted) return;
      bytes += chunk.byteLength;
      if (bytes > LIMIT) { socket.end(JSON.stringify({ ok: false, error: { code: "too_large", message: "Request exceeds 8 MB" } }) + "\n"); submitted = true; return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      submitted = true;
      const line = Buffer.concat(chunks).toString("utf8").split("\n", 1)[0]; chunks = [];
      void this.dispatch(line).then((response) => socket.end(JSON.stringify(response) + "\n"));
    });
  }
  async dispatch(line: string): Promise<unknown> {
    try {
      const request = RequestSchema.parse(JSON.parse(line));
      const actor = request.binding ? this.service.journal.binding(request.binding) : undefined;
      if ((request.client === "mcp" && !request.binding) || (request.binding && !actor)) throw new Error("Missing or invalid Board agent binding; reload the agent session");
      const result = await this.service.execute(request.operation, request.input, actor);
      return { ok: true, result };
    } catch (error) {
      const candidate = error as { code?: string; details?: unknown; message?: string };
      return { ok: false, error: { code: candidate.code ?? "request_failed", message: candidate.message ?? String(error), ...(candidate.details ? { details: candidate.details } : {}) } };
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const socket of this.sockets) socket.destroy();
    const server = this.server;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.path) await unlink(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    this.server = undefined; this.path = undefined;
  }
}
