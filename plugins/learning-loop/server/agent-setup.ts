// before("agent.create") and before("agent.session_open"). Pattern from paseo-async-shell
// (server/agent-setup.ts): a fresh binding nonce for every new agent, also when Paseo copied a
// caller's stored config (schedules do), and the MCP entry removed for providers that cannot run it.

import { randomBytes } from "node:crypto";
import type { PluginBeforeRequests, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { BINDING_ENV, MCP_SERVER } from "../shared/constants";
import type { Preferences } from "../shared/settings";
import type { BindingStore } from "./bindings";
import { describeError } from "./files";
import { withBlock, withoutBlock } from "./prompts";
import { TOOL_NAMES } from "./tools";

export type CreateRequest = PluginBeforeRequests["agent.create"];
type McpServers = NonNullable<CreateRequest["config"]["mcpServers"]>;

const KNOWN = new Set(["claude", "codex", "opencode", "pi", "omp"]);
/** Providers that take MCP servers and exact tool preapprovals. */
export const MCP_FAMILIES: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);
/** Providers that read config.systemPrompt; ACP providers do not. */
export const PROMPT_FAMILIES: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "pi", "omp"]);

type Providers = Record<string, { extends?: unknown } | undefined>;

/** The built-in provider a configured provider derives from, following `extends`; null when unknown. */
export function resolveFamily(providerId: string, providers: Providers): string | null {
  let id = providerId.split("/")[0]!;
  const seen = new Set<string>();
  while (!seen.has(id) && seen.size < 8) {
    if (KNOWN.has(id)) return id;
    seen.add(id);
    const next = providers[id]?.extends;
    if (typeof next !== "string" || !next) return null;
    id = next;
  }
  return null;
}

export interface SetupPaths {
  mcp: string;
}

function isOwnServer(server: McpServers[string] | undefined, paths: SetupPaths): boolean {
  if (!server || server.type !== "stdio") return false;
  return server.command === paths.mcp || (server.env !== undefined && BINDING_ENV in server.env);
}

function withoutOwnGrants(policy: CreateRequest["config"]["toolPolicy"]): CreateRequest["config"]["toolPolicy"] {
  const kept = policy?.preapproved.filter((grant) => grant.server !== MCP_SERVER) ?? [];
  return kept.length > 0 ? { preapproved: kept } : undefined;
}

export interface TransformInput {
  request: CreateRequest;
  family: string | null;
  settings: Preferences;
  paths: SetupPaths;
  /** The system-prompt block for this agent's cwd; null when prompt injection is off. */
  block: (tools: boolean) => Promise<string | null>;
  nonce?: () => string;
}

export async function transformCreate(input: TransformInput): Promise<CreateRequest | undefined> {
  const { request, family, settings, paths } = input;
  if (request.config.internal) return undefined;
  const config = { ...request.config };
  const servers: McpServers = { ...(config.mcpServers ?? {}) };
  const existing = servers[MCP_SERVER];
  const inherited = isOwnServer(existing, paths);
  const mcpFamily = family !== null && MCP_FAMILIES.has(family);
  let env = request.env;
  let changed = false;

  if (inherited) {
    delete servers[MCP_SERVER];
    config.mcpServers = Object.keys(servers).length > 0 ? servers : undefined;
    config.toolPolicy = withoutOwnGrants(config.toolPolicy);
    changed = true;
  }
  const addServer = mcpFamily && settings.injectTools && (existing === undefined || inherited);
  if (addServer) {
    const binding = `v3-${(input.nonce ?? (() => randomBytes(16).toString("hex")))()}`;
    config.mcpServers = { ...(config.mcpServers ?? {}), [MCP_SERVER]: { type: "stdio", command: paths.mcp, args: [], env: { [BINDING_ENV]: binding } } };
    env = { ...request.env, [BINDING_ENV]: binding };
    config.toolPolicy = withoutOwnGrants(config.toolPolicy);
    // On OpenCode any toolPolicy turns auto-accept off for every tool, so never add one there.
    if (settings.preapproveTools && family !== "opencode") {
      config.toolPolicy = {
        preapproved: [...(config.toolPolicy?.preapproved ?? []), ...TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: MCP_SERVER, tool }))],
      };
    }
    changed = true;
  }

  const hasTools = config.mcpServers !== undefined && MCP_SERVER in config.mcpServers;
  if (family !== null && PROMPT_FAMILIES.has(family)) {
    const block = settings.injectPrompt ? await input.block(hasTools) : null;
    const prompt = block ? withBlock(config.systemPrompt, block) : withoutBlock(config.systemPrompt);
    if (prompt !== config.systemPrompt) {
      config.systemPrompt = prompt;
      changed = true;
    }
  }
  if (!changed) return undefined;
  if (config.toolPolicy === undefined) delete config.toolPolicy;
  if (config.mcpServers === undefined) delete config.mcpServers;
  if (config.systemPrompt === undefined) delete config.systemPrompt;
  return env === undefined ? { ...request, config } : { ...request, config, env };
}

/**
 * On create, records nonce → agent and removes the nonce from the launch env (any extra launch env
 * makes Paseo start a separate OpenCode server for the session).
 */
export async function transformSessionOpen(request: PluginSessionOpenRequest, bindings: BindingStore): Promise<PluginSessionOpenRequest | undefined> {
  const nonce = request.env[BINDING_ENV];
  if (typeof nonce !== "string") return undefined;
  if (nonce && request.reason === "create") {
    try {
      await bindings.bind(nonce, { agentId: request.agentId, provider: request.provider, cwd: request.cwd, workspaceId: request.workspaceId });
    } catch (error) {
      console.error(`[learning-loop] could not save the MCP binding for ${request.agentId}: ${describeError(error)}`);
    }
  }
  const env: Record<string, string> = { ...request.env };
  delete env[BINDING_ENV];
  return { ...request, env };
}

const CACHE_MS = 60_000;

/** Daemon provider config, cached for a minute and refetched once when an id is unknown. */
export class ProviderFamilies {
  private providers: Providers = {};
  private fetchedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async family(paseo: { config: { get(): Promise<{ config: { providers?: unknown } }> } }, providerId: string): Promise<string | null> {
    const base = providerId.split("/")[0]!;
    if (KNOWN.has(base)) return base;
    const stale = this.fetchedAt === null || this.now() - this.fetchedAt > CACHE_MS;
    if (stale || !(base in this.providers)) {
      try {
        const result = await paseo.config.get();
        const providers = result.config.providers;
        this.providers = providers && typeof providers === "object" ? (providers as Providers) : {};
        this.fetchedAt = this.now();
      } catch {
        // keep the cached view
      }
    }
    return resolveFamily(base, this.providers);
  }
}
