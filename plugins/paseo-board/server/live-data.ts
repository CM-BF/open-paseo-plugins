import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { BoardChange } from "../shared/contracts";
import { IdSchema } from "../shared/contracts";
import {
  LiveChannelSchema, LiveChannelStateSchema, LiveErrorSchema, LiveGetInputSchema, LiveGetOutputSchema, LiveMarksSchema, LiveSetInputSchema, LiveSetOutputSchema,
  LiveTokenSchema, LiveWithheldSchema, LIVE_LIMITS, LIVE_RUNTIME_OUTDATED, type LiveChannel, type LiveGetOutput, type LiveMark, type LivePreview, type LiveSetInput, type LiveSetOutput, type LiveStatus,
} from "../shared/live-data";
import { LiveChannelIdSchema, PublicApiOriginSchema, type LiveState } from "../shared/release-contracts";
import { sortLiveMarks, type LiveBoardProjection } from "./live-projection";
import { BoardStoreError, canonicalJson, ensureDirectory, fingerprint, serialized } from "./store-format";

const DEBOUNCE_MS = 500, MAX_WAIT_MS = 2_000, HEARTBEAT_MS = 30_000, REQUEST_TIMEOUT_MS = 10_000, PROBE_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_SENDS = 4, PUSH_FLOOR_MS = 1_000, PUSH_BYTES_PER_SECOND = 8_000, MAX_RETRY_AFTER_MS = 300_000, LOCAL_FAILURE_RETRY_MS = 60_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const STORED_BYTES = 256 * 1024, RESPONSE_BYTES = 8_192;
const ACTIVE = new Set(["ready", "pending"]);
const CONSENT_CHANGED = "公开设置已变化，请重新确认";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** Consent binds to what is public and where, never to values, so later values can flow. */
export const liveConsentDigest = (origin: string, deploymentId: string, marks: readonly LiveMark[]) => hash(canonicalJson({ origin, deploymentId, marks: sortLiveMarks(marks) }));

const BlockedSchema = LiveErrorSchema.extend({ currentSeq: z.number().int().positive().optional() });
const ChannelFileSchema = z.object({
  version: z.literal(1), boardId: IdSchema, expectedCreatedAt: z.string(), channelId: LiveChannelIdSchema,
  origin: PublicApiOriginSchema, deploymentId: IdSchema, marks: LiveMarksSchema, state: LiveChannelStateSchema,
  blocked: BlockedSchema.optional(), eventId: IdSchema, requestDigest: z.string(), consentDigest: z.string(), consentAt: z.string(),
  token: LiveTokenSchema.optional(),
});
type ChannelFile = z.infer<typeof ChannelFileSchema>;
const PushSchema = z.object({ seq: z.number().int().positive(), digest: z.string(), canvasRevision: z.number().int().nonnegative(), at: z.string() });
// Fixed-size and value-free: it records which version was sent, never what it contained.
const JournalSchema = z.object({
  version: z.literal(1), seq: z.number().int().nonnegative(), sending: PushSchema.optional(), acked: PushSchema.extend({ bytes: z.number().int().nonnegative() }).optional(),
  lastError: LiveErrorSchema.optional(), attempts: z.number().int().nonnegative(), nextAttemptAt: z.string().optional(),
  withheld: z.array(LiveWithheldSchema).max(LIVE_LIMITS.paths), overLimit: z.boolean(),
});
type Journal = z.infer<typeof JournalSchema>;
const emptyJournal = (): Journal => ({ version: 1, seq: 0, attempts: 0, withheld: [], overLimit: false });
const HealthSchema = z.object({ id: z.string(), deploymentId: z.string(), live: z.number().default(LIVE_RUNTIME_OUTDATED) });
const ReplySchema = z.object({ error: z.string().optional(), currentSeq: z.number().int().positive().optional(), seq: z.number().int().positive().optional() });
type Reply = z.infer<typeof ReplySchema>;

export interface LiveClock { now(): number; setTimer(run: () => void, delayMs: number): unknown; clearTimer(timer: unknown): void }
const systemClock: LiveClock = {
  now: () => Date.now(),
  setTimer: (run, delayMs) => { const timer = setTimeout(run, delayMs); (timer as unknown as { unref?: () => void }).unref?.(); return timer; },
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
export interface LiveStore {
  subscribe(listener: (change: BoardChange) => void): () => void;
  projectPublic(boardId: string, expectedCreatedAt: string, marks: readonly LiveMark[]): Promise<LiveBoardProjection | null>;
}
export interface LiveDataOptions { fetcher?: typeof fetch; clock?: LiveClock; random?: () => number; log?: (message: string) => void }
export interface LivePublicView { paths: string[]; state: LiveState }
/** What a release or share update needs to know about a Board's channel; never carries the token. */
export interface LiveReleaseChannel { origin: string; channelId: string; paths: string[]; state: LiveState; channelState: LiveChannel["state"] }

interface Runtime {
  file: string; boardId: string; createdAt: string; active: boolean;
  dirty: boolean; force: boolean; busy: boolean; queued: boolean; heartbeatQueued: boolean;
  timer?: unknown; dirtySince?: number; notBefore: number; lastCanvasRevision?: number;
  abort?: AbortController; superseded: boolean;
}
type Sent = { status: number; retryAfterMs?: number; reply: Reply };
type Verdict = { kind: "ok" } | { kind: "need-value" } | { kind: "ignore" } | { kind: "retry"; code: string; message: string; retryAfterMs?: number } | { kind: "block"; code: string; message: string; currentSeq?: number };

const safeJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
/** A hostile or broken server cannot make the daemon buffer an unbounded response. */
async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); return ""; }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function retryAfterMs(header: string | null): number | undefined {
  if (!header || !/^\d{1,9}$/.test(header.trim())) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Number(header.trim()) * 1000);
}
// Every message here is fixed text: nothing from a response, URL or token can reach status or logs.
function classify(sent: Sent, heartbeat?: { seq: number; journalSeq: number }): Verdict {
  const { status, reply } = sent, conflict = reply.error;
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 401) return { kind: "block", code: "token_rejected", message: "后端拒绝了写入令牌；请在连接设置中重新填写。" };
  if (status === 404) return { kind: "block", code: "backend_disabled_or_missing", message: "后端没有启用实时数据或通道不存在；请检查 BOARD_LIVE_WRITE_TOKEN 与部署。" };
  if (status === 410) return { kind: "block", code: "backend_cleared", message: "后端副本已被清除；要恢复需要重新确认公开。", currentSeq: reply.currentSeq };
  if (status === 413) return { kind: "block", code: "document_rejected", message: "后端拒绝了过大的公开数据。" };
  if (status === 507) return { kind: "block", code: "backend_channel_limit", message: "后端的实时通道数量已达上限。" };
  if (status === 409 && conflict === "deployment_mismatch") return { kind: "block", code: "deployment_changed", message: "后端部署已变更；请重新确认后继续公开。" };
  if (status === 409 && conflict === "need_value" && heartbeat) return { kind: "need-value" };
  if (status === 409 && conflict === "stale_seq" && heartbeat && heartbeat.journalSeq > heartbeat.seq) return { kind: "ignore" };
  if (status === 409 && (conflict === "stale_seq" || conflict === "digest_conflict")) return { kind: "block", code: "foreign_writer", message: "后端已有更新的内容，可能来自其他写入者或旧备份；已停止推送，请确认后重新公开。", currentSeq: reply.currentSeq };
  if (status === 429) return { kind: "retry", code: "rate_limited", message: "后端限流，正在重试。", retryAfterMs: sent.retryAfterMs };
  if (status >= 500) return { kind: "retry", code: "server_error", message: "后端暂时不可用，正在重试。", retryAfterMs: sent.retryAfterMs };
  return { kind: "block", code: "backend_rejected", message: `后端拒绝了推送（HTTP ${status}）。` };
}

async function readStored<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STORED_BYTES) throw new BoardStoreError("unsafe_path", "Unsafe live data file");
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error instanceof BoardStoreError ? error : new BoardStoreError("corrupt_storage", "Live data file is unreadable");
  }
}
async function writeStored(path: string, value: unknown): Promise<void> {
  await ensureDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** Level-triggered mirror of human-approved paths. Desired state is the current projection. */
export class LiveDataPublisher {
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly clock: LiveClock;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly byBoard = new Map<string, Set<Runtime>>();
  private readonly working = new Set<Promise<unknown>>();
  private readonly waiters: Array<() => void> = [];
  private sends = 0;
  private stopped = false;
  private started = false;
  private unsubscribe?: () => void;
  private heartbeatTimer?: unknown;

  constructor(root: string, private readonly store: LiveStore, options: LiveDataOptions = {}) {
    this.directory = join(root, "live-data");
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => undefined);
  }

  private fileFor(boardId: string, createdAt: string) { return join(this.directory, `${hash(JSON.stringify([boardId, createdAt]))}.json`); }
  private journalFile(file: string) { return `${file.slice(0, -".json".length)}.journal.json`; }
  private readRecord(file: string) { return readStored(file, ChannelFileSchema); }
  private async readJournal(file: string): Promise<Journal> { return await readStored(this.journalFile(file), JournalSchema) ?? emptyJournal(); }
  private iso(time = this.clock.now()) { return new Date(time).toISOString(); }
  private async writeRecord(c: Runtime, record: ChannelFile) { await writeStored(c.file, ChannelFileSchema.parse(record)); c.active = ACTIVE.has(record.state); }
  private async writeJournal(c: Runtime, journal: Journal) { await writeStored(this.journalFile(c.file), JournalSchema.parse(journal)); return journal; }

  private runtime(boardId: string, createdAt: string): Runtime {
    const file = this.fileFor(boardId, createdAt);
    let c = this.runtimes.get(file);
    if (!c) {
      c = { file, boardId, createdAt, active: false, dirty: false, force: false, busy: false, queued: false, heartbeatQueued: false, notBefore: 0, superseded: false };
      this.runtimes.set(file, c);
      const peers = this.byBoard.get(boardId) ?? new Set();
      peers.add(c); this.byBoard.set(boardId, peers);
    }
    return c;
  }

  async start(): Promise<void> {
    if (this.stopped || this.started) return;
    this.started = true;
    await ensureDirectory(this.directory);
    this.unsubscribe = this.store.subscribe(change => this.onChange(change));
    for (const name of await readdir(this.directory)) {
      // A crash can leave a temporary copy, which may hold a token that was later wiped.
      if (name.endsWith(".tmp")) { await unlink(join(this.directory, name)).catch(() => undefined); continue; }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(this.directory, name);
      try {
        const record = await this.readRecord(file);
        if (!record || this.fileFor(record.boardId, record.expectedCreatedAt) !== file) continue;
        const c = this.runtime(record.boardId, record.expectedCreatedAt);
        c.active = ACTIVE.has(record.state);
        if (c.active || record.state === "revoking") { c.dirty = true; this.arm(c, this.clock.now()); }
      } catch { this.log("live data: skipped an unreadable channel file"); }
    }
    this.armHeartbeat();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.heartbeatTimer !== undefined) { this.clock.clearTimer(this.heartbeatTimer); this.heartbeatTimer = undefined; }
    for (const c of this.runtimes.values()) { this.disarm(c); c.superseded = true; c.abort?.abort(); }
    await this.idle();
  }

  /** Resolves once no publishing work is queued or running; timers may still be armed. */
  async idle(): Promise<void> { while (this.working.size) await Promise.allSettled([...this.working]); }
  private track<T>(work: Promise<T>): Promise<T> {
    this.working.add(work);
    void work.then(() => this.working.delete(work), () => this.working.delete(work));
    return work;
  }

  // Timing: one timer per channel covers debounce, the push floor, backoff and immediate kicks.
  private onChange(change: BoardChange): void {
    for (const c of this.byBoard.get(change.summary.id) ?? []) {
      if (!c.active) continue;
      // Worker-restart notices repeat the same revision and must not cause a push.
      if (change.canvasRevision === c.lastCanvasRevision && change.summary.createdAt === c.createdAt) continue;
      c.dirty = true;
      this.schedule(c);
    }
  }
  private schedule(c: Runtime): void {
    const now = this.clock.now();
    c.dirtySince ??= now;
    this.arm(c, Math.max(Math.min(now + DEBOUNCE_MS, c.dirtySince + MAX_WAIT_MS), c.notBefore));
  }
  private disarm(c: Runtime): void { if (c.timer !== undefined) { this.clock.clearTimer(c.timer); c.timer = undefined; } }
  private arm(c: Runtime, at: number): void {
    if (this.stopped) return;
    this.disarm(c);
    c.timer = this.clock.setTimer(() => { c.timer = undefined; c.dirtySince = undefined; this.enqueue(c); }, Math.max(0, at - this.clock.now()));
  }
  private enqueue(c: Runtime): void {
    if (this.stopped || c.queued) return;
    c.queued = true;
    void this.track(serialized(c.file, async () => { c.queued = false; await this.flush(c); }).catch(() => {
      // Local storage failed. Never leave the channel looking settled, or it would keep attesting stale data.
      this.log("live data: publish step failed");
      c.dirty = true; c.notBefore = this.clock.now() + LOCAL_FAILURE_RETRY_MS; this.arm(c, c.notBefore);
    }));
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error("aborted"));
    if (this.sends < MAX_CONCURRENT_SENDS) { this.sends++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const grant = () => { signal.removeEventListener("abort", cancel); resolve(); };
      const cancel = () => { this.waiters.splice(this.waiters.indexOf(grant), 1); reject(new Error("aborted")); };
      this.waiters.push(grant);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }
  private release(): void { const next = this.waiters.shift(); if (next) next(); else this.sends--; }

  /** The token leaves this module only as this header. Failures carry a class, never the raw error. */
  private async send(c: Runtime, record: ChannelFile, search: string, init: RequestInit): Promise<Sent | "superseded" | "failed"> {
    if (c.superseded) return "superseded";
    const controller = new AbortController();
    c.abort = controller;
    let timer: unknown;
    try {
      await this.acquire(controller.signal);
      try {
        timer = this.clock.setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const response = await this.fetcher(`${record.origin}/_board/live/${record.channelId}${search}`, {
          ...init, headers: { ...init.headers, Authorization: `Bearer ${record.token}` }, redirect: "error", signal: controller.signal as RequestInit["signal"],
        });
        const reply = ReplySchema.safeParse(safeJson(await readBounded(response)));
        return { status: response.status, retryAfterMs: retryAfterMs(response.headers.get("retry-after")), reply: reply.success ? reply.data : {} };
      } finally { if (timer !== undefined) this.clock.clearTimer(timer); this.release(); }
    } catch { return c.superseded ? "superseded" : "failed"; }
    finally { c.abort = undefined; }
  }

  private async backoff(c: Runtime, journal: Journal, failure: { code: string; message: string; retryAfterMs?: number }, force = false): Promise<void> {
    const attempts = journal.attempts + 1, base = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
    const at = this.clock.now() + Math.max(base, failure.retryAfterMs ?? 0) * (1 + this.random() * 0.2);
    await this.writeJournal(c, { ...journal, attempts, nextAttemptAt: this.iso(at), lastError: { code: failure.code, message: failure.message, at: this.iso() } });
    c.dirty = true; c.force ||= force; c.notBefore = at;
    this.arm(c, at);
  }
  private async block(c: Runtime, record: ChannelFile, journal: Journal, failure: { code: string; message: string; currentSeq?: number }): Promise<void> {
    const at = this.iso(), { code, message, currentSeq } = failure;
    await this.writeJournal(c, { ...journal, attempts: 0, nextAttemptAt: undefined, lastError: { code, message, at } });
    await this.writeRecord(c, { ...record, state: "blocked", blocked: { code, message, at, ...(currentSeq ? { currentSeq } : {}) } });
    c.dirty = false; c.force = false; this.disarm(c);
    this.log(`live data: channel blocked (${code})`);
  }

  private async flush(c: Runtime): Promise<void> {
    if (this.stopped) return;
    const record = await this.readRecord(c.file);
    if (!record) { c.dirty = false; return; }
    if (record.state === "revoking") return this.clearBackend(c, record);
    if (!c.dirty || !ACTIVE.has(record.state)) { c.dirty = false; return; }
    const force = c.force;
    c.dirty = false; c.force = false; c.busy = true;
    try { await this.push(c, record, force); } finally { c.busy = false; }
  }

  private async push(c: Runtime, record: ChannelFile, force: boolean): Promise<void> {
    let journal = await this.readJournal(c.file), p: LiveBoardProjection | null;
    try { p = await this.store.projectPublic(record.boardId, record.expectedCreatedAt, record.marks); }
    catch { return this.backoff(c, journal, { code: "board_unavailable", message: "暂时读不到 Board 数据，正在重试。" }, force); }
    if (!p || p.createdAt !== record.expectedCreatedAt) return this.block(c, record, journal, { code: "board_replaced", message: "Board 已被替换" });
    c.lastCanvasRevision = p.canvasRevision;
    if (canonicalJson(journal.withheld) !== canonicalJson(p.withheld) || journal.overLimit !== p.overLimit) {
      journal = await this.writeJournal(c, { ...journal, withheld: p.withheld, overLimit: p.overLimit });
    }
    if (p.overLimit || !p.body || !p.digest) return; // The backend keeps its last good copy; no heartbeat will attest it.
    const { body, digest, bytes, canvasRevision } = p;
    if (record.state === "ready" && !force && !journal.sending && digest === journal.acked?.digest) {
      if (journal.attempts || journal.lastError) await this.writeJournal(c, { ...journal, attempts: 0, nextAttemptAt: undefined, lastError: undefined });
      return;
    }
    if (!record.token) return this.block(c, record, journal, { code: "token_rejected", message: "缺少写入令牌；请在连接设置中重新填写。" });
    // A repeat reuses its version; a forced repush repeats the acknowledged one. Anything else is new.
    const repeated = journal.sending?.digest === digest ? journal.sending.seq : force && !journal.sending && journal.acked?.digest === digest ? journal.acked.seq : undefined;
    const seq = repeated ?? journal.seq + 1, sending = { seq, digest, canvasRevision, at: this.iso() };
    journal = await this.writeJournal(c, { ...journal, seq: Math.max(journal.seq, seq), sending });
    // Built around the worker's canonical text so the document is never parsed or restringified here.
    const payload = `{"deploymentId":${JSON.stringify(record.deploymentId)},"seq":${seq},"digest":"${digest}","value":${body}}`;
    const sent = await this.send(c, record, "", { method: "PUT", headers: { "Content-Type": "application/json" }, body: payload });
    if (sent === "superseded") { c.dirty = true; c.force ||= force; return; }
    if (sent === "failed") return this.backoff(c, journal, { code: "network_error", message: "连接不上后端，正在重试。" });
    const verdict = classify(sent);
    if (verdict.kind === "retry") return this.backoff(c, journal, verdict);
    if (verdict.kind === "block") return this.block(c, record, journal, verdict);
    await this.writeJournal(c, { ...journal, sending: undefined, acked: { ...sending, bytes }, attempts: 0, nextAttemptAt: undefined, lastError: undefined });
    if (record.state === "pending") await this.writeRecord(c, { ...record, state: "ready" });
    c.notBefore = this.clock.now() + Math.max(PUSH_FLOOR_MS, bytes / PUSH_BYTES_PER_SECOND * 1000);
    if (c.dirty) this.schedule(c);
  }

  private async clearBackend(c: Runtime, record: ChannelFile): Promise<void> {
    c.dirty = false;
    if (!record.token) return;
    const journal = await this.readJournal(c.file);
    const sent = await this.send(c, record, `?seq=${journal.seq}`, { method: "DELETE" });
    if (sent === "superseded") { c.dirty = true; return; }
    if (sent === "failed") return this.backoff(c, journal, { code: "network_error", message: "连接不上后端，正在重试清除。" });
    if (sent.status < 200 || sent.status >= 300) {
      return this.backoff(c, journal, { code: "clear_failed", message: `后端未能清除副本（HTTP ${sent.status}），正在重试。`, retryAfterMs: sent.retryAfterMs });
    }
    await this.writeJournal(c, { ...journal, seq: Math.max(journal.seq, sent.reply.seq ?? 0), sending: undefined, attempts: 0, nextAttemptAt: undefined, lastError: undefined });
    const { token: _token, ...cleared } = record;
    await this.writeRecord(c, { ...cleared, state: "revoked" });
  }

  private armHeartbeat(): void {
    if (this.stopped) return;
    this.heartbeatTimer = this.clock.setTimer(() => {
      this.armHeartbeat();
      for (const c of this.runtimes.values()) {
        if (!c.active || c.dirty || c.heartbeatQueued) continue;
        c.heartbeatQueued = true;
        void this.track(serialized(c.file, async () => { c.heartbeatQueued = false; await this.heartbeat(c); }).catch(() => this.log("live data: heartbeat failed")));
      }
    }, HEARTBEAT_MS);
  }

  /** Runs in the channel queue, so it is the one in-flight request and cannot race a push. */
  private async heartbeat(c: Runtime): Promise<void> {
    if (this.stopped || c.dirty) return;
    const record = await this.readRecord(c.file);
    if (record?.state !== "ready" || !record.token) return;
    const journal = await this.readJournal(c.file), acked = journal.acked;
    if (journal.overLimit || journal.attempts !== 0 || journal.sending || !acked) return;
    const body = JSON.stringify({ deploymentId: record.deploymentId, seq: acked.seq, digest: acked.digest });
    const sent = await this.send(c, record, "", { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    if (sent === "superseded") return;
    if (sent === "failed") return this.backoff(c, journal, { code: "network_error", message: "连接不上后端，正在重试。" }, true);
    const verdict = classify(sent, { seq: acked.seq, journalSeq: journal.seq });
    if (verdict.kind === "need-value") { c.dirty = true; c.force = true; c.notBefore = 0; this.arm(c, this.clock.now()); return; }
    if (verdict.kind === "retry") return this.backoff(c, journal, verdict, true);
    if (verdict.kind === "block") return this.block(c, record, journal, verdict);
  }

  private public(record: ChannelFile): LiveChannel {
    const { channelId, origin, deploymentId, marks, state, eventId } = record;
    return LiveChannelSchema.parse({ channelId, origin, deploymentId, marks, state, eventId });
  }
  private status(record: ChannelFile | null, journal: Journal, c?: Runtime): LiveStatus {
    const state: LiveState = !record ? "off"
      : record.state === "revoked" || record.state === "revoking" || record.state === "blocked" || record.state === "paused" ? record.state
      : journal.overLimit ? "too-large"
      : journal.attempts > 0 ? "retrying"
      : record.state === "pending" ? "pending"
      : journal.sending || c?.dirty || c?.busy ? "syncing" : "live";
    const { acked, lastError, attempts, nextAttemptAt, withheld } = journal;
    return { state, seq: acked?.seq ?? 0, ...(acked ? { pushedAt: acked.at, pushedBytes: acked.bytes, pushedCanvasRevision: acked.canvasRevision } : {}), ...(lastError ? { lastError } : {}), attempts, ...(nextAttemptAt ? { nextAttemptAt } : {}), withheld };
  }
  private async result(c: Runtime): Promise<LiveSetOutput> {
    const record = await this.readRecord(c.file);
    if (!record) throw new BoardStoreError("not_found", "This Board has no live channel");
    return LiveSetOutputSchema.parse({ channel: this.public(record), status: this.status(record, await this.readJournal(c.file), c) });
  }

  private async requireBoard(boardId: string, expectedCreatedAt: string): Promise<LiveBoardProjection> {
    const current = await this.store.projectPublic(boardId, expectedCreatedAt, []);
    if (!current || current.createdAt !== expectedCreatedAt) throw new BoardStoreError("board_identity_changed", "This Board was replaced; reopen it before changing live data");
    return current;
  }

  /** The Board's channel as the release flow sees it, including one that can no longer publish. */
  async releaseChannel(boardId: string, createdAt: string): Promise<LiveReleaseChannel | null> {
    const file = this.fileFor(boardId, createdAt), record = await this.readRecord(file);
    if (!record) return null;
    const { origin, channelId, marks, state: channelState } = record, state = this.status(record, await this.readJournal(file), this.runtimes.get(file)).state;
    return { origin, channelId, paths: marks.map(mark => mark.path).sort(), state, channelState };
  }

  async publicView(boardId: string, createdAt: string): Promise<LivePublicView | undefined> {
    const file = this.fileFor(boardId, createdAt), record = await this.readRecord(file);
    if (!record || record.state === "revoked") return undefined;
    return { paths: record.marks.map(mark => mark.path), state: this.status(record, await this.readJournal(file), this.runtimes.get(file)).state };
  }

  private async health(origin: string, pageOrigin?: string): Promise<{ status: number; allowOrigin: string | null; text: string } | null> {
    try {
      const response = await this.fetcher(`${origin}/_board/health`, { headers: { Accept: "application/json", ...(pageOrigin ? { Origin: pageOrigin } : {}) }, redirect: "error", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) as RequestInit["signal"] });
      return { status: response.status, allowOrigin: response.headers.get("access-control-allow-origin"), text: await readBounded(response) };
    } catch { return null; }
  }
  private async probe(origin: string, pageOrigins: readonly string[]): Promise<Pick<LiveGetOutput, "backend" | "originProblems">> {
    const health = await this.health(origin);
    const parsed = health?.status === 200 ? HealthSchema.safeParse(safeJson(health.text)) : undefined;
    if (!parsed?.success) return { backend: null, originProblems: [] };
    const originProblems: string[] = [];
    for (const pageOrigin of pageOrigins) {
      const seen = await this.health(origin, pageOrigin);
      if (!seen || seen.status === 403 || seen.allowOrigin !== pageOrigin) originProblems.push(`把 ${pageOrigin} 加入 board-app.json 的 origins，然后重新部署。`);
    }
    const { id, deploymentId, live } = parsed.data;
    return { backend: { id, deploymentId, live }, originProblems };
  }
  private async preview(boardId: string, createdAt: string, marks: readonly LiveMark[]): Promise<LivePreview> {
    const projection = await this.store.projectPublic(boardId, createdAt, marks);
    if (!projection || projection.createdAt !== createdAt) throw new BoardStoreError("board_identity_changed", "This Board was replaced; reopen it before changing live data");
    const { body, bytes, overLimit, withheld, pathBytes } = projection;
    return { ...(body ? { values: JSON.parse(body) as Record<string, unknown> } : {}), bytes, overLimit, withheld, pathBytes };
  }

  async get(raw: unknown): Promise<LiveGetOutput> {
    const input = LiveGetInputSchema.parse(raw);
    await this.requireBoard(input.boardId, input.expectedCreatedAt);
    const file = this.fileFor(input.boardId, input.expectedCreatedAt), record = await this.readRecord(file);
    const journal = await this.readJournal(file), status = this.status(record, journal, this.runtimes.get(file));
    const marks = input.marks ?? record?.marks;
    const preview = marks?.length ? await this.preview(input.boardId, input.expectedCreatedAt, marks) : null;
    const { backend, originProblems } = input.probeOrigin ? await this.probe(input.probeOrigin, input.pageOrigins ?? []) : { backend: null, originProblems: [] };
    const origin = input.probeOrigin ?? record?.origin;
    const deploymentId = backend?.deploymentId ?? (origin === record?.origin ? record?.deploymentId : undefined);
    const consentDigest = marks?.length && origin && deploymentId ? liveConsentDigest(origin, deploymentId, marks) : null;
    return LiveGetOutputSchema.parse({ channel: record ? this.public(record) : null, status, preview, backend, originProblems, consentDigest });
  }

  async set(raw: unknown): Promise<LiveSetOutput> {
    const input = LiveSetInputSchema.parse(raw);
    await this.requireBoard(input.boardId, input.expectedCreatedAt);
    const c = this.runtime(input.boardId, input.expectedCreatedAt);
    // Interrupt any request in flight: a pause or narrowing must not wait for its timeout.
    c.superseded = true;
    c.abort?.abort();
    try {
      return await this.track(serialized(c.file, async () => { c.superseded = false; return this.apply(c, input); }));
    } finally {
      if (c.dirty) this.arm(c, Math.max(this.clock.now(), c.notBefore));
    }
  }

  private async apply(c: Runtime, input: LiveSetInput): Promise<LiveSetOutput> {
    const previous = await this.readRecord(c.file), requestDigest = fingerprint("live-set", input);
    if (previous?.eventId === input.eventId) {
      if (previous.requestDigest !== requestDigest) throw new Error("Live data event ID reused with different settings");
      return this.result(c);
    }
    if ((previous?.eventId ?? null) !== input.expectedEventId) throw new BoardStoreError("revision_conflict", "Live data settings changed; refresh and review them before saving");
    if (input.action === "upsert") await this.upsert(c, previous, input, requestDigest);
    else {
      if (!previous) throw new BoardStoreError("not_found", "This Board has no live channel");
      const update = { eventId: input.eventId, requestDigest };
      if (input.action === "pause") await this.pause(c, previous, update);
      else if (input.action === "resume") await this.resume(c, previous, update, input.consentDigest);
      else if (input.action === "revoke") await this.revoke(c, previous, update);
      else await this.stopLocal(c, previous, update);
    }
    return this.result(c);
  }

  private async upsert(c: Runtime, previous: ChannelFile | null, input: Extract<LiveSetInput, { action: "upsert" }>, requestDigest: string): Promise<void> {
    const marks = sortLiveMarks(input.marks);
    if (input.consentDigest !== liveConsentDigest(input.origin, input.deploymentId, marks)) throw new BoardStoreError("consent_changed", CONSENT_CHANGED);
    if (previous?.state === "revoking") throw new BoardStoreError("invalid_transition", "正在清除后端副本；请等待完成，或选择仅本机停止");
    const targetChanged = !!previous && (previous.origin !== input.origin || previous.deploymentId !== input.deploymentId);
    if (previous && previous.state !== "revoked") {
      if (previous.origin !== input.origin) throw new BoardStoreError("invalid_transition", "请先停止公开并清除旧后端的副本");
      if (previous.deploymentId !== input.deploymentId && previous.blocked?.code !== "deployment_changed") throw new BoardStoreError("invalid_transition", "后端部署没有变更记录；请先停止公开并清除旧后端的副本");
    }
    const token = input.token ?? (targetChanged ? undefined : previous?.token);
    if (!token) throw new BoardStoreError("invalid_input", "请填写写入令牌");
    // Journal first, so a crash between the two writes can only cost one extra version number.
    const journal = await this.readJournal(c.file);
    if (!previous || previous.state === "revoked" || previous.state === "blocked" || targetChanged) {
      await this.writeJournal(c, { ...journal, seq: Math.max(journal.seq, previous?.blocked?.currentSeq ?? 0), sending: undefined, acked: undefined, attempts: 0, nextAttemptAt: undefined, lastError: undefined });
    }
    await this.writeRecord(c, {
      version: 1, boardId: input.boardId, expectedCreatedAt: input.expectedCreatedAt, channelId: previous?.channelId ?? `c${randomBytes(16).toString("hex")}`,
      origin: input.origin, deploymentId: input.deploymentId, marks, state: previous?.state === "ready" && !targetChanged ? "ready" : "pending",
      eventId: input.eventId, requestDigest, consentDigest: input.consentDigest, consentAt: this.iso(), token,
    });
    c.dirty = true; c.notBefore = 0; c.lastCanvasRevision = undefined;
  }

  private async pause(c: Runtime, previous: ChannelFile, update: Pick<ChannelFile, "eventId" | "requestDigest">): Promise<void> {
    if (!ACTIVE.has(previous.state)) throw new BoardStoreError("invalid_transition", "当前状态不能暂停");
    await this.writeRecord(c, { ...previous, ...update, state: "paused" });
    c.dirty = false; c.force = false; this.disarm(c);
  }
  private async resume(c: Runtime, previous: ChannelFile, update: Pick<ChannelFile, "eventId" | "requestDigest">, consentDigest: string): Promise<void> {
    if (previous.state !== "paused") throw new BoardStoreError("invalid_transition", "只能从暂停状态恢复");
    if (consentDigest !== previous.consentDigest) throw new BoardStoreError("consent_changed", CONSENT_CHANGED);
    await this.writeRecord(c, { ...previous, ...update, state: "pending" });
    c.dirty = true; c.notBefore = 0;
  }
  private async revoke(c: Runtime, previous: ChannelFile, update: Pick<ChannelFile, "eventId" | "requestDigest">): Promise<void> {
    if (previous.state === "revoked") { await this.writeRecord(c, { ...previous, ...update }); return; }
    if (previous.state !== "revoking") {
      // The tombstone takes a version above anything sent, so a late PUT cannot land after it.
      const journal = await this.readJournal(c.file);
      await this.writeJournal(c, { ...journal, seq: journal.seq + 1, sending: undefined, attempts: 0, nextAttemptAt: undefined, lastError: undefined });
    }
    await this.writeRecord(c, { ...previous, ...update, state: "revoking", blocked: undefined });
    c.dirty = true; c.force = false; c.notBefore = 0;
  }
  private async stopLocal(c: Runtime, previous: ChannelFile, update: Pick<ChannelFile, "eventId" | "requestDigest">): Promise<void> {
    const journal = await this.readJournal(c.file), { token: _token, ...kept } = previous;
    await this.writeJournal(c, { ...journal, sending: undefined, attempts: 0, nextAttemptAt: undefined, lastError: { code: "backend_copy_not_cleared", message: "已在本机停止，后端副本未清除，仍可能被读取。", at: this.iso() } });
    await this.writeRecord(c, { ...kept, ...update, state: "revoked", blocked: undefined });
    c.dirty = false; c.force = false; this.disarm(c);
  }
}
