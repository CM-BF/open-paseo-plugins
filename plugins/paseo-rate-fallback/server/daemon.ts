import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";

type RawAgent = NonNullable<Awaited<ReturnType<DaemonClient["fetchAgent"]>>>["agent"];

export interface AgentSnapshot {
  id: string;
  provider: string;
  model: string | null;
  thinkingOptionId: string | null;
  status: RawAgent["status"];
  archivedAt: string | null;
  activeTurn: NonNullable<RawAgent["activeTurn"]> | null;
  pendingPermissions: RawAgent["pendingPermissions"];
  lastError: string | null;
  cwd: string;
  workspaceId?: string | null;
  title?: string | null;
  currentModeId?: string | null;
  labels?: Record<string, string>;
}

export interface AgentSettings {
  model: string | null;
  thinkingOptionId: string | null;
}

export type UsageReports = Awaited<ReturnType<DaemonClient["listUsageReports"]>>;
export type TimelinePage = Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>;
export type ProviderModels = Awaited<ReturnType<DaemonClient["listProviderModels"]>>;
export type ForkContext = Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;
export type ForkAttachment = NonNullable<ForkContext["attachment"]>;
export interface CreateFallbackInput {
  source: AgentSnapshot;
  operationId: string;
}

export const FALLBACK_OWNER_LABEL = "paseo-rate-fallback-owner";
export const FALLBACK_OPERATION_LABEL = "paseo-rate-fallback-operation";

export interface DaemonAdapter {
  getAgent(id: string): Promise<AgentSnapshot | null>;
  applySettings(id: string, settings: AgentSettings): Promise<void>;
  send(id: string, text: string, messageId: string): Promise<void>;
  usage(agentId?: string): Promise<UsageReports>;
  timeline(id: string): Promise<TimelinePage>;
  models(provider?: string, cwd?: string): Promise<ProviderModels>;
  forkContext?(id: string): Promise<ForkContext>;
  createFallback?(input: CreateFallbackInput): Promise<AgentSnapshot>;
  findFallback?(operationId: string, sourceAgentId: string): Promise<AgentSnapshot | null>;
  sendWithContext?(id: string, text: string, messageId: string, attachment: ForkAttachment): Promise<void>;
  stop?(id: string): Promise<void>;
  providerFamily?(provider: string): Promise<string | null>;
  close(): Promise<void>;
}

export interface ForkDaemonAdapter extends DaemonAdapter {
  forkContext(id: string): Promise<ForkContext>;
  createFallback(input: CreateFallbackInput): Promise<AgentSnapshot>;
  findFallback(operationId: string, sourceAgentId: string): Promise<AgentSnapshot | null>;
  sendWithContext(id: string, text: string, messageId: string, attachment: ForkAttachment): Promise<void>;
  stop(id: string): Promise<void>;
  providerFamily(provider: string): Promise<string | null>;
}

function snapshot(agent: RawAgent): AgentSnapshot {
  return {
    id: agent.id,
    provider: agent.provider,
    model: agent.runtimeInfo?.model !== undefined ? agent.runtimeInfo.model : agent.model,
    thinkingOptionId: agent.runtimeInfo?.thinkingOptionId !== undefined
      ? agent.runtimeInfo.thinkingOptionId
      : agent.effectiveThinkingOptionId !== undefined
        ? agent.effectiveThinkingOptionId
        : agent.thinkingOptionId ?? null,
    status: agent.status,
    archivedAt: agent.archivedAt ?? null,
    activeTurn: agent.activeTurn ?? null,
    pendingPermissions: agent.pendingPermissions,
    lastError: agent.lastError ?? null,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title ?? null,
    currentModeId: agent.runtimeInfo?.modeId !== undefined ? agent.runtimeInfo.modeId : agent.currentModeId ?? null,
    labels: agent.labels ?? {},
  };
}

function fallbackMode(source: AgentSnapshot): {
  modeId: string;
  featureValues?: Record<string, unknown>;
  providerOptions?: { sandbox_mode: "read-only"; approval_policy: "on-request" };
} {
  const mode = source.currentModeId;
  if (mode === "plan" || mode === "read-only" || mode === "readOnly") return {
    modeId: "auto", providerOptions: { sandbox_mode: "read-only", approval_policy: "on-request" },
    ...(mode === "plan" ? { featureValues: { plan_mode: true } } : {}),
  };
  if (mode === "bypassPermissions" || mode === "full-access") return { modeId: "full-access" };
  return { modeId: "auto" };
}

function fallbackTitle(source: AgentSnapshot): string {
  const suffix = " · GPT-6.1 fallback";
  // The protocol limits explicit titles to 200 UTF-16 code units.
  const prefix = (source.title || "Agent").slice(0, 200 - suffix.length)
    .replace(/[\uD800-\uDBFF]$/, "");
  return `${prefix}${suffix}`;
}

/** Local credentials must never be sent to an address outside this daemon machine. */
export function localDaemonTarget(listen: unknown): string {
  if (typeof listen !== "string" || !listen.trim()) {
    throw new Error("The Paseo daemon lock has no listen address");
  }
  const value = listen.trim();
  if (value.startsWith("/")) return `unix://${value}`;
  if (value.startsWith("unix:///") || value.startsWith("pipe://")) return value;
  if (value.startsWith("\\\\.\\pipe\\")) return `pipe://${value}`;
  const host = value.replace(/^tcp:\/\//, "");
  const match = /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)$/.exec(host);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new Error("Rate fallback requires a local Paseo daemon listen address");
  }
  const hostname = match[1] === "0.0.0.0" ? "127.0.0.1" : match[1] === "[::]" ? "[::1]" : match[1];
  return `${hostname}:${match[2]}`;
}

/**
 * Paseo 0.12's public agent handle has no model setter. Use the daemon's supported
 * config RPC through one dedicated local SDK connection, closed with the plugin.
 */
export function createDaemonAdapter(options: { home?: string } = {}): ForkDaemonAdapter {
  const home = options.home ?? process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const clientId = `rate-fallback-${randomUUID()}`;
  let client: DaemonClient | null = null;
  let connecting: Promise<DaemonClient> | null = null;
  let disposed = false;
  let providerConfig: { at: number; providers: Record<string, unknown> } | null = null;

  async function connect(): Promise<DaemonClient> {
    if (disposed) throw new Error("Rate fallback daemon adapter is closed");
    if (connecting) return connecting;
    if (client?.getConnectionState().status === "connected") return client;
    connecting = (async () => {
      await client?.close();
      client = null;
      const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")) as { listen?: unknown };
      const target = localDaemonTarget(lock.listen);
      const socketPath = target.startsWith("unix://") ? target.slice("unix://".length)
        : target.startsWith("pipe://") ? target.slice("pipe://".length) : undefined;
      const next = new DaemonClient({
        url: socketPath ? "ws://localhost/ws" : `ws://${target}/ws`,
        webSocketFactory: (url, transportOptions) => new WebSocket(url, transportOptions?.protocols, {
          headers: transportOptions?.headers,
          ...(socketPath ? { socketPath } : {}),
          maxPayload: 100 * 1024 * 1024,
        }) as unknown as WebSocketLike,
        clientId,
        clientType: "cli",
        appVersion: "0.12.0",
        localCredential: async () => {
          const token = (await readFile(join(home, "local-credential"), "utf8")).trim();
          if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid Paseo local credential");
          return token;
        },
        connectTimeoutMs: 10_000,
        reconnect: { enabled: false },
      });
      client = next;
      try {
        await next.connect();
        if (disposed) throw new Error("Rate fallback daemon adapter is closed");
        return next;
      } catch (error) {
        if (client === next) client = null;
        await next.close().catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function findFallback(operationId: string, sourceAgentId: string): Promise<AgentSnapshot | null> {
    const page = await (await connect()).fetchAgents({
      includeBackground: true,
      filter: { includeArchived: true, labels: {
        [FALLBACK_OWNER_LABEL]: sourceAgentId,
        [FALLBACK_OPERATION_LABEL]: operationId,
      } },
      page: { limit: 200 },
    });
    const matches = page.entries.map(({ agent }) => agent).filter((agent) =>
      agent.labels?.[FALLBACK_OWNER_LABEL] === sourceAgentId &&
      agent.labels?.[FALLBACK_OPERATION_LABEL] === operationId);
    if (page.pageInfo.hasMore || matches.length > 1) throw new Error("Multiple backup agents exist for this fallback operation");
    return matches[0] ? snapshot(matches[0]) : null;
  }

  return {
    async getAgent(id) {
      const result = await (await connect()).fetchAgent({ agentId: id });
      return result ? snapshot(result.agent) : null;
    },
    async applySettings(id, settings) {
      const connection = await connect();
      if (connection.getLastServerInfoMessage()?.features?.agentConfigApply !== true) {
        throw new Error("Update the Paseo daemon to support a single agent configuration request");
      }
      await connection.applyAgentConfig(id, {
        modelId: settings.model,
        thinkingOptionId: settings.thinkingOptionId,
      });
    },
    async send(id, text, messageId) {
      await (await connect()).sendAgentMessage(id, text, { messageId, activeTurnBehavior: "steer" });
    },
    async usage(agentId) {
      return (await connect()).listUsageReports({ agentId, forceRefresh: true });
    },
    async timeline(id) {
      return (await connect()).fetchAgentTimeline(id, { direction: "tail", limit: 60 });
    },
    async models(provider = "codex", cwd) {
      return (await connect()).listProviderModels(provider, cwd ? { cwd } : undefined);
    },
    async forkContext(id) {
      return (await connect()).buildAgentForkContext(id);
    },
    findFallback,
    async createFallback({ source, operationId }) {
      if (!source.workspaceId) throw new Error("The source agent must belong to a workspace before it can be forked");
      if (!operationId) throw new Error("A fallback operation ID is required");
      const existing = await findFallback(operationId, source.id);
      if (existing) {
        if (existing.workspaceId !== source.workspaceId || existing.provider !== "codex") {
          throw new Error("The saved backup agent does not match the source workspace and Codex provider");
        }
        return existing;
      }
      const connection = await connect();
      if (connection.getLastServerInfoMessage()?.features?.agentRequestReceipts !== true &&
          connection.getLastServerInfoMessage()?.features?.creationLifecycle !== true) {
        throw new Error("Update the Paseo daemon to support durable backup agent creation");
      }
      const agent = await connection.createAgent({
        workspaceId: source.workspaceId,
        callerAgentId: source.id,
        idempotencyKey: operationId,
        labels: { [FALLBACK_OWNER_LABEL]: source.id, [FALLBACK_OPERATION_LABEL]: operationId },
        config: { provider: "codex", cwd: source.cwd, model: "gpt-6.1-sol", thinkingOptionId: "ultra",
          title: fallbackTitle(source), ...fallbackMode(source) },
      });
      return snapshot(agent);
    },
    async sendWithContext(id, text, messageId, attachment) {
      await (await connect()).sendAgentMessage(id, text, {
        messageId, activeTurnBehavior: "steer", attachments: [attachment],
      });
    },
    async stop(id) {
      const connection = await connect();
      const result = await connection.fetchAgent({ agentId: id });
      if (!result) return;
      const labels = result.agent.labels;
      if (!labels?.[FALLBACK_OWNER_LABEL] || !labels?.[FALLBACK_OPERATION_LABEL]) {
        throw new Error("Refusing to stop an agent that is not a plugin-owned backup");
      }
      if (!result.agent.archivedAt) await connection.cancelAgent(id);
    },
    async providerFamily(provider) {
      if (provider === "claude" || provider === "codex") return provider;
      if (!providerConfig || Date.now() - providerConfig.at >= 60_000) {
        const result = await (await connect()).getDaemonConfig();
        providerConfig = { at: Date.now(), providers: result.config.providers ?? {} };
      }
      const seen = new Set<string>();
      let id = provider;
      while (!seen.has(id)) {
        if (id === "claude" || id === "codex") return id;
        seen.add(id);
        const entry = providerConfig.providers[id];
        if (!entry || typeof entry !== "object" || !("extends" in entry) || typeof entry.extends !== "string") return null;
        id = entry.extends;
      }
      return null;
    },
    async close() {
      disposed = true;
      await client?.close();
      await connecting?.catch(() => undefined);
      client = null;
    },
  };
}
