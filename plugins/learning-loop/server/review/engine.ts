// The background review loop (Hermes agent/background_review.py + the nudge counters in
// agent/turn_finalizer.py). After each turn, count the agent's user turns and tool calls since its
// last review; past a threshold (and a cooldown), queue a review: a headless Claude run that reads a
// digest of the conversation and writes memory and skills through this plugin's own MCP tools.
// One review runs at a time host-wide. Results are logged and, when something changed, shown as a
// row in that agent's timeline.

import { join } from "node:path";
import { ReviewBudget } from "./budget";
import { MCP_SERVER, REVIEW_BINDING_PREFIX, UPDATE_KIND, UPDATE_VERSION } from "../../shared/constants";
import type { ProjectRef, ReviewRun, UpdateRow } from "../../shared/contracts";
import type { Preferences } from "../../shared/settings";
import { appendLine, describeError, newId, readJson, readText, SerialQueue, writeJson } from "../files";
import { complete, resolveRoute, routeErrorText, type Exec, type ModelRoute, type RouteResult } from "../kit/complete";
import type { StatePaths } from "../paths";
import { CURATOR_PROMPT, REVIEW_SYSTEM_PROMPT, reviewInput } from "../prompts";
import type { TimelineEntryLike } from "../sessions/transcript";
import { TOOL_NAMES } from "../tools";
import { buildDigest } from "./digest";

export interface ReviewAgent {
  id: string;
  title: string | null;
  provider: string;
  cwd: string;
  parentAgentId: string | null;
}

interface AgentCounters {
  userTurns: number;
  toolCalls: number;
  lastReviewAt: string | null;
  epoch: string | null;
  countedSeq: number;
  reviewedSeq: number;
}

type CountersFile = { agents: Record<string, AgentCounters> };

function parseCounters(value: unknown): CountersFile {
  const agents: Record<string, AgentCounters> = {};
  const raw = (value as { agents?: unknown })?.agents;
  if (raw && typeof raw === "object") {
    for (const [id, c] of Object.entries(raw as Record<string, Partial<AgentCounters>>)) {
      agents[id] = {
        userTurns: Number(c.userTurns) || 0,
        toolCalls: Number(c.toolCalls) || 0,
        lastReviewAt: typeof c.lastReviewAt === "string" ? c.lastReviewAt : null,
        epoch: typeof c.epoch === "string" ? c.epoch : null,
        countedSeq: Number.isFinite(c.countedSeq) ? Number(c.countedSeq) : -1,
        reviewedSeq: Number.isFinite(c.reviewedSeq) ? Number(c.reviewedSeq) : -1,
      };
    }
  }
  return { agents };
}

export interface TimelineFetch {
  epoch: string;
  entries: readonly TimelineEntryLike[];
}

/** What the review run collects about itself while its MCP calls arrive. */
export interface RunContext {
  runId: string;
  agentId: string;
  agentTitle: string | null;
  project: ProjectRef | null;
  evidence?: { epoch: string; fromSeq: number; toSeq: number };
  memoryRevisions?: Record<string, string>;
  changes: string[];
  staged: number;
}

export interface ReviewDeps {
  paths: StatePaths;
  settings(): Preferences;
  paseo: { config: { get(): Promise<{ config: { providers?: unknown } }> } };
  /** The last `limit` projected timeline entries of an agent. */
  tail(agentId: string, limit: number): Promise<TimelineFetch>;
  appendRow(agentId: string, id: string, row: UpdateRow): Promise<void>;
  project(cwd: string): Promise<ProjectRef | null>;
  /** Runs registered here resolve `review-<runId>` MCP bindings. */
  runs: Map<string, RunContext>;
  /** Current title of an agent (hook payloads carry null for untitled agents). */
  title?(agentId: string): Promise<string | null>;
  currentState?(project: ProjectRef | null, context: RunContext): Promise<string>;
  exec?: Exec;
  now?: () => Date;
}

const TAIL_LIMIT = 400;
const QUEUE_MAX = 6;

export class ReviewEngine {
  private readonly counterQueue = new SerialQueue();
  private readonly runQueue = new SerialQueue();
  private readonly queued = new Set<string>();
  private readonly running = new Map<string, ReviewRun>();
  private readonly abort = new AbortController();
  private curatorQueued = 0;
  private readonly startedAt: number;
  private readonly budget: ReviewBudget;

  constructor(private readonly deps: ReviewDeps) {
    this.startedAt = this.now().getTime();
    this.budget = new ReviewBudget(join(deps.paths.root, "review-budget.v1.json"), () => this.now());
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  stop(): void {
    this.abort.abort();
  }

  async budgetStatus() { return { ...await this.budget.today(), limit: this.deps.settings().review.dailyBudgetUsd }; }

  queuedCount(): number { return this.queued.size + this.curatorQueued; }

  runningRuns(): ReviewRun[] {
    return [...this.running.values()];
  }

  private async counters(): Promise<CountersFile> {
    return readJson(this.deps.paths.counters, { agents: {} }, parseCounters);
  }

  /** Counts the turn that just ended; queues a review when a threshold is met. */
  onTurnEnded(agent: ReviewAgent): Promise<void> {
    return this.counterQueue.run(async () => {
      const settings = this.deps.settings().review;
      if (!settings.enabled) return;
      if (agent.parentAgentId && !settings.includeChildAgents) return;
      const timeline = await this.deps.tail(agent.id, TAIL_LIMIT);
      const file = await this.counters();
      let c = file.agents[agent.id];
      if (!c) {
        // First sight of an agent: count only what happened since this plugin started, so installing
        // (or reinstalling) does not queue a review of every agent's old history at once.
        const before = timeline.entries.filter((e) => Date.parse(e.timestamp) < this.startedAt).map((e) => e.seqEnd);
        const seen = before.length ? Math.max(...before) : -1;
        c = { userTurns: 0, toolCalls: 0, lastReviewAt: null, epoch: timeline.epoch, countedSeq: seen, reviewedSeq: seen };
      }
      const fresh = c.epoch !== timeline.epoch;
      if (fresh) {
        c.epoch = timeline.epoch;
        c.countedSeq = -1;
        c.reviewedSeq = -1;
      }
      for (const entry of timeline.entries) {
        if (entry.seqEnd <= c.countedSeq) continue;
        if (entry.item.type === "user_message") c.userTurns += 1;
        else if (entry.item.type === "tool_call") c.toolCalls += 1;
      }
      c.countedSeq = Math.max(c.countedSeq, ...timeline.entries.map((e) => e.seqEnd));
      file.agents[agent.id] = c;
      await writeJson(this.deps.paths.counters, file);
      const due = c.userTurns >= settings.userTurns || c.toolCalls >= settings.toolCalls;
      const cooled = !c.lastReviewAt || this.now().getTime() - Date.parse(c.lastReviewAt) >= settings.cooldownMinutes * 60_000;
      if (due && cooled) this.enqueue(agent, "threshold");
    });
  }

  /** Archive is the session boundary: review leftover activity once. */
  onArchived(agent: ReviewAgent): Promise<void> {
    return this.counterQueue.run(async () => {
      const settings = this.deps.settings().review;
      if (!settings.enabled || !settings.onArchive) return;
      if (agent.parentAgentId && !settings.includeChildAgents) return;
      const c = (await this.counters()).agents[agent.id];
      if (c && c.userTurns >= 1 && c.toolCalls >= 3) this.enqueue(agent, "archive");
    });
  }

  /** `/review` and the UI: review this agent now, whatever the counters say. */
  runNow(agent: ReviewAgent): { ok: boolean; message: string } {
    if (this.queued.has(agent.id)) return { ok: false, message: "A review of this agent is already queued or running." };
    if (!this.enqueue(agent, "manual")) return { ok: false, message: "The review queue is full or stopping." };
    return { ok: true, message: "Review started. Its result appears in this chat and in Learning → Activity." };
  }

  private enqueue(agent: ReviewAgent, trigger: ReviewRun["trigger"]): boolean {
    if (this.queued.has(agent.id) || this.queued.size >= QUEUE_MAX || this.abort.signal.aborted) return false;
    this.queued.add(agent.id);
    const runId = newId("rv_");
    if (trigger === "manual") {
      const row: UpdateRow = { runId, status: "running", trigger, actions: [], model: this.deps.settings().review.model, costUsd: null, note: null };
      void this.deps.appendRow(agent.id, `review-${runId}`, row).catch(() => undefined);
    }
    void this.runQueue
      .run(() => this.review(agent, trigger, runId))
      .catch((error) => console.error(`[learning-loop] review of ${agent.id} failed: ${describeError(error)}`))
      .finally(() => this.queued.delete(agent.id));
    return true;
  }

  private async route(providerId: string): Promise<RouteResult> {
    return resolveRoute(this.deps.paseo, providerId);
  }

  private mcpConfig(binding: string): string {
    return JSON.stringify({
      mcpServers: { [MCP_SERVER]: { type: "stdio", command: this.deps.paths.mcp, args: [], env: { LEARNING_LOOP_BINDING: binding } } },
    });
  }

  private allowedTools(): string[] {
    return TOOL_NAMES.map((tool) => `mcp__${MCP_SERVER}__${tool}`);
  }

  private async review(agent: ReviewAgent, trigger: ReviewRun["trigger"], runId: string): Promise<ReviewRun> {
    const settings = this.deps.settings().review;
    if (!agent.title && this.deps.title) agent = { ...agent, title: await this.deps.title(agent.id).catch(() => null) };
    const run: ReviewRun = {
      id: runId,
      agentId: agent.id,
      agentTitle: agent.title,
      trigger,
      startedAt: this.now().toISOString(),
      endedAt: null,
      status: "running",
      model: settings.model,
      costUsd: null,
      actions: [],
      note: null,
    };
    this.running.set(runId, run);
    const context: RunContext = { runId, agentId: agent.id, agentTitle: agent.title, project: null, changes: [], staged: 0 };
    let reviewedSeq = -1;
    let reviewedEpoch: string | null = null;
    let reserved = false;
    try {
      const route = await this.route(settings.provider);
      if (!route.ok) throw new RunError(`Review model route unavailable: ${routeErrorText(route.error)} (${route.label}).`);
      const timeline = await this.deps.tail(agent.id, TAIL_LIMIT);
      reviewedEpoch = timeline.epoch;
      const counters = (await this.counters()).agents[agent.id];
      const since = counters && counters.epoch === timeline.epoch ? counters.reviewedSeq : -1;
      const digest = buildDigest(timeline.entries, { reviewedSeq: since });
      reviewedSeq = Math.max(-1, ...timeline.entries.map((e) => e.seqEnd));
      if (digest.newEntries === 0) {
        run.status = "nothing";
        run.note = "No new conversation since the last review.";
        return run;
      }
      context.evidence = { epoch: timeline.epoch, fromSeq: since + 1, toSeq: reviewedSeq };
      context.project = await this.deps.project(agent.cwd).catch(() => null);
      this.deps.runs.set(runId, context);
      const header = [
        `Agent: ${agent.title ?? agent.id} (${agent.provider}, Paseo agent ${agent.id})`,
        `Working directory: ${agent.cwd}`,
        context.project ? `Project (target='project' writes go here): ${context.project.name} — ${context.project.root}` : "Project: none known (do not use target='project').",
        `Trigger: ${trigger}`,
      ].join("\n");
      const current = await this.deps.currentState?.(context.project, context) ?? "Current state unavailable; use skills_list and skill_view before changes.";
      reserved = await this.budget.reserve(runId, settings.maxBudgetUsd, settings.dailyBudgetUsd);
      if (!reserved) throw new RunError("Host daily review budget reached; no model run started (UTC day).");
      const result = await complete({
        route: route.route as ModelRoute,
        model: settings.model,
        maxBudgetUsd: settings.maxBudgetUsd,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        stdin: reviewInput(digest.text, `${header}\n\n<current-learning-state>\n${current}\n</current-learning-state>`),
        mcpConfig: this.mcpConfig(REVIEW_BINDING_PREFIX + runId),
        allowedTools: this.allowedTools(),
        role: "learning-loop-review",
        timeoutMs: 10 * 60_000,
        signal: this.abort.signal,
        ...(this.deps.exec ? { exec: this.deps.exec } : {}),
      });
      run.costUsd = result.costUsd;
      run.model = result.models[0] ?? settings.model;
      run.actions = [...context.changes];
      if (!result.ok) {
        run.status = context.changes.length > 0 ? (context.staged > 0 ? "staged" : "updated") : "failed";
        run.note = `The review run ended early: ${routeErrorText(result.error)}${result.apiStatus ? ` (HTTP ${result.apiStatus})` : ""}.`;
      } else {
        run.status = context.changes.length === 0 ? "nothing" : context.staged > 0 && context.staged === context.changes.length ? "staged" : "updated";
        const summary = result.text.trim().split("\n").filter(Boolean).slice(-6).join(" ").slice(0, 600);
        run.note = summary || null;
      }
      return run;
    } catch (error) {
      run.status = "failed";
      run.note = error instanceof RunError ? error.message : `Review failed: ${describeError(error)}`;
      return run;
    } finally {
      if (reserved) await this.settleBudget(run);
      this.deps.runs.delete(runId);
      run.endedAt = this.now().toISOString();
      this.running.delete(runId);
      await this.finish(agent, run, reviewedSeq, reviewedEpoch);
    }
  }

  private async settleBudget(run: ReviewRun): Promise<void> {
    try { await this.budget.settle(run.id, run.costUsd); }
    catch (error) {
      run.status = "failed";
      run.note = `Budget settlement failed; reservation remains charged: ${describeError(error)}`;
    }
  }

  private async finish(agent: ReviewAgent, run: ReviewRun, reviewedSeq: number, epoch: string | null): Promise<void> {
    await this.counterQueue.run(async () => {
      const file = await this.counters();
      let c = file.agents[agent.id];
      if (!c && epoch && reviewedSeq >= 0) {
        c = { userTurns: 0, toolCalls: 0, lastReviewAt: null, epoch, countedSeq: reviewedSeq, reviewedSeq: -1 };
        file.agents[agent.id] = c;
      }
      if (c && run.status !== "failed") {
        c.userTurns = 0;
        c.toolCalls = 0;
        c.lastReviewAt = run.endedAt;
        if (reviewedSeq >= 0) {
          c.reviewedSeq = reviewedSeq;
          // Recount turns that arrived while the reviewer was working on the older snapshot.
          c.countedSeq = Math.min(c.countedSeq, reviewedSeq);
        }
        await writeJson(this.deps.paths.counters, file);
      } else if (c && run.status === "failed") {
        // Back off a failing route for a cooldown, but keep the counts.
        c.lastReviewAt = run.endedAt;
        await writeJson(this.deps.paths.counters, file);
      }
    });
    await appendLine(this.deps.paths.reviews, run).catch(() => undefined);
    // A manual review already showed a "running" row; replace it whatever the outcome.
    if (run.status === "updated" || run.status === "staged" || run.trigger === "manual") {
      const note = run.status === "nothing" || run.status === "failed" ? run.note : null;
      const row: UpdateRow = { runId: run.id, status: run.status, trigger: run.trigger, actions: run.actions.slice(0, 20), model: run.model, costUsd: run.costUsd, note };
      await this.deps.appendRow(agent.id, `review-${run.id}`, row).catch((error) => console.error(`[learning-loop] timeline row for ${agent.id} failed: ${describeError(error)}`));
    }
  }

  /** The curator's LLM consolidation pass: same runner, the curator prompt, no conversation. */
  consolidate(): Promise<ReviewRun> {
    this.curatorQueued += 1;
    return this.runQueue.run(async () => {
      const settings = this.deps.settings().review;
      const agent: ReviewAgent = { id: "curator", title: "Skill curator", provider: settings.provider, cwd: this.deps.paths.root, parentAgentId: null };
      const runId = newId("cu_");
      const run: ReviewRun = { id: runId, agentId: agent.id, agentTitle: agent.title, trigger: "curator", startedAt: this.now().toISOString(), endedAt: null, status: "running", model: settings.model, costUsd: null, actions: [], note: null };
      this.running.set(runId, run);
      const context: RunContext = { runId, agentId: agent.id, agentTitle: agent.title, project: null, changes: [], staged: 0 };
      this.deps.runs.set(runId, context);
      let reserved = false;
      try {
        const route = await this.route(settings.provider);
        if (!route.ok) throw new RunError(`Model route unavailable: ${routeErrorText(route.error)} (${route.label}).`);
        reserved = await this.budget.reserve(runId, settings.maxBudgetUsd, settings.dailyBudgetUsd);
        if (!reserved) throw new RunError("Host daily review budget reached; no model run started (UTC day).");
        const result = await complete({
          route: route.route,
          model: settings.model,
          maxBudgetUsd: settings.maxBudgetUsd,
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          stdin: `${CURATOR_PROMPT}\n\nStart with skills_list.`,
          mcpConfig: this.mcpConfig(REVIEW_BINDING_PREFIX + runId),
          allowedTools: this.allowedTools(),
          role: "learning-loop-curator",
          timeoutMs: 20 * 60_000,
          signal: this.abort.signal,
          ...(this.deps.exec ? { exec: this.deps.exec } : {}),
        });
        run.costUsd = result.costUsd;
        run.actions = [...context.changes];
        run.status = context.changes.length ? (context.staged === context.changes.length ? "staged" : "updated") : result.ok ? "nothing" : "failed";
        run.note = result.ok ? result.text.trim().slice(-600) || null : `Ended early: ${routeErrorText(result.error)}.`;
      } catch (error) {
        run.status = "failed";
        run.note = describeError(error);
      } finally {
        if (reserved) await this.settleBudget(run);
        this.deps.runs.delete(runId);
        this.running.delete(runId);
        run.endedAt = this.now().toISOString();
        await appendLine(this.deps.paths.reviews, run).catch(() => undefined);
      }
      return run;
    }).finally(() => { this.curatorQueued -= 1; });
  }

  async history(limit: number): Promise<ReviewRun[]> {
    const raw = await readText(this.deps.paths.reviews);
    const runs: ReviewRun[] = [];
    if (raw) {
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          runs.push(JSON.parse(line) as ReviewRun);
        } catch {
          // skip a torn line
        }
      }
    }
    return [...this.runningRuns(), ...runs.reverse()].slice(0, limit);
  }
}

class RunError extends Error {}
