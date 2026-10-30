import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { CreateAgentOptions, Cursor } from "./sdk";
import type { Interaction, InteractInput, SelectSideAgentInput } from "../shared/contracts";
import { BoardStoreError, canonicalJson } from "./store-format";

export interface SideRoute { agentId?: string; pendingInteractionId?: string; version: number }
export interface CreationSpec {
  config: CreateAgentOptions["config"]; title: string; idempotencyKey: string;
  labels: Record<string, string>; workspaceId?: string; cwd: string;
}

export interface Delivery {
  boardId: string;
  interactionId: string;
  ownerAgentId: string;
  targetAgentId?: string;
  kind: "question" | "change" | "fork" | "return" | "reply";
  prompt: string;
  images?: Array<{ data: string; mimeType: string }>;
  input?: InteractInput;
  /** Original user request is compared on retry; input contains the frozen resolved kind/anchor. */
  request?: InteractInput;
  sourceSnapshot?: Interaction["sourceSnapshot"];
  waitForSideInteractionId?: string;
  creationSpec?: CreationSpec;
  state: "saved" | "creating" | "sending" | "delivered" | "unknown" | "failed" | "settled";
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
  sideRoutes: Record<string, SideRoute>;
  sideSelections: Record<string, SelectSideAgentInput>;
}

/** Durable immutable delivery payloads are saved before any SDK side effect. */
export class ServiceJournal {
  private file: string;
  private tail: Promise<unknown> = Promise.resolve();
  private data: JournalData = { version: 1, deliveries: {}, bindings: {}, cursors: {}, active: {}, sideRoutes: {}, sideSelections: {} };
  constructor(file: string) { this.file = file; }
  async init(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed.version !== 1 || !parsed.deliveries || !parsed.bindings || !parsed.cursors || !parsed.active) throw new Error("Invalid board service journal");
      this.data = parsed;
      this.data.sideRoutes ??= {};
      this.data.sideSelections ??= {};
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
  sideRoute(boardId: string): SideRoute | undefined { const route = this.data.sideRoutes[boardId]; return route && structuredClone(route); }
  sideSelection(input: SelectSideAgentInput): boolean {
    const previous = this.data.sideSelections[deliveryKey(input.boardId, input.eventId)];
    if (!previous) return false;
    if (canonicalJson(previous) !== canonicalJson(input)) throw new BoardStoreError("idempotency_conflict", "Side-agent selection ID already belongs to a different request");
    return true;
  }
  /** Delivery plus a new-side reservation share one write-ahead transaction. */
  async prepare(delivery: Delivery, reserveSide: boolean): Promise<void> {
    await this.change(() => {
      const key = deliveryKey(delivery.boardId, delivery.interactionId);
      if (this.data.deliveries[key]) throw new BoardStoreError("idempotency_conflict", "Delivery already exists");
      this.data.deliveries[key] = structuredClone(delivery);
      if (reserveSide) {
        const route = this.data.sideRoutes[delivery.boardId];
        this.data.sideRoutes[delivery.boardId] = { agentId: route?.agentId, pendingInteractionId: delivery.interactionId, version: (route?.version ?? 0) + 1 };
      }
    });
  }
  async selectSide(input: SelectSideAgentInput): Promise<void> {
    await this.change(() => {
      if (this.sideSelection(input)) return;
      const route = this.data.sideRoutes[input.boardId];
      this.data.sideSelections[deliveryKey(input.boardId, input.eventId)] = structuredClone(input);
      this.data.sideRoutes[input.boardId] = { agentId: input.agentId, version: (route?.version ?? 0) + 1 };
    });
  }
  async assignFork(key: string, agentId: string): Promise<Delivery> {
    await this.change(() => {
      const delivery = this.data.deliveries[key];
      if (!delivery) throw new Error("Delivery record not found");
      if (delivery.targetAgentId && delivery.targetAgentId !== agentId) throw new Error("A fork delivery cannot change its assigned agent");
      delivery.targetAgentId = agentId; delivery.state = "saved"; delete delivery.error;
      const route = this.data.sideRoutes[delivery.boardId];
      if (route?.pendingInteractionId === delivery.interactionId) this.data.sideRoutes[delivery.boardId] = { agentId, version: route.version + 1 };
    });
    return this.get(key)!;
  }
  async put(delivery: Delivery): Promise<void> { await this.change(() => { this.data.deliveries[deliveryKey(delivery.boardId, delivery.interactionId)] = structuredClone(delivery); }); }
  async patch(key: string, update: Partial<Delivery>): Promise<Delivery> {
    await this.change(() => { const current = this.data.deliveries[key]; if (!current) throw new Error("Delivery record not found"); this.data.deliveries[key] = { ...current, ...structuredClone(update) }; });
    return this.get(key)!;
  }
  /** An already resolved intent needs no message; this is not a delivery acknowledgement. */
  async settleUnsent(key: string): Promise<void> {
    await this.change(() => {
      const current = this.data.deliveries[key];
      if (!current || !["saved", "creating"].includes(current.state)) return;
      this.data.deliveries[key] = { ...current, state: "settled", awaitingTurn: false, needsRecovery: false, error: undefined };
    });
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
