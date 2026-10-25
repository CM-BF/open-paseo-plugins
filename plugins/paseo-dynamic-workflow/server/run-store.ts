import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { type RunPaths, runPaths, type StatePaths } from "./paths";
import type { WorkflowMeta } from "./script-parse";
import { describeError, log, SerialWriter, writeAtomically } from "./util";
import {
  AgentCallSchema,
  LogLineSchema,
  RunStatusSchema,
  UsageSchema,
  type AgentCall,
  type RunStatus,
  type Usage,
} from "../shared/run-types";

export const RunRecordSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  meta: z.object({
    name: z.string(),
    description: z.string(),
    whenToUse: z.string().optional(),
    phases: z.array(z.object({ title: z.string(), detail: z.string().optional(), model: z.string().optional() })).optional(),
  }),
  status: RunStatusSchema,
  parentAgentId: z.string(),
  workspaceId: z.string().nullable(),
  cwd: z.string(),
  scriptPath: z.string(),
  sourcePath: z.string().nullable().optional(),
  args: z.unknown().optional(),
  source: z.enum(["script", "scriptPath", "name"]),
  resumedFrom: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
  phaseOrder: z.array(z.string()),
  calls: z.array(AgentCallSchema),
  logs: z.array(LogLineSchema),
  resultPreview: z.string().nullable(),
  usage: UsageSchema,
  budgetTotal: z.number().nullable(),
  /** The launching agent's Ultracode mode and size guideline at launch, exposed to the script as `guidance`. */
  guidance: z.object({ ultracode: z.boolean(), size: z.string() }).optional(),
  /** This run's position among the caller's launches since its latest user message. */
  chain: z.number().int().min(1).optional(),
  notified: z.boolean(),
  /** Rejected parallel()/pipeline() slots, identical messages collapsed: the notification's <failures>. */
  resultLength: z.number().optional(),
  failures: z.array(z.object({ label: z.string(), message: z.string(), count: z.number() })).optional(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export type JournalEntry =
  | { type: "run_started"; at: string; runId: string; resumedFrom: string | null }
  | { type: "agent_completed"; at: string; callId: string; key: string; label: string; result: unknown; cached: boolean; worktree?: AgentCall["worktree"]; agentId?: string | null; provider?: string | null; model?: string | null }
  | { type: "agent_started"; at: string; callId: string; key: string; label: string }
  | { type: "agent_failed"; at: string; callId: string; key: string; label: string; error: string; cutoff?: boolean }
  | { type: "phase"; at: string; title: string }
  | { type: "log"; at: string; message: string }
  | { type: "run_finished"; at: string; status: RunStatus; error: string | null };

export function newRunId(): string {
  return `wf_${randomBytes(6).toString("hex")}`;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** Cache key of an agent() call: the prompt and the options that change what the agent does. */
export function callKey(prompt: string, opts: Record<string, unknown>): string {
  const relevant = {
    prompt,
    schema: opts.schema ?? null,
    model: opts.model ?? null,
    provider: opts.provider ?? null,
    effort: opts.effort ?? null,
    isolation: opts.isolation ?? null,
    agentType: opts.agentType ?? null,
    cwd: opts.cwd ?? null,
  };
  return createHash("sha256").update(stableStringify(relevant)).digest("hex").slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type CacheSlot = { value: unknown; worktree: AgentCall["worktree"]; agentId?: string | null; provider?: string | null; model?: string | null } | "failed" | "cutoff";

/**
 * Results of an earlier run, by key in invocation order. Failed and cut-off calls occupy their
 * slots so later same-key successes keep their positions, independent of completion timing.
 *
 * Like the built-in Workflow tool, reuse stops at the first edited or new call: once a call has
 * no slot in the earlier run, it and every later call run live. A call that failed, or that the
 * earlier run's stop or interruption cut off, reruns. Only a cut-off call permits later reuse;
 * an explicit failure ends reuse. History participates in the key so reordering or deleting a
 * call cannot splice together results from different prefixes.
 * Journals written before `agent_started` lines existed cannot tell a new call from a cut-off
 * one, so they keep per-call matching.
 */
export class ResumeCache {
  private readonly byKey = new Map<string, CacheSlot[]>();
  private readonly used = new Map<string, number>();
  private strict = false;
  private diverged = false;
  private prefix = "";

  /**
   * `paths` is one run, or a resume chain newest first. A newer run's slot wins; an older run's
   * result fills a position the newer run did not complete, when the key there is the same.
   */
  static async load(paths: RunPaths | RunPaths[]): Promise<ResumeCache> {
    const cache = new ResumeCache();
    const runs = Array.isArray(paths) ? paths : [paths];
    const histories: Array<Map<string, { key: string; slot: CacheSlot }>> = [];
    for (const run of runs) {
      histories.push(await ResumeCache.read(run, cache));
    }
    // Legacy journals only identify an occurrence by callId. Merge those occurrences before
    // grouping by key; appending every ancestor would invent duplicate cached calls.
    if (!cache.strict) {
      const merged = new Map<string, { key: string; slot: CacheSlot }>();
      for (const history of histories) {
        for (const [id, entry] of history) {
          const current = merged.get(id);
          if (!current || (typeof current.slot !== "object" && typeof entry.slot === "object" && entry.key === current.key)) merged.set(id, entry);
        }
      }
      const ordered = [...merged.entries()].sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
      for (const [, { key, slot }] of ordered) {
        const list = cache.byKey.get(key) ?? [];
        list.push(slot);
        cache.byKey.set(key, list);
      }
      return cache;
    }
    for (const history of histories) {
      const ordered = [...history.entries()].sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
      let prefix = "";
      for (const [, { key, slot }] of ordered) {
        prefix = historyKey(prefix, key);
        const lookup = prefix;
        const list = cache.byKey.get(lookup) ?? [];
        if (list.length === 0 || (typeof list[0] !== "object" && typeof slot === "object")) list[0] = slot;
        cache.byKey.set(lookup, list);
      }
    }
    return cache;
  }

  private static async read(paths: RunPaths, cache: ResumeCache): Promise<Map<string, { key: string; slot: CacheSlot }>> {
    const text = await readFile(paths.journal, "utf8").catch(() => "");
    const byCall = new Map<string, { key: string; slot: CacheSlot }>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: JournalEntry;
      try {
        entry = JSON.parse(line) as JournalEntry;
      } catch {
        continue; // A torn last line from a crash; the rest is still usable.
      }
      if (entry.type === "agent_started") {
        cache.strict = true;
        if (!byCall.has(entry.callId)) byCall.set(entry.callId, { key: entry.key, slot: "cutoff" });
      } else if (entry.type === "agent_completed") {
        byCall.set(entry.callId, { key: entry.key, slot: { value: entry.result, worktree: entry.worktree ?? null, agentId: entry.agentId ?? null, provider: entry.provider ?? null, model: entry.model ?? null } });
      } else if (entry.type === "agent_failed") {
        byCall.set(entry.callId, { key: entry.key, slot: entry.cutoff ? "cutoff" : "failed" });
      }
    }
    return byCall;
  }

  add(key: string, result: unknown, worktree: AgentCall["worktree"] = null): void {
    const list = this.byKey.get(key) ?? [];
    list.push({ value: result, worktree });
    this.byKey.set(key, list);
  }

  get size(): number {
    let total = 0;
    for (const list of this.byKey.values()) total += list.filter((entry) => typeof entry === "object").length;
    return total;
  }

  /** `diverged` is true on the call that ended reuse for the rest of the run. */
  take(key: string): { hit: true; value: unknown; worktree: AgentCall["worktree"]; agentId?: string | null; provider?: string | null; model?: string | null } | { hit: false; diverged?: true } {
    if (this.diverged) return { hit: false };
    this.prefix = historyKey(this.prefix, key);
    const lookup = this.strict ? this.prefix : key;
    const list = this.byKey.get(lookup);
    const index = this.used.get(lookup) ?? 0;
    if (!list || index >= list.length) {
      if (!this.strict) return { hit: false };
      this.diverged = true;
      return { hit: false, diverged: true };
    }
    this.used.set(lookup, index + 1);
    const entry = list[index];
    if (this.strict && entry === "failed") {
      this.diverged = true;
      return { hit: false, diverged: true };
    }
    return typeof entry === "object" ? { hit: true, ...entry } : { hit: false };
  }
}

function historyKey(prefix: string, key: string): string {
  return createHash("sha256").update(prefix).update(":").update(key).digest("hex");
}

/** One run directory: run.json (snapshot), journal.jsonl (append-only), script.js, result.json. */
export class RunFiles {
  readonly paths: RunPaths;
  private readonly writer: SerialWriter;
  private journalChain: Promise<void> = Promise.resolve();
  private readonly journalLines: string[] = [];
  private journalScheduled = false;

  constructor(state: StatePaths, runId: string) {
    this.paths = runPaths(state, runId);
    this.writer = new SerialWriter(this.paths.run);
  }

  async create(script: string, record: RunRecord): Promise<void> {
    await mkdir(this.paths.dir, { recursive: true, mode: 0o700 });
    await writeAtomically(this.paths.script, script);
    await this.writer.write(`${JSON.stringify(record, null, 1)}\n`);
  }

  saveRecord(record: RunRecord): Promise<void> {
    return this.writer.write(`${JSON.stringify(record, null, 1)}\n`);
  }

  journal(entry: JournalEntry): Promise<void> {
    this.journalLines.push(`${JSON.stringify(entry)}\n`);
    if (this.journalScheduled) return this.journalChain;
    this.journalScheduled = true;
    this.journalChain = this.journalChain.then(() => {
      const batch = this.journalLines.splice(0).join("");
      this.journalScheduled = false;
      return appendFile(this.paths.journal, batch, { mode: 0o600 }).catch((error) =>
        log(`could not append to ${this.paths.journal}: ${describeError(error)}`),
      );
    });
    return this.journalChain;
  }

  async writeResult(json: string): Promise<void> {
    await writeAtomically(this.paths.result, json.endsWith("\n") ? json : `${json}\n`);
  }

  async idle(): Promise<void> {
    await Promise.all([this.writer.idle(), this.journalChain]);
  }
}

export async function readRecord(state: StatePaths, runId: string): Promise<RunRecord | null> {
  const paths = runPaths(state, runId);
  try {
    const parsed = RunRecordSchema.safeParse(JSON.parse(await readFile(paths.run, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Run ids on disk, newest first (by directory mtime). */
export async function listRunIds(state: StatePaths): Promise<string[]> {
  const names = await readdir(state.runs).catch(() => [] as string[]);
  const withTimes = await Promise.all(
    names
      .filter((name) => name.startsWith("wf_"))
      .map(async (name) => ({ name, mtime: (await stat(runPaths(state, name).run).catch(() => null))?.mtimeMs ?? 0 })),
  );
  return withTimes.filter((entry) => entry.mtime > 0).sort((a, b) => b.mtime - a.mtime).map((entry) => entry.name);
}

export function metaOf(meta: WorkflowMeta): RunRecord["meta"] {
  return {
    name: meta.name,
    description: meta.description,
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    ...(meta.phases ? { phases: meta.phases } : {}),
  };
}

export type { AgentCall };
