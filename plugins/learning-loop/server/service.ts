// Composition root of the daemon side: stores, the MCP bridge, lifecycle hooks, RPC handlers and
// the background work (session indexing, reviews, the curator).

import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { PLUGIN_VERSION, REVIEW_BINDING_PREFIX, UPDATE_KIND, UPDATE_VERSION } from "../shared/constants";
import {
  curatorRunRpc,
  learnRpc,
  ledgerListRpc,
  ledgerRollbackRpc,
  memoryListRpc,
  memoryWriteRpc,
  overviewRpc,
  pendingResolveRpc,
  rememberRpc,
  reviewRunRpc,
  reviewsListRpc,
  sessionsReadRpc,
  sessionsReindexRpc,
  sessionsSearchRpc,
  skillActionRpc,
  skillValidityRpc,
  skillPendingRpc,
  skillPendingResolveRpc,
  memoryValidityRpc,
  sessionsClearRpc,
  skillsListRpc,
  skillViewRpc,
  type Actor,
  type UpdateRow,
} from "../shared/contracts";
import { DEFAULT_PREFERENCES, preferences, type Preferences } from "../shared/settings";
import { ProviderFamilies, transformCreate, transformSessionOpen } from "./agent-setup";
import { BindingStore } from "./bindings";
import { Bridge } from "./bridge";
import { appendLine, describeError, readJson, writeJson } from "./files";
import { resolveRoute, routeErrorText } from "./kit/complete";
import { MemoryStore, type MemoryChange } from "./memory/store";
import { defaultStateDir, statePaths } from "./paths";
import { ProjectResolver, resolveProjectWithin } from "./project";
import { buildSystemBlock, learnPrompt } from "./prompts";
import { ReviewEngine, type ReviewAgent, type RunContext } from "./review/engine";
import { SessionIndex, type SessionMeta } from "./sessions/index";
import { SessionSync, type SyncSource, type TimelinePage } from "./sessions/sync";
import type { TimelineEntryLike } from "./sessions/transcript";
import { installShim } from "./shim";
import { shouldStage } from "./approval";
import { LearnedCatalog } from "./skills/catalog";
import { SkillLibrary } from "./skills/library";
import { callTool, TOOL_DEFINITIONS, TOOL_DEFINITIONS_V2, TOOL_DEFINITIONS_V3, bindingVersion, toolsForBinding, type CallContext, type ToolDeps } from "./tools";

type PaseoApi = PluginHookContext["paseo"];

const CURATOR_CHECK_MS = 6 * 3_600_000;
const CURATOR_INTERVAL_MS = 24 * 3_600_000;
const BACKFILL_DELAY_MS = 8_000;

/** Holds the PaseoApi captured from the first hook or RPC context (plugins get none at start). */
class Gate {
  private api: PaseoApi | null = null;
  private readonly waiters: Array<(api: PaseoApi) => void> = [];

  capture(api: PaseoApi | undefined): void {
    if (this.api || !api) return;
    this.api = api;
    for (const resolve of this.waiters.splice(0)) resolve(api);
  }

  get paseo(): PaseoApi | null {
    return this.api;
  }

  ready(): Promise<PaseoApi> {
    return this.api ? Promise.resolve(this.api) : new Promise((resolve) => this.waiters.push(resolve));
  }
}

function changeLine(change: MemoryChange): string {
  const store = change.target === "project" && change.project ? `project ${change.project.name}` : change.target;
  const verb = change.action === "add" ? "added" : change.action === "patch" ? "updated" : "removed";
  const text = change.text.length > 140 ? `${change.text.slice(0, 140)}…` : change.text;
  return `Memory (${store}) ${verb}: ${text}`;
}

export function contributeServer(server: PluginServerContext): () => Promise<void> {
  const paths = statePaths(defaultStateDir());
  const gate = new Gate();
  const abort = new AbortController();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let prefs: Preferences = { ...DEFAULT_PREFERENCES, injectPrompt: false, injectTools: false, indexSessions: false, review: { ...DEFAULT_PREFERENCES.review, enabled: false }, curator: { ...DEFAULT_PREFERENCES.curator, enabled: false } };

  const settings = server.registerSettings(preferences);
  const settingsReady = settings.read().then((state) => {
    if (state.status === "ready") prefs = state.values;
    else throw new Error("Learning settings are not ready; background work remains disabled.");
  });
  const unsubscribeSettings = settings.subscribe((state) => {
    if (state.status === "ready") prefs = state.values;
  });

  const memory = new MemoryStore(paths, () => ({ user: prefs.userCharLimit, memory: prefs.memoryCharLimit, project: prefs.projectCharLimit }));
  const skills = new SkillLibrary(paths);
  const catalog = new LearnedCatalog(paths.root, skills, () => prefs.exportCatalog);
  const projects = new ProjectResolver();
  const bindings = new BindingStore(paths.bindings);
  const families = new ProviderFamilies();
  const runs = new Map<string, RunContext>();
  let index: SessionIndex | null = null;
  try {
    mkdirSync(paths.root, { recursive: true });
    index = new SessionIndex(paths.sessionsDb);
  } catch (error) {
    console.error(`[learning-loop] session index unavailable: ${describeError(error)}`);
  }

  const capture = (context: { paseo: PaseoApi }) => gate.capture(context.paseo);

  const source: SyncSource = {
    async fetch(agentId, options) {
      const paseo = await gate.ready();
      const page = await paseo.agents.ref(agentId).timeline.refetch({
        direction: options.direction,
        ...(options.cursor ? { cursor: options.cursor } : {}),
        limit: options.limit,
        projection: "projected",
      });
      return page as unknown as TimelinePage;
    },
    async listAgents() {
      const paseo = await gate.ready();
      const out: SessionMeta[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await paseo.agents.list({ includeBackground: true, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const { agent } of result.entries) {
          if ((agent as { internal?: boolean }).internal) continue;
          out.push({
            agentId: agent.id,
            title: agent.title,
            provider: agent.provider,
            cwd: agent.cwd,
            createdAt: agent.createdAt,
            updatedAt: agent.updatedAt,
            archived: Boolean(agent.archivedAt),
            scopeKey: (await projects.resolve(agent.cwd)).key,
          });
        }
        if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
        cursor = result.pageInfo.nextCursor;
      }
      return out;
    },
  };
  const sync = index ? new SessionSync(index, source, () => prefs.indexSessions, () => prefs.sessionRetentionDays) : null;

  const review = new ReviewEngine({
    paths,
    settings: () => prefs,
    paseo: {
      config: {
        get: async () => (await gate.ready()).config.get() as Promise<{ config: { providers?: unknown } }>,
      },
    },
    async tail(agentId, limit) {
      const paseo = await gate.ready();
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit, projection: "projected" });
      return { epoch: page.epoch, entries: page.entries as unknown as TimelineEntryLike[] };
    },
    async appendRow(agentId, id, row: UpdateRow) {
      const paseo = await gate.ready();
      await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind: UPDATE_KIND, version: UPDATE_VERSION, data: row });
    },
    project: (cwd) => projects.resolve(cwd),
    runs,
    async currentState(project, run) {
      const stores = await Promise.all((["user", "memory", ...(project ? ["project"] : [])] as Array<"user" | "memory" | "project">).map(async target => [target + ":" + (target === "project" ? project!.key : "host"), (await memory.inspect(target, target === "project" ? project : null)).revision]));
      run.memoryRevisions = Object.fromEntries(stores);
      return `Memory (entries, source, validity and revisions):\n${await memory.reviewState(project)}\n\nSkills (name, revision, state; use skill_view before editing):\n${JSON.stringify(await Promise.all((await skills.list()).map(async s => ({ name: s.name, state: s.state, revision: await skills.revision(s.name) }))))}`;
    },
    async title(agentId) {
      const paseo = await gate.ready();
      return (await paseo.agents.ref(agentId).refresh())?.agent.title ?? null;
    },
  });

  const stage = (actor: Actor): boolean => shouldStage(prefs.writeApproval, actor);

  const memoryLog = join(paths.memoryDir, "log.jsonl");
  const toolDeps: ToolDeps = {
    memory,
    skills,
    get sessions() {
      return prefs.indexSessions ? index : null;
    },
    stage,
    resolveProjectPath: resolveProjectWithin,
    onMemoryChange(context, changes, staged) {
      const run = context.actor.runId ? runs.get(context.actor.runId) : undefined;
      for (const change of changes) {
        if (run) {
          run.changes.push(`${staged ? "Staged for approval — " : ""}${changeLine(change)}`);
          if (staged) run.staged += 1;
        }
        void appendLine(memoryLog, {
          at: new Date().toISOString(),
          actor: context.actor,
          staged,
          target: change.target,
          project: change.project?.key ?? null,
          action: change.action,
          text: change.text,
          ...(change.before ? { before: change.before } : {}),
        }).catch(() => undefined);
      }
    },
    onSkillChange(context, summaries, staged = false) {
      const run = context.actor.runId ? runs.get(context.actor.runId) : undefined;
      if (run) {
        run.changes.push(...summaries.map((s) => `${staged ? "Staged for approval — " : ""}Skill ${s}`));
        if (staged) run.staged += summaries.length;
      }
      void catalog.publish().catch(e => console.error(`[learning-loop] catalog: ${describeError(e)}`));
    },
  };

  async function callContext(headers: { binding: string | null; agentId: string | null; cwd: string | null }): Promise<CallContext> {
    const { binding } = headers;
    if (binding?.startsWith(REVIEW_BINDING_PREFIX)) {
      const runId = binding.slice(REVIEW_BINDING_PREFIX.length);
      const run = runs.get(runId);
      return {
        actor: { kind: run?.agentId === "curator" ? "curator" : "review", agentId: run?.agentId ?? null, title: run?.agentTitle ?? null, runId, ...(run?.evidence ? { evidence: run.evidence } : {}) },
        reader: binding,
        project: run?.project ?? null,
        selfAgentId: null,
        version: 2,
        memoryRevisions: run?.memoryRevisions,
      };
    }
    const bound = binding ? await bindings.get(binding) : null;
    const agentId = bound?.agentId ?? headers.agentId;
    const cwd = bound?.cwd ?? headers.cwd;
    const project = cwd ? await projects.resolve(cwd).catch(() => null) : null;
    return {
      actor: { kind: "agent", agentId: agentId ?? null, title: null, runId: null },
      reader: binding ?? (agentId ? `agent-${agentId}` : "anonymous"),
      project,
      selfAgentId: agentId ?? null,
      version: bindingVersion(binding),
    };
  }

  const bridge = new Bridge({
    tools: toolsForBinding,
    async call(name, args, headers) {
      try {
        return await callTool(name, args, await callContext(headers), toolDeps);
      } catch (error) {
        return { isError: true, text: JSON.stringify({ success: false, error: `learning-loop failed: ${describeError(error)}` }) };
      }
    },
  });

  const startup = (async () => {
    await settingsReady;
    await mkdir(paths.memoryDir, { recursive: true });
    await mkdir(paths.skillsDir, { recursive: true });
    await installShim(paths, TOOL_DEFINITIONS, undefined, TOOL_DEFINITIONS_V2, TOOL_DEFINITIONS_V3);
    if (abort.signal.aborted) return;
    await bridge.start(paths.socket);
    await catalog.publish();
    console.log(`[learning-loop] ${PLUGIN_VERSION} ready; state in ${paths.root}`);
  })().catch((error) => console.error(`[learning-loop] startup failed: ${describeError(error)}`));

  // ── Lifecycle hooks ──────────────────────────────────────────────────────────────────────────

  // Before hooks fail open: a throw here would make the daemon refuse to create the agent.
  server.before("agent.create", async ({ request }, context) => {
    capture(context);
    try {
      await startup;
      const family = await families.family(context.paseo as never, request.config.provider);
      return await transformCreate({
        request,
        family,
        settings: prefs,
        paths,
        block: async (tools) => {
          const project = await projects.resolve(request.config.cwd).catch(() => null);
          return buildSystemBlock({
            tools,
            memorySnapshot: await memory.snapshot(project),
            skillsIndex: tools ? await skills.index(prefs.skillsIndexLimit) : "",
          });
        },
      });
    } catch (error) {
      console.error(`[learning-loop] agent.create left unchanged: ${describeError(error)}`);
      return undefined;
    }
  });

  server.before("agent.session_open", async ({ request }, context) => {
    capture(context);
    try {
      return await transformSessionOpen(request, bindings);
    } catch (error) {
      console.error(`[learning-loop] agent.session_open left unchanged: ${describeError(error)}`);
      return undefined;
    }
  });

  server.on("agent.created", (_event, context) => capture(context));

  server.on("agent.turn_ended", (event, context) => {
    capture(context);
    const agent = event.agent;
    const meta: SessionMeta = {
      agentId: agent.id,
      title: agent.title,
      provider: agent.provider,
      cwd: agent.cwd,
      createdAt: null,
      updatedAt: new Date().toISOString(),
      archived: false,
    };
    if (sync) void projects.resolve(agent.cwd).then(project => sync.sync({ ...meta, scopeKey: project.key }));
    if (event.outcome.kind === "completed") {
      const reviewAgent: ReviewAgent = { id: agent.id, title: agent.title, provider: agent.provider, cwd: agent.cwd, parentAgentId: agent.parentAgentId };
      void settingsReady.then(() => review.onTurnEnded(reviewAgent)).catch((error) => console.error(`[learning-loop] review counter for ${agent.id}: ${describeError(error)}`));
    }
  });

  // Lifecycle handlers have 30 s; indexing a long timeline can take longer, so it runs in the background.
  server.on("agent.archived", (event, context) => {
    capture(context);
    const agent = event.agent;
    const work = (async () => {
      if (sync && index) {
        await sync.sync({ agentId: agent.id, title: agent.title, provider: agent.provider, cwd: agent.cwd, createdAt: null, updatedAt: event.archivedAt, archived: true, scopeKey: (await projects.resolve(agent.cwd)).key });
        index.markArchived(agent.id);
      }
      skills.forgetReader(`agent-${agent.id}`);
      await review.onArchived({ id: agent.id, title: agent.title, provider: agent.provider, cwd: agent.cwd, parentAgentId: agent.parentAgentId });
    })();
    void work.catch((error) => console.error(`[learning-loop] archive of ${agent.id}: ${describeError(error)}`));
  });

  // ── RPC ──────────────────────────────────────────────────────────────────────────────────────

  const user: Actor = { kind: "user", agentId: null, title: null, runId: null };

  server.handle(overviewRpc, async (_input, context) => {
    capture(context);
    const views = await memory.views();
    const list = await skills.list();
    const history = await review.history(200);
    const route = await resolveRoute(context.paseo as never, prefs.review.provider);
    const stats = index?.stats() ?? { sessions: 0, messages: 0 };
    return {
      stateDir: paths.root,
      memory: views.map((v) => ({ label: v.label, used: v.used, limit: v.limit, entries: v.entries.length })),
      pending: (await memory.pending()).length + (await skills.pending()).length,
      skills: {
        active: list.filter((s) => s.state === "active").length,
        stale: list.filter((s) => s.state === "stale").length,
        archived: list.filter((s) => s.state === "archived").length,
      },
      sessions: { ...stats, lastSyncAt: sync?.lastSyncAt ?? null },
      reviews: { total: history.filter((r) => r.status !== "running").length, lastAt: history.find((r) => r.endedAt)?.endedAt ?? null, running: review.runningRuns().length, queued: review.queuedCount() },
      route: route.ok ? { ok: true, providerId: prefs.review.provider, detail: `${route.label} · ${prefs.review.model}` } : { ok: false, providerId: prefs.review.provider, detail: routeErrorText(route.error) },
      boundAgents: await bindings.count(),
      budget: await review.budgetStatus(),
    };
  });

  server.handle(memoryListRpc, async (_input, context) => {
    capture(context);
    return { stores: await memory.views(), pending: await memory.pending() };
  });

  server.handle(memoryWriteRpc, async (input, context) => {
    capture(context);
    const project = input.target === "project" && input.projectKey ? await memory.project(input.projectKey) : null;
    const { result, changes } = await memory.write(input.target, project, input.operations, { actor: user, stage: false });
    if (changes.length > 0) toolDeps.onMemoryChange({ actor: user, reader: "user", project, selfAgentId: null }, changes, false);
    return { ok: result.success, message: result.success ? (result.message ?? "Saved.") : (result.error ?? "Failed.") };
  });

  server.handle(pendingResolveRpc, async (input, context) => {
    capture(context);
    const outcome = await memory.resolvePending(input.id, input.approve);
    if (outcome.changes.length > 0) toolDeps.onMemoryChange({ actor: user, reader: "user", project: null, selfAgentId: null }, outcome.changes, false);
    return { ok: outcome.ok, message: outcome.message };
  });

  server.handle(rememberRpc, async (input, context) => {
    capture(context);
    const project = input.target === "project" && input.cwd ? await projects.resolve(input.cwd).catch(() => null) : null;
    const actor: Actor = { ...user, agentId: input.agentId };
    const { result, changes } = await memory.write(input.target, project, [{ action: "add", content: input.text }], { actor, stage: false });
    if (changes.length > 0) toolDeps.onMemoryChange({ actor, reader: "user", project, selfAgentId: null }, changes, false);
    if (!result.success) return { ok: false, message: result.error ?? "Could not save." };
    const where = input.target === "project" ? `project memory (${project?.name ?? "?"})` : input.target === "user" ? "the user profile" : "memory";
    const message = result.message ?? `Saved to ${where}. New agents will see it.`;
    if (input.agentId) {
      const row: UpdateRow = { runId: `remember-${Date.now()}`, status: changes.length ? "updated" : "nothing", trigger: "remember", actions: changes.map(changeLine), model: null, costUsd: null, note: changes.length ? null : message };
      await context.paseo.agents.ref(input.agentId).timeline.append({ type: "plugin", id: row.runId, kind: UPDATE_KIND, version: UPDATE_VERSION, data: row }).catch(() => undefined);
    }
    return { ok: true, message };
  });

  server.handle(memoryValidityRpc, async (input, context) => {
    capture(context);
    const project = input.projectKey ? await memory.project(input.projectKey) : null;
    return memory.setValidity(input.target, project, input.id, input.revision, input.state, input.reviewDue);
  });

  server.handle(skillPendingRpc, async (_input, context) => {
    capture(context);
    return { proposals: await skills.pending() };
  });
  server.handle(skillPendingResolveRpc, async (input, context) => {
    capture(context);
    const result = await skills.resolvePending(input.id, input.approve);
    await catalog.publish();
    return result;
  });

  server.handle(skillsListRpc, async (input, context) => {
    capture(context);
    return { skills: await skills.list(input.includeArchived) };
  });

  server.handle(skillViewRpc, async (input, context) => {
    capture(context);
    const result = await skills.view(input.name, input.filePath, null);
    if (!result.success) throw new Error(result.error ?? "Could not load the skill.");
    return { name: input.name, filePath: result.file_path ?? null, content: result.content ?? "", files: result.files ?? [] };
  });

  server.handle(skillValidityRpc, async (input, context) => {
    capture(context);
    const result = await skills.setValidity(input.name, input.revision, input.validity, input.reviewDue);
    await catalog.publish();
    return result;
  });

  server.handle(skillActionRpc, async (input, context) => {
    capture(context);
    const result = await skills.setState(input.name, input.action, user);
    await catalog.publish();
    return result;
  });

  server.handle(ledgerListRpc, async (input, context) => {
    capture(context);
    return { entries: await skills.ledger(input.skill, input.limit) };
  });

  server.handle(ledgerRollbackRpc, async (input, context) => {
    capture(context);
    const result = await skills.rollback(input.id, user);
    await catalog.publish();
    return result;
  });

  server.handle(sessionsSearchRpc, async (input, context) => {
    capture(context);
    if (!index) return { hits: [], recent: [] };
    const scopeKey = input.scopePath ? (await projects.resolve(input.scopePath)).key : null;
    const query = input.query.trim();
    if (!query) return { hits: [], recent: index.recent(30, [], scopeKey) };
    return { hits: index.search(query, { limit: input.limit, sort: input.sort, scopeKey }), recent: [] };
  });

  server.handle(sessionsReadRpc, async (input, context) => {
    capture(context);
    if (!index) return { session: null, messages: [] };
    return { session: index.session(input.agentId), messages: index.window(input.agentId, input.aroundSeq, input.window) };
  });

  server.handle(sessionsClearRpc, async (_input, context) => {
    capture(context);
    if (prefs.indexSessions) return { ok: false, message: "Turn off session indexing first, then clear the indexed copies. Source conversations are never deleted." };
    sync?.clear();
    return { ok: true, message: "Indexed copies deleted. Source conversations remain in Paseo." };
  });

  server.handle(sessionsReindexRpc, async (_input, context) => {
    capture(context);
    if (!sync) return { ok: false, message: "The session index could not be opened on this daemon." };
    if (!prefs.indexSessions) return { ok: false, message: "Session indexing is turned off in settings." };
    void sync.backfill(abort.signal);
    return { ok: true, message: "Indexing every agent's conversation in the background." };
  });

  server.handle(reviewsListRpc, async (input, context) => {
    capture(context);
    return { runs: await review.history(input.limit) };
  });

  server.handle(reviewRunRpc, async (input, context) => {
    capture(context);
    const refreshed = await context.paseo.agents.ref(input.agentId).refresh();
    if (!refreshed) return { ok: false, message: "That agent was not found." };
    const agent = refreshed.agent;
    return review.runNow({ id: agent.id, title: agent.title, provider: agent.provider, cwd: agent.cwd, parentAgentId: null });
  });

  server.handle(learnRpc, async (input, context) => {
    capture(context);
    await context.paseo.agents.ref(input.agentId).send(learnPrompt(input.request));
    return { ok: true, message: "Sent the /learn request to the agent." };
  });

  server.handle(curatorRunRpc, async (input, context) => {
    capture(context);
    if (input.consolidate) {
      void review.consolidate();
      return { ok: true, message: "Consolidation started in the background; see Activity." };
    }
    const changes = await skills.curate(prefs.curator.staleAfterDays, prefs.curator.archiveAfterDays, stage({ kind: "curator", agentId: null, title: null, runId: null }));
    await catalog.publish();
    await writeJson(join(paths.root, "curator.json"), { lastRunAt: new Date().toISOString() });
    return { ok: true, message: changes.length ? changes.join("; ") : "Nothing to change: every agent-written skill was used recently." };
  });

  // ── Background work ──────────────────────────────────────────────────────────────────────────

  void gate.ready().then(() => {
    if (abort.signal.aborted) return;
    const timer = setTimeout(() => {
      if (sync && prefs.indexSessions) void sync.backfill(abort.signal);
    }, BACKFILL_DELAY_MS);
    timers.push(timer);
  });

  const curatorTick = async () => {
    await settingsReady;
    if (!prefs.curator.enabled) return;
    const file = join(paths.root, "curator.json");
    const state = await readJson(file, { lastRunAt: null as string | null }, (v) => ({ lastRunAt: typeof (v as { lastRunAt?: unknown })?.lastRunAt === "string" ? ((v as { lastRunAt: string }).lastRunAt) : null }));
    // First observation defers the first pass by a full interval (Hermes curator first-run behavior).
    if (!state.lastRunAt) return writeJson(file, { lastRunAt: new Date().toISOString() });
    if (Date.now() - Date.parse(state.lastRunAt) < CURATOR_INTERVAL_MS) return;
    const changes = await skills.curate(prefs.curator.staleAfterDays, prefs.curator.archiveAfterDays, stage({ kind: "curator", agentId: null, title: null, runId: null }));
    await catalog.publish();
    await writeJson(file, { lastRunAt: new Date().toISOString() });
    if (changes.length) console.log(`[learning-loop] curator: ${changes.join("; ")}`);
  };
  const catalogTimer = setInterval(() => void catalog.publish().catch(e => console.error(`[learning-loop] catalog: ${describeError(e)}`)), 15_000);
  timers.push(catalogTimer);
  const retentionTimer = setInterval(() => { if (prefs.indexSessions) index?.prune(prefs.sessionRetentionDays); }, 3_600_000);
  timers.push(retentionTimer);
  const curatorTimer = setInterval(() => void curatorTick().catch((e) => console.error(`[learning-loop] curator: ${describeError(e)}`)), CURATOR_CHECK_MS);
  timers.push(curatorTimer);
  void startup.then(() => curatorTick()).catch(() => undefined);

  return async () => {
    abort.abort();
    review.stop();
    unsubscribeSettings();
    for (const timer of timers) clearTimeout(timer);
    clearInterval(curatorTimer);
    await startup;
    await bridge.stop();
    await sync?.stop();
    index?.close();
  };
}
