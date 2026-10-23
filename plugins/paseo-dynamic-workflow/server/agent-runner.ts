import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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
  /** Per-call time limit; the smaller of this and the global limit applies. Not part of the cache key. */
  timeoutMs?: number;
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
  creating?(info: { agentId: string }): Promise<void> | void;
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
  retained?: boolean;
}

export type AgentOutcome =
  | { ok: true; value: unknown; worktree: WorktreeInfo | null }
  | { ok: false; error: string; skipped: boolean; throws?: boolean; worktree: WorktreeInfo | null };

const BUILT_IN_TYPES: Record<string, string | null> = {
  "general-purpose": null,
  general: null,
  default: null,
  explore:
    "Role: explorer. Read and search to answer the task. Do not create, modify or delete files, and run only read-only commands.",
  plan: "Role: planner. Investigate and produce a concrete plan. Do not create, modify or delete files.",
  verification:
    "Role: adversarial verifier. Try to refute the claim with evidence you check yourself: read the code, run the reproduction. When the evidence you examined does not support it, treat it as refuted. When you could not examine it at all (a missing tool, a denied permission, an unreachable source), say so plainly instead of guessing; if the task's schema has a field for that, use it. Do not modify files.",
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
  options?: Record<string, unknown>;
}

class Aborted extends Error {}
class ConfigurationError extends Error {}
type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type AgentSnapshot = NonNullable<ReturnType<AgentHandle["current"]>>;
interface ProviderMode { id: string; colorTier?: string; isUnattended?: boolean }
interface UsageTracker { counted: string | null; record(usage: AgentSnapshot["lastUsage"], unfinished?: boolean): void }

export class AgentRunner {
  private readonly models = new Map<string, { at: number; models: ModelInfo[] }>();
  private profiles: { at: number; list: Array<Record<string, unknown>> } | null = null;

  constructor(private readonly paseo: () => PaseoApi) {}

  async run(task: AgentTask, progress: AgentProgress): Promise<AgentOutcome> {
    let handle: AgentHandle | null = null;
    let agentId: string | null = null;
    let worktree: WorktreeInfo | null = null;
    let base: string | null = null;
    let reservedBranch: string | null = null;
    let ownsReservedBranch = false;
    let releaseTimeline: (() => void) | null = null;
    let canceled: string | null = null;
    const deadline = task.timeoutMs > 0 ? Date.now() + task.timeoutMs : Number.POSITIVE_INFINITY;
    const cwd = resolve(task.opts.cwd ?? task.parent.cwd);
    const usage = usageTracker(progress);
    try {
      const config = await this.resolveConfig(task, deadline);
      const isolation = task.opts.isolation === "worktree";
      await requireDirectory(cwd);
      let workspace: Awaited<ReturnType<PaseoApi["workspaces"]["open"]>> | null = null;
      if (!isolation && !(await sameDirectory(cwd, task.parent.cwd))) {
        workspace = await this.paseo().workspaces.open(cwd);
        if (!workspace.directory || !(await sameDirectory(workspace.directory, cwd))) {
          throw new ConfigurationError(`agent() cwd ${cwd} resolves to workspace ${workspace.directory ?? "(unavailable)"}; use isolation: 'worktree' for a different directory`);
        }
      }
      throwIfAborted(task.signal);
      if (isolation) {
        base = await gitHead(cwd);
        if (!base) throw new ConfigurationError(`agent() worktree isolation requires a git repository with a commit: ${cwd}`);
        reservedBranch = branchName(task);
        // Checkout mode avoids the daemon's asynchronous first-prompt branch rename.
        await run("git", ["-C", cwd, "branch", reservedBranch, base], { timeout: 10_000 });
        ownsReservedBranch = true;
      }
      throwIfAborted(task.signal);
      agentId = randomUUID();
      await progress.creating?.({ agentId });
      const options = {
        agentId,
        idempotencyKey: `${task.runId}:${task.callId}:${agentId}`,
        config: {
          provider: `${config.provider}/${config.model ?? "default"}`,
          ...(config.modeId ? { modeId: config.modeId } : {}),
          ...(config.thinkingOptionId ? { thinkingOptionId: config.thinkingOptionId } : {}),
          ...(config.featureValues ? { featureValues: config.featureValues } : {}),
          ...(config.options ? { options: config.options } : {}),
          systemPrompt: config.role ? `${CHILD_SYSTEM_PROMPT}\n${config.role}` : CHILD_SYSTEM_PROMPT,
        },
        parent: task.parent.agentId,
        title: task.label,
        env: { [CHILD_ENV]: task.runId },
        labels: { [LABEL_RUN]: task.runId, [LABEL_CALL]: task.callId, ...(base ? { "paseo-dynamic-workflow/base": base } : {}) },
        ...(isolation && reservedBranch ? { worktree: { mode: "checkout-branch" as const, branch: reservedBranch }, background: true } : {}),
      };
      // Creation is idempotent, and the ownership id is persisted before the request.
      // Do not abandon an in-flight create on abort: its late child still needs cleanup.
      handle = await retryTransient(
        () => workspace ? workspace.agents.create(options) : this.paseo().agents.create({ ...options, cwd }),
        task.signal, deadline, false,
      );
      agentId = handle.id;
      const snapshot = handle.current();
      if (isolation) {
        if (!snapshot?.cwd || await sameDirectory(snapshot.cwd, cwd)) throw new Error("the daemon did not return an isolated worktree directory");
        worktree = { path: snapshot.cwd, branch: reservedBranch, workspaceId: snapshot.workspaceId ?? null, changed: null };
      }
      progress.started({ agentId, provider: config.provider, model: snapshot?.model ?? config.model, worktree });
      throwIfAborted(task.signal);
      assertChildActive(snapshot);
      // Subscribe before sending the first prompt so even a very short canceled turn
      // cannot be mistaken for a successful idle result containing partial text.
      const observation = handle.timeline.subscribe((message) => {
        if (message.event.type === "turn_canceled") canceled = message.event.reason || "the agent was stopped by the user";
      });
      releaseTimeline = observation;
      await retryTransient(() => observation.ready, task.signal, deadline);
      const active = async () => {
        throwIfAborted(task.signal);
        if (canceled) throw new Aborted(canceled);
        const fresh = await retryTransient(() => handle!.refresh(), task.signal, deadline);
        if (!fresh) throw new Error("the child agent disappeared");
        assertChildActive(fresh.agent);
        if (canceled) throw new Aborted(canceled);
        throwIfAborted(task.signal);
      };
      await active();
      await this.send(handle, buildPrompt(task, reservedBranch), task, deadline, "initial");
      let turn = await this.waitTurn(handle, task.signal, deadline, progress, usage, () => canceled);
      await active();
      let value: unknown = turn.lastMessage;
      if (turn.status === "error") throw new Error(turn.error ?? "the agent failed");
      if (task.opts.schema) {
        const schema = task.opts.schema;
        for (let attempt = 0; ; attempt++) {
          const parsed = extractJson(turn.lastMessage);
          const errors = parsed === undefined ? ["the final message contains no JSON value"] : schema.validate(parsed);
          if (errors.length === 0) { value = parsed; break; }
          if (attempt >= MAX_REPAIRS) throw new ConfigurationError(`the final message did not match the schema after ${MAX_REPAIRS} corrections: ${errors.join("; ")}`);
          await active();
          progress.repaired();
          await this.send(handle, repairPrompt(errors, schema), task, deadline, `repair-${attempt}`);
          turn = await this.waitTurn(handle, task.signal, deadline, progress, usage, () => canceled);
          await active();
          if (turn.status === "error") throw new Error(turn.error ?? "the agent failed");
        }
      }
      // Release before our own archive emits a canceled/closed lifecycle event.
      releaseTimeline(); releaseTimeline = null;
      if (task.archiveWhenDone) await this.archive(agentId);
      if (worktree) worktree = await this.settleWorktree(worktree, base, cwd, !task.archiveWhenDone);
      return { ok: true, value: value ?? "", worktree };
    } catch (error) {
      releaseTimeline?.(); releaseTimeline = null;
      const skipped = error instanceof Aborted;
      if (handle) {
        try { usage.record((await handle.refresh())?.agent.lastUsage, true); } catch { /* The daemon may already be closed. */ }
      }
      if (agentId) await this.archive(agentId);
      if (worktree) worktree = await this.settleWorktree(worktree, base, cwd);
      // Without a completed create we cannot prove a reserved branch is unused:
      // a daemon-side creation may still be in flight. Recovery owns that case.
      if (ownsReservedBranch && reservedBranch && !agentId && base) await removeUnchangedBranch(cwd, reservedBranch, base);
      return { ok: false, error: skipped ? describeError(task.signal.reason ?? error) : describeError(error), skipped, throws: !skipped && (error instanceof ConfigurationError || !handle), worktree };
    } finally {
      releaseTimeline?.();
    }
  }

  private async send(handle: AgentHandle, prompt: string, task: AgentTask, deadline: number, turn: string): Promise<void> {
    await retryTransient(() => handle.send(prompt, { messageId: `${task.runId}:${task.callId}:${turn}` }), task.signal, deadline);
  }

  private async archive(agentId: string): Promise<void> {
    try {
      const result = await retryTransient(() => this.paseo().agents.ref(agentId).archive(), undefined, Date.now() + 30_000);
      if (!result.archivedAt) throw new Error("the daemon did not confirm the archive");
    } catch (error) {
      log(`could not archive child agent ${agentId}: ${describeError(error)}; recovery will retry`);
    }
  }

  /** Waits for the current turn, through permission prompts, until idle or error. */
  private async waitTurn(
    handle: ReturnType<PaseoApi["agents"]["ref"]>,
    signal: AbortSignal,
    deadline: number,
    progress: AgentProgress,
    usage: UsageTracker,
    canceled: () => string | null,
  ): Promise<{ status: "idle" | "error"; lastMessage: string | null; error: string | null }> {
    const startedAt = Date.now();
    for (;;) {
      throwIfAborted(signal);
      if (Date.now() > deadline) throw new Error("the agent ran past the configured time limit");
      const slice = Math.max(1000, Math.min(WAIT_SLICE_MS, deadline - Date.now()));
      const result = await retryTransient(() => handle.waitForFinish(slice), signal, deadline);
      if (canceled()) throw new Aborted(canceled()!);
      assertChildActive(result.final);
      if (result.status === "timeout") continue;
      if (result.status === "permission") {
        progress.status("permission");
        await this.waitForPermission(handle, signal, deadline);
        progress.status("running");
        continue;
      }
      // A turn that has not registered yet reads as idle with no message: give it a moment.
      if (result.status === "idle" && result.lastMessage === null && Date.now() - startedAt < 15_000) {
        await pause(1000, signal);
        continue;
      }
      usage.record(result.final?.lastUsage);
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
      await pause(3000, signal);
      const fresh = await retryTransient(() => handle.refresh(), signal, deadline);
      if (!fresh) throw new Error("the agent disappeared while waiting for a permission answer");
      assertChildActive(fresh.agent);
      if (fresh.agent.pendingPermissions.length === 0) return;
    }
  }

  private async settleWorktree(worktree: WorktreeInfo, base: string | null, cwd: string, retainUnchanged = false): Promise<WorktreeInfo> {
    const branch = await currentBranch(worktree.path);
    const changed = await worktreeChanged(worktree.path, base);
    if (changed === false && retainUnchanged) return { ...worktree, branch, changed, retained: true };
    if (changed === false && worktree.workspaceId) {
      try {
        const result = await retryTransient(() => this.paseo().workspaces.archive(worktree.workspaceId!), undefined, Date.now() + 30_000);
        if (result.error || !result.archivedAt) throw new Error(result.error ?? "the daemon did not confirm workspace removal");
        if (existsSync(worktree.path)) throw new Error("the workspace was archived but its worktree directory still exists");
        if (branch && branch === worktree.branch && base) await removeUnchangedBranch(cwd, branch, base);
      } catch (error) {
        log(`could not remove the unchanged worktree ${worktree.path}: ${describeError(error)}`);
        return { ...worktree, branch, changed: null };
      }
    } else if (changed !== true) {
      log(`kept worktree ${worktree.path}: ${changed === null ? "git state is unknown" : "the daemon returned no workspace id"}`);
      return { ...worktree, branch, changed: null };
    }
    return { ...worktree, branch, changed };
  }

  private async resolveConfig(task: AgentTask, deadline: number): Promise<ResolvedConfig> {
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
      const builtIn = Object.hasOwn(BUILT_IN_TYPES, type.toLowerCase()) ? BUILT_IN_TYPES[type.toLowerCase()] : undefined;
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
    const beforeModel = `${config.provider}/${config.model ?? ""}`;
    const requestedModel = task.opts.model?.trim();
    if (requestedModel) {
      const cwd = task.opts.cwd ?? task.parent.cwd;
      const models = await this.providerModels(config.provider, cwd);
      const exact = findModel(models, requestedModel);
      const slash = requestedModel.indexOf("/");
      if (exact) config.model = exact.id;
      else if (slash > 0 && await this.isProvider(requestedModel.slice(0, slash), config.provider)) {
        const provider = requestedModel.slice(0, slash);
        if (provider !== config.provider) config = { provider, model: null, role: config.role };
        config.model = await this.resolveModel(provider, requestedModel.slice(slash + 1), cwd);
      } else config.model = await this.resolveModel(config.provider, requestedModel, cwd);
      if (`${config.provider}/${config.model ?? ""}` !== beforeModel) delete config.thinkingOptionId;
    }
    const requestedMode = config.modeId;
    config.modeId = await this.permissionMode(task, config, deadline);
    if (requestedMode !== config.modeId && config.featureValues) {
      // Provider features can include auto-accept controls. Do not retain stale
      // grants when the parent was tightened or a profile had to be capped.
      const restricted = {
        ...(config.featureValues.plan_mode === true ? { plan_mode: true } : {}),
        ...(config.featureValues.auto_accept === false ? { auto_accept: false } : {}),
      };
      config.featureValues = Object.keys(restricted).length ? restricted : undefined;
    }
    if (!config.model || config.model === "default") {
      const models = await this.providerModels(config.provider, task.opts.cwd ?? parent.cwd);
      config.model = models?.find((model) => model.isDefault)?.id ?? models?.[0]?.id ?? null;
    }
    if (task.opts.effort) {
      const options = await this.thinkingOptions(config.provider, config.model, task.parent.cwd);
      if (options === null || options.includes(task.opts.effort)) config.thinkingOptionId = task.opts.effort;
      else log(`effort "${task.opts.effort}" is not a thinking option of ${config.provider}/${config.model ?? "default"} (${options.join(", ")}); using the default`);
    }
    return config;
  }

  private async isProvider(provider: string, current: string): Promise<boolean> {
    if (provider === current) return true;
    const result = await this.paseo().providers.listAvailable();
    return result.providers.some((entry) => entry.provider === provider);
  }

  /** Cap every child at both the launch-time and the current parent mode. */
  private async permissionMode(task: AgentTask, config: ResolvedConfig, deadline: number): Promise<string | undefined> {
    const parent = task.parent;
    const current = await retryTransient(() => this.paseo().agents.ref(parent.agentId).refresh(), task.signal, deadline);
    const sourceModes = await this.providerModes(parent.provider, parent.cwd);
    if (config.featureValues?.auto_accept === true) {
      const currentAutoAccept = current?.agent.features?.find((feature) => feature.id === "auto_accept");
      if (parent.featureValues?.auto_accept !== true || (current && (!currentAutoAccept || currentAutoAccept.value !== true))) {
        config.featureValues = { ...config.featureValues, auto_accept: false };
      }
    }
    const launchTier = modeTier(parent.modeId, sourceModes, parent.provider);
    // Runtime snapshots often contain only mode ids/labels. Permission metadata
    // comes from the catalog, including for the current parent's mode.
    const liveModes = current && current.agent.provider !== parent.provider
      ? await this.providerModes(current.agent.provider, parent.cwd)
      : sourceModes;
    const liveTier = current ? modeTier(current.agent.currentModeId, liveModes, current.agent.provider) : launchTier;
    const cap = Math.min(launchTier, liveTier);
    if (config.provider === "opencode" && cap < 3) config.featureValues = { ...config.featureValues, auto_accept: false };
    if (config.provider === parent.provider && config.modeId === (parent.modeId ?? undefined) && cap === launchTier) return config.modeId;
    const targetModes = config.provider === parent.provider ? sourceModes : await this.providerModes(config.provider, task.opts.cwd ?? parent.cwd);
    if (config.modeId && modeTier(config.modeId, targetModes, config.provider) >= 0 && modeTier(config.modeId, targetModes, config.provider) <= cap) return config.modeId;
    const allowed = targetModes.filter((mode) => modeTier(mode.id, targetModes, config.provider) >= 0 && modeTier(mode.id, targetModes, config.provider) <= cap);
    const preferred = allowed.find((mode) => modeTier(mode.id, targetModes, config.provider) === cap) ?? allowed[0];
    if (preferred) return preferred.id;
    // 0.12 validates catalog mode ids before calling Codex, so the hidden
    // read-only preset cannot be selected directly. Pin its native sandbox.
    if (config.provider === "codex" && cap >= 0 && cap <= 1 && targetModes.some((mode) => mode.id === "auto")) {
      config.options = { sandbox_mode: "read-only", approval_policy: "on-request" };
      if (cap === 0) config.featureValues = { plan_mode: true };
      return "auto";
    }
    if (cap === 3 && targetModes.length === 0) return undefined;
    throw new ConfigurationError(`Cannot preserve parent ${parent.provider}/${parent.modeId ?? "unknown"} permissions for ${config.provider}; select a provider/profile with an equally restrictive permission mode`);
  }

  private async providerModes(provider: string, cwd: string): Promise<ProviderMode[]> {
    const result = await this.paseo().providers.listModes(provider, { cwd });
    if (result.error || !result.modes) throw new ConfigurationError(`Cannot discover permission modes for ${provider}: ${result.error ?? "no modes returned"}`);
    return result.modes;
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
      throw new ConfigurationError(
        `Unknown agentType "${type}". Use general-purpose, explore, plan, verification, or an agent profile: ${names.length ? names.join(", ") : "(none configured)"}`,
      );
    }
    return profile;
  }

  private async providerModels(provider: string, cwd: string): Promise<ModelInfo[] | null> {
    const key = `${provider}:${resolve(cwd)}`;
    const cached = this.models.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.models;
    try {
      const result = await this.paseo().providers.listModels(provider, { cwd });
      const models = ((result as { models?: ModelInfo[] }).models ?? []).filter((model) => model && typeof model.id === "string");
      this.models.set(key, { at: Date.now(), models });
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

export function branchName(task: Pick<AgentTask, "runId" | "callId" | "label">): string {
  const prefix = `wf-${task.runId.slice(3)}-${task.callId}`;
  const slug = task.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 49 - prefix.length).replace(/-+$/, "");
  return slug ? `${prefix}-${slug}` : prefix;
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch { return null; }
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
    return (await gitHead(path)) !== base;
  } catch {
    return null;
  }
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  if (resolve(left) === resolve(right)) return true;
  try {
    const paths = await Promise.all([realpath(left), realpath(right)]);
    return paths[0] === paths[1];
  } catch { return false; }
}

async function requireDirectory(cwd: string): Promise<void> {
  try {
    if ((await stat(cwd)).isDirectory()) return;
  } catch (error) {
    throw new ConfigurationError(`agent() cwd is unavailable: ${cwd}: ${describeError(error)}`);
  }
  throw new ConfigurationError(`agent() cwd is not a directory: ${cwd}`);
}

async function removeUnchangedBranch(cwd: string, branch: string, base: string): Promise<void> {
  try {
    const head = await run("git", ["-C", cwd, "rev-parse", "--verify", `refs/heads/${branch}`], { timeout: 10_000 });
    if (head.stdout.trim() !== base) return;
    // Git also refuses deletion while this branch is checked out in any worktree.
    await run("git", ["-C", cwd, "branch", "-D", "--", branch], { timeout: 10_000 });
  } catch (error) { log(`could not remove unchanged workflow branch ${branch}: ${describeError(error)}`); }
}

function findModel(models: ModelInfo[] | null, requested: string): ModelInfo | undefined {
  const wanted = requested.toLowerCase();
  return models?.find((model) => model.id.toLowerCase() === wanted || model.aliases?.some((alias) => alias.toLowerCase() === wanted) || model.label?.toLowerCase() === wanted);
}

function modeTier(modeId: string | null | undefined, modes: ProviderMode[], provider: string): number {
  const mode = modes.find((entry) => entry.id === modeId);
  if (mode?.isUnattended || (mode?.colorTier === "dangerous" && ["bypassPermissions", "full-access", "full", "allow-all"].includes(mode.id))) return 3;
  if (mode?.colorTier === "moderate") return 2;
  if (mode?.colorTier === "safe") return 1;
  if (mode?.colorTier === "planning" || modeId === "read-only") return 0;
  // An unknown mode is never permission to silently broaden the child's access.
  if (provider === "pi" && modes.length === 0) return 3;
  return -1;
}

function assertChildActive(snapshot: AgentSnapshot | null): void {
  if (snapshot?.archivedAt || snapshot?.status === "closed") throw new Aborted("the agent was stopped or archived by the user");
}

function usageTracker(progress: AgentProgress): UsageTracker {
  return {
    counted: null,
    record(value, unfinished = false) {
      if (!value) return;
      const key = JSON.stringify(value);
      if (unfinished && key === this.counted) return;
      this.counted = key;
      progress.usage({ inputTokens: value.inputTokens ?? 0, outputTokens: value.outputTokens ?? 0, costUsd: value.totalCostUsd ?? 0 });
    },
  };
}

function isTransient(error: unknown): boolean {
  if (!(error instanceof Error) || /Daemon client closed|Paseo API is disposed/.test(error.message)) return false;
  const code = (error as Error & { code?: string }).code;
  return error.name === "DaemonConnectionError" || code === "DAEMON_CONNECTION_LOST" || code === "DAEMON_REQUEST_TIMEOUT";
}

async function retryTransient<T>(operation: () => Promise<T>, signal?: AbortSignal, deadline = Infinity, abortPending = true): Promise<T> {
  const until = Math.min(deadline, Date.now() + 120_000);
  let delay = 500;
  for (;;) {
    if (signal) throwIfAborted(signal);
    if (Date.now() >= deadline) throw new Error("the agent ran past the configured time limit");
    try {
      const pending = operation();
      return await (signal && abortPending ? abortable(pending, signal) : pending);
    } catch (error) {
      if (!isTransient(error) || Date.now() >= until) throw error;
      await pause(Math.min(delay, Math.max(1, until - Date.now())), signal);
      delay = Math.min(delay * 2, 10_000);
    }
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

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal) throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new Aborted(describeError(signal?.reason ?? "skipped"))); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

