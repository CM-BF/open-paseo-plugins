import { readdir, readFile, stat } from "node:fs/promises";
import { cpus, homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CARD_KIND, CARD_VERSION, LABEL_RUN, RUN_ID_PATTERN } from "../shared/ids";
import { NOTIFICATION_MARKER } from "../shared/notification";
import type { RunDetail, RunSummary } from "../shared/run-types";
import type { Preferences } from "../shared/settings";
import { AgentRunner, type ParentContext } from "./agent-runner";
import { parseBudgetDirective } from "./budget";
import { RunEngine } from "./engine";
import type { Gate, PaseoApi } from "./gate";
import { Notifier } from "./notifier";
import { paseoHome, runPaths, type StatePaths } from "./paths";
import { REFERENCE } from "./reference";
import {
  emptyUsage,
  listRunIds,
  metaOf,
  newRunId,
  readRecord,
  ResumeCache,
  RunFiles,
  type RunRecord,
} from "./run-store";
import { parseWorkflowScript, ScriptError } from "./script-parse";
import { describeError, log, nowIso, unref } from "./util";
import { cardData, notificationText, runDetail, runSummary, statusText } from "./views";

const execFileAsync = promisify(execFile);

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LaunchInput {
  script?: string;
  scriptPath?: string;
  name?: string;
  args?: unknown;
  resumeFromRunId?: string;
}

export interface ServiceOptions {
  paths: StatePaths;
  gate: Gate;
  settings: () => Preferences;
}

const CARD_THROTTLE_MS = 1200;
const SAVE_THROTTLE_MS = 1000;

export class WorkflowService {
  private readonly paths: StatePaths;
  private readonly gate: Gate;
  private readonly settings: () => Preferences;
  private readonly runner: AgentRunner;
  readonly notifier: Notifier;
  private readonly engines = new Map<string, RunEngine>();
  /** Runs whose end the launching agent learned from workflow_stop: no notification for them. */
  private readonly quietStops = new Set<string>();
  private readonly cardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cardWarned = false;

  constructor(options: ServiceOptions) {
    this.paths = options.paths;
    this.gate = options.gate;
    this.settings = options.settings;
    this.runner = new AgentRunner(() => this.requirePaseo());
    this.notifier = new Notifier(options.paths.outbox, () => this.gate.paseo);
  }

  get activeRuns(): number {
    return this.engines.size;
  }

  private requirePaseo(): PaseoApi {
    const paseo = this.gate.paseo;
    if (!paseo) throw new ServiceError("not_ready", "The plugin has no connection to Paseo yet; try again in a few seconds.");
    return paseo;
  }

  /** Startup: runs that were active when the plugin stopped end as interrupted; their children are archived. */
  async recover(): Promise<void> {
    await this.notifier.load();
    for (const runId of await listRunIds(this.paths)) {
      const record = await readRecord(this.paths, runId);
      if (!record) continue;
      // A clean shutdown records the run as interrupted but cannot wait for its children to be
      // archived; archive any that are still open.
      if (record.status === "interrupted" && record.endedAt && Date.now() - Date.parse(record.endedAt) < 24 * 60 * 60_000) {
        void this.gate.wait(10 * 60_000).then(
          (paseo) => this.archiveLeftovers(paseo, record),
          () => undefined,
        );
        continue;
      }
      if (record.status !== "running" && record.status !== "stopping") continue;
      record.status = "interrupted";
      record.endedAt = record.endedAt ?? nowIso();
      record.error = record.error ?? "The plugin stopped (reload, disable or daemon shutdown) while the run was active. Resume it with resumeFromRunId.";
      for (const call of record.calls) {
        if (call.status !== "completed" && call.status !== "cached" && call.status !== "failed" && call.status !== "skipped") {
          call.status = "skipped";
          call.error = "run interrupted";
          call.endedAt = record.endedAt;
        }
      }
      const files = new RunFiles(this.paths, runId);
      await files.saveRecord(record);
      await files.journal({ type: "run_finished", at: record.endedAt, status: "interrupted", error: record.error });
      if (!record.notified) {
        record.notified = true;
        await files.saveRecord(record);
        this.notifier.add({ id: `notify-${runId}`, agentId: record.parentAgentId, text: notificationText(record, this.paths) });
      }
      void this.gate.wait(10 * 60_000).then(
        (paseo) => this.archiveLeftovers(paseo, record),
        () => undefined,
      );
    }
  }

  private async archiveLeftovers(paseo: PaseoApi, record: RunRecord): Promise<void> {
    for (const call of record.calls) {
      if (!call.agentId) continue;
      try {
        const fresh = await paseo.agents.ref(call.agentId).refresh();
        if (fresh && !fresh.agent.archivedAt && fresh.agent.labels?.[LABEL_RUN] === record.runId) {
          await paseo.agents.ref(call.agentId).archive();
        }
      } catch {
        // Already gone.
      }
    }
    void this.publishCard(record);
  }

  async launch(callerId: string, input: LaunchInput): Promise<string> {
    const paseo = await this.gate.wait(20_000);
    const caller = await paseo.agents.ref(callerId).refresh();
    if (!caller || caller.agent.archivedAt) throw new ServiceError("unknown_agent", `Agent ${callerId} was not found on this host.`);
    const agent = caller.agent;
    const parent: ParentContext = {
      agentId: agent.id,
      provider: agent.provider,
      model: agent.model,
      modeId: agent.currentModeId,
      thinkingOptionId: agent.thinkingOptionId ?? null,
      featureValues: featureValues(agent.features),
      cwd: agent.cwd,
      workspaceId: agent.workspaceId ?? null,
    };

    const source = await this.resolveSource(input, agent.cwd);
    let parsed: ReturnType<typeof parseWorkflowScript>;
    try {
      parsed = parseWorkflowScript(source.script);
    } catch (error) {
      if (error instanceof ScriptError) throw new ServiceError("invalid_script", `Invalid workflow script: ${error.message}`);
      throw error;
    }

    let cache: ResumeCache | null = null;
    let resumedFrom: string | null = null;
    if (input.resumeFromRunId) {
      const previous = input.resumeFromRunId.trim();
      if (!RUN_ID_PATTERN.test(previous)) throw new ServiceError("invalid_request", `resumeFromRunId "${previous}" is not a run id (wf_...).`);
      if (this.engines.has(previous)) {
        throw new ServiceError("still_running", `Workflow ${previous} is still running. Stop it first with workflow_stop({ runId: "${previous}" }), then resume.`);
      }
      const record = await readRecord(this.paths, previous);
      if (!record) throw new ServiceError("unknown_run", `No workflow run ${previous} on this host.`);
      cache = await ResumeCache.load(runPaths(this.paths, previous));
      resumedFrom = previous;
    }

    const budgetTotal = await this.budgetFor(paseo, callerId);
    const runId = newRunId();
    const files = new RunFiles(this.paths, runId);
    const record: RunRecord = {
      version: 1,
      runId,
      meta: metaOf(parsed.meta),
      status: "running",
      parentAgentId: callerId,
      workspaceId: parent.workspaceId,
      cwd: parent.cwd,
      scriptPath: source.path ?? files.paths.script,
      source: source.kind,
      resumedFrom,
      startedAt: nowIso(),
      endedAt: null,
      error: null,
      phaseOrder: (parsed.meta.phases ?? []).map((phase) => phase.title),
      calls: [],
      logs: [],
      resultPreview: null,
      usage: emptyUsage(),
      budgetTotal,
      notified: false,
    };
    await files.create(source.script, record);
    if (resumedFrom && cache) {
      record.logs.push({ at: nowIso(), message: `Resuming from ${resumedFrom}: ${cache.size} cached agent result(s) available` });
    }

    const settings = this.settings();
    const engine = new RunEngine({
      record,
      files,
      body: parsed.body,
      args: input.args,
      parent,
      cache,
      runner: this.runner,
      concurrency: concurrency(settings),
      maxAgents: settings.maxAgentsPerRun,
      agentTimeoutMs: settings.agentTimeoutMinutes * 60_000,
      archiveWhenDone: settings.archiveFinishedAgents,
      resolveWorkflow: (ref, current) => this.resolveNested(ref, current),
      onChange: (changed) => this.onChange(changed),
      onFinished: (finished) => void this.onFinished(finished),
    });
    this.engines.set(runId, engine);
    engine.start();
    void this.publishCard(record);

    const lines = [
      `Workflow launched in background. Run ID: ${runId}`,
      `Summary: ${parsed.meta.description}`,
      `Script file: ${record.scriptPath}`,
      `Transcript dir: ${files.paths.dir}`,
    ];
    if (resumedFrom && cache) lines.push(`Resuming from ${resumedFrom} with ${cache.size} cached agent result(s).`);
    if (budgetTotal !== null) lines.push(`Token budget from the user's message: ${budgetTotal} output tokens.`);
    lines.push(`To iterate: edit the script file, then workflow({ scriptPath: "${record.scriptPath}", resumeFromRunId: "${runId}" }).`);
    lines.push("A <task-notification> message arrives when the run ends; end your turn now unless other work does not depend on it. workflow_status reports progress.");
    return lines.join("\n");
  }

  async stop(runId: string, by: { agentId?: string }): Promise<string> {
    const engine = this.engines.get(runId);
    if (!engine) {
      const record = await readRecord(this.paths, runId);
      if (!record) throw new ServiceError("unknown_run", `No workflow run ${runId} on this host.`);
      return `Workflow ${runId} is not running (${record.status}).`;
    }
    if (by.agentId && by.agentId === engine.record.parentAgentId) this.quietStops.add(runId);
    await engine.stop(by.agentId ? "stopped by the launching agent" : "stopped by the user");
    return statusText(engine.record, this.paths);
  }

  skip(runId: string, callId: string): boolean {
    return this.engines.get(runId)?.skip(callId) ?? false;
  }

  async status(callerId: string | null, runId: string | undefined, waitSeconds: number): Promise<string> {
    if (!runId) {
      const runs = await this.list(callerId ?? undefined, 5);
      if (runs.length === 0) return "You have no workflow runs on this host.";
      return runs
        .map((run) => `${run.runId} "${run.name}": ${run.status}, ${run.agents.total} agents (${run.agents.running} running, ${run.agents.failed} failed), started ${run.startedAt}`)
        .join("\n");
    }
    const engine = this.engines.get(runId);
    if (engine && waitSeconds > 0) {
      await Promise.race([engine.finished, new Promise((resolveWait) => setTimeout(resolveWait, waitSeconds * 1000))]);
    }
    const record = engine?.record ?? (await readRecord(this.paths, runId));
    if (!record) throw new ServiceError("unknown_run", `No workflow run ${runId} on this host.`);
    return statusText(record, this.paths);
  }

  reference(): string {
    return REFERENCE;
  }

  async list(agentId: string | undefined, limit: number): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const runId of await listRunIds(this.paths)) {
      const record = this.engines.get(runId)?.record ?? (await readRecord(this.paths, runId));
      if (!record) continue;
      if (agentId && record.parentAgentId !== agentId) continue;
      out.push(runSummary(record));
      if (out.length >= limit) break;
    }
    return out;
  }

  async detail(runId: string): Promise<RunDetail | null> {
    const record = this.engines.get(runId)?.record ?? (await readRecord(this.paths, runId));
    return record ? runDetail(record, this.paths) : null;
  }

  onAgentArchived(agentId: string): void {
    for (const engine of this.engines.values()) {
      if (engine.record.parentAgentId === agentId) void engine.stop("the launching agent was archived");
    }
    this.notifier.dropFor(agentId);
  }

  async dispose(): Promise<void> {
    for (const timer of [...this.cardTimers.values(), ...this.saveTimers.values()]) clearTimeout(timer);
    await Promise.all([...this.engines.values()].map((engine) => engine.interrupt().catch(() => undefined)));
    await Promise.all([...this.engines.values()].map((engine) => engine.files.idle()));
    await this.notifier.dispose();
  }

  private onChange(engine: RunEngine): void {
    const runId = engine.runId;
    if (!this.saveTimers.has(runId)) {
      this.saveTimers.set(
        runId,
        unref(
          setTimeout(() => {
            this.saveTimers.delete(runId);
            void engine.files.saveRecord(engine.record);
          }, SAVE_THROTTLE_MS),
        ),
      );
    }
    if (!this.cardTimers.has(runId)) {
      this.cardTimers.set(
        runId,
        unref(
          setTimeout(() => {
            this.cardTimers.delete(runId);
            void this.publishCard(engine.record);
          }, CARD_THROTTLE_MS),
        ),
      );
    }
  }

  private async onFinished(engine: RunEngine): Promise<void> {
    const record = engine.record;
    this.engines.delete(record.runId);
    for (const timers of [this.saveTimers, this.cardTimers]) {
      const timer = timers.get(record.runId);
      if (timer) clearTimeout(timer);
      timers.delete(record.runId);
    }
    const quiet = this.quietStops.delete(record.runId);
    if (!quiet) {
      this.notifier.add({ id: `notify-${record.runId}`, agentId: record.parentAgentId, text: notificationText(record, this.paths) });
    }
    record.notified = true;
    await engine.files.saveRecord(record);
    await this.publishCard(record);
    log(`run ${record.runId} "${record.meta.name}" ${record.status}: ${record.calls.length} agents`);
  }

  private async publishCard(record: RunRecord): Promise<void> {
    const paseo = this.gate.paseo;
    if (!paseo) return;
    try {
      await paseo.agents.ref(record.parentAgentId).timeline.append({
        type: "plugin",
        id: `run-${record.runId}`,
        kind: CARD_KIND,
        version: CARD_VERSION,
        data: cardData(record),
      });
    } catch (error) {
      if (!this.cardWarned) log(`could not update the run card of ${record.runId}: ${describeError(error)}`);
      this.cardWarned = true;
    }
  }

  private async budgetFor(paseo: PaseoApi, agentId: string): Promise<number | null> {
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" });
      const entries = (page as { entries?: Array<{ item: { type: string; text?: string } }> }).entries ?? [];
      for (let index = entries.length - 1; index >= 0; index--) {
        const item = entries[index]?.item;
        if (item?.type === "user_message" && typeof item.text === "string") {
          if (item.text.startsWith(NOTIFICATION_MARKER)) continue;
          return parseBudgetDirective(stripReminders(item.text));
        }
      }
    } catch (error) {
      log(`could not read the token budget of ${agentId}: ${describeError(error)}`);
    }
    return null;
  }

  private async resolveSource(
    input: LaunchInput,
    cwd: string,
  ): Promise<{ script: string; path: string | null; kind: RunRecord["source"] }> {
    if (input.scriptPath?.trim()) {
      const path = isAbsolute(input.scriptPath) ? input.scriptPath : resolve(cwd, input.scriptPath);
      const script = await readFile(path, "utf8").catch((error) => {
        throw new ServiceError("invalid_request", `Cannot read scriptPath ${path}: ${describeError(error)}`);
      });
      return { script, path, kind: "scriptPath" };
    }
    if (typeof input.script === "string" && input.script.trim()) return { script: input.script, path: null, kind: "script" };
    if (input.name?.trim()) {
      const found = await this.findNamed(input.name.trim(), cwd);
      return { script: found.script, path: found.path, kind: "name" };
    }
    throw new ServiceError("invalid_request", "Provide script, scriptPath or name.");
  }

  private async resolveNested(ref: unknown, record: RunRecord): Promise<{ name: string; body: string; filename: string }> {
    let script: string;
    if (typeof ref === "string" && ref.trim()) {
      script = (await this.findNamed(ref.trim(), record.cwd)).script;
    } else if (ref && typeof ref === "object" && typeof (ref as { scriptPath?: unknown }).scriptPath === "string") {
      const raw = (ref as { scriptPath: string }).scriptPath;
      const path = isAbsolute(raw) ? raw : resolve(record.cwd, raw);
      script = await readFile(path, "utf8").catch((error) => {
        throw new Error(`workflow(): cannot read ${path}: ${describeError(error)}`);
      });
    } else {
      throw new TypeError("workflow() expects a saved workflow name or { scriptPath }");
    }
    try {
      const parsed = parseWorkflowScript(script);
      return { name: parsed.meta.name, body: parsed.body, filename: `${parsed.meta.name}.nested.workflow.js` };
    } catch (error) {
      throw new Error(`workflow(): invalid nested script: ${describeError(error)}`);
    }
  }

  private async findNamed(name: string, cwd: string): Promise<{ script: string; path: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new ServiceError("invalid_request", `"${name}" is not a workflow name (letters, digits, dot, dash and underscore).`);
    }
    const dirs = await workflowDirs(cwd);
    for (const dir of dirs) {
      const path = join(dir, `${name}.js`);
      const script = await readFile(path, "utf8").catch(() => null);
      if (script !== null) return { script, path };
    }
    const available = await availableWorkflows(dirs);
    throw new ServiceError(
      "unknown_workflow",
      `Workflow "${name}" not found. Looked in ${dirs.join(", ")}. Available: ${available.length ? available.join(", ") : "(none)"}`,
    );
  }
}

function concurrency(settings: Preferences): number {
  if (settings.maxConcurrentAgents > 0) return settings.maxConcurrentAgents;
  return Math.max(1, Math.min(8, cpus().length - 2));
}

function featureValues(features: ReadonlyArray<{ id: string; value: unknown }> | undefined): Record<string, unknown> | undefined {
  if (!features || features.length === 0) return undefined;
  const values: Record<string, unknown> = {};
  for (const feature of features) {
    if (feature && typeof feature.id === "string" && feature.value !== undefined && feature.value !== null) values[feature.id] = feature.value;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");
}

async function workflowDirs(cwd: string): Promise<string[]> {
  const roots = [cwd];
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 });
    const top = stdout.trim();
    if (top && top !== cwd) roots.push(top);
  } catch {
    // Not a git checkout.
  }
  const dirs: string[] = [];
  for (const root of roots) dirs.push(join(root, ".paseo", "workflows"), join(root, ".claude", "workflows"));
  dirs.push(join(paseoHome(), "workflows"), join(homedir(), ".claude", "workflows"));
  return [...new Set(dirs)];
}

async function availableWorkflows(dirs: string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const dir of dirs) {
    const isDir = await stat(dir).then((entry) => entry.isDirectory(), () => false);
    if (!isDir) continue;
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      if (file.endsWith(".js")) names.add(file.slice(0, -3));
    }
  }
  return [...names].sort();
}

