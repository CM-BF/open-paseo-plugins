// File-only history for indexing. This module deliberately has no SDK/provider/process dependency.
// A successful page always comes from one completely parsed, stable, bounded transcript.
import { constants, promises as fs, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { TimelineCursor, TimelinePage } from "./sync";
import type { TimelineEntryLike } from "./transcript";

export const NATIVE_HISTORY_LIMITS = {
  fileBytes: 256 * 1024 * 1024,
  lineBytes: 8 * 1024 * 1024,
  textBytes: 32 * 1024 * 1024,
  entries: 40_000,
  discoveryFiles: 20_000,
} as const;
const SMALL_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const ROLLOUT_ID = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
type Obj = Record<string, unknown>;
type Family = "codex" | "claude";
type FetchOptions = { direction: "tail" | "after"; cursor?: TimelineCursor; limit: number };
type Options = { paseoHome: string; codexHome?: string; claudeHome?: string; signal?: AbortSignal };
type Snapshot = { agentId: string; file: string; fingerprint: string; epoch: string; entries: TimelineEntryLike[] };

function obj(value: unknown): Obj | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Obj : null; }
function str(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null; }
function safeId(id: string): boolean { return SAFE_ID.test(id) && !id.includes(".."); }
function stamp(st: Stats): string { return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`; }
function rootPath(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return path.join(homedir(), text.slice(2));
  return path.isAbsolute(text) ? text : null;
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap(raw => {
    const block = obj(raw);
    return block && ["text", "input_text", "output_text"].includes(String(block.type)) && typeof block.text === "string" ? [block.text] : [];
  }).join("\n\n");
}
function summarizeInput(value: unknown): string {
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value) ?? ""; } catch { text = ""; }
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
function tool(name: unknown, input: unknown, callId: unknown, seq: number): AgentTimelineItem {
  return {
    type: "tool_call", name: str(name) ?? "tool", callId: str(callId) ?? `native-${seq}`,
    status: "completed", error: null, detail: { type: "plain_text", label: summarizeInput(input) },
  };
}
function encodeClaudeProject(cwd: string): string {
  const normalized = process.platform === "darwin" ? cwd.normalize("NFC") : cwd;
  const encoded = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= 200) return encoded;
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
function emptyPage(error: string): TimelinePage {
  return { epoch: "", reset: false, staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: -1, nextSeq: 0 }, endCursor: null, hasNewer: false, entries: [], error };
}

export class NativeHistorySource {
  private snapshot: Snapshot | null = null;
  private records: Map<string, string> | null = null;
  private codexFiles: { root: string; foundAt: number; files: Map<string, string> } | null = null;
  private closed = false;
  private generation = 0;
  constructor(private readonly options: Options) {}

  release(agentId?: string): void { if (!agentId || this.snapshot?.agentId === agentId) this.snapshot = null; }
  close(): void { this.closed = true; this.generation++; this.snapshot = null; this.records = null; this.codexFiles = null; }
  private check(): void {
    if (this.closed || this.options.signal?.aborted) throw new Error("Native history read canceled");
  }
  private async regular(file: string, cap: number): Promise<fs.FileHandle> {
    this.check();
    const handle = await fs.open(file, OPEN_FLAGS);
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new Error("Native history source is not a regular file");
      if (st.size > cap) throw new Error("Native history file exceeds size limit");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  private async smallJson(file: string, optional = false): Promise<Obj> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await this.regular(file, SMALL_BYTES);
      const data = obj(JSON.parse(await handle.readFile("utf8")));
      if (!data) throw new Error("Native history metadata is not an object");
      return data;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    } finally { await handle?.close(); }
  }
  private async directories(dir: string): Promise<import("node:fs").Dirent[]> {
    this.check();
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (entries.length > NATIVE_HISTORY_LIMITS.discoveryFiles) throw new Error("Native history directory discovery exceeds limit");
      return entries;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async contained(root: string, file: string): Promise<string> {
    const actualRoot = await fs.realpath(root);
    const actual = await fs.realpath(file);
    const relative = path.relative(actualRoot, actual);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("Native history path escapes its configured root");
    if (!(await fs.lstat(file)).isFile()) throw new Error("Native history source must be a regular file, not a symlink");
    return file;
  }
  private async record(agentId: string): Promise<Obj> {
    if (!safeId(agentId)) throw new Error("Invalid agent id for native history");
    const root = path.join(this.options.paseoHome, "agents");
    if (!this.records || !this.records.has(agentId)) {
      const found = new Map<string, string>();
      const add = (dir: string, name: string) => {
        if (found.size >= NATIVE_HISTORY_LIMITS.discoveryFiles) throw new Error("Native history record discovery exceeds limit");
        if (name.endsWith(".json")) found.set(name.slice(0, -5), path.join(dir, name));
      };
      for (const item of await this.directories(root)) {
        if (item.isFile()) add(root, item.name);
        else if (item.isDirectory()) for (const child of await this.directories(path.join(root, item.name))) if (child.isFile()) add(path.join(root, item.name), child.name);
      }
      this.records = found;
    }
    const file = this.records.get(agentId);
    if (!file) throw new Error("Persisted agent record was not found");
    const data = await this.smallJson(await this.contained(root, file));
    if (data.id !== agentId || data.internal === true) throw new Error("Persisted agent record is unavailable for indexing");
    return data;
  }
  private async location(record: Obj): Promise<{ family: Family; root: string; sessionId: string; cwd: string }> {
    const config = await this.smallJson(path.join(this.options.paseoHome, "config.json"), true);
    const daemon = obj(config.daemon);
    const profiles = obj(obj(config.agents)?.providers) ?? obj(obj(daemon?.agents)?.providers) ?? obj(daemon?.providers) ?? obj(config.providers) ?? {};
    const persistence = obj(record.persistence);
    const metadata = obj(persistence?.metadata);
    const provider = str(record.provider) ?? "";
    let current = provider;
    const seen = new Set<string>();
    const ownEnv = obj(obj(record.config)?.env) ?? obj(metadata?.env);
    let codex = rootPath(ownEnv?.CODEX_HOME);
    let claude = rootPath(ownEnv?.CLAUDE_CONFIG_DIR);
    while (current && !seen.has(current) && seen.size < 16) {
      seen.add(current);
      const profile = obj(profiles[current]);
      const env = obj(profile?.env);
      codex ??= rootPath(env?.CODEX_HOME);
      claude ??= rootPath(env?.CLAUDE_CONFIG_DIR);
      const parent = str(profile?.extends);
      if (!parent) break;
      current = parent;
    }
    const candidates = [current, persistence?.provider, metadata?.provider, provider];
    const family = candidates.find(v => v === "codex" || v === "claude") as Family | undefined;
    if (!family) throw new Error(`Native history is unsupported for provider ${provider.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 80)}`);
    const sessionId = str(persistence?.sessionId) ?? str(metadata?.threadId) ?? str(persistence?.nativeHandle);
    if (!sessionId || !safeId(sessionId)) throw new Error("Invalid or missing persisted session id");
    const root = family === "codex"
      ? codex ?? rootPath(this.options.codexHome) ?? rootPath(process.env.CODEX_HOME) ?? path.join(homedir(), ".codex")
      : claude ?? rootPath(this.options.claudeHome) ?? rootPath(process.env.CLAUDE_CONFIG_DIR) ?? path.join(homedir(), ".claude");
    return { family, root, sessionId, cwd: str(record.cwd) ?? str(metadata?.cwd) ?? "" };
  }
  private async transcript(location: { family: Family; root: string; sessionId: string; cwd: string }): Promise<string> {
    const { family, root, sessionId, cwd } = location;
    if (family === "claude") {
      const projects = path.join(root, "projects");
      const dirs = await this.directories(projects);
      const encoded = encodeClaudeProject(cwd);
      dirs.sort((a, b) => Number(b.name === encoded) - Number(a.name === encoded));
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const file = path.join(projects, dir.name, `${sessionId}.jsonl`);
        try { if ((await fs.lstat(file)).isFile()) return await this.contained(root, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } else {
      if (!this.codexFiles || this.codexFiles.root !== root || Date.now() - this.codexFiles.foundAt > 60_000 || !this.codexFiles.files.has(sessionId.toLowerCase())) {
        const files = new Map<string, string>();
        let count = 0;
        const walk = async (dir: string, depth: number): Promise<void> => {
          for (const item of await this.directories(dir)) {
            if (++count > NATIVE_HISTORY_LIMITS.discoveryFiles) throw new Error("Native history transcript discovery exceeds limit");
            const file = path.join(dir, item.name);
            if (item.isDirectory() && depth > 0) await walk(file, depth - 1);
            else if (item.isFile()) {
              const id = ROLLOUT_ID.exec(item.name)?.[1]?.toLowerCase();
              if (id && !files.has(id)) files.set(id, file);
            }
          }
        };
        await walk(path.join(root, "sessions"), 3);
        await walk(path.join(root, "archived_sessions"), 0);
        this.codexFiles = { root, foundAt: Date.now(), files };
      }
      const file = this.codexFiles.files.get(sessionId.toLowerCase());
      if (file) return this.contained(root, file);
    }
    throw new Error("Native transcript was not found; provider will not be started");
  }

  private async read(agentId: string, file: string, family: Family, sessionId: string): Promise<Snapshot> {
    const handle = await this.regular(file, NATIVE_HISTORY_LIMITS.fileBytes);
    const entries: TimelineEntryLike[] = [];
    let textBytes = 0;
    let recognized = 0;
    let pending = Buffer.alloc(0);
    const generation = this.generation;
    try {
      const before = await handle.stat();
      const fingerprint = stamp(before);
      const emit = (item: AgentTimelineItem, at: unknown) => {
        const size = item.type === "user_message" || item.type === "assistant_message" ? Buffer.byteLength(item.text) : Buffer.byteLength(JSON.stringify(item));
        textBytes += size;
        if (textBytes > NATIVE_HISTORY_LIMITS.textBytes || entries.length >= NATIVE_HISTORY_LIMITS.entries) throw new Error("Native history index content exceeds resource limit");
        const seq = entries.length;
        entries.push({ item, timestamp: str(at) ?? "", seqStart: seq, seqEnd: seq });
      };
      const parse = (line: Buffer, last: boolean) => {
        if (line.length > NATIVE_HISTORY_LIMITS.lineBytes) throw new Error("Native history JSONL line exceeds size limit");
        if (!line.toString("utf8").trim()) return;
        let value: Obj | null;
        try { value = obj(JSON.parse(line.toString("utf8"))); }
        catch { throw new Error(last ? "Native transcript has an incomplete final JSON line; retry after the writer finishes" : "Native transcript contains invalid JSON"); }
        if (!value) throw new Error("Native transcript contains a non-object JSON line");
        if (family === "codex") {
          if (["session_meta", "turn_context", "response_item", "event_msg", "compacted"].includes(String(value.type))) recognized++;
          const payload = obj(value.payload);
          if (value.type === "session_meta" && payload?.id && payload.id !== sessionId) throw new Error("Native transcript session identity does not match");
          if (value.type !== "response_item" || !payload) return;
          if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
            // Codex also persists internal analysis as ordinary assistant messages. Only
            // display channels (or older messages with no channel) belong in search.
            const channel = str(payload.channel);
            if (payload.role === "assistant" && channel && channel !== "final" && channel !== "commentary") return;
            const text = textContent(payload.content);
            if (text.trim()) emit({ type: payload.role === "user" ? "user_message" : "assistant_message", text }, value.timestamp);
          } else if (payload.type === "function_call") emit(tool(payload.name, payload.arguments, payload.call_id, entries.length), value.timestamp);
          else if (payload.type === "custom_tool_call") emit(tool(payload.name, payload.input, payload.call_id, entries.length), value.timestamp);
          else if (payload.type === "local_shell_call") emit(tool("local_shell", obj(payload.action)?.command, payload.call_id, entries.length), value.timestamp);
          return;
        }
        if (["user", "assistant", "system", "summary", "file-history-snapshot", "queue-operation", "progress", "custom-title", "attachment"].includes(String(value.type))) recognized++;
        if (value.sessionId && value.sessionId !== sessionId) throw new Error("Native transcript session identity does not match");
        if (value.isMeta === true || value.isSynthetic === true || value.isCompactSummary === true || value.isSidechain === true) return;
        const message = obj(value.message);
        if (value.type === "user") {
          const text = textContent(message?.content);
          if (text.trim()) emit({ type: "user_message", text }, value.timestamp);
        } else if (value.type === "assistant") {
          const content = message?.content;
          if (typeof content === "string" && content.trim()) emit({ type: "assistant_message", text: content }, value.timestamp);
          else if (Array.isArray(content)) for (const raw of content) {
            const block = obj(raw);
            if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) emit({ type: "assistant_message", text: block.text }, value.timestamp);
            else if (block?.type === "tool_use") emit(tool(block.name, block.input, block.id, entries.length), value.timestamp);
          }
        }
      };
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      for (let position = 0; position < before.size;) {
        this.check();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (!bytesRead) throw new Error("Native transcript changed while being read");
        position += bytesRead;
        const bytes = pending.length ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead));
        let from = 0;
        for (let end = bytes.indexOf(10, from); end >= 0; end = bytes.indexOf(10, from)) {
          parse(bytes.subarray(from, end), false);
          from = end + 1;
        }
        pending = Buffer.from(bytes.subarray(from));
        if (pending.length > NATIVE_HISTORY_LIMITS.lineBytes) throw new Error("Native history JSONL line exceeds size limit");
      }
      if (pending.length) parse(pending, true);
      this.check();
      if (generation !== this.generation || fingerprint !== stamp(await handle.stat()) || fingerprint !== stamp(await fs.stat(file))) throw new Error("Native transcript changed while being read; retry indexing");
      if (!recognized) throw new Error("Native transcript format is empty or unsupported");
      const epoch = `native-v1:${createHash("sha256").update(`${family}:${sessionId}:${file}:${fingerprint}`).digest("hex")}`;
      return { agentId, file, fingerprint, epoch, entries };
    } finally { await handle.close(); }
  }

  async fetch(agentId: string, options: FetchOptions): Promise<TimelinePage> {
    try {
      this.check();
      if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > NATIVE_HISTORY_LIMITS.entries) throw new Error("Invalid native history page limit");
      if (options.cursor && (!Number.isInteger(options.cursor.seq) || options.cursor.seq < -1)) throw new Error("Invalid native history cursor");
      let snapshot = this.snapshot;
      if (!snapshot || snapshot.agentId !== agentId) {
        this.snapshot = null;
        const record = await this.record(agentId);
        const location = await this.location(record);
        const file = await this.transcript(location);
        snapshot = await this.read(agentId, file, location.family, location.sessionId);
        this.check();
        this.snapshot = snapshot;
      }
      // SessionSync releases this view after its final page. Changes made by a live writer
      // are picked up by the next sync, never midway through a replacement transaction.
      const stale = options.cursor !== undefined && options.cursor.epoch !== snapshot.epoch;
      const all = snapshot.entries;
      const start = options.direction === "tail" ? Math.max(0, all.length - options.limit) : stale ? 0 : Math.min(all.length, (options.cursor?.seq ?? -1) + 1);
      const entries = all.slice(start, start + options.limit);
      const last = entries.at(-1);
      return {
        epoch: snapshot.epoch, reset: stale, staleCursor: stale, gap: false,
        window: { minSeq: 0, maxSeq: all.length - 1, nextSeq: all.length },
        endCursor: last ? { epoch: snapshot.epoch, seq: last.seqEnd } : null,
        hasNewer: start + entries.length < all.length, entries, error: null,
      };
    } catch (error) {
      this.release(agentId);
      const message = error instanceof Error ? error.message : "Native history read failed";
      // Node filesystem errors include local paths; return a bounded diagnosis without transcript text.
      return emptyPage((error as NodeJS.ErrnoException)?.code ? `Native history file access failed (${(error as NodeJS.ErrnoException).code})` : message);
    }
  }
}
