import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Cursor } from "./sdk";
import type { InteractInput } from "../shared/contracts";

export interface Delivery {
  boardId: string;
  interactionId: string;
  ownerAgentId: string;
  targetAgentId?: string;
  kind: "question" | "change" | "fork" | "return" | "reply";
  prompt: string;
  images?: Array<{ data: string; mimeType: string }>;
  input?: InteractInput;
  state: "saved" | "creating" | "sending" | "delivered" | "unknown" | "failed";
  awaitingTurn?: boolean;
  needsRecovery?: boolean;
  turnId?: string;
  outcome?: "completed" | "failed" | "canceled";
  responseChunks?: Record<string, { seq: number; end?: number; epoch?: string; text: string }>;
  error?: string;
}
export interface Binding { agentId: string; workspaceId?: string; cwd: string }
interface JournalData {
  version: 1;
  deliveries: Record<string, Delivery>;
  bindings: Record<string, Binding>;
  cursors: Record<string, Cursor>;
  active: Record<string, string>;
}

/** Durable immutable delivery payloads are saved before any SDK side effect. */
export class ServiceJournal {
  private file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private data: JournalData = { version: 1, deliveries: {}, bindings: {}, cursors: {}, active: {} };
  constructor(file: string) { this.file = file; }
  async init(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed.version !== 1 || !parsed.deliveries || !parsed.bindings || !parsed.cursors || !parsed.active) throw new Error("Invalid board service journal");
      this.data = parsed;
      for (const delivery of Object.values(this.data.deliveries)) {
        // Creation uses a stable idempotency key; a lost send acknowledgement is never retried blindly.
        if (delivery.state === "sending") { delivery.state = "unknown"; delivery.error = "投递时服务中断，送达结果未知；请在原会话核对。"; }
        if (delivery.awaitingTurn && !delivery.outcome) delivery.needsRecovery = true;
      }
      await this.flush();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  get(id: string): Delivery | undefined { const value = this.data.deliveries[id]; return value && structuredClone(value); }
  all(): Delivery[] { return structuredClone(Object.values(this.data.deliveries)); }
  binding(token: string): Binding | undefined { return this.data.bindings[token] && { ...this.data.bindings[token] }; }
  tokenFor(agentId: string): string | undefined { return Object.entries(this.data.bindings).find(([, binding]) => binding.agentId === agentId)?.[0]; }
  cursor(agentId: string): Cursor | undefined { return this.data.cursors[agentId]; }
  active(agentId: string): string | undefined { return this.data.active[agentId]; }
  async put(delivery: Delivery): Promise<void> { await this.change(() => { this.data.deliveries[deliveryKey(delivery.boardId, delivery.interactionId)] = structuredClone(delivery); }); }
  async patch(key: string, update: Partial<Delivery>): Promise<Delivery> {
    await this.change(() => { const current = this.data.deliveries[key]; if (!current) throw new Error("Delivery record not found"); this.data.deliveries[key] = { ...current, ...structuredClone(update) }; });
    return this.get(key)!;
  }
  async bind(token: string, binding: Binding): Promise<void> {
    await this.change(() => {
      const existing = this.data.bindings[token];
      if (existing && existing.agentId !== binding.agentId) throw new Error("Board binding already belongs to another agent");
      this.data.bindings[token] = { ...binding };
    });
  }
  async progress(agentId: string, cursor: Cursor | undefined, active: string | undefined): Promise<void> {
    await this.change(() => {
      if (cursor) this.data.cursors[agentId] = cursor; else delete this.data.cursors[agentId];
      if (active) this.data.active[agentId] = active; else delete this.data.active[agentId];
    });
  }
  private async change(work: () => void): Promise<void> {
    const result = this.tail.then(async () => {
      const previous = structuredClone(this.data);
      try { work(); await this.flush(); } catch (error) { this.data = previous; throw error; }
    });
    this.tail = result.catch(() => undefined);
    await result;
  }
  private async flush(): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(this.data);
    if (Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw new Error("Board delivery history exceeds 64 MiB; no existing history was removed");
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, this.file);
  }
  async idle(): Promise<void> { await this.tail; }
}
export const deliveryKey = (boardId: string, interactionId: string) => `${boardId}/${interactionId}`;
