export const PLUGIN_ID = "learning-loop";
export const PLUGIN_VERSION = "0.2.1";

/** MCP server name in agent configs; Claude Code exposes its tools as mcp__learning__<tool>. */
export const MCP_SERVER = "learning";
export const MCP_TOOL_NAMES = ["memory", "skills_list", "skill_view", "skill_manage", "session_search"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** Env var carrying the per-agent binding nonce to the MCP shim. */
export const BINDING_ENV = "LEARNING_LOOP_BINDING";
/** Binding prefix of background review runs (resolved against the in-memory run registry). */
export const REVIEW_BINDING_PREFIX = "review-";

/** Wraps the block this plugin adds to an agent's system prompt, so a copied config can be refreshed. */
export const PROMPT_START = "<learning-loop>";
export const PROMPT_END = "</learning-loop>";

/** Hermes defaults (tools/memory_tool.py, website/docs/user-guide/features/memory.md). */
export const DEFAULT_USER_CHAR_LIMIT = 1375;
export const DEFAULT_MEMORY_CHAR_LIMIT = 2200;
export const DEFAULT_PROJECT_CHAR_LIMIT = 2000;
export const ENTRY_DELIMITER = "\n§\n";

/** Skill names: lowercase, hyphens/underscores, max 64 chars (tools/skill_manager_tool.py). */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SKILL_CATEGORY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SKILL_SUPPORT_DIRS = ["references", "templates", "scripts", "assets"] as const;
/** The system-prompt index truncates descriptions here (agent/learn_prompt.py). */
export const SKILL_DESCRIPTION_INDEX_CHARS = 60;

/** Timeline renderer for review results. */
export const UPDATE_KIND = "learning-update";
export const UPDATE_VERSION = 1;
