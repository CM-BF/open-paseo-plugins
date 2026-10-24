import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CARD_KIND, CARD_VERSION, LABEL_RUN, RUN_ID_PATTERN } from "../shared/ids";
import { NOTIFICATION_MARKER } from "../shared/notification";
import type { RunDetail, RunSummary } from "../shared/run-types";
import { isWorkflowSize, type ToolGuidance } from "../shared/guidance";
import { CHAIN_CHECK_IN, chainCheckIn, guidanceReminder, referenceStatus } from "./prompts";
import type { Preferences } from "../shared/settings";
import { AgentRunner, relayedRequest, type ParentContext } from "./agent-runner";
import { parseBudgetDirective } from "./budget";
import { RunEngine } from "./engine";
import type { Gate, PaseoApi } from "./gate";
import { Notifier } from "./notifier";
import { runPaths, type StatePaths } from "./paths";
import { REFERENCE } from "./reference";
import { recoverChildren } from "./recovery";
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
import { catalogText, findNamedWorkflow, isWorkflowName, listWorkflows, type NamedWorkflow, UnknownWorkflowError, workflowDirs } from "./workflow-catalog";
import { cardData, notificationText, runDetail, runSummary, statusText } from "./views";

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
  /** The caller's current Ultracode and size guidance; restated in launch results and notifications. */
  guidance?: (agentId: string) => ToolGuidance;
}

const CARD_THROTTLE_MS = 1200;
const SAVE_THROTTLE_MS = 1000;
const MAX_CACHED_RECORDS = 100;

export class WorkflowService {
  private readonly paths: StatePaths;
  private readonly gate: Gate;
  private readonly settings: () => Preferences;
  private readonly guidance: (agentId: string) => ToolGuidance | null;
  private readonly runner: AgentRunner;
  readonly notifier: Notifier;
  private readonly engines = new Map<string, RunEngine>();
  private readonly cardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cardFailures = new Map<string, number>();
  private readonly records = new Map<string, RunRecord>();
  private readonly summaries = new Map<string, RunSummary>();
  private runOrder: string[] = [];
  private readonly finalizers = new Set<Promise<void>>();
  /** Runs launched per agent since its latest user message; resets with the plugin. */
  private readonly chains = new Map<string, { key: string; count: number }>();
  private disposed = false;

  constructor(options: ServiceOptions) {
    this.paths = options.paths;
    this.gate = options.gate;
    this.settings = options.settings;
    this.guidance = options.guidance ?? (() => null);
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
    this.runOrder = await listRunIds(this.paths);
    for (const runId of this.runOrder) {
      const record = await readRecord(this.paths, runId);
      if (!record) continue;
      this.rememberRecord(record, this.records.size < MAX_CACHED_RECORDS);
      if (record.status !== "running" && record.status !== "stopping" && !record.notified) {
        this.notifier.add({ id: `notify-${runId}`, agentId: record.parentAgentId, text: this.notification(record) });
        record.notified = true;
        await new RunFiles(this.paths, runId).saveRecord(record);
      }
      // A clean shutdown records the run as interrupted but cannot wait for its children to be
      // archived; archive any that are still open.
      if (record.status === "interrupted" && record.endedAt && Date.now() - Date.parse(record.endedAt) < 24 * 60 * 60_000) {
        if (!record.notified) {
          this.notifier.add({ id: `notify-${runId}`, agentId: record.parentAgentId, text: this.notification(record) });
          record.notified = true;
          await new RunFiles(this.paths, runId).saveRecord(record);
        }
        void this.gate.wait().then(
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
        this.notifier.add({ id: `notify-${runId}`, agentId: record.parentAgentId, text: this.notification(record) });
      }
      this.rememberRecord(record, this.records.has(runId));
      void this.gate.wait().then(
        (paseo) => this.archiveLeftovers(paseo, record),
        () => undefined,
      );
    }
  }

  private async archiveLeftovers(paseo: PaseoApi, record: RunRecord): Promise<void> {
    await recoverChildren(paseo, record);
    await new RunFiles(this.paths, record.runId).saveRecord(record);
    this.rememberRecord(record, this.records.has(record.runId));
    this.notifier.replacePending(`notify-${record.runId}`, this.notification(record));
    await this.publishCard(record);
  }

  async launch(callerId: string, input: LaunchInput): Promise<string> {
    if (this.disposed) throw new ServiceError("not_ready", "The workflow plugin is stopping.");
    const paseo = await this.gate.wait(20_000);
    const caller = await paseo.agents.ref(callerId).refresh();
    if (!caller || caller.agent.archivedAt) throw new ServiceError("unknown_agent", `Agent ${callerId} was not found on this host.`);
    const agent = caller.agent;
    if (agent.labels?.[LABEL_RUN]) throw new ServiceError("recursive_workflow", "Workflow children cannot launch more workflow runs; use workflow() in the orchestration script.");
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
      if (error instanceof ScriptError) {
        const hint = source.kind === "name" ? "" : "\nRead the authoring reference first if you have not (workflow_reference, or the CLI's reference command), fix the script, and retry.";
        throw new ServiceError("invalid_script", `Invalid workflow script: ${error.message}${hint}`);
      }
      throw error;
    }

    let cache: ResumeCache | null = null;
    let resumedFrom: string | null = null;
    let args = input.args;
    let guidance = this.guidance(callerId);
    let inheritedGuidance = false;
    let droppedUltracode = false;
    if (input.resumeFromRunId) {
      const previous = input.resumeFromRunId.trim();
      if (!RUN_ID_PATTERN.test(previous)) throw new ServiceError("invalid_request", `resumeFromRunId "${previous}" is not a run id (wf_...).`);
      if (this.engines.has(previous)) {
        throw new ServiceError("still_running", `Workflow ${previous} is still running. Stop it first with workflow_stop({ runId: "${previous}" }), then resume.`);
      }
      const record = await readRecord(this.paths, previous);
      if (!record) throw new ServiceError("unknown_run", `No workflow run ${previous} on this host.`);
      this.requireOwner(record, callerId);
      if (!Object.prototype.hasOwnProperty.call(input, "args")) args = record.args;
      // Resume means the same plan: scripts that scale with `guidance` must see what the first run saw.
      // Turning Ultracode off is a request to spend less, so it wins over cache reuse.
      const turnedOff = record.guidance?.ultracode === true && guidance !== null && !guidance.ultracode;
      if (record.guidance && !turnedOff) {
        inheritedGuidance = guidance === null || guidance.ultracode !== record.guidance.ultracode || guidance.size !== record.guidance.size;
        guidance = { ultracode: record.guidance.ultracode, size: isWorkflowSize(record.guidance.size) ? record.guidance.size : "unrestricted" };
      }
      if (turnedOff) droppedUltracode = true;
      cache = await ResumeCache.load(runPaths(this.paths, previous));
      resumedFrom = previous;
    }

    const message = await this.latestUserMessage(paseo, callerId);
    const budgetTotal = message ? parseBudgetDirective(stripReminders(message.text)) : null;
    parent.userRequest = relayedRequest(message ? stripReminders(message.text) : null);
    if (this.disposed) throw new ServiceError("not_ready", "The workflow plugin stopped before this launch could start.");
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
      scriptPath: source.kind === "name" ? files.paths.script : (source.path ?? files.paths.script),
      sourcePath: source.path ?? undefined,
      args,
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
      ...(guidance ? { guidance } : {}),
      chain: this.chainIndex(callerId, message?.key ?? null),
      notified: false,
    };
    await files.create(source.script, record);
    if (this.disposed) {
      record.status = "interrupted";
      record.endedAt = nowIso();
      record.error = "The plugin stopped while the workflow launch was being persisted.";
      await files.saveRecord(record);
      throw new ServiceError("not_ready", record.error);
    }
    if (resumedFrom && cache) {
      record.logs.push({ at: nowIso(), message: `Resuming from ${resumedFrom}: ${cache.size} cached agent result(s) available` });
    }

    const settings = this.settings();
    const engine = new RunEngine({
      record,
      files,
      body: parsed.body,
      args,
      parent,
      cache,
      runner: this.runner,
      concurrency: concurrency(settings),
      maxAgents: settings.maxAgentsPerRun,
      agentTimeoutMs: settings.agentTimeoutMinutes * 60_000,
      archiveWhenDone: settings.archiveFinishedAgents,
      resolveWorkflow: (ref, current) => this.resolveNested(ref, current),
      onChange: (changed) => this.onChange(changed),
      onFinished: (finished) => {
        const work = this.onFinished(finished);
        this.finalizers.add(work);
        void work.finally(() => this.finalizers.delete(work)).catch((error) => log(`could not finalize ${finished.runId}: ${describeError(error)}`));
        return work;
      },
    });
    this.engines.set(runId, engine);
    this.rememberRecord(record);
    this.runOrder.unshift(runId);
    engine.start();
    void this.publishCard(record);

    const lines = [
      `Workflow launched in background. Run ID: ${runId}`,
      `Summary: ${parsed.meta.description.replace(/[\p{Cc}\p{Cf}\u2028\u2029<>]+/gu, " ").slice(0, 400)}`,
      ...(source.kind === "name" ? [`Named workflow "${input.name?.trim()}" resolved to ${source.path ?? "the built-in that ships with the plugin"}.`] : []),
      `Script file: ${record.scriptPath}`,
      `Run files: ${files.paths.dir} (script.js, run.json, journal.jsonl, result.json)`,
    ];
    if (resumedFrom && cache) lines.push(`Resuming from ${resumedFrom} with ${cache.size} cached agent result(s).`);
    if (budgetTotal !== null) lines.push(`Token budget from the user's message: ${budgetTotal} output tokens.`);
    const cli = `'${this.paths.cli.replaceAll("'", "'\\''")}'`;
    lines.push(`To iterate, edit the script file and launch again with workflow({ scriptPath: ${JSON.stringify(record.scriptPath)}, resumeFromRunId: "${runId}" }) (CLI: ${cli} run --script-path ${JSON.stringify(record.scriptPath)} --resume ${runId}). The longest unchanged prefix of agent() calls returns cached results, which can themselves be empty: read journal.jsonl before assuming there is something to recover. Resume inherits saved args unless you override them.`);
    lines.push("");
    lines.push("You will be notified with a <task-notification> message when it ends; end your turn now unless other work does not depend on it. The user watches it in the run card and the Dynamic workflows panel; workflow_status reports progress.");
    const current = this.guidance(callerId);
    if (current) lines.push(guidanceReminder(current));
    if (droppedUltracode) lines.push(`The user turned Ultracode off after ${resumedFrom}, so this resume runs without it; scripts that scale with \`guidance\` start fewer agents and their changed calls miss the cache.`);
    if (inheritedGuidance && guidance) lines.push(`This resume keeps the guidance of ${resumedFrom} (Ultracode ${guidance.ultracode ? "on" : "off"}, size ${guidance.size}) so its cached results stay valid; launch without resumeFromRunId to use the current setting.`);
    if ((record.chain ?? 1) >= CHAIN_CHECK_IN) lines.push(chainCheckIn(record.chain ?? 1));
    return lines.join("\n");
  }

  async stop(runId: string, by: { agentId?: string }): Promise<string> {
    const engine = this.engines.get(runId);
    if (!engine) {
      const record = await this.recordFor(runId);
      if (!record) throw new ServiceError("unknown_run", `No workflow run ${runId} on this host.`);
      if (by.agentId) this.requireOwner(record, by.agentId);
      return `Workflow ${runId} is not running (${record.status}).`;
    }
    if (by.agentId) this.requireOwner(engine.record, by.agentId);
    if (engine.record.status !== "running") return statusText(engine.record, this.paths);
    // Acknowledge the request before child cleanup, which can outlast the host RPC.
    void engine.stop(by.agentId ? "stopped by the launching agent" : "stopped by the user")
      .catch((error) => log(`could not stop ${runId}: ${describeError(error)}`));
    return statusText(engine.record, this.paths);
  }

  skip(runId: string, callId: string): boolean {
    return this.engines.get(runId)?.skip(callId) ?? false;
  }

  async status(callerId: string | null, runId: string | undefined, waitSeconds: number): Promise<string> {
    if (!callerId) throw new ServiceError("unknown_agent", "The calling agent must be identified.");
    if (!runId) {
      const runs = await this.list(callerId ?? undefined, 5);
      if (runs.length === 0) return "You have no workflow runs on this host.";
      return runs
        .map((run) => `${run.runId} "${run.name}": ${run.status}, ${run.agents.total} agents (${run.agents.running} running, ${run.agents.failed} failed), started ${run.startedAt}`)
        .join("\n");
    }
    const engine = this.engines.get(runId);
    if (engine && waitSeconds > 0) {
      await waitUpTo(engine.finished, waitSeconds * 1000);
    }
    const record = engine?.record ?? (await this.recordFor(runId));
    if (!record) throw new ServiceError("unknown_run", `No workflow run ${runId} on this host.`);
    this.requireOwner(record, callerId);
    return statusText(record, this.paths);
  }

  /**
   * Refreshes pending guidance while preserving receipt identity. Known failed deliveries may
   * be superseded; uncertain receipts require reconciliation and are never resent here.
   */
  async refreshNotifications(agentId?: string): Promise<void> {
    for (const id of this.notifier.pendingIds(agentId)) {
      if (!id.startsWith("notify-")) continue;
      const record = await this.recordFor(id.slice("notify-".length)).catch(() => null);
      if (record) this.notifier.replacePending(id, this.notification(record));
    }
  }

  private notification(record: RunRecord): string {
    return notificationText(record, this.paths, this.guidance(record.parentAgentId));
  }

  /** The reference for one caller: its current guidance, the shared text, and the workflows it can name. */
  async reference(callerId: string, guidance: ToolGuidance): Promise<string> {
    let cwd: string | null = null;
    try {
      const caller = await (await this.gate.wait(5_000)).agents.ref(callerId).refresh();
      cwd = caller?.agent.cwd ?? null;
    } catch {
      // Without the daemon the saved project workflows are unknown; built-ins still apply.
    }
    const dirs = cwd ? await workflowDirs(cwd) : [];
    const note = cwd ? undefined : "Saved workflows are not listed: the plugin could not reach Paseo to find your working directory. Built-ins are complete; retry for the saved ones.";
    const settings = this.settings();
    const limits = `> Your limits: ${concurrency(settings)} agents at once per run, at most ${settings.maxAgentsPerRun} agents per run.`;
    return [`${referenceStatus(guidance)}\n${limits}`, REFERENCE.trimEnd(), catalogText(await listWorkflows(dirs), this.paths.builtins, note)].join("\n\n") + "\n";
  }

  async list(agentId: string | undefined, limit: number): Promise<RunSummary[]> {
    const out: RunSummary[] = [];
    for (const runId of this.runOrder) {
      const live = this.engines.get(runId)?.record;
      const summary = live ? runSummary(live) : this.summaries.get(runId);
      if (!summary || (agentId && summary.parentAgentId !== agentId)) continue;
      out.push(summary);
      if (out.length >= limit) break;
    }
    return out;
  }

  async detail(runId: string): Promise<RunDetail | null> {
    const record = await this.recordFor(runId);
    return record ? runDetail(record, this.paths) : null;
  }

  /** History lists retain small summaries; full result previews have a bounded LRU. */
  private rememberRecord(record: RunRecord, cache = true): void {
    this.summaries.set(record.runId, runSummary(record));
    if (!cache) return;
    this.records.delete(record.runId);
    this.records.set(record.runId, record);
    while (this.records.size > MAX_CACHED_RECORDS) this.records.delete(this.records.keys().next().value!);
  }

  private async recordFor(runId: string): Promise<RunRecord | null> {
    const live = this.engines.get(runId)?.record;
    if (live) return live;
    const record = this.records.get(runId) ?? (await readRecord(this.paths, runId));
    if (record) this.rememberRecord(record);
    return record;
  }

  onAgentArchived(agentId: string): void {
    for (const engine of this.engines.values()) {
      if (engine.record.parentAgentId === agentId) void engine.stop("the launching agent was archived");
    }
    this.notifier.dropFor(agentId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.notifier.pause();
    const engines = [...this.engines.values()];
    for (const timer of [...this.cardTimers.values(), ...this.saveTimers.values()]) clearTimeout(timer);
    this.cardTimers.clear();
    this.saveTimers.clear();
    await Promise.all(engines.map((engine) => engine.interrupt().catch((error) => log(`interrupt ${engine.runId}: ${describeError(error)}`))));
    await Promise.allSettled([...this.finalizers]);
    await Promise.all(engines.map((engine) => engine.files.idle()));
    await this.notifier.dispose();
  }

  private onChange(engine: RunEngine): void {
    if (this.disposed) return;
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
    this.rememberRecord(record);
    this.engines.delete(record.runId);
    for (const timers of [this.saveTimers, this.cardTimers]) {
      const timer = timers.get(record.runId);
      if (timer) clearTimeout(timer);
      timers.delete(record.runId);
    }
    this.notifier.add({ id: `notify-${record.runId}`, agentId: record.parentAgentId, text: this.notification(record) });
    record.notified = true;
    await engine.files.saveRecord(record);
    await this.publishCard(record);
    log(`run ${record.runId} "${record.meta.name}" ${record.status}: ${record.calls.length} agents`);
  }

  private async publishCard(record: RunRecord): Promise<void> {
    if (this.disposed) return;
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
      this.cardFailures.delete(record.runId);
    } catch (error) {
      const failures = (this.cardFailures.get(record.runId) ?? 0) + 1;
      this.cardFailures.set(record.runId, failures);
      if (failures === 1) log(`could not update the run card of ${record.runId}: ${describeError(error)}`);
      if (failures <= 3 && !this.cardTimers.has(record.runId)) this.cardTimers.set(record.runId, unref(setTimeout(() => {
        this.cardTimers.delete(record.runId);
        void this.publishCard(record);
      }, failures * 2000)));
    }
  }

  private requireOwner(record: RunRecord, agentId: string): void {
    if (record.parentAgentId !== agentId) throw new ServiceError("forbidden", "This workflow belongs to another agent.");
  }

  /** The caller's latest message from the user (plugin notifications skipped), or null. */
  private async latestUserMessage(paseo: PaseoApi, agentId: string): Promise<{ text: string; key: string } | null> {
    try {
      const timeline = paseo.agents.ref(agentId).timeline;
      let page = await timeline.refetch({ direction: "tail", limit: 200, projection: "canonical" });
      for (;;) {
        const entries = page.entries;
        for (let index = entries.length - 1; index >= 0; index--) {
          const entry = entries[index];
          const item = entry?.item;
          if (item?.type === "user_message" && typeof item.text === "string") {
            if (item.text.startsWith(NOTIFICATION_MARKER)) continue;
            return { text: item.text, key: `${entry.timestamp}:${entry.seqStart}` };
          }
        }
        if (!page.hasOlder || !page.startCursor) break;
        const cursor = page.startCursor;
        page = await timeline.refetch({ direction: "before", cursor, limit: 200, projection: "canonical" });
        if (page.startCursor?.seq === cursor.seq && page.startCursor.epoch === cursor.epoch) break;
      }
    } catch (error) {
      log(`could not read the latest user message of ${agentId}: ${describeError(error)}`);
    }
    return null;
  }

  /** How many runs this agent has launched since the user's message `key`, this one included. */
  private chainIndex(agentId: string, key: string | null): number {
    if (!key) return 1;
    const previous = this.chains.get(agentId);
    const index = previous && previous.key === key ? previous.count + 1 : 1;
    this.chains.set(agentId, { key, count: index });
    return index;
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

  private async findNamed(name: string, cwd: string): Promise<NamedWorkflow> {
    if (!isWorkflowName(name)) {
      throw new ServiceError("invalid_request", `"${name}" is not a workflow name (letters, digits, dot, dash and underscore).`);
    }
    try {
      return await findNamedWorkflow(name, await workflowDirs(cwd));
    } catch (error) {
      if (error instanceof UnknownWorkflowError) throw new ServiceError("unknown_workflow", error.message);
      throw error;
    }
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

async function waitUpTo(done: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([done, new Promise<void>((resolveWait) => { timer = unref(setTimeout(resolveWait, ms)); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
