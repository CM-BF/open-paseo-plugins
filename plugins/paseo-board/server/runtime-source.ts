/** Standalone CLI/MCP transport written into the plugin's stable runtime directory. */
export const RUNTIME_SOURCE = String.raw`
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const definitions = __BOARD_TOOL_DEFINITIONS__;
const root = process.env.PASEO_BOARD_HOME;
const mode = process.argv[2];
const MAX = 8000000;
function request(operation, input) {
  return new Promise((resolve, reject) => {
    if (!root) { reject(new Error('PASEO_BOARD_HOME is missing; use the installed launcher')); return; }
    const socket = createConnection(join(root, 'bridge.sock'));
    let chunks = [], size = 0, settled = false;
    const done = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(15000, () => done(new Error('Board service timed out; outcome may be unknown. Retry only with the same eventId and payload.')));
    socket.on('error', error => done(error));
    socket.on('connect', () => socket.write(JSON.stringify({ protocol: 1, client: mode === 'mcp' ? 'mcp' : 'cli', binding: process.env.PASEO_BOARD_BINDING || undefined, operation, input }) + '\n'));
    socket.on('data', chunk => {
      chunks.push(chunk); size += chunk.length;
      if (size > MAX * 8) { done(new Error('Board response too large')); return; }
      if (!chunk.includes(10)) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8').split('\n')[0]);
        if (!payload.ok) { const error = new Error(payload.error.message); error.code = payload.error.code; error.details = payload.error.details; done(error); }
        else done(null, payload.result);
      } catch (error) { done(error); }
    });
    socket.on('end', () => { if (!settled) done(new Error('Board service closed without a receipt')); });
  });
}
function compact(operation, result) {
  if (operation === 'read' || operation === 'list' || !result || !result.canvas) return result;
  return { id: result.id, title: result.title, revision: result.revision, canvasRevision: result.canvas.revision, updatedAt: result.updatedAt, decisionCount: result.decisions.length, interactions: result.interactions.map(x => ({ id: x.id, status: x.status, agentId: x.agentId, resultReferences: x.resultReferences })) };
}
function write(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
if (mode === 'mcp') {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', async line => {
    if (Buffer.byteLength(line) > MAX) return;
    let message;
    try { message = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (message.id === undefined) return;
    const respond = result => write({ jsonrpc: '2.0', id: message.id, result });
    try {
      if (message.method === 'initialize') { respond({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'paseo-board', version: '0.1.0' }, instructions: 'Persistent, fully interactive free canvases; read current revision before publish. Ordinary events do not wake agents.' }); return; }
      if (message.method === 'ping') { respond({}); return; }
      if (message.method === 'tools/list') { respond({ tools: definitions }); return; }
      if (message.method !== 'tools/call') { write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }); return; }
      const tool = definitions.find(x => x.name === message.params?.name);
      if (!tool) throw new Error('Unknown board tool');
      const operation = tool.name.slice('board_'.length);
      const result = await request(operation, message.params.arguments || {});
      respond({ content: [{ type: 'text', text: JSON.stringify(compact(operation, result)) }] });
    } catch (error) { respond({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, code: error.code, details: error.details }) }] }); }
  });
} else {
  try {
    const args = process.argv.slice(3);
    const operation = args.shift();
    if (!operation || ['--help', '-h', 'help'].includes(operation)) {
      process.stdout.write('Usage: paseo-board <list|read|create|publish|respond|decision|emit> [--file /absolute/input.json | --json JSON]\nNo input option reads JSON from stdin. list defaults to {}. create/publish/respond accept htmlFile.\n');
    } else {
      if (!definitions.some(tool => tool.name === 'board_' + operation)) throw new Error('Unknown operation: ' + operation);
      let raw = '{}';
      if (args[0] === '--file' && args.length === 2) raw = await readFile(args[1], 'utf8');
      else if (args[0] === '--json' && args.length === 2) raw = args[1];
      else if (args.length) throw new Error('Use --file PATH, --json JSON, or stdin');
      else if (!process.stdin.isTTY) { const chunks = []; let bytes = 0; for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > MAX) throw new Error('Input exceeds 8 MB'); chunks.push(chunk); } raw = Buffer.concat(chunks).toString('utf8') || '{}'; }
      const result = await request(operation, JSON.parse(raw));
      write(compact(operation, result));
    }
  } catch (error) { process.stderr.write(JSON.stringify({ error: error.message, code: error.code, details: error.details }) + '\n'); process.exitCode = 1; }
}
`;
