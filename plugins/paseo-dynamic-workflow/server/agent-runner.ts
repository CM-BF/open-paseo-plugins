import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CHILD_ENV, LABEL_CALL, LABEL_RUN } from "../shared/ids";
import type { Usage } from "../shared/run-types";
import type { PaseoApi } from "./gate";
import { type CompiledSchema, extractJson } from "./json-schema";
import { describeError, log } from "./util";

const run = promisify(execFile);

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Options of one agent() call after validation. */
export interface AgentOptions {
  label?: string;
  schema?: CompiledSchema;
  model?: string;
  provider?: string;
  effort?: string;
  isolation?: "worktree";
  agentType?: string;
  cwd?: string;
}

/** What a child inherits: the launching agent's settings. */
export interface ParentContext {
  agentId: string;
  provider: string;
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown> | undefined;
  cwd: string;
  workspaceId: string | null;
}

export interface AgentTask {
  runId: string;
  callId: string;
  workflowName: string;
  label: string;
  phase: string | null;
  prompt: string;
  opts: AgentOptions;
  parent: ParentContext;
  signal: AbortSignal;
  timeoutMs: number;
  archiveWhenDone: boolean;
}

export interface AgentProgress {
  started(info: { agentId: string; provider: string; model: string | null; worktree: WorktreeInfo | null }): void;
  status(status: "running" | "permission"): void;
  usage(usage: Usage): void;
  repaired(): void;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  workspaceId: string | null;
  changed: boolean | null;
}

export type AgentOutcome =
  | { ok: true; value: unknown; worktree: WorktreeInfo | null }
  | { ok: false; error: string; skipped: boolean; worktree: WorktreeInfo | null };

const BUILT_IN_TYPES: Record<string, string | null> = {
  "general-purpose": null,
  general: null,
  default: null,
  explore:
    "Role: explorer. Read and search to answer the task. Do not create, modify or delete files, and run only read-only commands.",
  plan: "Role: planner. Investigate and produce a concrete plan. Do not create, modify or delete files.",
  verification:
    "Role: adversarial verifier. Try to refute the claim with evidence you check yourself: read the code, run the reproduction. When you cannot confirm it, treat it as refuted. Do not modify files.",
};

/** Same text for every child, so providers that cache the system prompt can share it. */
export const CHILD_SYSTEM_PROMPT = `You are a subagent in a Paseo dynamic workflow. An orchestrating script started you with one task and reads your final message as data.
- Work on the task on your own. Nobody answers questions during the run: make reasonable assumptions and state them in your result.
- Your final message is the return value. Write it for a program: no greetings and no account of your process unless the task asks for one.
- When the task gives a JSON Schema, your final message must be exactly one JSON value that matches it, with no prose and no code fences around it.
- Do not start workflows or other agents unless the task tells you to.`;

const MAX_REPAIRS = 3;
const WAIT_SLICE_MS = 60_000;

interface ModelInfo {
  id: string;
  aliases?: string[];
  label: string;
  thinkingOptions?: Array<{ id: string }>;
  isDefault?: boolean;
}

interface ResolvedConfig {
  provider: string;
  model: string | null;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  role: string | null;
}

class Aborted extends Error {}

export class AgentRunner {
  private readonly models = new Map<string, { at: number; models: ModelInfo[] }>();
  private profiles: { at: number; list: Array<Record<string, unknown>> } | null = null;

  constructor(private readonly paseo: () => PaseoApi) {}

  async run(task: AgentTask, progress: AgentProgress): Promise<AgentOutcome> {
    let agentId: string | null = null;
    let worktree: WorktreeInfo | null = null;
    let base: string | null = null;
    try {
      const config = await this.resolveConfig(task);
      const cwd = task.opts.cwd ?? task.parent.cwd;
      const isolation = task.opts.isolation === "worktree";
      if (isolation) base = await gitHead(cwd);
      throwIfAborted(task.signal);
      const branch = isolation ? branchName(task) : null;
      const handle = await this.paseo().agents.create({
        config: {
          provider: config.model ? `${config.provider}/${config.model}` : config.provider,
          ...(config.modeId ? { modeId: config.modeId } : {}),
          ...(config.thinkingOptionId ? { thinkingOptionId: config.thinkingOptionId } : {}),
          ...(config.featureValues ? { featureValues: config.featureValues } : {}),
          systemPrompt: config.role ? `${CHILD_SYSTEM_PROMPT}\n${config.role}` : CHILD_SYSTEM_PROMPT,
        },
        cwd,
        parent: task.parent.agentId,
        title: task.label,
        prompt: buildPrompt(task, branch),
        env: { [CHILD_ENV]: task.runId },
        labels: { [LABEL_RUN]: task.runId, [LABEL_CALL]: task.callId },
        ...(isolation && branch ? { worktree: { mode: "branch-off" as const, newBranch: branch, ...(base ? { base } : {}) }, background: true } : {}),
      });
      agentId = handle.id;
      const snapshot = handle.current();
      if (isolation) {
        worktree = { path: snapshot?.cwd ?? cwd, branch, workspaceId: snapshot?.workspaceId ?? null, changed: null };
      }
      progress.started({ agentId, provider: config.provider, model: snapshot?.model ?? config.model, worktree });

      const deadline = task.timeoutMs > 0 ? Date.now() + task.timeoutMs : Number.POSITIVE_INFINITY;
      let turn = await this.waitTurn(handle, task.signal, deadline, progress);
      let value: unknown = turn.lastMessage;
      if (turn.status === "error") {
        throw new Error(turn.error ?? "the agent failed");
      }
      if (task.opts.schema) {
        const schema = task.opts.schema;
        let attempt = 0;
        for (;;) {
          const parsed = extractJson(turn.lastMessage);
          const errors = parsed === undefined ? ["the final message contains no JSON value"] : schema.validate(parsed);
          if (errors.length === 0) {
            value = parsed;
            break;
          }
          if (attempt >= MAX_REPAIRS) {
            throw new Error(`the final message did not match the schema after ${MAX_REPAIRS} corrections: ${errors.join("; ")}`);
          }
          attempt++;
          progress.repaired();
          await handle.send(repairPrompt(errors, schema));
          turn = await this.waitTurn(handle, task.signal, deadline, progress);
          if (turn.status === "error") throw new Error(turn.error ?? "the agent failed");
        }
      }
      if (worktree) worktree = await this.settleWorktree(worktree, base);
      if (task.archiveWhenDone) await this.archive(agentId);
      return { ok: true, value: value ?? "", worktree };
    } catch (error) {
      const skipped = error instanceof Aborted;
      if (agentId) await this.archive(agentId);
      if (worktree) worktree = await this.settleWorktree(worktree, base).catch(() => worktree);
      return { ok: false, error: skipped ? describeError(task.signal.reason ?? error) : describeError(error), skipped, worktree };
    }
  }

  private async archive(agentId: string): Promise<void> {
    try {
      await this.paseo().agents.ref(agentId).archive();
    } catch (error) {
      log(`could not archive child agent ${agentId}: ${describeError(error)}`);
    }
  }

  /** Waits for the current turn, through permission prompts, until idle or error. */
  private async waitTurn(
    handle: ReturnType<PaseoApi["agents"]["ref"]>,
    signal: AbortSignal,
    deadline: number,
    progress: AgentProgress,
  ): Promise<{ status: "idle" | "error"; lastMessage: string | null; error: string | null }> {
    const startedAt = Date.now();
    for (;;) {
      throwIfAborted(signal);
      if (Date.now() > deadline) throw new Error("the agent ran past the configured time limit");
      const slice = Math.max(1000, Math.min(WAIT_SLICE_MS, deadline - Date.now()));
      const result = await abortable(handle.waitForFinish(slice), signal);
      if (result.status === "timeout") continue;
      if (result.status === "permission") {
        progress.status("permission");
        await this.waitForPermission(handle, signal, deadline);
        progress.status("running");
        continue;
      }
      // A turn that has not registered yet reads as idle with no message: give it a moment.
      if (result.status === "idle" && result.lastMessage === null && Date.now() - startedAt < 15_000) {
        await abortable(sleep(1000), signal);
        continue;
      }
      const usage = result.final?.lastUsage;
      if (usage) {
        progress.usage({
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          costUsd: usage.totalCostUsd ?? 0,
        });
      }
      return {
        status: result.status === "error" ? "error" : "idle",
        lastMessage: result.lastMessage,
        error: result.error ?? result.final?.lastError ?? null,
      };
    }
  }

  private async waitForPermission(
    handle: ReturnType<PaseoApi["agents"]["ref"]>,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      if (Date.now() > deadline) throw new Error("the agent ran past the configured time limit while waiting for a permission answer");
      await abortable(sleep(3000), signal);
      const fresh = await handle.refresh().catch(() => null);
      if (!fresh) throw new Error("the agent disappeared while waiting for a permission answer");
      if (fresh.agent.archivedAt) throw new Error("the agent was archived while waiting for a permission answer");
      if (fresh.agent.pendingPermissions.length === 0) return;
    }
  }

  private async settleWorktree(worktree: WorktreeInfo, base: string | null): Promise<WorktreeInfo> {
    // Paseo may rename a new worktree's branch after its first prompt: report the real one.
    const branch = (await currentBranch(worktree.path)) ?? worktree.branch;
    const changed = await worktreeChanged(worktree.path, base);
    if (changed === false && worktree.workspaceId) {
      try {
        await this.paseo().workspaces.archive(worktree.workspaceId);
      } catch (error) {
        log(`could not remove the unchanged worktree ${worktree.path}: ${describeError(error)}`);
      }
    }
    return { ...worktree, branch, changed };
  }

  private async resolveConfig(task: AgentTask): Promise<ResolvedConfig> {
    const parent = task.parent;
    let config: ResolvedConfig = {
      provider: parent.provider,
      model: parent.model,
      ...(parent.modeId ? { modeId: parent.modeId } : {}),
      ...(parent.thinkingOptionId ? { thinkingOptionId: parent.thinkingOptionId } : {}),
      ...(parent.featureValues ? { featureValues: parent.featureValues } : {}),
      role: null,
    };
    const type = task.opts.agentType?.trim();
    if (type) {
      const builtIn = BUILT_IN_TYPES[type.toLowerCase()];
      if (builtIn !== undefined) {
        config.role = builtIn;
      } else {
        const profile = await this.findProfile(type);
        config = {
          provider: String(profile.provider),
          model: typeof profile.model === "string" ? profile.model : null,
          ...(typeof profile.modeId === "string" ? { modeId: profile.modeId } : {}),
          ...(typeof profile.thinkingOptionId === "string" ? { thinkingOptionId: profile.thinkingOptionId } : {}),
          ...(profile.featureValues && typeof profile.featureValues === "object"
            ? { featureValues: profile.featureValues as Record<string, unknown> }
            : {}),
          role: null,
        };
      }
    }
    const providerOverride = task.opts.provider?.trim();
    if (providerOverride && providerOverride !== config.provider) {
      // Another provider's modes, thinking options and features do not carry over.
      config = { provider: providerOverride, model: null, role: config.role };
    }
    const requestedModel = task.opts.model?.trim();
    if (requestedModel) {
      const slash = requestedModel.indexOf("/");
      if (slash > 0) {
        const provider = requestedModel.slice(0, slash);
        if (provider !== config.provider) config = { provider, model: null, role: config.role };
        config.model = requestedModel.slice(slash + 1);
      } else {
        config.model = await this.resolveModel(config.provider, requestedModel, task.parent.cwd);
      }
      if (config.model !== parent.model) delete config.thinkingOptionId;
    }
    if (task.opts.effort) {
      const options = await this.thinkingOptions(config.provider, config.model, task.parent.cwd);
      if (options === null || options.includes(task.opts.effort)) config.thinkingOptionId = task.opts.effort;
      else log(`effort "${task.opts.effort}" is not a thinking option of ${config.provider}/${config.model ?? "default"} (${options.join(", ")}); using the default`);
    }
    return config;
  }

  private async findProfile(type: string): Promise<Record<string, unknown>> {
    if (!this.profiles || Date.now() - this.profiles.at > 60_000) {
      const result = await this.paseo().config.get();
      const list = (result.config as { agentProfiles?: Array<Record<string, unknown>> }).agentProfiles ?? [];
      this.profiles = { at: Date.now(), list };
    }
    const wanted = type.toLowerCase();
    const profile = this.profiles.list.find(
      (entry) => String(entry.id).toLowerCase() === wanted || String(entry.name).toLowerCase() === wanted,
    );
    if (!profile || typeof profile.provider !== "string") {
      const names = this.profiles.list.map((entry) => String(entry.name));
      throw new Error(
        `Unknown agentType "${type}". Use general-purpose, explore, plan, verification, or an agent profile: ${names.length ? names.join(", ") : "(none configured)"}`,
      );
    }
    return profile;
  }

  private async providerModels(provider: string, cwd: string): Promise<ModelInfo[] | null> {
    const cached = this.models.get(provider);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.models;
    try {
      const result = await this.paseo().providers.listModels(provider, { cwd });
      const models = ((result as { models?: ModelInfo[] }).models ?? []).filter((model) => model && typeof model.id === "string");
      this.models.set(provider, { at: Date.now(), models });
      return models;
    } catch (error) {
      log(`could not list ${provider} models: ${describeError(error)}`);
      return null;
    }
  }

  /** A bare model name: an id, alias or label of the provider (`opus` → claude-opus-…). */
  private async resolveModel(provider: string, requested: string, cwd: string): Promise<string> {
    const models = await this.providerModels(provider, cwd);
    if (!models) return requested;
    const wanted = requested.toLowerCase();
    const exact = models.find(
      (model) =>
        model.id.toLowerCase() === wanted ||
        model.aliases?.some((alias) => alias.toLowerCase() === wanted) ||
        model.label.toLowerCase() === wanted,
    );
    if (exact) return exact.id;
    const partial = models.find((model) => model.id.toLowerCase().includes(wanted));
    return partial?.id ?? requested;
  }

  private async thinkingOptions(provider: string, model: string | null, cwd: string): Promise<string[] | null> {
    const models = await this.providerModels(provider, cwd);
    if (!models) return null;
    const entry = models.find((candidate) => candidate.id === model) ?? models.find((candidate) => candidate.isDefault);
    if (!entry?.thinkingOptions) return null;
    return entry.thinkingOptions.map((option) => option.id);
  }
}

function buildPrompt(task: AgentTask, branch: string | null): string {
  const header = `[Paseo dynamic workflow "${task.workflowName}" · run ${task.runId} · agent "${task.label}"${task.phase ? ` · phase "${task.phase}"` : ""}]`;
  const notes: string[] = ["Your final message is returned to the workflow script as data."];
  if (task.opts.schema) {
    notes.push(
      `It must be exactly one JSON value matching this JSON Schema, with no prose and no code fences:\n${JSON.stringify(task.opts.schema.schema)}`,
    );
  }
  if (branch) {
    notes.push(
      "You work in an isolated git worktree; other agents edit their own copies in parallel. Commit your changes on the current branch before you finish and leave the branch in place: the orchestrator merges it.",
    );
  }
  return `${header}\n\n${task.prompt}\n\n---\n${notes.join("\n")}`;
}

function repairPrompt(errors: string[], schema: CompiledSchema): string {
  return `Your final message did not match the required JSON Schema:\n${errors.map((error) => `- ${error}`).join("\n")}\n\nReply with only the corrected JSON value (no prose, no code fences). Schema:\n${JSON.stringify(schema.schema)}`;
}

function branchName(task: AgentTask): string {
  const slug = task.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `workflow/${task.runId.slice(3)}/${slug || "agent"}-${task.callId}`;
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 10_000 });
    const name = stdout.trim();
    if (name && name !== "HEAD") return name;
    const sha = await run("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 10_000 });
    return sha.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function currentBranch(path: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 10_000 });
    const name = stdout.trim();
    return name && name !== "HEAD" ? name : null;
  } catch {
    return null;
  }
}

async function worktreeChanged(path: string, base: string | null): Promise<boolean | null> {
  try {
    const status = await run("git", ["-C", path, "status", "--porcelain"], { timeout: 20_000 });
    if (status.stdout.trim()) return true;
    if (!base) return null;
    const ahead = await run("git", ["-C", path, "rev-list", "--count", `${base}..HEAD`], { timeout: 20_000 });
    return Number(ahead.stdout.trim()) > 0;
  } catch {
    return null;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Aborted(describeError(signal.reason ?? "skipped"));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Aborted(describeError(signal.reason ?? "skipped")));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Aborted(describeError(signal.reason ?? "skipped")));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

