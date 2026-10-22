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
  notified: z.boolean(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export type JournalEntry =
  | { type: "run_started"; at: string; runId: string; resumedFrom: string | null }
  | { type: "agent_completed"; at: string; callId: string; key: string; label: string; result: unknown; cached: boolean; worktree?: AgentCall["worktree"] }
  | { type: "agent_failed"; at: string; callId: string; key: string; label: string; error: string }
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

/**
 * Completed results of an earlier run, by key in invocation order. The n-th call with a key in
 * the resumed run takes the n-th cached result with that key, independent of completion timing.
 */
export class ResumeCache {
  private readonly byKey = new Map<string, Array<{ value: unknown; worktree: AgentCall["worktree"] }>>();
  private readonly used = new Map<string, number>();

  static async load(paths: RunPaths): Promise<ResumeCache> {
    const cache = new ResumeCache();
    const text = await readFile(paths.journal, "utf8").catch(() => "");
    const completed: Array<Extract<JournalEntry, { type: "agent_completed" }>> = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as JournalEntry;
        if (entry.type === "agent_completed") completed.push(entry);
      } catch {
        // A torn last line from a crash; the rest is still usable.
      }
    }
    completed.sort((a, b) => Number(a.callId.slice(1)) - Number(b.callId.slice(1)));
    for (const entry of completed) cache.add(entry.key, entry.result, entry.worktree ?? null);
    return cache;
  }

  add(key: string, result: unknown, worktree: AgentCall["worktree"] = null): void {
    const list = this.byKey.get(key) ?? [];
    list.push({ value: result, worktree });
    this.byKey.set(key, list);
  }

  get size(): number {
    let total = 0;
    for (const list of this.byKey.values()) total += list.length;
    return total;
  }

  take(key: string): { hit: true; value: unknown; worktree: AgentCall["worktree"] } | { hit: false } {
    const list = this.byKey.get(key);
    const index = this.used.get(key) ?? 0;
    if (!list || index >= list.length) return { hit: false };
    this.used.set(key, index + 1);
    return { hit: true, ...list[index]! };
  }
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
