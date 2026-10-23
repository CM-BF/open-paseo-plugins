export const PLUGIN_ID = "paseo-dynamic-workflow";
export const PLUGIN_VERSION = "0.1.0";

/** MCP server key in agent configs; Claude shows the tools as `mcp__dynamic_workflow__<tool>`. */
export const MCP_SERVER = "dynamic_workflow";
export const MCP_TOOL_NAMES = ["workflow", "workflow_status", "workflow_stop", "workflow_reference"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const CLI_NAME = "paseo-workflow";
export const MCP_SHIM_NAME = "paseo-workflow-mcp";

/** Env var that carries the MCP binding nonce from agent.create to agent.session_open. */
export const BINDING_ENV = "PASEO_DYNAMIC_WORKFLOW_BINDING";
/** Explicit opt-in for agents created programmatically; never inherited by workflow children. */
export const ENABLE_ENV = "PASEO_DYNAMIC_WORKFLOW_ENABLED";
/** Set on every workflow child agent: children get no workflow tools (no recursion). */
export const CHILD_ENV = "PASEO_DYNAMIC_WORKFLOW_CHILD";

export const LABEL_RUN = "paseo-dynamic-workflow/run";
export const LABEL_CALL = "paseo-dynamic-workflow/call";

export const CARD_KIND = "dynamic-workflow-run";
export const CARD_VERSION = 1;
export const PANEL_ID = "dynamic-workflows";

export const RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;
