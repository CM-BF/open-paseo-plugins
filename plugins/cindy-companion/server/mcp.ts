import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { CompanionProfile, InvokeResult } from '../shared/contracts';
import { sessionScopeSchema, type SessionScope } from '../shared/session-scope';

export interface CompanionSessionTools {
  botId: string;
  scope: SessionScope;
  invoke(op: string, args: Record<string, unknown>): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }>;
}

export interface CompanionMcpDependencies {
  root: string;
  safePath(path: string): Promise<void>;
  readProfile(botId: string): Promise<CompanionProfile>;
  invokeMemory(botId: string, op: string, args: Record<string, unknown>): Promise<InvokeResult>;
  validateScope?(botId: string, scope: SessionScope): Promise<void>;
  invokeSession?(botId: string, scope: SessionScope, op: string, args: Record<string, unknown>): Promise<InvokeResult>;
  registerSessionTools?(server: McpServer, context: CompanionSessionTools): void;
}
interface Endpoint { version: 1; port: number; secret: string }
export interface CompanionMcpConfig { type: 'http'; url: string; headers: Record<string, string>; alwaysLoad: true }

/** Shares the UI's memory store. No second process or independent file writer is created. */
export class CompanionMcpServer {
  private readonly deps: CompanionMcpDependencies;
  private endpoint: Endpoint | null = null;
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private readonly requests = new Set<McpServer>();
  private readonly operations = new Set<Promise<unknown>>();
  private receiving = 0;
  constructor(deps: CompanionMcpDependencies) { this.deps = deps; }

  async configFor(botId: string, scope?: SessionScope): Promise<CompanionMcpConfig> {
    await this.deps.readProfile(botId);
    const encodedScope = scope ? Buffer.from(JSON.stringify(sessionScopeSchema.parse(scope))).toString('base64url') : undefined;
    if (encodedScope && (!this.deps.validateScope || !this.deps.invokeSession || !this.deps.registerSessionTools)) throw new Error('Session tools are not configured');
    if (!this.starting) {
      const attempt = this.start();
      this.starting = attempt;
      void attempt.catch(() => { if (this.starting === attempt) this.starting = null; });
    }
    await this.starting;
    if (this.disposed || !this.endpoint) throw new Error('Companion tools are closed');
    return { type: 'http', url: `http://127.0.0.1:${this.endpoint.port}/mcp/${botId}${encodedScope ? `/session/${encodedScope}` : ''}`,
      headers: { Authorization: `Bearer ${this.token(botId, encodedScope)}` }, alwaysLoad: true };
  }
  private token(botId: string, encodedScope?: string): string {
    return createHmac('sha256', this.endpoint!.secret).update(encodedScope ? `session-v1\0${botId}\0${encodedScope}` : botId).digest('hex');
  }
  private async start(): Promise<void> {
    const path = join(this.deps.root, 'mcp-endpoint.json');
    await this.deps.safePath(path);
    let saved: Endpoint | undefined;
    try {
      const candidate = JSON.parse(await readFile(path, 'utf8'));
      if (candidate.version !== 1 || !Number.isInteger(candidate.port) || candidate.port < 1024 || candidate.port > 65535 || !/^[a-f0-9]{64}$/.test(candidate.secret)) throw new Error('Invalid companion tool endpoint');
      saved = candidate;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (this.disposed) throw new Error('Companion tools are closed');
    const server = createServer((req, res) => { void this.receive(req, res); });
    this.server = server;
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    try { await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      server.once('error', fail);
      server.listen(saved?.port ?? 0, '127.0.0.1', () => { server.off('error', fail); resolve(); });
    }); } catch (error) { await this.stopServer(); throw error; }
    if (this.disposed) { await this.stopServer(); throw new Error('Companion tools are closed'); }
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Companion tool endpoint did not bind');
    this.endpoint = saved ?? { version: 1, port: address.port, secret: randomBytes(32).toString('hex') };
    try {
      if (!saved) {
        const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
        await writeFile(temporary, JSON.stringify(this.endpoint), { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
      }
    } catch (error) { await this.stopServer(); throw error; }
  }
  private async receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reject = (status: number, message: string) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: message })); };
    let admitted = false;
    try {
      if (this.disposed || !this.endpoint) return reject(503, 'Companion tools are starting');
      const path = /^\/mcp\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,99})(?:\/session\/([A-Za-z0-9_-]{1,2048}))?$/.exec(req.url ?? '');
      if (!path) return reject(404, 'Not found');
      // Agent MCP clients do not send Origin. Browser origins cannot use this daemon-local API.
      if (req.headers.origin || ![`127.0.0.1:${this.endpoint.port}`, `localhost:${this.endpoint.port}`].includes(req.headers.host ?? '')) return reject(403, 'Invalid origin');
      const auth = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const expected = this.token(path[1], path[2]);
      if (!/^[a-f0-9]{64}$/.test(auth) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return reject(401, 'Unauthorized');
      if (req.method !== 'POST') return reject(405, 'Use POST');
      if (this.receiving + this.requests.size + this.operations.size >= 16) return reject(429, 'Too many companion tool requests');
      this.receiving++; admitted = true;
      const scope = path[2] ? Object.freeze(sessionScopeSchema.parse(JSON.parse(Buffer.from(path[2], 'base64url').toString('utf8')))) : undefined;
      if (scope) {
        if (!this.deps.validateScope || !this.deps.invokeSession || !this.deps.registerSessionTools) return reject(403, 'Session tools are unavailable');
        await this.deps.validateScope(path[1], scope);
      }
      const profile = await this.deps.readProfile(path[1]);
      if (!profile.enabled || profile.status !== 'active') return reject(403, 'Companion is paused');
      const parts: Buffer[] = []; let bytes = 0;
      for await (const part of req) {
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > 128 * 1024) return reject(413, 'Request too large');
        parts.push(chunk);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { return reject(400, 'Invalid JSON'); }
      if (this.disposed) return reject(503, 'Companion tools are closed');
      const mcp = this.createTools(profile.id, scope);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      this.requests.add(mcp);
      res.once('close', () => { this.requests.delete(mcp); void mcp.close(); });
      await mcp.connect(transport);
      if (this.disposed) { await mcp.close(); return reject(503, 'Companion tools are closed'); }
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) reject(500, error instanceof Error ? error.message : 'Companion tool request failed');
      else res.end();
    } finally { if (admitted) this.receiving--; }
  }
  private runTool<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Companion tools are closed'));
    const job = Promise.resolve().then(operation);
    this.operations.add(job);
    void job.finally(() => { this.operations.delete(job); }).catch(() => {});
    return job;
  }
  private createTools(botId: string, scope?: SessionScope): McpServer {
    const mcp = new McpServer({ name: 'cindy-companion', version: '0.1.0' });
    const output = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError });
    const scoped = <T>(operation: () => Promise<T>) => this.runTool(async () => {
      if (scope) await this.deps.validateScope!(botId, scope);
      return operation();
    });
    const invoke = (op: string, args: Record<string, unknown>) => scoped(async () => {
      const profile = await this.deps.readProfile(botId);
      if (!profile.enabled || profile.status !== 'active' || !profile.capabilities.memory) return output({ code: 'MEMORY_DISABLED', message: 'Memory is disabled for this teammate.' }, true);
      const result = await this.deps.invokeMemory(botId, op, args);
      return output(result.ok ? result.value : result, !result.ok);
    });
    mcp.registerTool('companion_context', {
      description: 'Read this teammate’s current identity, user context and memory setting. Read at the beginning of each turn; saved settings may have changed.',
      inputSchema: {}, annotations: { readOnlyHint: true },
    }, () => scoped(async () => {
      const p = await this.deps.readProfile(botId);
      if (!p.enabled || p.status !== 'active') return output({ code: 'COMPANION_PAUSED' }, true);
      const result = await this.deps.invokeMemory(botId, 'profile.context', {});
      return output(result.ok ? result.value : result, !result.ok);
    }));
    mcp.registerTool('memory_list', { description: 'List or search this teammate’s durable memories. All tools share the same store as the Memory settings page.',
      inputSchema: { query: z.string().max(1000).optional() }, annotations: { readOnlyHint: true } }, args => invoke('memory.list', args));
    mcp.registerTool('memory_read', { description: 'Read a memory including its updatedAt version for conflict-safe edits.',
      inputSchema: { filename: z.string().max(100) }, annotations: { readOnlyHint: true } }, args => invoke('memory.read', args));
    mcp.registerTool('memory_write', { description: 'Save a durable fact or preference. Do not save temporary progress or secrets. Existing names are not silently overwritten.',
      inputSchema: { type: z.enum(['user', 'feedback', 'project', 'reference']), name: z.string().regex(/^[a-z0-9_-]{1,64}$/), title: z.string().min(1).max(100), description: z.string().max(200).optional(), body: z.string().min(1).max(8192) } }, args => invoke('memory.create', args));
    mcp.registerTool('memory_update', { description: 'Update a memory read earlier. Supply its exact updatedAt to protect concurrent user edits.',
      inputSchema: { filename: z.string().max(100), title: z.string().min(1).max(100), body: z.string().min(1).max(8192), expectedUpdatedAt: z.string().max(64) } }, args => invoke('memory.update', args));
    mcp.registerTool('memory_delete', { description: 'Remove an obsolete memory, with the exact updatedAt from memory_read.',
      inputSchema: { filename: z.string().max(100), expectedUpdatedAt: z.string().max(64) }, annotations: { destructiveHint: true } }, args => invoke('memory.delete', args));
    if (scope) this.deps.registerSessionTools!(mcp, { botId, scope, invoke: (op, args) => scoped(async () => {
      const profile = await this.deps.readProfile(botId);
      if (!profile.enabled || profile.status !== 'active') return output({ code: 'COMPANION_PAUSED' }, true);
      const result = await this.deps.invokeSession!(botId, scope, op, args);
      return output(result.ok ? result.value : result, !result.ok);
    }) });
    return mcp;
  }
  private async stopServer(): Promise<void> {
    const server = this.server; this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  async close(): Promise<void> {
    this.disposed = true;
    await this.starting?.catch(() => {});
    await Promise.allSettled([...this.operations]);
    await Promise.allSettled([...this.requests].map(mcp => mcp.close()));
    this.requests.clear();
    await this.stopServer();
  }
}
