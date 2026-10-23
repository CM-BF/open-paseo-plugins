import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPermissionRequest, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { LABEL_ROLE, MCP_SERVER, PLUGIN_VERSION } from "../shared/ids";
import { briefSlot, isActiveTime, nextBriefAt, nextCheckinAt, type ScheduleConfig } from "../shared/schedule";
import { dateKey, formatLocal, systemTimeZone } from "../shared/time";
import { ConfigSchema, type Alert, type Config, type Followup, type Overview, type Planned, type WaitingAgent } from "../shared/types";
import { encodeUpdate, isUpdateText, decodeUpdate } from "../shared/update";
import { describeRepeat, nextOccurrence, parseRepeat, parseWhen } from "../shared/when";
import { PaseoAccess, type PaseoApi } from "./access";
import { deliveryDecision, extractReport, mergeReport, type Report } from "./alerts";
import { waitingAgents } from "./digest";
import { McpRelay, type McpCaller } from "./mcp";
import { resolveHome, type StatePaths } from "./paths";
import { decideCheckinPermission } from "./policy";
import { DEFAULT_MEMORY, DEFAULT_WATCHLIST, MEMORY_FILE, WATCHLIST_FILE } from "../shared/defaults";
import { alertBody, assistantSystemPrompt, briefBody, checkinPrompt, checkinSystemPrompt, mcpInstructions, reminderBody, welcomeBody } from "./prompts";
import { archiveQuietly, runCheckinAgent, supportsToolGrants } from "./runner";
import { ActivityLog, Store, type InFlight, type OutboxEntry } from "./store";
import { buildTools } from "./tools";
import { Outbox } from "./outbox";
import { describeError, log, shortId, truncate, unref } from "./util";

const TICK_MS = 30_000;
const CHECKIN_TIMEOUT_MS = 10 * 60_000;
const MAX_ACTIVE_FOLLOWUPS = 50;
const DEFAULT_SNOOZE = "in 3h";

export class ServiceError extends Error {}

export interface ServiceOptions {
  paths: StatePaths;
  paseoHome: string;
  now?: () => number;
}

export interface SetupInput {
  name: string;
  language: string;
  home: string;
  chatModel: string;
  chatMode: string;
  checkinModel: string;
  watchlist?: string;
}

export interface FollowupInput {
  title: string;
  prompt: string;
  when?: string;
  repeat?: string;
  until?: string;
  mode: Followup["mode"];
}

export interface ScheduleChanges {
  checkinEveryMinutes?: number;
  checkinsEnabled?: boolean;
  briefTime?: string;
  briefEnabled?: boolean;
  activeHours?: { start: string; end: string };
  messagesPerDay?: number;
}

export class AideService {
  readonly store: Store;
  readonly activity: ActivityLog;
  readonly access: PaseoAccess;
  readonly relay: McpRelay;
  readonly outbox: Outbox;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private ticking = false;
  private readonly abort = new AbortController();
  private running: Promise<void> | null = null;
  private readonly reports = new Map<string, Report>();
  private started: Promise<void> | null = null;
  private startError: string | null = null;

  constructor(private readonly options: ServiceOptions) {
    this.store = new Store(options.paths);
    this.activity = new ActivityLog(options.paths.activity);
    this.access = new PaseoAccess(options.paseoHome);
    this.relay = new McpRelay({
      secret: () => this.store.state.secret,
      port: () => this.store.state.port,
      savePort: (port) => {
        this.store.state.port = port;
        this.store.save();
      },
      tools: buildTools(this),
      authorize: (caller) => this.authorize(caller),
      instructions: mcpInstructions,
    });
    this.outbox = new Outbox({
      store: this.store,
      access: this.access,
      onDelivered: (entry) => this.onDelivered(entry),
      onDropped: (entry, reason) => this.activity.add({ kind: "delivery", title: `Did not send: ${entryTitle(entry)}`, detail: `Not delivered because ${reason}.`, outcome: "failed" }),
      onAssistantGone: () => this.markDetached("The assistant chat is no longer available."),
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      try {
        await mkdir(this.options.paths.root, { recursive: true, mode: 0o700 });
        await this.store.load();
        await this.activity.load();
        await this.relay.start();
        this.timer = unref(setInterval(() => void this.tick(), TICK_MS));
        unref(setTimeout(() => void this.tick(), 3000));
        log(`ready (state ${this.options.paths.root}, tools on port ${this.relay.port})`);
      } catch (error) {
        this.startError = describeError(error);
        log(`startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
    })();
    return this.started;
  }

  async ready(): Promise<void> {
    await this.start();
    if (this.startError) throw new ServiceError(`Aide could not start: ${this.startError}`);
    if (this.stopping) throw new ServiceError("Aide is stopping.");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    await this.started;
    await Promise.race([this.running ?? Promise.resolve(), new Promise((resolve) => unref(setTimeout(resolve, 8000)))]);
    await this.outbox.dispose();
    await this.relay.close();
    await this.store.idle();
    await this.activity.idle();
    await this.access.dispose();
  }

  // ---------------------------------------------------------------- configuration

  config(): Config {
    return this.store.state.config;
  }

  timezone(): string {
    return this.config().timezone || systemTimeZone();
  }

  schedule(): ScheduleConfig {
    const config = this.config();
    return { timezone: this.timezone(), checkins: config.checkins, brief: config.brief, activeHours: config.activeHours };
  }

  paused(now = this.now()): boolean {
    const until = this.config().pausedUntil;
    if (!until) return false;
    if (until === "always") return true;
    return now < Date.parse(until);
  }

  /** From the settings screen: the chat's identity and the pause are not its to change. */
  saveConfig(next: Config): Config {
    const current = this.config();
    const config = ConfigSchema.parse({ ...next, name: current.name, chatModel: current.chatModel, chatMode: current.chatMode, pausedUntil: current.pausedUntil });
    this.store.state.config = config;
    this.store.save();
    this.activity.add({ kind: "schedule", title: "Settings changed", detail: scheduleSummary(config, this.timezone()) });
    return config;
  }

  updateSchedule(changes: ScheduleChanges): string {
    const current = this.config();
    const next = ConfigSchema.parse({
      ...current,
      checkins: {
        ...current.checkins,
        ...(changes.checkinEveryMinutes !== undefined ? { everyMinutes: changes.checkinEveryMinutes } : {}),
        ...(changes.checkinsEnabled !== undefined ? { enabled: changes.checkinsEnabled } : {}),
      },
      brief: {
        ...current.brief,
        ...(changes.briefTime !== undefined ? { time: changes.briefTime } : {}),
        ...(changes.briefEnabled !== undefined ? { enabled: changes.briefEnabled } : {}),
      },
      ...(changes.activeHours ? { activeHours: changes.activeHours } : {}),
      ...(changes.messagesPerDay !== undefined ? { messagesPerDay: changes.messagesPerDay } : {}),
    });
    this.store.state.config = next;
    this.store.save();
    const summary = scheduleSummary(next, this.timezone());
    this.activity.add({ kind: "schedule", title: "Schedule changed", detail: summary });
    return `Saved. ${summary}`;
  }

  pause(until: string | null): { pausedUntil: string | null; message: string } {
    const now = this.now();
    let value: string | null = null;
    if (until !== null) value = until.trim().toLowerCase() === "always" ? "always" : new Date(parseWhen(until, now, this.timezone())).toISOString();
    if (value && value !== "always" && Date.parse(value) <= now) throw new ServiceError("That time has already passed.");
    this.store.state.config = { ...this.config(), pausedUntil: value };
    this.store.save();
    const message = value === null ? "Resumed: check-ins and the morning brief run again." : value === "always" ? "Paused until you resume. Reminders you asked for still fire." : `Paused until ${formatLocal(Date.parse(value), this.timezone(), now)}. Reminders you asked for still fire.`;
    this.activity.add({ kind: "schedule", title: value === null ? "Resumed" : "Paused", detail: message });
    return { pausedUntil: value, message };
  }

  // ---------------------------------------------------------------- setup

  async setup(input: SetupInput, paseo: PaseoApi): Promise<{ agentId: string; workspaceId: string | null; home: string }> {
    await this.ready();
    const state = this.store.state;
    if (state.assistant && !state.assistant.archivedAt) throw new ServiceError(`Aide is already set up (agent ${state.assistant.agentId}).`);
    if (!/^[^/\s]+\/\S+$/.test(input.chatModel) || !/^[^/\s]+\/\S+$/.test(input.checkinModel)) throw new ServiceError("Choose models as provider/model.");
    const home = resolveHome(input.home);
    await mkdir(home, { recursive: true });
    await writeIfMissing(join(home, WATCHLIST_FILE), input.watchlist?.trim() ? `${input.watchlist.trim()}\n` : DEFAULT_WATCHLIST);
    await writeIfMissing(join(home, MEMORY_FILE), DEFAULT_MEMORY);
    const config = ConfigSchema.parse({ ...this.config(), name: input.name, language: input.language, chatModel: input.chatModel, chatMode: input.chatMode, checkinModel: input.checkinModel });
    state.config = config;
    this.store.save();

    const agentId = randomUUID();
    const mcp = await this.relay.serverFor({ role: "assistant", agentId, runId: null });
    const workspace = await paseo.workspaces.open(home);
    const schedule = this.schedule();
    const welcome = encodeUpdate({ v: 1, kind: "welcome", title: `${config.name} is set up`, at: new Date(this.now()).toISOString() }, welcomeBody(config, schedule));
    const handle = await workspace.agents.create({
      agentId,
      title: config.name,
      labels: { [LABEL_ROLE]: "assistant" },
      config: {
        provider: config.chatModel,
        ...(config.chatMode ? { modeId: config.chatMode } : {}),
        systemPrompt: assistantSystemPrompt(config, schedule, home),
        mcpServers: { [MCP_SERVER]: mcp },
        ...(supportsToolGrants(config.chatModel) ? { toolPolicy: { preapproved: this.relay.grants("assistant") } } : {}),
      },
      prompt: welcome,
    });
    state.assistant = { agentId: handle.id, workspaceId: handle.workspaceId ?? workspace.id ?? null, home, createdAt: new Date(this.now()).toISOString(), archivedAt: null };
    state.lastCheckinAt = null;
    state.quietStreak = 0;
    state.unanswered = 0;
    // A brief due right now would arrive on top of the welcome; start with tomorrow's.
    const slot = briefSlot(this.now(), schedule, null);
    if (slot && this.now() >= slot.at) state.lastBriefDay = slot.day;
    this.store.save();
    this.activity.add({ kind: "setup", title: `Set up ${config.name}`, detail: `Chat ${config.chatModel}, check-ins ${config.checkinModel}, folder ${home}.`, agentId: handle.id });
    return { agentId: handle.id, workspaceId: state.assistant.workspaceId, home };
  }

  private markDetached(reason: string): void {
    const assistant = this.store.state.assistant;
    if (!assistant || assistant.archivedAt) return;
    assistant.archivedAt = new Date(this.now()).toISOString();
    this.store.state.outbox = [];
    this.store.save();
    this.activity.add({ kind: "setup", title: "Stopped: the chat was archived", detail: `${reason} Set Aide up again to continue; your folder, memory and watch list are kept.`, agentId: assistant.agentId });
  }

  private assistantActive(): boolean {
    const assistant = this.store.state.assistant;
    return Boolean(assistant && !assistant.archivedAt);
  }

  // ---------------------------------------------------------------- scheduler

  private async tick(): Promise<void> {
    if (this.stopping || this.ticking || !this.assistantActive()) return;
    this.ticking = true;
    try {
      const now = this.now();
      this.rollDay(now);
      await this.recoverInFlight();
      this.wakeSnoozed(now);
      this.fireDueFollowups(now);
      await this.maybeBrief(now);
      this.maybeCheckin(now);
      this.outbox.kick();
    } catch (error) {
      log(`tick: ${describeError(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private rollDay(now: number): void {
    const state = this.store.state;
    const day = dateKey(now, this.timezone());
    if (state.day === day) return;
    state.day = day;
    state.checkinsToday = 0;
    state.messagesToday = 0;
    this.store.save();
  }

  /** A check-in left running by a previous plugin process: stop its agent and record it. */
  private async recoverInFlight(): Promise<void> {
    const state = this.store.state;
    const inFlight = state.inFlight;
    if (!inFlight || this.running) return;
    state.inFlight = null;
    this.store.save();
    if (inFlight.agentId) {
      const paseo = await this.access.get().catch(() => null);
      if (paseo) await archiveQuietly(paseo, inFlight.agentId);
    }
    this.activity.add({ kind: "checkin", title: "Check-in interrupted", detail: "The plugin restarted while it ran; the next one runs on schedule.", outcome: "failed", runId: inFlight.runId, ...(inFlight.agentId ? { agentId: inFlight.agentId } : {}) });
  }

  private wakeSnoozed(now: number): void {
    const state = this.store.state;
    if (!isActiveTime(now, this.schedule())) return;
    const woken = state.alerts.filter((alert) => alert.status === "snoozed" && alert.snoozedUntil && Date.parse(alert.snoozedUntil) <= now);
    if (woken.length === 0) return;
    const at = new Date(now).toISOString();
    for (const alert of woken) Object.assign(alert, { status: "open", snoozedUntil: null, updatedAt: at, delivered: false });
    this.store.save();
    this.deliverAlerts(woken, { runId: null, counts: false, title: woken.length === 1 ? `Back on: ${woken[0]!.title}` : `${woken.length} things you snoozed` });
    this.activity.add({ kind: "feedback", title: woken.length === 1 ? `Snooze ended: ${woken[0]!.title}` : `${woken.length} snoozes ended`, outcome: "alerted", alertIds: woken.map((alert) => alert.id) });
  }

  private fireDueFollowups(now: number): void {
    const state = this.store.state;
    const timezone = this.timezone();
    let changed = false;
    for (const followup of state.followups) {
      if (followup.status !== "active" || Date.parse(followup.dueAt) > now) continue;
      if (followup.until && Date.parse(followup.until) < now) {
        followup.status = "done";
        changed = true;
        continue;
      }
      if (followup.mode === "remind") {
        this.outbox.add({
          id: `remind-${followup.id}-${followup.fired + 1}`,
          kind: "reminder",
          text: encodeUpdate({ v: 1, kind: "reminder", title: followup.title, at: new Date(now).toISOString(), followupId: followup.id }, reminderBody(followup, timezone, now)),
          counts: false,
          alertIds: [],
        });
        this.advance(followup, now);
        changed = true;
        continue;
      }
      // A background look waits for active hours, the end of a pause, and a free slot.
      if (this.paused(now) || !isActiveTime(now, this.schedule()) || this.running) continue;
      const started = this.startCheckin({ reason: "followup", followup, focus: `Follow-up "${followup.title}": ${followup.prompt}` });
      if (started.started) {
        this.advance(followup, now);
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  private advance(followup: Followup, now: number): void {
    followup.fired++;
    followup.lastFiredAt = new Date(now).toISOString();
    if (!followup.repeat) {
      followup.status = "done";
      return;
    }
    // Missed occurrences collapse: the next one is after now, not after the missed due time.
    const next = nextOccurrence(followup.repeat, Math.max(now, Date.parse(followup.dueAt)), this.timezone());
    if (followup.until && next > Date.parse(followup.until)) followup.status = "done";
    else followup.dueAt = new Date(next).toISOString();
  }

  private async maybeBrief(now: number): Promise<void> {
    if (this.paused(now)) return;
    const state = this.store.state;
    const slot = briefSlot(now, this.schedule(), state.lastBriefDay);
    if (!slot) return;
    if (slot.missed) {
      state.lastBriefDay = slot.day;
      this.store.save();
      this.activity.add({ kind: "brief", title: "Skipped the morning brief", detail: "Paseo was not running at brief time; the next one is tomorrow.", outcome: "skipped" });
      return;
    }
    if (slot.due) await this.queueBrief(slot.day);
  }

  /** Queues the brief for `day` (a scheduled brief) or an extra one now (day null). */
  async queueBrief(day: string | null): Promise<{ queued: boolean; message: string }> {
    const state = this.store.state;
    if (!this.assistantActive()) return { queued: false, message: "Set Aide up first." };
    const now = this.now();
    if (day) {
      // Claim the day before the first await, so a second tick cannot queue it again.
      state.lastBriefDay = day;
      this.store.save();
    }
    const id = day ? `brief-${day}` : shortId("brief");
    if (this.outbox.pending.some((entry) => entry.kind === "brief")) return { queued: false, message: "A brief is already waiting for the chat to be free." };
    const paseo = await this.access.get().catch(() => null);
    const waiting = paseo ? await waitingAgents(paseo).catch(() => null) : null;
    const timezone = this.timezone();
    const todayKey = dateKey(now, timezone);
    const today = state.followups.filter((followup) => followup.status === "active" && dateKey(Date.parse(followup.dueAt), timezone) === todayKey);
    const body = briefBody({ now, config: this.config(), schedule: this.schedule(), alerts: state.alerts, waiting, today });
    const added = this.outbox.add({ id, kind: "brief", text: encodeUpdate({ v: 1, kind: "brief", title: day ? "Morning brief" : "Brief", at: new Date(now).toISOString() }, body), counts: false, alertIds: [] });
    return added ? { queued: true, message: "The brief is on its way to the chat." } : { queued: false, message: "That brief was already sent." };
  }

  private maybeCheckin(now: number): void {
    const state = this.store.state;
    const assistant = state.assistant;
    if (!assistant || this.running || state.inFlight || this.paused(now)) return;
    const schedule = this.schedule();
    const next = nextCheckinAt({ config: schedule, lastStartedAt: state.lastCheckinAt ? Date.parse(state.lastCheckinAt) : null, setupAt: Date.parse(assistant.createdAt), quietStreak: state.quietStreak });
    if (next === null || next > now || !isActiveTime(now, schedule)) return;
    if (state.checkinsToday >= schedule.checkins.maxPerDay) return;
    this.startCheckin({ reason: "scheduled" });
  }

  // ---------------------------------------------------------------- check-ins

  checkNow(focus?: string): { started: boolean; message: string } {
    if (!this.assistantActive()) return { started: false, message: "Set Aide up first." };
    return this.startCheckin({ reason: "manual", focus: focus?.trim() || null });
  }

  private startCheckin(options: { reason: InFlight["reason"]; followup?: Followup; focus?: string | null }): { started: boolean; message: string } {
    const state = this.store.state;
    const assistant = state.assistant;
    if (!assistant || assistant.archivedAt) return { started: false, message: "Set Aide up first." };
    if (this.running || state.inFlight) return { started: false, message: "A check-in is already running." };
    const now = this.now();
    const runId = shortId("ck");
    const agentId = randomUUID();
    const inFlight: InFlight = { runId, agentId, startedAt: new Date(now).toISOString(), reason: options.reason, followupId: options.followup?.id ?? null };
    state.inFlight = inFlight;
    if (options.reason !== "followup") {
      state.lastCheckinAt = inFlight.startedAt;
      state.checkinsToday++;
    }
    this.store.save();
    this.running = this.executeCheckin(inFlight, options.focus ?? null, options.followup ?? null)
      .catch((error) => log(`check-in ${runId}: ${describeError(error)}`))
      .finally(() => {
        this.running = null;
        // Something may have been waiting for the slot (a follow-up, the next tick's check-in).
        if (!this.stopping) unref(setTimeout(() => void this.tick(), 1000));
      });
    return { started: true, message: "Started a background check-in." };
  }

  private async executeCheckin(inFlight: InFlight, focus: string | null, followup: Followup | null): Promise<void> {
    const state = this.store.state;
    const assistant = state.assistant!;
    const config = this.config();
    let error: string | null = null;
    let lastMessage: string | null = null;
    let paseo: PaseoApi | null = null;
    try {
      paseo = await this.access.get();
      const prompt = checkinPrompt(await this.checkinContext(paseo, inFlight.reason, focus));
      const result = await runCheckinAgent({
        paseo,
        agentId: inFlight.agentId!,
        runId: inFlight.runId,
        cwd: assistant.home,
        parentId: assistant.agentId,
        title: followup ? `${config.name} · ${truncate(followup.title, 40)}` : `${config.name} · check-in`,
        provider: config.checkinModel,
        systemPrompt: checkinSystemPrompt(config),
        prompt,
        mcp: await this.relay.serverFor({ role: "checkin", agentId: inFlight.agentId!, runId: inFlight.runId }),
        grants: this.relay.grants("checkin"),
        timeoutMs: CHECKIN_TIMEOUT_MS,
        signal: this.abort.signal,
        decide: (request) => decideCheckinPermission(request),
      });
      lastMessage = result.lastMessage;
      if (result.status === "error") error = result.error ?? "the check-in agent failed";
    } catch (caught) {
      error = describeError(caught);
    } finally {
      if (paseo && inFlight.agentId) await archiveQuietly(paseo, inFlight.agentId);
    }
    const report = this.reports.get(inFlight.runId) ?? extractReport(lastMessage);
    this.reports.delete(inFlight.runId);
    if (state.inFlight?.runId === inFlight.runId) state.inFlight = null;
    if (this.stopping && !report) {
      this.store.save();
      this.activity.add({ kind: "checkin", title: "Check-in interrupted", detail: "The plugin stopped while it ran.", outcome: "failed", runId: inFlight.runId, agentId: inFlight.agentId! });
      return;
    }
    if (!report) {
      this.store.save();
      this.activity.add({ kind: "checkin", title: followup ? `Follow-up check failed: ${followup.title}` : "Check-in failed", detail: error ?? `It ended without a report.${lastMessage ? ` Last message: ${truncate(lastMessage, 300)}` : ""}`, outcome: "failed", runId: inFlight.runId, agentId: inFlight.agentId! });
      return;
    }
    this.applyReport(report, inFlight, followup);
  }

  private applyReport(report: Report, inFlight: InFlight, followup: Followup | null): void {
    const state = this.store.state;
    const now = this.now();
    const merged = mergeReport(state.alerts, report, { now, runId: inFlight.runId, source: followup ? "followup" : "checkin" });
    state.alerts = merged.alerts;
    const decision = deliveryDecision({
      notify: report.notify,
      fresh: merged.fresh,
      config: this.config(),
      messagesToday: state.messagesToday,
      unanswered: state.unanswered,
      activeNow: isActiveTime(now, this.schedule()),
      paused: this.paused(now),
      requested: inFlight.reason !== "scheduled",
    });
    const label = followup ? `Follow-up "${truncate(followup.title, 60)}"` : inFlight.reason === "manual" ? "Check-in you asked for" : "Check-in";
    const common = { kind: "checkin" as const, runId: inFlight.runId, agentId: inFlight.agentId!, detail: report.summary, alertIds: merged.fresh.map((alert) => alert.id) };
    if (decision.deliver) {
      state.quietStreak = 0;
      this.store.save();
      this.deliverAlerts(merged.fresh, { runId: inFlight.runId, counts: inFlight.reason === "scheduled", title: merged.fresh.length === 1 ? merged.fresh[0]!.title : `${merged.fresh.length} things need you` });
      this.activity.add({ ...common, title: `${label}: ${merged.fresh.length === 1 ? "1 thing" : `${merged.fresh.length} things`} for you`, outcome: "alerted" });
      return;
    }
    if (decision.reason === "quiet") {
      if (inFlight.reason === "scheduled") state.quietStreak++;
      this.store.save();
      this.activity.add({ ...common, title: `${label}: nothing new`, outcome: "quiet" });
      return;
    }
    this.store.save();
    this.activity.add({ ...common, title: `${label}: kept ${merged.fresh.length} for later (${decision.reason})`, outcome: "held" });
  }

  private deliverAlerts(alerts: readonly Alert[], options: { runId: string | null; counts: boolean; title: string }): void {
    if (alerts.length === 0) return;
    this.outbox.add({
      id: options.runId ? `checkin-${options.runId}` : shortId("wake"),
      kind: "checkin",
      text: encodeUpdate(
        { v: 1, kind: "checkin", title: options.title, at: new Date(this.now()).toISOString(), runId: options.runId, items: alerts.map((alert) => ({ id: alert.id, title: alert.title, urgency: alert.urgency })) },
        alertBody(alerts),
      ),
      counts: options.counts,
      alertIds: alerts.map((alert) => alert.id),
    });
  }

  private onDelivered(entry: OutboxEntry): void {
    const state = this.store.state;
    if (entry.counts) {
      state.messagesToday++;
      state.unanswered++;
    }
    const ids = new Set(entry.alertIds);
    for (const alert of state.alerts) if (ids.has(alert.id)) alert.delivered = true;
    this.store.save();
    this.activity.add({ kind: "delivery", title: `Sent: ${entryTitle(entry)}`, outcome: "sent", ...(entry.alertIds.length > 0 ? { alertIds: entry.alertIds } : {}) });
  }

  private async checkinContext(paseo: PaseoApi, reason: InFlight["reason"], focus: string | null) {
    const state = this.store.state;
    const assistant = state.assistant!;
    const [watchlist, memory, waiting, conversation] = await Promise.all([
      readFile(join(assistant.home, WATCHLIST_FILE), "utf8").catch(() => null),
      readFile(join(assistant.home, MEMORY_FILE), "utf8").catch(() => null),
      waitingAgents(paseo).catch((error) => {
        log(`could not read waiting agents: ${describeError(error)}`);
        return null;
      }),
      this.recentConversation(paseo, assistant.agentId).catch(() => []),
    ]);
    return { now: this.now(), config: this.config(), schedule: this.schedule(), reason, focus, watchlist, memory, alerts: state.alerts, followups: state.followups, waiting, conversation };
  }

  private async recentConversation(paseo: PaseoApi, agentId: string): Promise<{ role: "user" | "assistant"; text: string }[]> {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 80, projection: "canonical" });
    const items = ((page as { entries?: Array<{ item: AgentTimelineItem }> }).entries ?? []).map((entry) => entry.item);
    const messages: { role: "user" | "assistant"; text: string }[] = [];
    for (const item of items) {
      if (item.type === "user_message") {
        const update = decodeUpdate(item.text);
        messages.push({ role: "user", text: update ? `[${update.kind} note from the plugin: ${update.title}]` : item.text });
      } else if (item.type === "assistant_message") {
        const last = messages[messages.length - 1];
        // Streaming splits one reply into several items.
        if (last?.role === "assistant") last.text += item.text;
        else messages.push({ role: "assistant", text: item.text });
      }
    }
    return messages.slice(-10);
  }

  /** The check-in's report, through its MCP tool. Only the run in flight may report, once. */
  recordReport(caller: McpCaller, report: Report): string {
    if (!caller.runId || this.store.state.inFlight?.runId !== caller.runId) throw new ServiceError("This check-in has ended.");
    if (this.reports.has(caller.runId)) return "Already recorded; finish now.";
    this.reports.set(caller.runId, report);
    return report.notify ? `Recorded ${report.items.length} item(s). The assistant will tell the user. You are done; reply with one short line.` : "Recorded. Nothing will be sent. You are done; reply with one short line.";
  }

  // ---------------------------------------------------------------- follow-ups

  createFollowup(input: FollowupInput, createdBy: Followup["createdBy"]): { followup: Followup; receipt: string } {
    if (!this.assistantActive()) throw new ServiceError("Set Aide up first.");
    const state = this.store.state;
    const now = this.now();
    const timezone = this.timezone();
    const repeat = parseRepeat(input.repeat);
    let due: number;
    if (input.when?.trim()) due = parseWhen(input.when, now, timezone);
    else if (repeat) due = nextOccurrence(repeat, now, timezone);
    else throw new ServiceError("Say when, e.g. \"in 2h\" or \"tomorrow 9am\".");
    if (due < now - 60_000) throw new ServiceError(`${formatLocal(due, timezone, now)} has already passed.`);
    const until = input.until?.trim() ? parseWhen(input.until, now, timezone) : null;
    if (until !== null && until <= due) throw new ServiceError("The end must be after the first time.");
    if (state.followups.filter((followup) => followup.status === "active").length >= MAX_ACTIVE_FOLLOWUPS) throw new ServiceError(`There are already ${MAX_ACTIVE_FOLLOWUPS} active follow-ups; cancel some first.`);
    const followup: Followup = {
      id: shortId("fu"),
      title: input.title.trim(),
      prompt: input.prompt.trim(),
      mode: input.mode,
      dueAt: new Date(Math.max(due, now)).toISOString(),
      repeat,
      until: until === null ? null : new Date(until).toISOString(),
      status: "active",
      createdBy,
      createdAt: new Date(now).toISOString(),
      fired: 0,
      lastFiredAt: null,
    };
    state.followups.push(followup);
    this.store.save();
    let receipt = `Scheduled "${followup.title}" (${followup.mode === "remind" ? "reminder" : "background check"}) for ${formatLocal(Date.parse(followup.dueAt), timezone, now)} (${timezone})`;
    if (repeat) receipt += `, then ${describeRepeat(repeat)}`;
    if (until !== null) receipt += `, until ${formatLocal(until, timezone, now)}`;
    receipt += `. Id ${followup.id}.`;
    if (followup.mode === "check" && !isActiveTime(Date.parse(followup.dueAt), this.schedule())) receipt += ` Background checks run between ${this.config().activeHours.start} and ${this.config().activeHours.end}, so it will run when that window opens.`;
    if (followup.mode === "check" && this.paused(Date.parse(followup.dueAt))) receipt += " Aide is paused then, so it will run after the pause.";
    this.activity.add({ kind: "followup", title: `Scheduled: ${followup.title}`, detail: receipt });
    unref(setTimeout(() => void this.tick(), 500));
    return { followup, receipt };
  }

  cancelFollowup(id: string): Followup {
    const followup = this.store.state.followups.find((candidate) => candidate.id === id);
    if (!followup) throw new ServiceError(`No follow-up ${id}.`);
    if (followup.status === "active") {
      followup.status = "canceled";
      this.store.save();
      this.activity.add({ kind: "followup", title: `Canceled: ${followup.title}`, outcome: "done" });
    }
    return followup;
  }

  activeFollowups(): Followup[] {
    return this.store.state.followups.filter((followup) => followup.status === "active").sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  // ---------------------------------------------------------------- alerts

  alerts(includeClosed = false): Alert[] {
    return this.store.state.alerts.filter((alert) => includeClosed || alert.status === "open" || alert.status === "snoozed");
  }

  updateAlert(id: string, action: "done" | "snooze" | "mute" | "reopen", until?: string): { alert: Alert; message: string } {
    const alert = this.store.state.alerts.find((candidate) => candidate.id === id || candidate.key === id);
    if (!alert) throw new ServiceError(`No alert ${id}.`);
    const now = this.now();
    const at = new Date(now).toISOString();
    let message: string;
    switch (action) {
      case "done":
        Object.assign(alert, { status: "done", snoozedUntil: null, updatedAt: at });
        message = `Marked done: ${alert.title}.`;
        break;
      case "snooze": {
        const wake = parseWhen(until?.trim() || DEFAULT_SNOOZE, now, this.timezone());
        if (wake <= now) throw new ServiceError("Snooze until a time in the future.");
        Object.assign(alert, { status: "snoozed", snoozedUntil: new Date(wake).toISOString(), updatedAt: at });
        message = `Snoozed until ${formatLocal(wake, this.timezone(), now)}: ${alert.title}.`;
        break;
      }
      case "mute":
        Object.assign(alert, { status: "muted", snoozedUntil: null, updatedAt: at });
        message = `Won't bring this up again: ${alert.title}.`;
        break;
      case "reopen":
        Object.assign(alert, { status: "open", snoozedUntil: null, updatedAt: at });
        message = `Reopened: ${alert.title}.`;
        break;
    }
    this.store.save();
    this.activity.add({ kind: "feedback", title: message, outcome: "done", alertIds: [alert.id] });
    return { alert, message };
  }

  // ---------------------------------------------------------------- hooks

  /** The assistant finished a turn: notice the user writing, and deliver what waits. */
  onTurnEnded(agentId: string, timeline: readonly AgentTimelineItem[]): void {
    const state = this.store.state;
    if (!state.assistant || agentId !== state.assistant.agentId) return;
    let lastUser: string | null = null;
    for (let index = timeline.length - 1; index >= 0; index--) {
      const item = timeline[index]!;
      if (item.type === "user_message") {
        lastUser = item.text;
        break;
      }
    }
    if (lastUser !== null && !isUpdateText(lastUser)) {
      state.unanswered = 0;
      state.quietStreak = 0;
      state.lastUserAt = new Date(this.now()).toISOString();
      this.store.save();
    }
    this.outbox.kick();
  }

  /** Answers a running check-in's permission prompt; other agents are left alone. */
  async onPermissionRequested(agentId: string, request: AgentPermissionRequest, paseo: PaseoApi): Promise<void> {
    if (this.store.state.inFlight?.agentId !== agentId) return;
    try {
      await paseo.agents.ref(agentId).respondToPermission({ requestId: request.id, response: decideCheckinPermission(request) });
    } catch (error) {
      log(`check-in permission ${request.id}: ${describeError(error)}`);
    }
  }

  onArchived(agentId: string): void {
    if (this.store.state.assistant?.agentId === agentId) this.markDetached("You archived the chat.");
  }

  private authorize(caller: McpCaller): boolean {
    const state = this.store.state;
    if (caller.role === "assistant") return Boolean(state.assistant && !state.assistant.archivedAt && state.assistant.agentId === caller.agentId);
    return state.inFlight?.runId === caller.runId && state.inFlight?.agentId === caller.agentId;
  }

  // ---------------------------------------------------------------- reading

  async waiting(paseo?: PaseoApi): Promise<WaitingAgent[]> {
    const api = paseo ?? (await this.access.get());
    return waitingAgents(api);
  }

  statusText(): string {
    const state = this.store.state;
    const now = this.now();
    const timezone = this.timezone();
    const planned = this.planned(now);
    const lines = [
      `Now ${formatLocal(now, timezone)} (${timezone}). ${this.paused(now) ? `Paused${this.config().pausedUntil === "always" ? " until resumed" : ` until ${formatLocal(Date.parse(this.config().pausedUntil!), timezone, now)}`}.` : isActiveTime(now, this.schedule()) ? "Active." : "Outside active hours."}`,
      scheduleSummary(this.config(), timezone),
      `Today: ${state.checkinsToday} check-ins, ${state.messagesToday} proactive messages, ${state.unanswered} unanswered.`,
      planned.length > 0 ? `Next:\n${planned.slice(0, 8).map((entry) => `- ${formatLocal(Date.parse(entry.at), timezone, now)}: ${entry.title}`).join("\n")}` : "Nothing planned.",
    ];
    return lines.join("\n");
  }

  private planned(now: number): Planned[] {
    const state = this.store.state;
    const assistant = state.assistant;
    const planned: Planned[] = [];
    if (!assistant || assistant.archivedAt) return planned;
    const schedule = this.schedule();
    const paused = this.paused(now);
    for (const entry of state.outbox) {
      planned.push({ kind: entry.kind === "brief" ? "brief" : entry.kind === "reminder" ? "followup" : "checkin", at: new Date(now).toISOString(), title: `${entryTitle(entry)} (waiting for the chat to be free)`, detail: entry.lastError, followupId: null });
    }
    if (!paused) {
      const next = nextCheckinAt({ config: schedule, lastStartedAt: state.lastCheckinAt ? Date.parse(state.lastCheckinAt) : null, setupAt: Date.parse(assistant.createdAt), quietStreak: state.quietStreak });
      if (next !== null) {
        const capped = state.checkinsToday >= schedule.checkins.maxPerDay;
        planned.push({ kind: "checkin", at: new Date(Math.max(next, now)).toISOString(), title: capped ? "Check-in (daily limit reached; resumes tomorrow)" : "Background check-in", detail: state.quietStreak >= 3 ? `Slowed down after ${state.quietStreak} quiet check-ins.` : null, followupId: null });
      }
      const brief = nextBriefAt(now, schedule, state.lastBriefDay);
      if (brief !== null) planned.push({ kind: "brief", at: new Date(brief).toISOString(), title: "Morning brief", detail: null, followupId: null });
    }
    for (const followup of this.activeFollowups()) {
      planned.push({ kind: "followup", at: followup.dueAt, title: followup.title, detail: `${followup.mode === "remind" ? "Reminder" : "Background check"}, ${describeRepeat(followup.repeat)}`, followupId: followup.id });
    }
    return planned.sort((a, b) => a.at.localeCompare(b.at));
  }

  private stateOf(now: number): Overview["state"] {
    const assistant = this.store.state.assistant;
    if (!assistant) return "not_set_up";
    if (assistant.archivedAt) return "detached";
    if (this.paused(now)) return "paused";
    return isActiveTime(now, this.schedule()) ? "active" : "quiet_hours";
  }

  badge(): { state: Overview["state"]; openAlerts: number; busy: boolean } {
    const state = this.store.state;
    return { state: this.stateOf(this.now()), openAlerts: state.alerts.filter((alert) => alert.status === "open").length, busy: state.inFlight !== null };
  }

  async overview(paseo: PaseoApi): Promise<Overview> {
    await this.start();
    const state = this.store.state;
    const now = this.now();
    const assistant = state.assistant;
    let waiting: WaitingAgent[] = [];
    if (assistant && !assistant.archivedAt) waiting = await withTimeout(waitingAgents(paseo), 5000).catch(() => []);
    const status = this.stateOf(now);
    const alerts = state.alerts.filter((alert) => alert.status === "open" || alert.status === "snoozed");
    const closed = state.alerts.filter((alert) => alert.status === "done" || alert.status === "muted").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20);
    return {
      version: PLUGIN_VERSION,
      ready: this.startError === null,
      error: this.startError,
      timezone: this.timezone(),
      config: this.config(),
      assistant: assistant ? { agentId: assistant.agentId, workspaceId: assistant.workspaceId, home: assistant.home, createdAt: assistant.createdAt, archived: Boolean(assistant.archivedAt) } : null,
      state: status,
      busy: state.inFlight ? { since: state.inFlight.startedAt, agentId: state.inFlight.agentId, reason: state.inFlight.reason } : null,
      today: { checkins: state.checkinsToday, messages: state.messagesToday, unanswered: state.unanswered },
      alerts: [...alerts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), ...closed],
      waiting,
      planned: this.planned(now),
      followups: this.activeFollowups(),
      activity: this.activity.recent(60),
    };
  }

  async readHomeFile(name: string): Promise<{ path: string; text: string; exists: boolean }> {
    const assistant = this.store.state.assistant;
    if (!assistant) throw new ServiceError("Set Aide up first.");
    const path = join(assistant.home, name);
    try {
      return { path, text: await readFile(path, "utf8"), exists: true };
    } catch {
      return { path, text: "", exists: false };
    }
  }

  async writeHomeFile(name: string, text: string): Promise<{ path: string }> {
    const assistant = this.store.state.assistant;
    if (!assistant) throw new ServiceError("Set Aide up first.");
    const path = join(assistant.home, name);
    await writeFile(path, text.endsWith("\n") ? text : `${text}\n`);
    if (name === WATCHLIST_FILE) this.activity.add({ kind: "schedule", title: "Watch list edited" });
    return { path };
  }
}

function entryTitle(entry: OutboxEntry): string {
  const update = decodeUpdate(entry.text);
  if (!update) return entry.kind;
  return entry.kind === "reminder" ? `reminder "${update.title}"` : entry.kind === "brief" ? update.title.toLowerCase() : entry.kind === "welcome" ? "welcome message" : update.title;
}

export function scheduleSummary(config: Config, timezone: string): string {
  const checkins = config.checkins.enabled ? `Check-ins every ${config.checkins.everyMinutes} min (at most ${config.checkins.maxPerDay} a day)` : "Check-ins off";
  const brief = config.brief.enabled ? `brief at ${config.brief.time}` : "brief off";
  return `${checkins}, ${brief}, active ${config.activeHours.start}–${config.activeHours.end} ${timezone}, at most ${config.messagesPerDay} proactive messages a day.`;
}

async function writeIfMissing(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = unref(setTimeout(() => reject(new Error("timed out")), ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
