import { randomUUID } from "node:crypto";
import { FALLBACK_MODEL, FALLBACK_THINKING } from "./controller";
import { FALLBACK_OWNER_LABEL, FALLBACK_OPERATION_LABEL, type AgentSnapshot, type ForkDaemonAdapter } from "./daemon";
import { ForkStore, type ForkEntry } from "./fork-store";
import { detectRateLimit, usageRecovery, type RateLimit } from "./rate-limit";

type Outcome = { kind: "failed" | "completed" | "canceled"; error?: { message: string; code?: string } };
export interface TransferNotice {
  mainAgentId: string; fallbackAgentId: string; phase: string; message: string;
}
const PROBE_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const GRACE_MS = 5_000;
const CONTINUE = "原 Claude 会话遇到额度限制。用户已要求自动 fork 到 GPT-6.1 Ultra 接续同一个任务。附件是 Paseo 原生生成的会话上下文，工作区和文件保持在同一目录。先检查已完成的工作，从中断处继续用户任务，避免重复执行已有操作。不要把交接本身当成新的需求；若任务已完成，只交付结果并等待。若用户此后提出新指令，优先遵循最新指令，不恢复已经取消或替换的任务。";
const RETURN = "Claude 额度恢复，用户要求把备用 GPT 会话的进展交回本会话。附件是备用会话的最新 Paseo fork 上下文，同一工作区中的文件已包含其改动。先检查实际文件和最新进展，避免重复操作。若用户任务已经完成，只交付最终结果并等待；若任务尚未完成，从最新进展继续。若用户此后提出新指令，优先遵循最新指令，不恢复已经取消或替换的任务。";

function busy(agent: AgentSnapshot): boolean {
  return agent.status === "running" || agent.status === "initializing" ||
    Boolean(agent.activeTurn) || agent.pendingPermissions.length > 0;
}
function sameMain(agent: AgentSnapshot, entry: ForkEntry): boolean {
  return agent.provider === entry.mainProvider && agent.model === entry.mainModel &&
    agent.thinkingOptionId === entry.mainThinking && agent.workspaceId === entry.workspaceId;
}
function ownedBackup(agent: AgentSnapshot, entry: ForkEntry): boolean {
  return agent.id === entry.fallbackAgentId && agent.workspaceId === entry.workspaceId &&
    agent.labels?.[FALLBACK_OWNER_LABEL] === entry.mainAgentId &&
    agent.labels?.[FALLBACK_OPERATION_LABEL] === entry.operationId;
}
function unchangedBackup(agent: AgentSnapshot, entry: ForkEntry): boolean {
  return ownedBackup(agent, entry) && agent.provider === "codex" && agent.model === FALLBACK_MODEL &&
    agent.thinkingOptionId === FALLBACK_THINKING;
}

/** A fork is a new provider session; the original Claude session is retained for the return trip. */
export class ForkController {
  private readonly work = new Map<string, Promise<void>>();
  private readonly ended = new Map<string, string | null>();
  private readonly invalidated = new Set<string>();
  private stopped = false;
  private ticking = false;
  private verified = false;
  error: string | null = null;

  constructor(readonly adapter: ForkDaemonAdapter, readonly store: ForkStore,
    private readonly enabled: () => boolean,
    private readonly notify: (id: string, notice: TransferNotice) => Promise<void> = async () => {},
    private readonly now: () => number = Date.now) {}

  private entryFor(id: string): ForkEntry | undefined {
    return this.store.state.agents[id] ?? Object.values(this.store.state.agents)
      .find((entry) => entry.fallbackAgentId === id);
  }

  async started(id: string): Promise<void> {
    this.ended.delete(id);
    const entry = this.store.state.agents[id];
    if (!entry || entry.phase === "returning") return;
    this.invalidated.add(id);
    await this.exclusive(id, async () => {
      const current = this.store.state.agents[id];
      if (current && current.phase !== "returning") {
        await this.pause(current, "原会话已开始新的执行，已停止自动交接；备用会话的进展仍保留。");
      }
    });
  }

  async endedTurn(id: string, turnId: string | null, outcome: Outcome): Promise<void> {
    const known = this.entryFor(id);
    if (known && outcome.kind === "canceled") this.invalidated.add(known.mainAgentId);
    if (!known) {
      if (!this.enabled() || outcome.kind === "canceled") return;
      const agent = await this.adapter.getAgent(id);
      if (!agent || await this.adapter.providerFamily(agent.provider) !== "claude") return;
    }
    if (this.ended.has(id) && this.ended.get(id) === turnId) return;
    this.ended.set(id, turnId);
    await this.exclusive(known?.mainAgentId ?? id, async () => {
      const entry = this.entryFor(id);
      if (entry) {
        if (outcome.kind === "canceled") return this.pause(entry, "执行已取消，自动交接已停止，原会话和备用会话的历史均保留。");
        if (id === entry.fallbackAgentId) {
          entry.fallbackSent = true;
          if (outcome.kind === "failed") {
            entry.phase = "blocked";
            entry.lastError = "备用会话执行失败，等待 Claude 恢复后交回进展。";
          }
          await this.store.save();
          return this.reconcile(entry);
        }
        if (entry.phase === "returning") {
          const limit = await this.limit(id, outcome);
          if (!limit) {
            await this.notice(entry, "returned", "最新进展已交回原 Claude 会话，已恢复原模型和思考档位。");
            return this.forget(entry);
          }
          entry.returnSent = false;
          entry.returnMessageId = `rate-return-${randomUUID()}`;
          entry.resetAt = limit.resetAt;
          entry.nextCheckAt = limit.resetAt === null ? this.now() + PROBE_MS : this.now();
          entry.lastError = "Claude 仍处于限流状态，已保留备用会话及其最新进展。";
          if (this.enabled()) {
            entry.phase = "fallback";
            entry.fallbackSent = false;
            entry.fallbackMessageId = `rate-fork-${randomUUID()}`;
            await this.store.save();
            return this.continueOnBackup(entry);
          }
          entry.phase = "blocked";
          await this.store.save();
          return;
        }
        return;
      }
      if (!this.enabled() || outcome.kind === "canceled") return;
      const limit = await this.limit(id, outcome);
      if (!limit) return;
      const source = await this.adapter.getAgent(id);
      if (!source || source.archivedAt || busy(source) || !source.workspaceId ||
          await this.adapter.providerFamily(source.provider) !== "claude") return;
      const next: ForkEntry = {
        mainAgentId: id, mainProvider: source.provider, mainModel: source.model,
        mainThinking: source.thinkingOptionId, workspaceId: source.workspaceId, cwd: source.cwd,
        operationId: randomUUID(), fallbackAgentId: null, phase: "forking", resetAt: limit.resetAt,
        nextCheckAt: limit.resetAt === null ? this.now() + PROBE_MS : this.now(), lastError: null,
        fallbackSent: false, returnSent: false,
        fallbackMessageId: `rate-fork-${randomUUID()}`, returnMessageId: `rate-return-${randomUUID()}`,
      };
      this.invalidated.delete(id);
      this.store.state.agents[id] = next;
      await this.store.save();
      await this.continueOnBackup(next);
    });
  }

  private async limit(id: string, outcome: Outcome): Promise<RateLimit | null> {
    const direct = detectRateLimit({ outcome, provider: "claude", now: this.now() });
    if (direct || outcome.kind !== "completed") return direct;
    const page = await this.adapter.timeline(id);
    return detectRateLimit({ outcome, provider: "claude", timeline: page.entries, now: this.now() });
  }

  async archived(id: string): Promise<void> {
    const entry = this.entryFor(id);
    if (entry) this.invalidated.add(entry.mainAgentId);
    if (entry) await this.exclusive(entry.mainAgentId, async () => {
      const current = this.entryFor(id);
      if (current) await this.pause(current, "会话已归档，自动交接已停止。");
    });
    this.ended.delete(id);
  }

  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await Promise.all(Object.keys(this.store.state.agents).map((id) => this.exclusive(id, async () => {
        const entry = this.store.state.agents[id];
        if (entry) await this.reconcile(entry);
      })));
    } finally { this.ticking = false; }
  }

  private async verify(cwd: string): Promise<void> {
    if (this.verified) return;
    const model = (await this.adapter.models("codex", cwd)).models?.find(({ id }) => id === FALLBACK_MODEL);
    if (!model?.thinkingOptions?.some(({ id }) => id === FALLBACK_THINKING)) {
      throw new Error("Codex 未提供 GPT-6.1 Sol Ultra，暂时无法创建备用会话。");
    }
    this.verified = true;
  }

  private async continueOnBackup(entry: ForkEntry): Promise<void> {
    if (this.stopped || this.invalidated.has(entry.mainAgentId)) return;
    const source = await this.adapter.getAgent(entry.mainAgentId);
    if (!source || source.archivedAt) return this.pause(entry, "原会话已关闭，交接已停止。");
    if (!sameMain(source, entry)) return this.pause(entry, "原会话设置已手动更改，自动交接已停止。");
    if (busy(source)) return;
    if (!this.enabled()) {
      return this.pause(entry, "自动交接已停用，未发送新的备用任务。");
    }
    await this.verify(source.cwd);
    if (!entry.fallbackAgentId) {
      await this.store.save();
      const backup = await this.adapter.createFallback({ source, operationId: entry.operationId });
      entry.fallbackAgentId = backup.id;
      await this.store.save();
    }
    const backup = await this.adapter.getAgent(entry.fallbackAgentId);
    if (!backup || backup.archivedAt || !unchangedBackup(backup, entry)) {
      return this.pause(entry, "备用会话已被手动更改或移除，自动交接已停止。");
    }
    if (busy(backup) || entry.fallbackSent) return;
    const context = await this.adapter.forkContext(entry.mainAgentId);
    if (!context.attachment) throw new Error("原会话未提供 fork 上下文，已暂停交接。");
    const [latest, latestBackup] = await Promise.all([
      this.adapter.getAgent(entry.mainAgentId), this.adapter.getAgent(backup.id),
    ]);
    if (!latest || !latestBackup || latest.archivedAt || latestBackup.archivedAt ||
        !sameMain(latest, entry) || !unchangedBackup(latestBackup, entry) ||
        busy(latest) || busy(latestBackup) || this.invalidated.has(entry.mainAgentId)) return;
    if (!this.enabled()) return this.pause(entry, "自动交接已停用，未发送新的备用任务。");
    entry.phase = "fallback";
    await this.store.save();
    if (this.stopped || this.invalidated.has(entry.mainAgentId)) return;
    if (!this.enabled()) return this.pause(entry, "自动交接已停用，未发送新的备用任务。");
    await this.adapter.sendWithContext(backup.id, CONTINUE, entry.fallbackMessageId, context.attachment);
    entry.fallbackSent = true;
    entry.lastError = null;
    await this.store.save();
    await this.notice(entry, "fallback", "Claude 已限流，任务已 fork 到同一工作区的 GPT-6.1 Ultra 备用会话。");
    await this.refreshReset(entry);
  }

  private async refreshReset(entry: ForkEntry): Promise<void> {
    try {
      const quota = usageRecovery(await this.adapter.usage(entry.mainAgentId), entry.mainModel ?? "", this.now(), "claude");
      if (quota?.status === "exhausted" && quota.resetAt !== null) {
        entry.resetAt = Math.max(entry.resetAt ?? 0, quota.resetAt);
        entry.nextCheckAt = this.now();
        await this.store.save();
      }
    } catch (error) { console.warn("[rate-fallback] Claude quota lookup unavailable", String(error)); }
  }

  private async reconcile(entry: ForkEntry): Promise<void> {
    if (entry.phase === "paused") {
      if (this.now() >= entry.nextCheckAt) await this.pause(entry, entry.lastError ?? "自动交接已停止。");
      return;
    }
    const source = await this.adapter.getAgent(entry.mainAgentId);
    if (!source || source.archivedAt || !sameMain(source, entry)) {
      return this.pause(entry, "原会话已移除或设置已更改，自动交接已停止。");
    }
    if (entry.phase === "forking") {
      if (entry.lastError && this.now() < entry.nextCheckAt) return;
      return this.continueOnBackup(entry);
    }
    if (busy(source)) return;
    if (!entry.fallbackAgentId) throw new Error("缺少备用会话记录，已暂停交接。");
    const backup = await this.adapter.getAgent(entry.fallbackAgentId);
    if (!backup || backup.archivedAt || !unchangedBackup(backup, entry)) {
      return this.pause(entry, "备用会话已归档或手动更改，自动交接已停止。");
    }
    if (busy(backup)) return;
    if (entry.lastError && this.now() < entry.nextCheckAt) return;
    if (entry.phase === "returning") {
      if (entry.returnSent) {
        // The send acknowledgement can precede the new turn's status update.
        if (this.now() < entry.nextCheckAt) return;
        const limit = source.status === "error" && source.lastError
          ? detectRateLimit({ outcome: { kind: "failed", error: { message: source.lastError } }, provider: "claude", now: this.now() }) : null;
        if (limit) {
          entry.returnSent = false;
          entry.phase = "blocked";
          entry.resetAt = limit.resetAt;
          entry.nextCheckAt = this.now() + PROBE_MS;
          await this.store.save();
          return;
        }
        await this.notice(entry, "returned", "最新进展已交回原 Claude 会话，已恢复原模型和思考档位。");
        return this.forget(entry);
      }
      return this.returnToMain(entry);
    }
    if (entry.phase === "fallback" && !entry.fallbackSent) {
      if (this.enabled()) return this.continueOnBackup(entry);
    }
    const due = entry.resetAt === null ? entry.nextCheckAt : Math.max(entry.resetAt + GRACE_MS, entry.nextCheckAt);
    if (this.now() < due) return;
    let quota: ReturnType<typeof usageRecovery> = null;
    try { quota = usageRecovery(await this.adapter.usage(entry.mainAgentId), entry.mainModel ?? "", this.now(), "claude"); }
    catch (error) { console.warn("[rate-fallback] Claude quota lookup unavailable", String(error)); }
    if (quota?.status === "exhausted") {
      entry.resetAt = quota.resetAt;
      entry.nextCheckAt = this.now() + (quota.resetAt === null ? PROBE_MS : RETRY_MS);
      await this.store.save();
      return;
    }
    await this.returnToMain(entry);
  }

  private async returnToMain(entry: ForkEntry): Promise<void> {
    if (this.stopped || this.invalidated.has(entry.mainAgentId) || !entry.fallbackAgentId) return;
    const [source, backup] = await Promise.all([
      this.adapter.getAgent(entry.mainAgentId), this.adapter.getAgent(entry.fallbackAgentId),
    ]);
    if (!source || !backup || source.archivedAt || backup.archivedAt ||
        !sameMain(source, entry) || !unchangedBackup(backup, entry)) return;
    if (busy(source) || busy(backup)) return;
    const context = await this.adapter.forkContext(backup.id);
    if (!context.attachment) throw new Error("备用会话未提供 fork 上下文，原会话尚未恢复执行。");
    const [latestMain, latestBackup] = await Promise.all([
      this.adapter.getAgent(source.id), this.adapter.getAgent(backup.id),
    ]);
    if (!latestMain || !latestBackup || latestMain.archivedAt || latestBackup.archivedAt ||
        busy(latestMain) || busy(latestBackup) || !sameMain(latestMain, entry) ||
        !unchangedBackup(latestBackup, entry) || this.invalidated.has(entry.mainAgentId)) return;
    entry.phase = "returning";
    await this.store.save();
    if (this.stopped || this.invalidated.has(entry.mainAgentId)) return;
    await this.adapter.sendWithContext(source.id, RETURN, entry.returnMessageId, context.attachment);
    entry.returnSent = true;
    entry.nextCheckAt = this.now() + RETRY_MS;
    entry.lastError = null;
    await this.store.save();
    await this.notice(entry, "returning", "Claude 额度已恢复，备用会话的最新进展已交回原会话。");
  }

  private async pause(entry: ForkEntry, message: string): Promise<void> {
    // Persist the terminal intent before removing ownership, including if the final deletion fails.
    entry.phase = "paused";
    entry.lastError = message;
    await this.store.save();
    if (entry.fallbackAgentId) {
      const backup = await this.adapter.getAgent(entry.fallbackAgentId);
      if (backup && unchangedBackup(backup, entry) && busy(backup)) await this.adapter.stop(backup.id);
    }
    await this.notice(entry, "paused", message);
    await this.forget(entry);
  }

  private async notice(entry: ForkEntry, phase: string, message: string): Promise<void> {
    if (!entry.fallbackAgentId) return;
    const notice = { mainAgentId: entry.mainAgentId, fallbackAgentId: entry.fallbackAgentId, phase, message };
    for (const id of [entry.mainAgentId, entry.fallbackAgentId]) {
      try { await this.notify(id, notice); }
      catch (error) { console.warn("[rate-fallback] Could not append transfer status", String(error)); }
    }
  }

  private async forget(entry: ForkEntry): Promise<void> {
    delete this.store.state.agents[entry.mainAgentId];
    await this.store.save();
    this.invalidated.delete(entry.mainAgentId);
  }

  private async exclusive(id: string, task: () => Promise<void>): Promise<void> {
    const previous = this.work.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (this.stopped) return;
      try { await task(); }
      catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        const entry = this.store.state.agents[id];
        if (entry) {
          entry.lastError = this.error;
          entry.nextCheckAt = this.now() + RETRY_MS;
          await this.store.save();
        }
        console.error("[rate-fallback] fork", id, this.error);
      }
    });
    this.work.set(id, current);
    try { await current; }
    finally { if (this.work.get(id) === current) this.work.delete(id); }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.work.values()]);
  }
}
