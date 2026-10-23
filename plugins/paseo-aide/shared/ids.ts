export const PLUGIN_ID = "paseo-aide";
export const PLUGIN_VERSION = "0.1.0";

/** The MCP server name agents see; tools appear as mcp__aide__<tool> in Claude. */
export const MCP_SERVER = "aide";

/** Labels on the agents this plugin starts, so they can be told apart from the user's own. */
export const LABEL_ROLE = "paseo-aide/role";
export const LABEL_RUN = "paseo-aide/run";

export const SCREEN_HOME = "home";
export const SETTINGS_SCREEN = "preferences";

/** Timeline renderer for the plugin's own messages to the assistant. */
export const UPDATE_KIND = "aide-update";
export const UPDATE_VERSION = 1;
