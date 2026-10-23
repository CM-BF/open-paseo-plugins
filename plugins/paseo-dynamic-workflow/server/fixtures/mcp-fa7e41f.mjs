// Written by the paseo-dynamic-workflow Paseo plugin at every start; edits are overwritten.
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';

const VERSION = '0.1.0';
const SERVER_NAME = 'dynamic_workflow';
const TOOLS = [{"name":"workflow","description":"Execute a workflow script that orchestrates multiple Paseo agents deterministically. The run happens in the background: this tool returns immediately with a run id, and a <task-notification> message arrives when the workflow ends (end your turn rather than waiting). The user watches progress in the run card and the Dynamic workflows panel.\n\nOnly launch one when the user explicitly opted into multi-agent orchestration: they asked in their own words (\"use a workflow\", \"fan out agents\", \"orchestrate this with subagents\"), invoked a skill or command that says to run one, or asked for a named workflow. A task that would merely benefit from parallelism does not count: describe what a workflow would do and roughly what it costs, and ask. Workflows can start dozens of agents and spend a lot of tokens.\n\nCall workflow_reference before writing your first script: it documents the full API, limits, patterns and resume.\n\nEvery script must begin with `export const meta = {...}`, a PURE LITERAL (no variables, calls or interpolation) with `name`, a one-line `description` and optionally `phases` (one { title, detail? } per phase() title). The body is plain JavaScript (not TypeScript), already async, and returns the result. Pass it inline via `script`; do not write it to a file first.\n\nGlobals: agent(prompt, {label, phase, schema, model, effort, agentType, provider, isolation: 'worktree', cwd}) starts one Paseo agent and resolves with its final text, or with a validated object when `schema` (JSON Schema, object at the root) is given, or null when the agent fails or is skipped. pipeline(items, ...stages) runs each item through the stages with no barrier; each stage gets (prev, original, index); a throwing stage makes that item null. parallel(thunks) is a barrier over functions (not promises); a throwing thunk gives null. phase(title), log(message), args, budget {total, spent(), remaining()}, workflow(nameOrRef, args). Date.now(), Math.random() and argless new Date() throw; there is no filesystem or network access.\n\nCanonical pattern (pipeline by default; each review verifies as soon as it finishes):\n  export const meta = { name: 'review-changes', description: 'Review changes across dimensions, verify each finding', phases: [{ title: 'Review' }, { title: 'Verify' }] }\n  const results = await pipeline(\n    DIMENSIONS,\n    d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),\n    review => parallel(review.findings.map(f => () =>\n      agent('Try to refute: ' + f.title, { label: 'verify:' + f.file, phase: 'Verify', schema: VERDICT_SCHEMA })\n        .then(v => ({ ...f, verdict: v })))),\n  )\n  return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict && f.verdict.isReal) }\n\nTo iterate, edit the script file named in the result and launch again with {scriptPath}; add resumeFromRunId to reuse completed agent() results.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"script":{"type":"string","description":"Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal) followed by the body using agent()/parallel()/pipeline()/phase()."},"scriptPath":{"type":"string","description":"Path of a workflow script on disk; wins over script and name. Every launch saves its script and returns the path: edit that file and launch again with it instead of resending the script."},"name":{"type":"string","description":"Name of a saved workflow (.paseo/workflows/<name>.js or .claude/workflows/<name>.js in the project, or under ~/.paseo or ~/.claude)."},"args":{"description":"Value exposed to the script as the global `args`, verbatim. Pass arrays and objects as JSON values, not as a JSON-encoded string."},"resumeFromRunId":{"type":"string","pattern":"^wf_[a-z0-9-]{6,}$","description":"Run id of an earlier run to resume from: agent() calls with unchanged prompt and options return its cached results; only edited or new calls run. Stop that run first if it is still running."}}}},{"name":"workflow_status","description":"Report a dynamic workflow run: status, phases, active agents, recent log lines and, once it ended, the result. Without runId, list your recent runs. waitSeconds (at most 50) waits for the run to end before answering; prefer ending your turn and waiting for the <task-notification>.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"runId":{"type":"string","description":"Run id (wf_...). Omit to list your recent runs."},"waitSeconds":{"type":"number","minimum":0,"maximum":50,"description":"Wait up to this many seconds for the run to end."}}}},{"name":"workflow_stop","description":"Stop a running dynamic workflow: queued agent() calls fail, running child agents are stopped and archived, and the run ends as stopped. Completed results stay in the journal for resumeFromRunId.","inputSchema":{"type":"object","additionalProperties":false,"required":["runId"],"properties":{"runId":{"type":"string","description":"Run id (wf_...)."}}}},{"name":"workflow_reference","description":"Return the dynamic workflow authoring reference: script API and options, limits, pipeline versus barrier, quality patterns, prompts for child agents, and resume. Read it before writing your first workflow script. It does not itself authorize running a workflow.","inputSchema":{"type":"object","additionalProperties":false,"properties":{}}}];
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

const env = process.env;
const socketPath = path.join(env.DYNAMIC_WORKFLOW_HOME || '', 'bridge.sock');
// Only failures before a connection are safe to retry for a non-idempotent launch.
const TRANSPORT = new Set(['ENOENT', 'ECONNREFUSED']);

function requestOnce(urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
    if (env.PASEO_DYNAMIC_WORKFLOW_BINDING) headers['x-dynamic-workflow-binding'] = env.PASEO_DYNAMIC_WORKFLOW_BINDING;
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

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

// Only an explicitly enabled agent gets descriptions. Reading the durable state also works
// while the bridge restarts; missing/invalid state fails closed. Watch the directory because
// the plugin replaces its JSON files atomically.
async function enabledForAgent() {
  try {
    let agentId = env.PASEO_AGENT_ID;
    const nonce = env.PASEO_DYNAMIC_WORKFLOW_BINDING;
    if (nonce) {
      const bindings = JSON.parse(await readFile(path.join(env.DYNAMIC_WORKFLOW_HOME, 'bindings.json'), 'utf8'));
      agentId = bindings.bindings && bindings.bindings[nonce] && bindings.bindings[nonce].agentId;
    }
    if (!agentId) return false;
    const access = JSON.parse(await readFile(path.join(env.DYNAMIC_WORKFLOW_HOME, 'agent-access.json'), 'utf8'));
    return access.version === 1 && Array.isArray(access.enabledAgentIds)
      && access.enabledAgentIds.every((id) => typeof id === 'string' && id.length > 0)
      && access.enabledAgentIds.includes(agentId);
  } catch { return false; }
}

let initialized = false;
let lastEnabled = false;
let closed = false;
let check = Promise.resolve();
function serializeAvailability(operation) {
  const pending = check.then(operation);
  check = pending.catch(() => {});
  return pending;
}
function checkAvailability() {
  return serializeAvailability(async () => {
    const enabled = await enabledForAgent();
    if (!closed && initialized && enabled !== lastEnabled) {
      lastEnabled = enabled;
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
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      });
    }
    case 'notifications/initialized':
      initialized = true;
      checkAvailability();
      return null;
    case 'ping':
      return reply({});
    case 'tools/list': {
      const enabled = await enabledForAgent();
      lastEnabled = enabled;
      return reply({ tools: enabled ? TOOLS : [] });
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
