import { chmod, mkdir, readFile } from "node:fs/promises";
import { BINDING_ENV, MCP_SERVER, MCP_TOOL_NAMES, PLUGIN_VERSION, type McpToolName } from "../shared/ids";
import type { StatePaths } from "./paths";
import { REFERENCE_TOOL_DESCRIPTION, STATUS_TOOL_DESCRIPTION, STOP_TOOL_DESCRIPTION, WORKFLOW_TOOL_DESCRIPTION } from "./prompts";
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

export function toolDefinitions(): Array<{ name: McpToolName; description: string; inputSchema: unknown }> {
  const schemas: Record<McpToolName, { description: string; inputSchema: unknown }> = {
    workflow: {
      description: WORKFLOW_TOOL_DESCRIPTION,
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
            description: "Name of a saved workflow (.paseo/workflows/<name>.js or .claude/workflows/<name>.js in the project, or under ~/.paseo or ~/.claude).",
          },
          args: {
            description:
              "Value exposed to the script as the global `args`, verbatim. Pass arrays and objects as JSON values, not as a JSON-encoded string.",
          },
          resumeFromRunId: {
            type: "string",
            pattern: "^wf_[a-z0-9-]{6,}$",
            description:
              "Run id of an earlier run to resume from: agent() calls with unchanged prompt and options return its cached results; only edited or new calls run. Stop that run first if it is still running.",
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
const TRANSPORT = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE']);

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

const VERSION = '__PLUGIN_VERSION__';
const SERVER_NAME = '__SERVER_NAME__';
const TOOLS = __TOOLS_JSON__;
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
__CLIENT_SOURCE__
function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message) {
  if (!message || typeof message !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  const id = message.id;
  const isRequest = id !== undefined && id !== null;
  const reply = (result) => (isRequest ? { jsonrpc: '2.0', id, result } : null);
  switch (message.method) {
    case 'initialize': {
      const requested = message.params && message.params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
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
  Promise.all((batch ? message : [message]).map((item) => handle(item).catch((error) => ({
    jsonrpc: '2.0', id: item && item.id !== undefined ? item.id : null, error: { code: -32603, message: String(error && error.message) },
  })))).then((responses) => {
    const present = responses.filter(Boolean);
    if (batch) {
      if (present.length > 0) write(present);
    } else if (present[0]) write(present[0]);
  });
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

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) fail('missing value for ' + name);
  return value;
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
    const file = option(argv, '--file');
    const scriptPath = option(argv, '--script-path');
    const name = option(argv, '--name');
    const json = option(argv, '--args-json');
    const resume = option(argv, '--resume');
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
    const runId = argv[1] && !argv[1].startsWith('--') ? argv[1] : undefined;
    const wait = option(argv, '--wait');
    outcome = await callTool('workflow_status', { runId, waitSeconds: wait ? Number(wait) : 0 });
  } else if (command === 'stop') {
    if (!argv[1]) fail('stop needs a run id');
    outcome = await callTool('workflow_stop', { runId: argv[1] });
  } else if (command === 'reference') {
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
    .replace("__PLUGIN_VERSION__", () => PLUGIN_VERSION)
    .replace("__SERVER_NAME__", () => MCP_SERVER)
    .replace("__TOOLS_JSON__", () => JSON.stringify(toolDefinitions()));
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

/** Writes the shims, the two programs and REFERENCE.md. */
export async function writeScripts(paths: StatePaths, node: NodeRuntime = currentNode()): Promise<void> {
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  await mkdir(paths.lib, { recursive: true, mode: 0o700 });
  await writeIfChanged(paths.mcpScript, renderMcp(), 0o600);
  await writeIfChanged(paths.cliScript, renderCli(), 0o600);
  await writeIfChanged(paths.mcp, renderShim(paths.root, "mcp.mjs", node), 0o700);
  await writeIfChanged(paths.cli, renderShim(paths.root, "cli.mjs", node), 0o700);
  await writeIfChanged(paths.reference, REFERENCE, 0o600);
}
