import { randomUUID } from "node:crypto";
import { FALLBACK_OWNER_LABEL, type DaemonAdapter, type AgentSnapshot } from "./daemon";
import { detectRateLimit, usageRecovery } from "./rate-limit";
import { StateStore, type FallbackEntry } from "./store";

export const FALLBACK_MODEL = "gpt-6.1-sol";
export const FALLBACK_THINKING = "ultra";
const PROBE_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const RESET_GRACE_MS = 5_000;
const CONTINUE = "主模型遇到限流，插件已自动调整模型。请从刚才中断的位置继续完成用户的任务；先检查已有进展，避免重复已完成的操作。";
type Outcome = { kind: "completed" | "canceled" | "failed"; error?: { message: string; code?: string } };

function busy(agent: AgentSnapshot): boolean {
  return agent.status === "running" || agent.status === "initializing" ||
    Boolean(agent.activeTurn) || agent.pendingPermissions.length > 0;
}
function isFallback(agent: AgentSnapshot): boolean {
  return agent.provider === "codex" && agent.model === FALLBACK_MODEL &&
    agent.thinkingOptionId === FALLBACK_THINKING;
}
function isMain(agent: AgentSnapshot, entry: FallbackEntry): boolean {
  return agent.provider === "codex" && agent.model === entry.main.model &&
    agent.thinkingOptionId === entry.main.thinkingOptionId;
}
function isIntermediate(agent: AgentSnapshot, entry: FallbackEntry): boolean {
  if (agent.provider !== "codex") return false;
  return entry.phase === "switching"
    ? agent.model === FALLBACK_MODEL && agent.thinkingOptionId === entry.main.thinkingOptionId
    : entry.phase === "restoring" && agent.model === entry.main.model &&
      agent.thinkingOptionId === FALLBACK_THINKING;
}

export class FallbackController {
  private readonly work = new Map<string, Promise<void>>();
  private readonly ended = new Map<string, string | null>();
  private stopped = false;
  private verified = false;
  error: string | null = null;
  constructor(readonly adapter: DaemonAdapter, readonly store: StateStore,
    private readonly now: () => number = Date.now) {}

  started(agentId: string): void { this.ended.delete(agentId); }

  async endedTurn(agentId: string, turnId: string | null, outcome: Outcome): Promise<void> {
    if (this.ended.has(agentId) && this.ended.get(agentId) === turnId) return;
    this.ended.set(agentId, turnId);
    await this.exclusive(agentId, async () => {
      const existing = this.store.state.agents[agentId];
      if (outcome.kind === "canceled") {
        if (existing) { existing.pendingResume = false; await this.store.save(); }
        return;
      }
      if (existing) {
        if (outcome.kind === "completed") existing.pendingResume = false;
        if (detectRateLimit({ outcome, now: this.now() })) {
          existing.phase = "blocked";
          existing.pendingResume = true;
          existing.messageId = `rate-fallback-${randomUUID()}`;
          existing.lastError = "备用模型也遇到限流；等待主模型恢复。";
        }
        await this.store.save();
        await this.reconcile(existing);
        return;
      }
      if (!this.store.state.enabled || outcome.kind !== "failed") return;
      const limit = detectRateLimit({ outcome, now: this.now() });
      if (!limit) return;
      const agent = await this.adapter.getAgent(agentId);
      if (!agent || agent.archivedAt || agent.provider !== "codex" ||
          !agent.model || agent.model === FALLBACK_MODEL ||
          agent.labels?.[FALLBACK_OWNER_LABEL] || busy(agent)) return;
      const entry: FallbackEntry = {
        agentId, main: { model: agent.model, thinkingOptionId: agent.thinkingOptionId },
        phase: "switching", resetAt: limit.resetAt,
        nextCheckAt: limit.resetAt === null ? this.now() + PROBE_MS : this.now(),
        lastError: null, pendingResume: true, messageId: `rate-fallback-${randomUUID()}`,
      };
      // Persist the original settings before the first mutation.
      this.store.state.agents[agentId] = entry;
      await this.store.save();
      await this.switchToFallback(entry);
    });
  }

  async configure(enabled: boolean): Promise<void> {
    this.store.state.enabled = enabled;
    await this.store.save();
    await this.tick();
  }

  async archived(agentId: string): Promise<void> {
    await this.exclusive(agentId, async () => {
      delete this.store.state.agents[agentId];
      this.ended.delete(agentId);
      await this.store.save();
    });
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(Object.keys(this.store.state.agents).map((id) =>
      this.exclusive(id, async () => {
        const entry = this.store.state.agents[id];
        if (entry) await this.reconcile(entry);
      })));
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
        console.error("[rate-fallback]", id, this.error);
      }
    });
    this.work.set(id, current);
    try { await current; }
    finally { if (this.work.get(id) === current) this.work.delete(id); }
  }

  private async verifyModel(cwd: string): Promise<void> {
    if (this.verified) return;
    const result = await this.adapter.models("codex", cwd);
    const model = result.models?.find((model) => model.id === FALLBACK_MODEL);
    if (!model?.thinkingOptions?.some((option) => option.id === FALLBACK_THINKING)) {
      throw new Error("此 Codex 账户未提供 GPT-6.1 Sol Ultra，无法自动切换。");
    }
    this.verified = true;
  }

  private async switchToFallback(entry: FallbackEntry): Promise<void> {
    const current = await this.adapter.getAgent(entry.agentId);
    if (!current || current.archivedAt) return this.forget(entry);
    if (busy(current)) return;
    if (!isMain(current, entry) && !isFallback(current) && !isIntermediate(current, entry)) return this.forget(entry);
    if (!isFallback(current)) {
      await this.verifyModel(current.cwd);
      await this.store.save();
      await this.adapter.applySettings(entry.agentId, {
        model: FALLBACK_MODEL, thinkingOptionId: FALLBACK_THINKING,
      });
    }
    entry.phase = "fallback";
    entry.lastError = null;
    await this.store.save();
    console.log("[rate-fallback] switched", entry.agentId, entry.main.model, "->", FALLBACK_MODEL);
    await this.resume(entry);
    try {
      const quota = usageRecovery(await this.adapter.usage(entry.agentId), entry.main.model!, this.now());
      if (quota?.status === "exhausted" && quota.resetAt !== null) {
        entry.resetAt = Math.max(entry.resetAt ?? 0, quota.resetAt);
        entry.nextCheckAt = this.now();
        await this.store.save();
      }
    } catch (error) {
      console.warn("[rate-fallback] Could not read the main model's reset time", String(error));
    }
  }

  private async resume(entry: FallbackEntry): Promise<void> {
    if (!entry.pendingResume || this.stopped) return;
    const current = await this.adapter.getAgent(entry.agentId);
    if (!current || busy(current)) return;
    if (entry.phase === "restoring" ? !isMain(current, entry) : !isFallback(current)) return;
    await this.adapter.send(entry.agentId, CONTINUE, entry.messageId);
    entry.pendingResume = false;
    await this.store.save();
  }

  private async reconcile(entry: FallbackEntry): Promise<void> {
    const current = await this.adapter.getAgent(entry.agentId);
    if (!current || current.archivedAt) return this.forget(entry);
    if (busy(current)) return;
    if (entry.phase === "restoring") {
      if (this.now() < entry.nextCheckAt) return;
      if (isMain(current, entry)) {
        await this.resume(entry);
        if (!entry.pendingResume) await this.forget(entry);
        return;
      }
      if (!isFallback(current) && !isIntermediate(current, entry)) return this.forget(entry);
      return this.restore(entry);
    }
    if (!isFallback(current)) {
      if (entry.phase === "switching" && (isMain(current, entry) || isIntermediate(current, entry))) {
        if (!this.store.state.enabled) {
          if (isMain(current, entry)) return this.forget(entry);
          return this.restore(entry);
        }
        if (this.now() >= entry.nextCheckAt) await this.switchToFallback(entry);
        return;
      }
      // Manual changes relinquish this plugin's ownership.
      return this.forget(entry);
    }
    if (!this.store.state.enabled) return this.restore(entry);
    if (entry.phase === "switching") entry.phase = "fallback";
    if (entry.pendingResume && entry.phase === "fallback") {
      if (entry.lastError && this.now() < entry.nextCheckAt) return;
      await this.resume(entry);
      entry.lastError = null;
    }
    const due = entry.resetAt === null ? entry.nextCheckAt : entry.resetAt + RESET_GRACE_MS;
    if (this.now() < Math.max(due, entry.nextCheckAt)) return;
    let quota: ReturnType<typeof usageRecovery> = null;
    try {
      quota = usageRecovery(await this.adapter.usage(entry.agentId), entry.main.model!, this.now());
    } catch (error) {
      console.warn("[rate-fallback] Usage unavailable; using reset time or periodic probe", String(error));
    }
    if (quota?.status === "exhausted") {
      entry.resetAt = quota.resetAt;
      entry.nextCheckAt = this.now() + (quota.resetAt ? RETRY_MS : PROBE_MS);
      await this.store.save();
      return;
    }
    await this.restore(entry);
  }

  private async restore(entry: FallbackEntry): Promise<void> {
    const current = await this.adapter.getAgent(entry.agentId);
    if (!current || current.archivedAt) return this.forget(entry);
    if (busy(current)) return;
    if (!isFallback(current) && !isMain(current, entry) && !isIntermediate(current, entry)) return this.forget(entry);
    entry.phase = "restoring";
    await this.store.save();
    if (!isMain(current, entry)) await this.adapter.applySettings(entry.agentId, entry.main);
    console.log("[rate-fallback] restored", entry.agentId, entry.main.model);
    await this.resume(entry);
    if (!entry.pendingResume) await this.forget(entry);
  }

  private async forget(entry: FallbackEntry): Promise<void> {
    delete this.store.state.agents[entry.agentId];
    await this.store.save();
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.work.values()]);
    await this.adapter.close();
  }
}
