import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { httpError } from './comments.mjs';
import { noSymlinks } from './files.mjs';

const prefix = '/_board/live/', channelPattern = /^c[a-f0-9]{32}$/, digestPattern = /^[a-f0-9]{64}$/, tokenPattern = /^[\x21-\x7e]{32,512}$/;
const fileName = /^(c[a-f0-9]{32})\.json$/, temporaryName = /^c[a-f0-9]{32}\.json\.[\w.-]+\.tmp$/;
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
const compress = promisify(gzip);
const limits = { paths: 32, bytes: 60000, depth: 64, channels: 256, writesPerSecond: 4, readBudget: 5000, fileBytes: 131072 };
const leaseMs = 120000, graceMs = 45000, loadWindowMs = 10000, targetRate = 200, minPeriod = 5, maxPeriod = 60;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validSeq = value => Number.isSafeInteger(value) && value >= 1;
const withinDepth = (value, depth = 1) => value === null || typeof value !== 'object' || (depth <= limits.depth && Object.values(value).every(item => withinDepth(item, depth + 1)));

function validPointer(key) {
  if (key.length > 500 || !key.startsWith('/') || /~(?:[^01]|$)/.test(key)) return false;
  const parts = key.slice(1).split('/');
  return parts.length <= limits.depth && !parts.some(part => dangerous.has(part.replace(/~1/g, '/').replace(/~0/g, '~')));
}

/** Returns the canonical text of a public document, or null when its shape is refused. */
function renderValues(value) {
  if (!isObject(value) || Object.keys(value).length > limits.paths || !Object.keys(value).every(validPointer) || !withinDepth(value)) return null;
  return JSON.stringify(value);
}

function acceptsGzip(header) {
  return String(header || '').split(',').some(part => {
    const [name, ...parameters] = part.trim().split(';');
    return name.trim().toLowerCase() === 'gzip' && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(parameter));
  });
}

async function writeAtomic(directory, file, text, unique) {
  const temporary = `${file}.${process.pid}.${unique}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
  } catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  const directoryHandle = await fs.open(directory, 'r');
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
}

export async function createLive(app, deploymentId, { now = Date.now } = {}) {
  // Read once, before authored routes load. Setting the token needs one restart.
  const token = process.env.BOARD_LIVE_WRITE_TOKEN;
  if (!tokenPattern.test(token || '')) return { enabled: false, route: async () => false };
  const expected = Buffer.from(`Bearer ${token}`), startedAt = now(), dep8 = deploymentId.slice(0, 8), channels = new Map(), queues = new Map();
  const directory = await noSymlinks(path.join(app.dataDir, 'live'));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let unique = 0, period = minPeriod, polls = 0, windowStart = startedAt, budgetSecond = 0, budgetSpent = 0;

  const fileOf = channelId => path.join(directory, `${channelId}.json`);
  async function publicDocument(seq, digest, at, values) {
    const version = `${dep8}.${seq}`;
    const body = Buffer.from(`{"v":${JSON.stringify(version)},"seq":${seq},"at":${JSON.stringify(at)},"values":${values}}`);
    const compressed = await compress(body);
    return { seq, digest, at, version, body, gzip: compressed.length < body.length ? compressed : null, seenAt: null, cleared: false, writeSecond: 0, writes: 0 };
  }
  const tombstone = (seq, at) => ({ seq, at, cleared: true, writeSecond: 0, writes: 0 });

  async function loadFile(entry) {
    const skip = reason => console.error(`Skipping live channel file ${JSON.stringify(entry.name)}: ${reason}`);
    if (temporaryName.test(entry.name)) { await fs.rm(path.join(directory, entry.name), { force: true }); return; }
    const channelId = fileName.exec(entry.name)?.[1];
    if (!channelId || !entry.isFile()) { skip('not a channel file'); return; }
    const file = path.join(directory, entry.name);
    if ((await fs.stat(file)).size > limits.fileBytes) { skip('too large'); return; }
    let record;
    try { record = JSON.parse(await fs.readFile(file, 'utf8')); } catch { skip('invalid JSON'); return; }
    if (!isObject(record) || typeof record.deploymentId !== 'string') { skip('invalid record'); return; }
    if (record.deploymentId !== deploymentId) { await fs.rm(file, { force: true }); return; }
    if (record.version !== 1 || record.channelId !== channelId || !validSeq(record.seq) || typeof record.at !== 'string') { skip('invalid record'); return; }
    if (record.cleared === true) { channels.set(channelId, tombstone(record.seq, record.at)); return; }
    const values = digestPattern.test(record.digest) ? renderValues(record.values) : null;
    if (values === null || Buffer.byteLength(values) > limits.bytes) { skip('invalid document'); return; }
    channels.set(channelId, await publicDocument(record.seq, record.digest, record.at, values));
  }
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    try { await loadFile(entry); } catch (error) { console.error(`Skipping live channel file ${JSON.stringify(entry.name)}: ${error.code || 'unreadable'}`); }
  }

  function serialized(channelId, task) {
    const run = (queues.get(channelId) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    queues.set(channelId, tail);
    void tail.then(() => { if (queues.get(channelId) === tail) queues.delete(channelId); });
    return run;
  }
  const save = (channelId, record) => writeAtomic(directory, fileOf(channelId), `${JSON.stringify({ version: 1, deploymentId, channelId, ...record })}\n`, unique++);

  function observePoll(time) {
    if (time - windowStart >= loadWindowMs) {
      const visitors = polls * 1000 / (time - windowStart) * period;
      period = Math.min(maxPeriod, Math.max(minPeriod, Math.ceil(visitors / targetRate)));
      windowStart = time; polls = 0;
    }
    polls++;
  }
  function spend(time, cost) {
    const second = Math.floor(time / 1000);
    if (second !== budgetSecond) { budgetSecond = second; budgetSpent = 0; }
    if (budgetSpent + cost > limits.readBudget) return false;
    budgetSpent += cost; return true;
  }
  function freshness(entry, time) {
    if (entry.seenAt === null) return time - startedAt < graceMs ? 'g' : '0';
    return time - entry.seenAt < leaseMs ? '1' : '0';
  }

  function read({ request, response, url, json }, channelId) {
    const time = now();
    observePoll(time);
    const entry = channelPattern.test(channelId) ? channels.get(channelId) : undefined;
    const servable = entry && !entry.cleared ? entry : null;
    const unchanged = servable !== null && url.searchParams.get('v') === servable.version;
    const compressed = servable?.gzip && !unchanged && acceptsGzip(request.headers['accept-encoding']) ? servable.gzip : null;
    const payload = servable && !unchanged ? compressed ?? servable.body : null;
    if (!spend(time, payload ? 1 + Math.ceil(payload.length / 4096) : 1)) { response.setHeader('retry-after', String(period)); json(429, { error: 'Too many requests' }); return; }
    if (!entry) { json(404, { error: 'Unknown live channel' }); return; }
    if (entry.cleared) { json(410, { error: 'Live data was cleared' }); return; }
    const headers = { 'board-live': `f=${freshness(entry, time)}, p=${period}`, 'cache-control': 'public, max-age=1', 'x-content-type-options': 'nosniff' };
    if (unchanged) { response.writeHead(204, { ...headers, vary: 'Origin' }); response.end(); return; }
    response.writeHead(200, { ...headers, vary: 'Origin, Accept-Encoding', 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, ...(compressed ? { 'content-encoding': 'gzip' } : {}) });
    response.end(payload);
  }

  function authorize(request) {
    if (request.headers.origin) throw httpError(403, 'Live writes are not accepted from browsers');
    const supplied = Buffer.from(request.headers.authorization || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw httpError(401, 'A valid live write token is required');
  }

  function parseWrite(body) {
    if (!isObject(body) || Object.keys(body).some(key => !['deploymentId', 'seq', 'digest', 'value'].includes(key))) throw httpError(400, 'Expected deploymentId, seq, digest and optional value');
    if (typeof body.deploymentId !== 'string' || !validSeq(body.seq) || typeof body.digest !== 'string' || !digestPattern.test(body.digest)) throw httpError(400, 'Invalid deploymentId, seq or digest');
    if (body.value === undefined) return body;
    const values = renderValues(body.value);
    if (values === null) throw httpError(400, `value must be an object of at most ${limits.paths} JSON Pointer keys, nested at most ${limits.depth} levels`);
    if (Buffer.byteLength(values) > limits.bytes) throw httpError(413, `value exceeds ${limits.bytes} bytes`);
    return { ...body, values };
  }

  function write({ response, json }, channelId, input) {
    return serialized(channelId, async () => {
      const current = channels.get(channelId), time = now();
      const accepted = entry => json(200, { deploymentId, seq: entry.seq, version: entry.version });
      if (input.deploymentId !== deploymentId) { json(409, { error: 'deployment_mismatch' }); return; }
      if (current?.cleared && input.seq <= current.seq) { json(410, { error: 'cleared', currentSeq: current.seq }); return; }
      if (current && !current.cleared) {
        if (input.seq < current.seq) { json(409, { error: 'stale_seq', currentSeq: current.seq }); return; }
        if (input.seq === current.seq) {
          if (input.digest !== current.digest) { json(409, { error: 'digest_conflict', currentSeq: current.seq }); return; }
          current.seenAt = time; accepted(current); return;
        }
      }
      if (input.values === undefined) { json(409, { error: 'need_value' }); return; }
      if ((!current || current.cleared) && [...channels.values()].filter(entry => !entry.cleared).length >= limits.channels) { json(507, { error: 'channel_limit' }); return; }
      const second = Math.floor(time / 1000), writes = current?.writeSecond === second ? current.writes : 0;
      if (writes >= limits.writesPerSecond) { response.setHeader('retry-after', '1'); json(429, { error: 'Too many writes' }); return; }
      const at = new Date(time).toISOString();
      const next = await publicDocument(input.seq, input.digest, at, input.values);
      await save(channelId, { seq: input.seq, digest: input.digest, at, values: input.value });
      next.seenAt = time; next.writeSecond = second; next.writes = writes + 1;
      channels.set(channelId, next);
      accepted(next);
    });
  }

  function clear({ json }, channelId, requested) {
    return serialized(channelId, async () => {
      const current = channels.get(channelId), seq = Math.max(requested, current?.seq ?? 0);
      if (!current?.cleared || current.seq !== seq) {
        const at = new Date(now()).toISOString();
        await save(channelId, { seq, at, cleared: true });
        channels.set(channelId, tombstone(seq, at));
      }
      json(200, { deploymentId, seq, cleared: true });
    });
  }

  async function route(context) {
    const { request, response, url, readJson } = context;
    if (!url.pathname.startsWith(prefix)) return false;
    const channelId = url.pathname.slice(prefix.length);
    if (request.method === 'GET') {
      if (request.headers.origin) response.setHeader('access-control-expose-headers', 'Board-Live, Retry-After');
      read(context, channelId); return true;
    }
    if (request.method !== 'PUT' && request.method !== 'DELETE') throw httpError(405, 'Use GET, PUT or DELETE');
    authorize(request);
    if (!channelPattern.test(channelId)) throw httpError(404, 'Not found');
    if (request.method === 'PUT') { await write(context, channelId, parseWrite(await readJson())); return true; }
    const seq = url.searchParams.get('seq') ?? '';
    if (!/^[1-9]\d{0,15}$/.test(seq) || !Number.isSafeInteger(+seq)) throw httpError(400, 'Provide a positive integer seq');
    await clear(context, channelId, +seq); return true;
  }
  return { enabled: true, route };
}
