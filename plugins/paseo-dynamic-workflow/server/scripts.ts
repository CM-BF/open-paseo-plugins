import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BINDING_ENV, MCP_SERVER, MCP_TOOL_NAMES, PLUGIN_VERSION, type McpToolName } from "../shared/ids";
import type { StatePaths } from "./paths";
import { DEFAULT_WORKFLOW_SIZE, type ToolGuidance, WORKFLOW_SIZES } from "../shared/guidance";
import { GUIDANCE_SLOT, guidanceText, mcpInstructions, REFERENCE_TOOL_DESCRIPTION, sizeGuidelineText, STATUS_TOOL_DESCRIPTION, STOP_TOOL_DESCRIPTION, ULTRACODE_SHORT, WORKFLOW_TOOL_DESCRIPTION } from "./prompts";
import { BUILTIN_WORKFLOWS } from "./builtin-workflows";
import { REFERENCE } from "./reference";
import { writeAtomically } from "./util";

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface NodeRuntime {
  execPath: string;
  electron: boolean;
}

export function currentNode(): NodeRuntime {
  return { execPath: process.execPath, electron: typeof process.versions.electron === "string" };
}

/**
 * The stable entry point saved in agent configs and prompts. It runs the plugin's own Node (on
 * macOS the Paseo Electron helper, which needs ELECTRON_RUN_AS_NODE), falling back to another
 * node when that path is gone. Volta shims are skipped: run with a changed HOME they re-spawn
 * themselves without end.
 */
export function renderShim(stateDir: string, script: string, node: NodeRuntime): string {
  return `#!/bin/sh
# Written by the paseo-dynamic-workflow Paseo plugin at every start; edits are overwritten.
DYNAMIC_WORKFLOW_HOME=${shellQuote(stateDir)}
export DYNAMIC_WORKFLOW_HOME
is_volta_shim() {
  case "$1" in */.volta/bin/*) return 0 ;; esac
  target=$(readlink -f "$1" 2>/dev/null) || target=$1
  case "$target" in */.volta/bin/* | */volta-shim | */volta-shim.exe) return 0 ;; esac
  return 1
}
usable() { [ -n "$1" ] && [ -x "$1" ] && ! is_volta_shim "$1"; }
node=${shellQuote(node.execPath)}
electron=${node.electron ? 1 : 0}
if ! usable "$node"; then
  electron=0
  node=
  for c in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if usable "$c"; then node=$c; break; fi
  done
fi
if [ -z "$node" ]; then
  echo 'paseo-dynamic-workflow needs Node.js; none found' >&2
  exit 3
fi
if [ "$electron" = 1 ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$node" "$DYNAMIC_WORKFLOW_HOME/lib/${script}" "$@"
fi
exec "$node" "$DYNAMIC_WORKFLOW_HOME/lib/${script}" "$@"
`;
}

/**
 * Claude Code defers MCP tool descriptions behind tool search unless a tool asks to load: an
 * enabled agent must see the opt-in rule and its Ultracode notice when it decides how to work.
 */
export const WORKFLOW_TOOL_META = {
  "anthropic/alwaysLoad": true,
  "anthropic/searchHint": "workflow multi-agent orchestration fan out subagents parallel verify ultracode",
};

/**
 * The tools one enabled agent sees. Without guidance this is the base catalog the MCP shim
 * embeds; the shim appends the same guidance text itself (see MCP_SOURCE).
 */
export function toolDefinitions(guidance?: ToolGuidance): Array<{ name: McpToolName; description: string; inputSchema: unknown; _meta?: unknown }> {
  // Without guidance the slot stays in place for the shim, which fills it per agent.
  const workflowDescription = guidance ? WORKFLOW_TOOL_DESCRIPTION.replace(GUIDANCE_SLOT, () => guidanceText(guidance)) : WORKFLOW_TOOL_DESCRIPTION;
  const schemas: Record<McpToolName, { description: string; inputSchema: unknown; _meta?: unknown }> = {
    workflow: {
      description: workflowDescription,
      ...(guidance ? { _meta: WORKFLOW_TOOL_META } : {}),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          script: {
            type: "string",
            description:
              "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal) followed by the body using agent()/parallel()/pipeline()/phase().",
          },
          scriptPath: {
            type: "string",
            description:
              "Path of a workflow script on disk; wins over script and name. Every launch saves its script and returns the path: edit that file and launch again with it instead of resending the script.",
          },
          name: {
            type: "string",
            description: "Name of a built-in workflow (deep-review, deep-research, design-panel, critique, verify-claims; `builtin.<name>` skips a saved file of the same name) or a saved one (.paseo/workflows/<name>.js or .claude/workflows/<name>.js in the project, or under ~/.paseo or ~/.claude); workflow_reference lists them with their args.",
          },
          args: {
            description:
              "Value exposed to the script as the global `args`, verbatim. Pass arrays and objects as JSON values, not as a JSON-encoded string.",
          },
          resumeFromRunId: {
            type: "string",
            pattern: "^wf_[a-z0-9-]{6,}$",
            description:
              "Run id of an earlier run you launched, to resume from: the longest unchanged prefix of agent() calls (same prompt and options, in order) returns cached results; the first edited or new call and everything after it run again. Stop that run first if it is still running.",
          },
        },
      },
    },
    workflow_status: {
      description: STATUS_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: { type: "string", description: "Run id (wf_...). Omit to list your recent runs." },
          waitSeconds: { type: "number", minimum: 0, maximum: 50, description: "Wait up to this many seconds for the run to end." },
        },
      },
    },
    workflow_stop: {
      description: STOP_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["runId"],
        properties: { runId: { type: "string", description: "Run id (wf_...)." } },
      },
    },
    workflow_reference: {
      description: REFERENCE_TOOL_DESCRIPTION,
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  };
  return MCP_TOOL_NAMES.map((name) => ({ name, ...schemas[name] }));
}

/** Shared by both programs: one POST to the bridge, retried while the plugin restarts. */
const CLIENT_SOURCE = String.raw`
const env = process.env;
const socketPath = path.join(env.DYNAMIC_WORKFLOW_HOME || '', 'bridge.sock');
// Only failures before a connection are safe to retry for a non-idempotent launch.
const TRANSPORT = new Set(['ENOENT', 'ECONNREFUSED']);

function requestOnce(urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    if (env.__BINDING_ENV__) headers['x-dynamic-workflow-binding'] = env.__BINDING_ENV__;
    if (env.PASEO_AGENT_ID) headers['x-dynamic-workflow-agent'] = env.PASEO_AGENT_ID;
    const request = http.request({ socketPath, path: urlPath, method: 'POST', headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { parsed = null; }
        resolve({ status: response.statusCode || 0, body: parsed });
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error('request timed out');
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    });
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callTool(name, args) {
  if (Buffer.byteLength(JSON.stringify({ arguments: args || {} })) > 2 * 1024 * 1024) {
    return { error: 'too_large: Request body is larger than 2 MB; use scriptPath instead of an inline script.' };
  }
  const deadline = Date.now() + 20000;
  let delay = 250;
  for (;;) {
    let outcome;
    try {
      outcome = await requestOnce('/v1/tools/' + name, { arguments: args || {} }, 120000);
    } catch (error) {
      if (!TRANSPORT.has(error.code) || Date.now() >= deadline) {
        return { error: 'The paseo-dynamic-workflow plugin is not reachable on this host (' + socketPath + '): ' + error.message + '. If it is reloading, try again; if it was removed, these tools no longer work.' };
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
      continue;
    }
    if (outcome.status >= 200 && outcome.status < 300 && outcome.body) return { text: String(outcome.body.text) };
    const failure = outcome.body && outcome.body.error ? outcome.body.error : { code: 'http_' + outcome.status, message: 'HTTP ' + outcome.status };
    return { error: failure.code + ': ' + failure.message };
  }
}
`;

export const MCP_SOURCE = String.raw`// Written by the paseo-dynamic-workflow Paseo plugin at every start; edits are overwritten.
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';

const VERSION = '__PLUGIN_VERSION__';
const SERVER_NAME = '__SERVER_NAME__';
const TOOLS = __TOOLS_JSON__;
const ULTRACODE_TEXT = __ULTRACODE_JSON__;
const SIZE_TEXT = __SIZE_TEXT_JSON__;
const DEFAULT_SIZE = '__DEFAULT_SIZE__';
const TOOL_META = __TOOL_META_JSON__;
const GUIDANCE_SLOT = __GUIDANCE_SLOT_JSON__;
const INSTRUCTIONS = __INSTRUCTIONS_JSON__;
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
__CLIENT_SOURCE__
function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

// Only an explicitly enabled agent gets descriptions. Reading the durable state also works
// while the bridge restarts; missing/invalid state fails closed. Watch the directory because
// the plugin replaces its JSON files atomically.
async function readJson(name) {
  return JSON.parse(await readFile(path.join(env.DYNAMIC_WORKFLOW_HOME, name), 'utf8'));
}
async function accessForAgent() {
  try {
    let agentId = env.PASEO_AGENT_ID;
    const nonce = env.__BINDING_ENV__;
    if (nonce) {
      const bindings = await readJson('bindings.json');
      agentId = bindings.bindings && bindings.bindings[nonce] && bindings.bindings[nonce].agentId;
    }
    if (!agentId) return null;
    const access = await readJson('agent-access.json');
    const ids = (list) => Array.isArray(list) && list.every((id) => typeof id === 'string' && id.length > 0);
    if (access.version !== 1 || !ids(access.enabledAgentIds) || !access.enabledAgentIds.includes(agentId)) return null;
    const ultracode = Array.isArray(access.ultracodeAgentIds) && access.ultracodeAgentIds.includes(agentId);
    return { ultracode, size: await processSize() };
  } catch { return null; }
}
// The size guideline is read once per process: a later settings change must not rewrite every
// enabled agent's tool list (and prompt cache). Launch results and notifications carry the current value.
let sizeOnce = null;
function processSize() {
  sizeOnce ??= readJson('guidance.json').then(
    (guidance) => (guidance && guidance.version === 1 && Object.hasOwn(SIZE_TEXT, guidance.workflowSize) ? guidance.workflowSize : DEFAULT_SIZE),
    () => DEFAULT_SIZE,
  ).catch(() => DEFAULT_SIZE);
  return sizeOnce;
}
function toolsFor(access) {
  if (!access) return [];
  const text = access.ultracode ? ULTRACODE_TEXT : SIZE_TEXT[access.size];
  return TOOLS.map((tool) => (tool.name === 'workflow' ? { ...tool, description: tool.description.replace(GUIDANCE_SLOT, () => text), _meta: TOOL_META } : tool));
}
const fingerprint = (access) => (access ? (access.ultracode ? 'ultracode' : 'on') : 'off');

let initialized = false;
let lastListed = 'off';
let closed = false;
let check = Promise.resolve();
function serializeAvailability(operation) {
  const pending = check.then(operation);
  check = pending.catch(() => {});
  return pending;
}
function checkAvailability() {
  return serializeAvailability(async () => {
    const listed = fingerprint(await accessForAgent());
    if (!closed && initialized && listed !== lastListed) {
      lastListed = listed;
      write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
  });
}
let watcher;
try {
  watcher = watch(env.DYNAMIC_WORKFLOW_HOME, (_event, name) => {
    if (!name || name === 'agent-access.json' || name === 'bindings.json') checkAvailability();
  });
  watcher.on('error', () => { watcher.close(); });
} catch { /* Missing state remains disabled. A new process can attach after installation. */ }

async function handle(message) {
  if (!message || typeof message !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  const id = message.id;
  const isRequest = id !== undefined && id !== null;
  const reply = (result) => (isRequest ? { jsonrpc: '2.0', id, result } : null);
  switch (message.method) {
    case 'initialize': {
      const requested = message.params && message.params.protocolVersion;
      // Instructions only for an enabled agent; they are read once per connection (a reload refreshes them).
      const access = await accessForAgent();
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        ...(access ? { instructions: INSTRUCTIONS + (access.ultracode ? '\n' + ULTRACODE_TEXT : '') } : {}),
      });
    }
    case 'notifications/initialized':
      initialized = true;
      checkAvailability();
      return null;
    case 'ping':
      return reply({});
    case 'tools/list': {
      const access = await accessForAgent();
      lastListed = fingerprint(access);
      return reply({ tools: toolsFor(access) });
    }
    case 'tools/call': {
      const params = message.params || {};
      if (!TOOLS.some((tool) => tool.name === params.name)) {
        return reply({ content: [{ type: 'text', text: 'Unknown tool: ' + params.name }], isError: true });
      }
      const outcome = await callTool(params.name, params.arguments);
      if (outcome.error) return reply({ content: [{ type: 'text', text: outcome.error }], isError: true });
      return reply({ content: [{ type: 'text', text: outcome.text }] });
    }
    default:
      if (!isRequest) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + message.method } };
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('close', () => { closed = true; watcher?.close(); });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (e) {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const batch = Array.isArray(message);
  const items = batch ? message : [message];
  const dispatch = () => Promise.all(items.map((item) => handle(item).catch((error) => ({
    jsonrpc: '2.0', id: item && item.id !== undefined ? item.id : null, error: { code: -32603, message: String(error && error.message) },
  })))).then((responses) => {
    const present = responses.filter(Boolean);
    if (batch) {
      if (present.length > 0) write(present);
    } else if (present[0]) write(present[0]);
  });
  // Keep the response write in the same lane as watcher notifications. Otherwise an old
  // listing can arrive after its invalidation and become the client's final cached catalog.
  // Whole batch replies stay atomic; ordinary tools/call messages remain concurrent.
  if (items.some((item) => item && item.method === 'tools/list')) void serializeAvailability(dispatch);
  else void dispatch();
});
process.stdout.on('error', () => process.exit(0));
`;

export const CLI_SOURCE = String.raw`// Written by the paseo-dynamic-workflow Paseo plugin at every start; edits are overwritten.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const VERSION = '__PLUGIN_VERSION__';
__CLIENT_SOURCE__
const USAGE = [
  'paseo-workflow ' + VERSION + ': run Paseo dynamic workflows from an agent shell.',
  '',
  'Usage:',
  '  paseo-workflow run --file <script.js> [--args-json <json>] [--resume <runId>]',
  '  paseo-workflow run --name <saved-workflow> [--args-json <json>]',
  '  paseo-workflow run --script-path <path> [--resume <runId>]   (run a saved script file in place)',
  '  paseo-workflow status [runId] [--wait <seconds>]',
  '  paseo-workflow stop <runId>',
  '  paseo-workflow reference',
  '',
  'The calling agent is identified by PASEO_AGENT_ID, which Paseo sets for agent processes.',
].join('\n');

function parse(argv, allowed, maxPositionals) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('-')) {
      if (!allowed.includes(token)) fail('unknown option ' + token);
      if (Object.hasOwn(flags, token)) fail('duplicate option ' + token);
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) fail('missing value for ' + token);
      flags[token] = value;
    } else positional.push(token);
  }
  if (positional.length > maxPositionals) fail('unexpected argument ' + positional[maxPositionals]);
  return { flags, positional };
}

function fail(message) {
  process.stderr.write('paseo-workflow: ' + message + '\n\n' + USAGE + '\n');
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  let outcome;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  if (command === 'run') {
    const args = {};
    const { flags } = parse(argv.slice(1), ['--file', '--script-path', '--name', '--args-json', '--resume'], 0);
    const file = flags['--file'];
    const scriptPath = flags['--script-path'];
    const name = flags['--name'];
    const json = flags['--args-json'];
    const resume = flags['--resume'];
    if ([file, scriptPath, name].filter(Boolean).length !== 1) fail('give exactly one of --file, --script-path or --name');
    if (file) args.script = fs.readFileSync(path.resolve(file), 'utf8');
    if (scriptPath) args.scriptPath = path.resolve(scriptPath);
    if (name) args.name = name;
    if (!args.script && !args.scriptPath && !args.name) fail('give --file, --script-path or --name');
    if (json !== undefined) {
      try { args.args = JSON.parse(json); } catch (e) { fail('--args-json is not valid JSON: ' + e.message); }
    }
    if (resume) args.resumeFromRunId = resume;
    outcome = await callTool('workflow', args);
  } else if (command === 'status') {
    const { flags, positional } = parse(argv.slice(1), ['--wait'], 1);
    const runId = positional[0];
    const wait = flags['--wait'];
    if (wait !== undefined && (!Number.isFinite(Number(wait)) || Number(wait) < 0 || Number(wait) > 50)) fail('--wait must be a number from 0 to 50');
    outcome = await callTool('workflow_status', { runId, waitSeconds: wait ? Number(wait) : 0 });
  } else if (command === 'stop') {
    const { positional } = parse(argv.slice(1), [], 1);
    if (!positional[0] || !/^wf_[a-z0-9-]{6,}$/.test(positional[0])) fail('stop needs a run id (wf_...)');
    outcome = await callTool('workflow_stop', { runId: positional[0] });
  } else if (command === 'reference') {
    parse(argv.slice(1), [], 0);
    outcome = await callTool('workflow_reference', {});
  } else {
    fail('unknown command ' + command);
  }
  if (outcome.error) {
    process.stderr.write(outcome.error + '\n');
    process.exit(1);
  }
  process.stdout.write(outcome.text + '\n');
}

main().catch((error) => {
  process.stderr.write('paseo-workflow: ' + (error && error.message ? error.message : String(error)) + '\n');
  process.exit(1);
});
`;

function fill(source: string): string {
  return source
    .replace("__CLIENT_SOURCE__", () => CLIENT_SOURCE.replaceAll("__BINDING_ENV__", BINDING_ENV))
    .replaceAll("__BINDING_ENV__", BINDING_ENV)
    .replace("__PLUGIN_VERSION__", () => PLUGIN_VERSION)
    .replace("__SERVER_NAME__", () => MCP_SERVER)
    .replace("__TOOLS_JSON__", () => JSON.stringify(toolDefinitions()))
    .replace("__ULTRACODE_JSON__", () => JSON.stringify(ULTRACODE_SHORT))
    .replace("__SIZE_TEXT_JSON__", () => JSON.stringify(Object.fromEntries(WORKFLOW_SIZES.map((size) => [size, sizeGuidelineText(size)]))))
    .replace("__DEFAULT_SIZE__", () => DEFAULT_WORKFLOW_SIZE)
    .replace("__TOOL_META_JSON__", () => JSON.stringify(WORKFLOW_TOOL_META))
    .replace("__GUIDANCE_SLOT_JSON__", () => JSON.stringify(GUIDANCE_SLOT))
    .replace("__INSTRUCTIONS_JSON__", () => JSON.stringify(mcpInstructions({ ultracode: false, size: DEFAULT_WORKFLOW_SIZE })));
}

export function renderMcp(): string {
  return fill(MCP_SOURCE);
}

export function renderCli(): string {
  return fill(CLI_SOURCE);
}

async function writeIfChanged(file: string, text: string, mode: number): Promise<void> {
  const current = await readFile(file, "utf8").catch(() => null);
  if (current !== text) await writeAtomically(file, text, mode);
  await chmod(file, mode);
}

const STATIC_REFERENCE_NOTE = "> This file is a static copy without your per-agent status. `workflow_reference` (or `paseo-workflow reference`) returns it with your current Ultracode mode, your limits and the named workflows you can launch.";

/** Writes the shims, the two programs and REFERENCE.md. */
export async function writeScripts(paths: StatePaths, node: NodeRuntime = currentNode()): Promise<void> {
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  await mkdir(paths.lib, { recursive: true, mode: 0o700 });
  await writeIfChanged(paths.mcpScript, renderMcp(), 0o600);
  await writeIfChanged(paths.cliScript, renderCli(), 0o600);
  await writeIfChanged(paths.mcp, renderShim(paths.root, "mcp.mjs", node), 0o700);
  await writeIfChanged(paths.cli, renderShim(paths.root, "cli.mjs", node), 0o700);
  await writeIfChanged(paths.reference, `${STATIC_REFERENCE_NOTE}\n\n${REFERENCE}`, 0o600);
  await mkdir(paths.builtins, { recursive: true, mode: 0o700 });
  // Read-only: they document the built-ins; to change one, copy it into a workflows directory.
  for (const [name, script] of Object.entries(BUILTIN_WORKFLOWS)) await writeIfChanged(join(paths.builtins, `${name}.js`), script, 0o400);
}
