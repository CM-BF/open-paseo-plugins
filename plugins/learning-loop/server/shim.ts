// The stdio MCP server agents run: a stable launcher in $STATE/bin plus a dependency-free script in
// $STATE/lib, both rewritten at every plugin start. The script answers initialize/ping itself and
// forwards tools/list and tools/call to the plugin over the unix socket (HTTP), retrying briefly
// while the plugin reloads. Pattern from paseo-async-shell (server/scripts.ts, script-mcp.ts).

import { chmod, mkdir } from "node:fs/promises";
import { BINDING_ENV, MCP_SERVER, PLUGIN_VERSION } from "../shared/constants";
import { writeAtomic } from "./files";
import type { StatePaths } from "./paths";
import type { ToolDefinition } from "./tools";

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
 * Runs the plugin's own Node (the Electron helper on the Mac needs ELECTRON_RUN_AS_NODE), falling
 * back to another node if that path disappeared. Never a volta shim: one re-spawning itself with a
 * changed HOME took a host down (paseo-async-shell, 2026-10-11).
 */
export function renderLauncher(stateDir: string, node: NodeRuntime): string {
  return `#!/bin/sh
# Written by the learning-loop Paseo plugin at every start; edits are overwritten.
LEARNING_LOOP_HOME=${shellQuote(stateDir)}
export LEARNING_LOOP_HOME
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
  echo 'learning-loop MCP: Node.js not found' >&2
  exit 3
fi
if [ "$electron" = 1 ]; then
  ELECTRON_RUN_AS_NODE=1 exec "$node" "$LEARNING_LOOP_HOME/lib/mcp.mjs" "$@"
fi
exec "$node" "$LEARNING_LOOP_HOME/lib/mcp.mjs" "$@"
`;
}

/** Newline-delimited JSON-RPC 2.0, Node built-ins only. No backticks or dollar-brace in the source. */
const MCP_SOURCE = String.raw`// Written by the learning-loop Paseo plugin at every start; edits are overwritten.
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';

const VERSION = '__VERSION__';
const SERVER_NAME = '__SERVER__';
const FALLBACK_TOOLS = __TOOLS_JSON__;
const FALLBACK_TOOLS_V2 = __TOOLS_V2_JSON__;
const FALLBACK_TOOLS_V3 = __TOOLS_V3_JSON__;
const BINDING_ENV = '__BINDING_ENV__';
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const env = process.env;
const socketPath = path.join(env.LEARNING_LOOP_HOME || '', 'bridge.sock');
const TRANSPORT = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function requestOnce(method, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {};
    if (env[BINDING_ENV]) headers['x-learning-binding'] = env[BINDING_ENV];
    if (env.PASEO_AGENT_ID) headers['x-learning-agent'] = env.PASEO_AGENT_ID;
    if (env.PASEO_AGENT_CWD) headers['x-learning-cwd-enc'] = encodeURIComponent(env.PASEO_AGENT_CWD);
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const request = http.request({ socketPath, path: urlPath, method, headers, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = null;
        }
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
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, urlPath, body) {
  const deadline = Date.now() + 15000;
  let delay = 250;
  for (;;) {
    try {
      const outcome = await requestOnce(method, urlPath, body, 60000);
      if (outcome.status >= 200 && outcome.status < 300) return { body: outcome.body };
      const failure = outcome.body && outcome.body.error ? outcome.body.error : { code: 'http_' + outcome.status, message: 'HTTP ' + outcome.status };
      return { error: failure.code + ': ' + failure.message };
    } catch (error) {
      if (!TRANSPORT.has(error.code) || Date.now() >= deadline) {
        return { error: 'The learning-loop Paseo plugin is not reachable (' + socketPath + '): ' + error.message + '. If it is reloading, try again in a moment.' };
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
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
    case 'tools/list': {
      const outcome = await call('GET', '/v1/tools');
      const tools = outcome.body && Array.isArray(outcome.body.tools) ? outcome.body.tools : (String(env[BINDING_ENV] || '').startsWith('v3-') ? FALLBACK_TOOLS_V3 : String(env[BINDING_ENV] || '').startsWith('v2-') || String(env[BINDING_ENV] || '').startsWith('review-') ? FALLBACK_TOOLS_V2 : FALLBACK_TOOLS);
      return reply({ tools });
    }
    case 'tools/call': {
      const params = message.params || {};
      const outcome = await call('POST', '/v1/call', { name: params.name, arguments: params.arguments || {} });
      if (outcome.error) return reply({ content: [{ type: 'text', text: outcome.error }], isError: true });
      const body = outcome.body || {};
      return reply({ content: [{ type: 'text', text: String(body.text || '') }], isError: body.isError === true });
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
  } catch {
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

export function renderMcpScript(tools: readonly ToolDefinition[], toolsV2: readonly ToolDefinition[] = tools, toolsV3: readonly ToolDefinition[] = toolsV2): string {
  return MCP_SOURCE.replace("__VERSION__", PLUGIN_VERSION)
    .replace("__SERVER__", MCP_SERVER)
    .replace("__BINDING_ENV__", BINDING_ENV)
    .replace("__TOOLS_JSON__", () => JSON.stringify(tools))
    .replace("__TOOLS_V2_JSON__", () => JSON.stringify(toolsV2))
    .replace("__TOOLS_V3_JSON__", () => JSON.stringify(toolsV3));
}

export async function installShim(paths: StatePaths, tools: readonly ToolDefinition[], node: NodeRuntime = currentNode(), toolsV2: readonly ToolDefinition[] = tools, toolsV3: readonly ToolDefinition[] = toolsV2): Promise<void> {
  await mkdir(paths.bin, { recursive: true });
  await mkdir(paths.lib, { recursive: true });
  await writeAtomic(paths.mcpScript, renderMcpScript(tools, toolsV2, toolsV3));
  await writeAtomic(paths.mcp, renderLauncher(paths.root, node), 0o755);
  await chmod(paths.mcp, 0o755);
}
