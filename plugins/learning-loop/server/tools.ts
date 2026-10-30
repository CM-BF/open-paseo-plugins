// The `learning` MCP tools: definitions (JSON Schema, sent to agents by the shim) and the dispatcher
// the bridge calls. Results are JSON text, as Hermes' tools return.

import type { Actor, MemoryOp, MemoryTarget, ProjectRef } from "../shared/contracts";
import type { MemoryChange, MemoryStore } from "./memory/store";
import {
  MEMORY_TOOL_DESCRIPTION,
  SESSION_SEARCH_DESCRIPTION,
  SKILL_MANAGE_DESCRIPTION,
  SKILL_VIEW_DESCRIPTION,
  SKILLS_LIST_DESCRIPTION,
  SKILL_LIBRARY_BOUNDARY,
} from "./prompts";
import type { SessionIndex } from "./sessions/index";
import { parseOps, type SkillLibrary } from "./skills/library";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const memoryOpItem = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["add", "patch", "remove"] },
    content: { type: "string", description: "Required for add and patch: the new entry, or the text that replaces old_text." },
    old_text: { type: "string", description: "Required for patch and remove: text from ONE entry ('§' separates entries)." },
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "memory",
    description: MEMORY_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", enum: ["user", "memory", "project"], description: "Which store: 'user', 'memory' (environment notes) or 'project' (the current repository)." },
        operations: { type: "array", items: memoryOpItem, description: "Batch shape (preferred): applied atomically against the final char budget." },
        action: { type: "string", enum: ["add", "patch", "remove"], description: "Single-op shape. Omit when using 'operations'." },
        content: { type: "string", description: "Single-op shape: for add the new entry; for patch the replacement for old_text." },
        old_text: { type: "string", description: "Single-op shape: for patch the span to replace; for remove text identifying the entry." },
      },
    },
  },
  {
    name: "skills_list",
    description: SKILLS_LIST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { category: { type: "string", description: "Only skills in this category." } },
    },
  },
  {
    name: "skill_view",
    description: SKILL_VIEW_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        file_path: { type: "string", description: "A supporting file relative to the skill, e.g. 'references/api.md'. Omit for SKILL.md." },
      },
    },
  },
  {
    name: "skill_manage",
    description: SKILL_MANAGE_DESCRIPTION,
    inputSchema: {
      type: "object",
      required: ["operations"],
      properties: {
        operations: {
          type: "array",
          description: "Ordered ops, applied atomically. Each names its target skill.",
          items: {
            type: "object",
            required: ["name", "action"],
            properties: {
              name: { type: "string", description: "Skill name: lowercase letters, digits, hyphens, underscores (max 64)." },
              action: { type: "string", enum: ["create", "patch", "write_file", "remove_file", "delete"] },
              content: { type: "string", description: "create: the full SKILL.md (frontmatter + body). patch without old_string: a full SKILL.md rewrite." },
              category: { type: "string", description: "create only: optional category directory, e.g. 'devops'." },
              old_string: { type: "string", description: "patch: text to find (exactly once unless replace_all)." },
              new_string: { type: "string", description: "patch: replacement; empty string deletes the match." },
              replace_all: { type: "boolean", description: "patch: replace every occurrence." },
              file_path: { type: "string", description: "patch/write_file/remove_file: supporting file under references/, templates/, scripts/ or assets/." },
              file_content: { type: "string", description: "write_file: full text of the supporting file." },
              absorbed_into: { type: "string", description: "delete (consolidation only): the umbrella skill that absorbed this one." },
            },
          },
        },
      },
    },
  },
  {
    name: "session_search",
    description: SESSION_SEARCH_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Discovery: keywords or \"quoted phrases\" (all must match; falls back to any)." },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 3, description: "Discovery: sessions to return (default 3)." },
        sort: { type: "string", enum: ["newest", "oldest"], description: "Discovery: time bias; omit for relevance." },
        after: { type: "string", description: "Discovery: only sessions started at/after this ISO date or relative duration (7d, 24h, 2w)." },
        before: { type: "string", description: "Discovery: only sessions started before this ISO date or relative duration." },
        exclude_agent_ids: { type: "array", items: { type: "string" }, description: "Discovery: sessions already inspected." },
        agent_id: { type: "string", description: "Scroll/read: the session (Paseo agent id) to read." },
        around_seq: { type: "integer", description: "Scroll: message seq to center the window on." },
        window: { type: "integer", minimum: 1, maximum: 80, default: 20, description: "Scroll/read: messages to return." },
      },
    },
  },
];

/** Existing bindings retain the v1 schema and host-wide search default. */
export const TOOL_DEFINITIONS_V2: ToolDefinition[] = TOOL_DEFINITIONS.map(tool => {
  if (tool.name !== "session_search" && tool.name !== "memory") return tool;
  const properties = tool.inputSchema.properties as Record<string, unknown>;
  const added = tool.name === "memory"
    ? { action: { type: "string", enum: ["read", "add", "patch", "remove"], description: "Read the current scoped entries/revision, or write using the single-op shape." }, project_path: { type: "string", description: "When cwd is a multi-repo workspace, choose a repository path inside it; omitted writes belong to the workspace itself." } }
    : { scope: { type: "string", enum: ["current", "host"], default: "current", description: "Current repo/workspace by default. Explicit host searches every indexed project on this host." } };
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: { ...properties, ...added } } };
});

/** New bindings clarify native versus learned skills; older description prefixes stay frozen. */
export const TOOL_DEFINITIONS_V3: ToolDefinition[] = TOOL_DEFINITIONS_V2.map(tool => {
  const intro: Record<string, string> = {
    skills_list: "List only Learning Loop-owned skills; this is not the provider's native skill catalog. ",
    skill_view: "Read a skill only from Learning Loop's learned library. ",
    skill_manage: "Create or modify only Learning Loop-owned skills; native skill packages are outside this tool. ",
  };
  return intro[tool.name] ? { ...tool, description: intro[tool.name] + SKILL_LIBRARY_BOUNDARY + "\n\n" + tool.description } : tool;
});

export function bindingVersion(binding?: string | null): number {
  return binding?.startsWith("v3-") ? 3 : binding?.startsWith("v2-") || binding?.startsWith("review-") ? 2 : 1;
}
export function toolsForBinding(binding?: string | null): ToolDefinition[] {
  const version = bindingVersion(binding);
  return version === 3 ? TOOL_DEFINITIONS_V3 : version === 2 ? TOOL_DEFINITIONS_V2 : TOOL_DEFINITIONS;
}

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

/** Who is calling: an agent session (via its binding) or a background review run. */
export interface CallContext {
  actor: Actor;
  /** Read-before-write tracking key. */
  reader: string;
  project: ProjectRef | null;
  /** The calling agent's own id; its own session is left out of discovery results. */
  selfAgentId: string | null;
  version?: number;
  memoryRevisions?: Record<string, string>;
}

export interface ToolDeps {
  memory: MemoryStore;
  skills: SkillLibrary;
  sessions: SessionIndex | null;
  /** Whether this caller's memory writes must be staged for approval. */
  stage(actor: Actor): boolean;
  /** Changes made through tools, for review summaries and the activity log. */
  onMemoryChange(context: CallContext, changes: MemoryChange[], staged: boolean): void;
  onSkillChange(context: CallContext, summaries: string[], staged?: boolean): void;
  resolveProjectPath?(base: ProjectRef, path: string): Promise<ProjectRef>;
}

export interface ToolResult {
  isError: boolean;
  text: string;
}

const json = (value: unknown, isError = false): ToolResult => ({ isError, text: JSON.stringify(value, null, 2) });
const error = (message: string): ToolResult => json({ success: false, error: message }, true);

/** "7d", "24h", "2w" → ISO timestamp that far back; ISO dates pass through. */
export function parseTimeBound(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  const rel = /^(\d+)\s*([hdwm])$/i.exec(v);
  if (rel) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000, m: 2_592_000_000 }[rel[2]!.toLowerCase() as "h" | "d" | "w" | "m"];
    return new Date(now - Number(rel[1]) * unit).toISOString();
  }
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function memoryOps(args: Record<string, unknown>): MemoryOp[] | string {
  const list = Array.isArray(args.operations) ? (args.operations as unknown[]) : typeof args.action === "string" ? [args] : null;
  if (!list || list.length === 0) return "Pass 'operations' (a list of {action, content?, old_text?}) or a single action.";
  const ops: MemoryOp[] = [];
  for (const raw of list) {
    const op = (raw ?? {}) as Record<string, unknown>;
    if (op.action === "replace") return "There is no 'replace' action: use 'patch' (old_text = the span to change, content = its replacement).";
    if (op.action !== "add" && op.action !== "patch" && op.action !== "remove") return `Unknown action '${String(op.action)}'. Use add, patch or remove.`;
    if ("target" in op && op.target !== args.target) return "Every operation in a batch uses the top-level target; use separate calls for different stores.";
    const content = typeof op.content === "string" ? op.content : typeof op.new_text === "string" ? op.new_text : undefined;
    ops.push({ action: op.action, ...(content !== undefined ? { content } : {}), ...(typeof op.old_text === "string" ? { old_text: op.old_text } : {}) });
  }
  return ops;
}

export async function callTool(name: string, rawArgs: unknown, context: CallContext, deps: ToolDeps): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  switch (name) {
    case "memory": {
      const target = args.target;
      if (target !== "user" && target !== "memory" && target !== "project") return error("'target' is required: 'user', 'memory' or 'project'.");
      if ((context.version ?? 1) >= 2 && typeof args.project_path === "string" && target === "project") {
        if (!context.project || !deps.resolveProjectPath) return error("No workspace is known.");
        context = { ...context, project: await deps.resolveProjectPath(context.project, args.project_path) };
      }
      const project = target === "project" ? context.project : null;
      const identity = `${target}:${project?.key ?? "host"}`;
      if ((context.version ?? 1) >= 2 && args.action === "read") {
        const state = await deps.memory.inspect(target, project);
        if (context.memoryRevisions) context.memoryRevisions[identity] = state.revision;
        return json({ success: true, target, ...state });
      }
      const ops = memoryOps(args);
      if (typeof ops === "string") return error(ops);
      const stage = deps.stage(context.actor);
      const { result, changes } = await deps.memory.write(target as MemoryTarget, target === "project" ? context.project : null, ops, { actor: context.actor, stage, expectedRevision: context.memoryRevisions?.[identity] });
      if (result.success && !result.staged && context.memoryRevisions) context.memoryRevisions[identity] = (await deps.memory.inspect(target, project)).revision;
      if (result.success && changes.length > 0) deps.onMemoryChange(context, changes, result.staged === true);
      return json(result, !result.success);
    }
    case "skills_list": {
      const category = typeof args.category === "string" ? args.category : null;
      const skills = (await deps.skills.list(false)).filter((s) => !category || s.category === category);
      return json({
        success: true,
        count: skills.length,
        skills: skills.map((s) => ({ name: s.name, category: s.category, description: s.description, state: s.state, ...(s.pinned ? { pinned: true } : {}) })),
      });
    }
    case "skill_view": {
      if (typeof args.name !== "string" || !args.name) return error("'name' is required.");
      const result = await deps.skills.view(args.name, typeof args.file_path === "string" ? args.file_path : null, context.reader);
      if (!result.success && (context.version ?? 1) >= 2 && result.error?.startsWith("No skill named")) {
        return json({ ...result, library: "learning-loop", hint: SKILL_LIBRARY_BOUNDARY }, true);
      }
      return json(result, !result.success);
    }
    case "skill_manage": {
      const parsed = parseOps(args);
      if (!parsed.ok) return error(parsed.error);
      const result = await deps.skills.manage(parsed.ops, context.actor, context.reader, deps.stage(context.actor));
      if (result.success && result.results) deps.onSkillChange(context, result.results.map((r) => `${r.name}: ${r.message}`), result.staged === true);
      return json(result, !result.success);
    }
    case "session_search":
      return sessionSearch(args, context, deps);
    default:
      return error(`Unknown tool: ${name}`);
  }
}

function sessionSearch(args: Record<string, unknown>, context: CallContext, deps: ToolDeps): ToolResult {
  const index = deps.sessions;
  if (!index) return error("Session indexing is turned off in the Learning Loop settings.");
  const scopeKey = (context.version ?? 1) >= 2 && args.scope !== "host" ? context.project?.key ?? "unknown-scope" : null;
  const windowSize = Math.min(80, Math.max(1, Number(args.window) || 20));
  const link = (agentId: string) => `paseo agent ${agentId}`;
  if (typeof args.agent_id === "string" && args.agent_id) {
    const session = index.session(args.agent_id);
    if (scopeKey && index.scopeOf(args.agent_id) !== scopeKey) return error("That session is outside the current scope. Use scope=host explicitly to read across projects.");
    if (!session) return error(`No indexed session for agent ${args.agent_id}.`);
    const around = Number.isInteger(args.around_seq) ? (args.around_seq as number) : null;
    return json({ success: true, shape: around === null ? "read" : "scroll", session: { ...session, link: link(session.agentId) }, messages: index.window(session.agentId, around, windowSize) });
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const exclude = [
    ...(Array.isArray(args.exclude_agent_ids) ? (args.exclude_agent_ids as unknown[]).filter((v): v is string => typeof v === "string") : []),
    ...(context.selfAgentId ? [context.selfAgentId] : []),
  ];
  if (!query) {
    return json({ success: true, shape: "browse", sessions: index.recent(10, exclude, scopeKey).map((s) => ({ ...s, link: link(s.agentId) })) });
  }
  const limit = Math.min(10, Math.max(1, Number(args.limit) || 3));
  const sort = args.sort === "newest" || args.sort === "oldest" ? args.sort : "relevance";
  const hits = index.search(query, { limit, sort, after: parseTimeBound(args.after), before: parseTimeBound(args.before), excludeAgentIds: exclude, scopeKey });
  if (hits.length === 0) {
    return json({ success: true, shape: "discovery", query, results: [], note: "No past session matched. Try fewer or different keywords; this searches stored conversation text only." });
  }
  return json({
    success: true,
    shape: "discovery",
    query,
    results: hits.map((hit, rank) => ({
      session: { ...hit.session, link: link(hit.session.agentId) },
      anchor: hit.anchor,
      ...(rank === 0
        ? { window: index.window(hit.session.agentId, hit.anchor.seq, Math.min(windowSize, 16)), bookends: index.bookends(hit.session.agentId) }
        : { snippet: hit.snippet }),
    })),
    note: "Scroll with session_search(agent_id, around_seq) for more context around a result.",
  });
}
