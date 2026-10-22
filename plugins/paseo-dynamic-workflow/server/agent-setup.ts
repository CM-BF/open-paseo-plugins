import { randomBytes } from "node:crypto";
import type { PluginBeforeRequests, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { BINDING_ENV, CHILD_ENV, MCP_SERVER, MCP_TOOL_NAMES } from "../shared/ids";
import type { Preferences } from "../shared/settings";
import type { BindingStore } from "./bindings";
import type { PaseoApi } from "./gate";
import { appendPrompt, PROMPT_MARKER, replacePrompt, systemPromptCli, systemPromptMcp } from "./prompts";
import { describeError, log } from "./util";

export type CreateRequest = PluginBeforeRequests["agent.create"];
type McpServers = NonNullable<CreateRequest["config"]["mcpServers"]>;

const KNOWN = new Set(["claude", "codex", "opencode", "pi", "omp"]);
/** Providers that take MCP servers and exact tool preapprovals. */
export const MCP_FAMILIES: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);
/** Providers that read config.systemPrompt; ACP providers do not. */
export const PROMPT_FAMILIES: ReadonlySet<string> = new Set(["claude", "codex", "opencode", "pi", "omp"]);

type Providers = Record<string, { extends?: unknown } | undefined>;

/** The built-in provider a configured provider derives from (`extends`), or null. */
export function resolveFamily(providerId: string, providers: Providers): string | null {
  let id = providerId;
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

/** Daemon provider config, cached for a minute. */
export class ProviderFamilies {
  private providers: Providers = {};
  private fetchedAt = 0;

  async family(paseo: PaseoApi, providerId: string): Promise<string | null> {
    if (KNOWN.has(providerId)) return providerId;
    if (Date.now() - this.fetchedAt > 60_000 || !(providerId in this.providers)) {
      try {
        const result = await paseo.config.get();
        const providers = (result.config as { providers?: unknown }).providers;
        this.providers = providers && typeof providers === "object" ? (providers as Providers) : {};
        this.fetchedAt = Date.now();
      } catch (error) {
        log(`could not read provider config: ${describeError(error)}`);
      }
    }
    return resolveFamily(providerId, this.providers);
  }
}

function isOwnServer(server: McpServers[string] | undefined, mcpPath: string): boolean {
  if (!server || server.type !== "stdio") return false;
  return server.command === mcpPath || (server.env !== undefined && BINDING_ENV in server.env);
}

function withoutOwnGrants(policy: CreateRequest["config"]["toolPolicy"]): CreateRequest["config"]["toolPolicy"] {
  const kept = policy?.preapproved.filter((grant) => grant.server !== MCP_SERVER) ?? [];
  return kept.length > 0 ? { preapproved: kept } : undefined;
}

/**
 * Adds the dynamic_workflow MCP server (MCP families) and the instructions (every family that
 * reads a system prompt) to a new agent. Workflow children (CHILD_ENV) get nothing. An entry of
 * ours copied from another agent's stored config always gets a fresh nonce.
 */
export function transformCreate(
  request: CreateRequest,
  family: string | null,
  settings: Preferences,
  paths: { mcp: string; cli: string },
  nonce: () => string = () => randomBytes(16).toString("hex"),
): CreateRequest | undefined {
  if (request.env?.[CHILD_ENV] !== undefined) return undefined;
  const config = { ...request.config };
  const servers: McpServers = { ...(config.mcpServers ?? {}) };
  const existing = servers[MCP_SERVER];
  const inherited = isOwnServer(existing, paths.mcp);
  const mcpFamily = family !== null && MCP_FAMILIES.has(family);
  let env = request.env;
  let changed = false;
  if (inherited && !mcpFamily) {
    delete servers[MCP_SERVER];
    config.mcpServers = Object.keys(servers).length > 0 ? servers : undefined;
    config.toolPolicy = withoutOwnGrants(config.toolPolicy);
    if (config.systemPrompt?.includes(PROMPT_MARKER)) config.systemPrompt = replacePrompt(config.systemPrompt, systemPromptCli(paths.cli));
    changed = true;
  }
  const addServer = mcpFamily && (inherited || (settings.injectIntoNewAgents && existing === undefined));
  if (addServer) {
    const binding = nonce();
    config.mcpServers = { ...servers, [MCP_SERVER]: { type: "stdio", command: paths.mcp, env: { [BINDING_ENV]: binding } } };
    env = { ...request.env, [BINDING_ENV]: binding };
    config.toolPolicy = withoutOwnGrants(config.toolPolicy);
    // On OpenCode any toolPolicy turns auto-accept off for every tool, so never add one there.
    if (settings.preapproveTools && family !== "opencode") {
      config.toolPolicy = {
        preapproved: [
          ...(config.toolPolicy?.preapproved ?? []),
          ...MCP_TOOL_NAMES.map((tool) => ({ kind: "mcp" as const, server: MCP_SERVER, tool })),
        ],
      };
    }
    changed = true;
  }
  if (settings.injectIntoNewAgents && family !== null && PROMPT_FAMILIES.has(family)) {
    const hasServer = config.mcpServers !== undefined && MCP_SERVER in config.mcpServers;
    const block = mcpFamily && hasServer ? systemPromptMcp() : systemPromptCli(paths.cli);
    const prompt = appendPrompt(config.systemPrompt, block);
    if (prompt !== config.systemPrompt) {
      config.systemPrompt = prompt;
      changed = true;
    }
  }
  if (!changed) return undefined;
  if (config.toolPolicy === undefined) delete config.toolPolicy;
  if (config.mcpServers === undefined) delete config.mcpServers;
  return env === undefined ? { ...request, config } : { ...request, config, env };
}

/**
 * On create, maps the nonce the create hook put in the env to the new agent id. Removes it and
 * the child marker from the agent's env: any extra launch env makes Paseo start a separate
 * OpenCode server.
 */
export async function transformSessionOpen(
  request: PluginSessionOpenRequest,
  bindings: BindingStore,
): Promise<PluginSessionOpenRequest | undefined> {
  const nonce = request.env[BINDING_ENV];
  const child = request.env[CHILD_ENV];
  if (typeof nonce !== "string" && typeof child !== "string") return undefined;
  if (typeof nonce === "string" && nonce && request.reason === "create") {
    try {
      await bindings.bind(nonce, request.agentId);
    } catch (error) {
      log(`could not save the MCP binding for ${request.agentId}: ${describeError(error)}`);
    }
  }
  // The child marker only matters to the create hook.
  const env: Record<string, string> = { ...request.env };
  delete env[BINDING_ENV];
  delete env[CHILD_ENV];
  return { ...request, env };
}
