import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOutcome, AgentProgress, AgentTask, ParentContext } from "./agent-runner";
import { RunEngine, type Runner } from "./engine";
import { statePaths, type StatePaths } from "./paths";
import { emptyUsage, metaOf, newRunId, ResumeCache, RunFiles, type RunRecord } from "./run-store";
import { parseWorkflowScript } from "./script-parse";

export const PARENT: ParentContext = {
  agentId: "parent-1",
  provider: "claude",
  model: "claude-test",
  modeId: "default",
  thinkingOptionId: null,
  featureValues: undefined,
  cwd: "/tmp",
  workspaceId: "ws-1",
};

export type Behavior = (task: AgentTask, progress: AgentProgress) => Promise<AgentOutcome> | AgentOutcome;

/** A runner whose agents answer through `behavior`; it records every task. */
export class FakeRunner implements Runner {
  readonly tasks: AgentTask[] = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly behavior: Behavior) {}

  async run(task: AgentTask, progress: AgentProgress): Promise<AgentOutcome> {
    this.tasks.push(task);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      progress.started({ agentId: `child-${task.callId}`, provider: "claude", model: "claude-test", worktree: null });
      return await this.behavior(task, progress);
    } finally {
      this.active--;
    }
  }
}

export function ok(value: unknown): AgentOutcome {
  return { ok: true, value, worktree: null };
}

export interface RunOptions {
  args?: unknown;
  cache?: ResumeCache | null;
  budgetTotal?: number | null;
  maxAgents?: number;
  concurrency?: number;
  state?: StatePaths;
  nested?: Record<string, string>;
  onEngine?: (engine: RunEngine) => void;
  watchdog?: { heartbeatMs: number; stuckMs: number };
}

export interface RunResult {
  record: RunRecord;
  result: unknown;
  state: StatePaths;
  engine: RunEngine;
}

export async function tempState(): Promise<StatePaths> {
  return statePaths(await mkdtemp(join(tmpdir(), "dwf-test-")));
}

export async function cleanup(state: StatePaths): Promise<void> {
  await rm(state.root, { recursive: true, force: true });
}

export async function runScript(script: string, runner: Runner, options: RunOptions = {}): Promise<RunResult> {
  const state = options.state ?? (await tempState());
  const parsed = parseWorkflowScript(script);
  const runId = newRunId();
  const files = new RunFiles(state, runId);
  const record: RunRecord = {
    version: 1,
    runId,
    meta: metaOf(parsed.meta),
    status: "running",
    parentAgentId: PARENT.agentId,
    workspaceId: PARENT.workspaceId,
    cwd: PARENT.cwd,
    scriptPath: files.paths.script,
    source: "script",
    resumedFrom: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    error: null,
    phaseOrder: (parsed.meta.phases ?? []).map((phase) => phase.title),
    calls: [],
    logs: [],
    resultPreview: null,
    usage: emptyUsage(),
    budgetTotal: options.budgetTotal ?? null,
    notified: false,
  };
  await files.create(script, record);
  const engine = new RunEngine({
    record,
    files,
    body: parsed.body,
    args: options.args,
    parent: PARENT,
    cache: options.cache ?? null,
    runner,
    concurrency: options.concurrency ?? 4,
    maxAgents: options.maxAgents ?? 1000,
    agentTimeoutMs: 0,
    archiveWhenDone: false,
    resolveWorkflow: async (ref) => {
      const source = options.nested?.[String(ref)];
      if (!source) throw new Error(`Workflow "${String(ref)}" not found`);
      const child = parseWorkflowScript(source);
      return { name: child.meta.name, body: child.body, filename: `${child.meta.name}.nested.workflow.js` };
    },
    onChange: () => undefined,
    onFinished: () => undefined,
    ...(options.watchdog ? { watchdog: options.watchdog } : {}),
  });
  options.onEngine?.(engine);
  engine.start();
  await engine.finished;
  await files.idle();
  const result = record.status === "completed" ? JSON.parse(await readFile(files.paths.result, "utf8")) : undefined;
  return { record, result, state, engine };
}

export function meta(name = "test", phases = ""): string {
  return `export const meta = { name: '${name}', description: 'test workflow'${phases ? `, phases: ${phases}` : ""} }\n`;
}
