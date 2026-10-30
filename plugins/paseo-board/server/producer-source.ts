/** Installed dependency-free latest-state producer SDK. */
export const PRODUCER_SOURCE = String.raw`
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open, rename, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const LIMIT = 256000;
const fail = (code, message) => Object.assign(new Error(message), { code });
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
function json(value) {
  let count = 0;
  const visit = (item, depth) => {
    if (++count > 100000 || depth > 64) throw fail('size_limit', 'Feed value is too complex');
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) { item.forEach(x => visit(x, depth + 1)); return; }
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) { Object.values(item).forEach(x => visit(x, depth + 1)); return; }
    throw fail('invalid_input', 'Feed values must be finite JSON');
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > LIMIT) throw fail('size_limit', 'Feed value exceeds 256000 bytes');
  return JSON.parse(text);
}
async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw fail('unsafe_path', 'Feed journal must be a regular file');
  if (stat.size > 600000) throw fail('size_limit', 'Feed journal exceeds its bound');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function atomic(path, value) {
  const temporary = path + '.tmp-' + randomUUID();
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
// A stateFile belongs to one producer. Concurrent use fails without queuing values.
// A dead local process may be recovered; a live or unknown PID is never displaced.
async function lock(path) {
  const lockPath = path + '.lock';
  const identity = { pid: process.pid, nonce: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
      return async () => {
        const owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
        if (owner.nonce === identity.nonce) await rm(lockPath, { recursive: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await lstat(lockPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('unsafe_path', 'Feed journal lock is not a directory');
      let owner;
      try { owner = JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')); }
      catch { throw fail('producer_busy', 'Feed journal lock has no confirmed owner; inspect it before recovery'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw fail('producer_busy', 'Feed lock PID is unknown');
      try { process.kill(owner.pid, 0); throw fail('producer_busy', 'Another live producer holds this stateFile'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      const current = await lstat(lockPath);
      if (current.ino !== stat.ino) throw fail('producer_busy', 'Feed lock changed during recovery');
      const abandoned = lockPath + '.abandoned-' + randomUUID();
      await rename(lockPath, abandoned);
      await rm(abandoned, { recursive: true });
    }
  }
  throw fail('producer_busy', 'Could not acquire the feed journal');
}
function transport(root, binding, input) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(root, 'bridge.sock'));
    let text = '', done = false;
    const decoder = new StringDecoder('utf8');
    const finish = (error, result) => { if (done) return; done = true; socket.destroy(); error ? reject(error) : resolve(result); };
    socket.setTimeout(15000, () => finish(fail('outcome_unknown', 'Board timed out; this exact pending value is retained')));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(JSON.stringify({ protocol: 1, client: 'cli', binding, operation: 'feed', input }) + '\n'));
    socket.on('data', bytes => {
      text += decoder.write(bytes);
      if (Buffer.byteLength(text) > 1000000) { finish(fail('outcome_unknown', 'Unexpectedly large feed response')); return; }
      if (!text.includes('\n')) return;
      try {
        const response = JSON.parse(text.split('\n')[0]);
        if (!response.ok) finish(Object.assign(fail(response.error.code, response.error.message), { confirmed: true, details: response.error.details }));
        else finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.on('end', () => { if (!done) finish(fail('outcome_unknown', 'Board closed before acknowledgement; pending value retained')); });
  });
}

/** Latest JSON state, with one durable pending operation and bounded identical retries.
 * Import from the installed runtime lib/feed.mjs. Inherit PASEO_BOARD_BINDING from
 * the owning agent; no credentials are accepted in options or written to disk.
 */
export async function createFeed(options) {
  const { boardId, sourceId, path, focusSelectors = [] } = options;
  if (!options.stateFile || !options.stateFile.startsWith('/')) throw fail('invalid_input', 'stateFile must be an absolute durable path owned by this producer');
  const root = process.env.PASEO_BOARD_HOME || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const binding = process.env.PASEO_BOARD_BINDING;
  if (!root || !binding) throw fail('forbidden', 'Use the installed Board runtime and inherit this agent’s PASEO_BOARD_BINDING');
  const stateFile = resolve(options.stateFile);
  await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
  const config = json({ boardId, sourceId, path, focusSelectors });
  let active = false;
  async function exclusive(fn) {
    if (active) throw fail('producer_busy', 'Await the current feed operation before submitting another value');
    active = true;
    let release;
    try { release = await lock(stateFile); return await fn(); }
    finally { try { if (release) await release(); } finally { active = false; } }
  }
  async function load() {
    const state = await regular(stateFile);
    if (state.version !== 1 || canonical(state.config) !== canonical(config)) throw fail('state_conflict', 'This journal belongs to another feed configuration');
    return state;
  }
  async function send(input) {
    for (let attempt = 0; ; attempt++) {
      try { return await transport(root, binding, input); }
      catch (error) {
        if (attempt >= 2 || error.confirmed && error.code !== 'backpressure') throw error;
        await new Promise(resolve => setTimeout(resolve, [40, 120][attempt]));
      }
    }
  }
  async function settle(state) {
    if (!state.pending) return state.lastAck;
    const request = state.pending;
    try {
      const result = await send(request);
      if (result.source?.sourceId !== sourceId || result.source?.path !== path) throw fail('outcome_unknown', 'Source receipt does not match this feed');
      if (state.actorAgentId && result.source.actorAgentId !== state.actorAgentId) throw fail('forbidden', 'Feed writer identity changed');
      if (request.action !== 'close') {
        const ack = result.ack;
        if (!ack || ack.boardId !== boardId || ack.sourceId !== sourceId || !Number.isSafeInteger(ack.revision) || ack.generation !== (request.action === 'open' ? request.expectedGeneration + 1 : request.generation) || ack.seq !== (request.action === 'open' ? 0 : request.seq)) throw fail('outcome_unknown', 'Unconfirmed sequence receipt; pending value retained');
        state.generation = ack.generation; state.seq = ack.seq; state.lastAck = ack; state.actorAgentId = result.source.actorAgentId;
      } else state.closed = true;
      delete state.pending; delete state.lastError;
      await atomic(stateFile, state);
      return result.ack ?? result.source;
    } catch (error) {
      state.lastError = { code: error.code ?? 'outcome_unknown', message: error.message, at: new Date().toISOString(), confirmed: error.confirmed === true };
      await atomic(stateFile, state);
      throw error;
    }
  }
  await exclusive(async () => {
    let state;
    try { state = await load(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { version: 1, config, seq: 0, pending: { ...config, action: 'open', requestId: randomUUID(), expectedGeneration: 0 } };
      await atomic(stateFile, state);
    }
    if (options.restart === true) {
      if (state.pending && state.lastError?.confirmed !== true) throw fail('pending_write', 'An unknown operation must be retried before replacing this producer generation');
      const current = await send({ boardId, sourceId, action: 'status' });
      if (state.actorAgentId && state.actorAgentId !== current.source.actorAgentId) throw fail('forbidden', 'Another writer owns this source');
      state.pending = { ...config, action: 'open', requestId: randomUUID(), expectedGeneration: current.source.generation };
      delete state.closed;
      await atomic(stateFile, state);
    }
    // Resume an interrupted write with its immutable payload before accepting new work.
    if (state.pending) await settle(state);
    else {
      const result = await send({ boardId, sourceId, action: 'status' });
      if (state.actorAgentId !== result.source.actorAgentId || state.generation !== result.source.generation || result.source.closed) throw fail('generation_conflict', 'Feed generation changed or closed; inspect and explicitly reopen it');
    }
  });
  return {
    set: (value, policy = {}) => exclusive(async () => {
      const state = await load();
      const request = { boardId, sourceId, action: 'set', generation: state.generation, seq: state.seq + 1, value: json(value), attention: policy.attention ?? 'quiet', ...(policy.focusSelectors ? { focusSelectors: json(policy.focusSelectors) } : {}) };
      if (state.closed) throw fail('source_closed', 'Feed is closed');
      if (state.pending && canonical(state.pending) !== canonical(request)) throw fail('pending_write', 'Reconcile the retained pending value with retry(); do not replace it with a new value');
      state.pending = request;
      await atomic(stateFile, state);
      return settle(state);
    }),
    retry: () => exclusive(async () => settle(await load())),
    status: () => exclusive(async () => ({ local: await load(), remote: await send({ boardId, sourceId, action: 'status' }) })),
    reopen: (options = {}) => exclusive(async () => {
      const state = await load();
      if (state.pending && !(options.discardRejected === true && state.lastError?.confirmed === true)) throw fail('pending_write', 'Retry unknown writes; explicitly discardRejected:true only for a confirmed rejection');
      const current = await send({ boardId, sourceId, action: 'status' });
      if (current.source.actorAgentId !== state.actorAgentId) throw fail('forbidden', 'Another writer owns this source');
      state.pending = { ...config, action: 'open', expectedGeneration: current.source.generation, requestId: randomUUID() };
      delete state.closed;
      await atomic(stateFile, state);
      return settle(state);
    }),
    close: () => exclusive(async () => {
      const state = await load();
      if (state.pending) throw fail('pending_write', 'Resolve the pending operation before closing');
      state.pending = { boardId, sourceId, action: 'close', generation: state.generation };
      await atomic(stateFile, state);
      return settle(state);
    }),
  };
}
`;
