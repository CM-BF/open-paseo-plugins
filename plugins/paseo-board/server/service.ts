import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { setTimeout, clearTimeout } from "node:timers";
import {
  CreateInputSchema, DecisionUpdateInputSchema, EmitInputSchema, IdSchema, InteractInputSchema,
  PublishInputSchema, RespondInputSchema, type Board, type Interaction, type InteractInput,
} from "../shared/contracts";
import { BoardStore, BoardStoreError } from "./store";
import { ServiceJournal, deliveryKey, type Binding, type Delivery } from "./journal";
import { discussionConfig, isBusy, type Agent, type Paseo, type TimelinePage } from "./sdk";
import { extractCandidates } from "./extraction";

export type Operation = "list" | "read" | "create" | "publish" | "decision" | "emit" | "respond";
const terminal = new Set<Interaction["status"]>(["applied", "rejected", "answered"]);
const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
const marker = (boardId: string, intentId: string) => `[paseo-board board=${boardId} intent=${intentId}]`;

export function interactionPrompt(board: Board, input: InteractInput): string {
  const anchor = input.anchor ? { ...input.anchor, image: input.anchor.image ? { mimeType: "image/png", attached: true } : undefined } : undefined;
  const source = input.sourceInteractionId ? board.interactions.find((item) => item.id === input.sourceInteractionId) : undefined;
  const context = {
    boardId: board.id, interactionId: input.intentId, responseRevision: board.interactions.find(item => item.id === input.intentId)?.responseRevision ?? 0, title: board.title, ownerAgentId: board.ownerAgentId,
    boardRevision: board.revision, canvasRevision: board.canvas.revision,
    anchor,
    selectionMayBeStale: !!anchor && anchor.canvasRevision !== board.canvas.revision,
    relatedDecisions: board.decisions.filter((item) => item.status !== "dismissed").slice(-12),
    data: JSON.stringify(board.canvas.data).slice(0, 24000),
    visibleText: board.canvas.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 12000),
    sourceDiscussion: source ? { id: source.id, question: source.text, response: source.response, responseRevision: source.responseRevision ?? 0, resultReferences: source.resultReferences, anchor: source.anchor ? { ...source.anchor, image: source.anchor.image ? { mimeType: "image/png", attached: true } : undefined } : undefined, responseCanvas: source.responseCanvas ? { revision: source.responseCanvas.revision, documentVersion: source.responseCanvas.documentVersion, readPath: `board_read({boardId:"${board.id}"}).interactions.find(i => i.id === "${source.id}").responseCanvas` } : undefined } : undefined,
  };
  return `${marker(board.id, input.intentId)}
User intent (${input.kind}): ${input.text}

You are responding on a persistent, fully interactive Paseo Board. The free HTML/JS canvas is the main conversation surface. You may answer with a local animation, simulator, figure, explanation or control where the user pointed. Do not require a task template or fixed component types.
Read the board using board_read / paseo-board read before publishing. For a local edit, publish a patch with a stable selector; data-only updates should preserve running controls. Whole-document replacement is explicit and may reset runtime state. Record meaningful default choices using board_decision with actual evidence and your stated reason.
${input.kind === "fork" || input.kind === "reply" ? "This fork is a separate conversation context on the same shared Board, like /btw. Follow the user's request directly: if they ask for a change, perform it and update this Board without requiring a return to the owner. The branch does not replace the Board's owner or authorize changes beyond the user's request.\n" : ""}For an explanation, use board_respond with boardId="${board.id}", interactionId="${input.intentId}", expectedResponseRevision (missing means 0), eventId, response text, and optional html/htmlFile for a visual answer at the question marker. For requested shared-canvas changes, use board_publish with boardId="${board.id}" and interactionResult.id=${input.intentId}. Read the current revision first; publish a local patch and record meaningful defaults with board_decision. Mark processing while working; mark applied only with concrete resultReferences (new canvas change, file or verified result) and an explanation of what changed. Mere receipt, a generic final reply or a completed turn is not application. If you decline, use rejected with a reason.
If the anchor's content version is old, compare its frozen quote/image/coordinates to the current board. Optional component binding helps display a marker after movement or collapse; it does not refresh the original evidence or prove the component's current content. Do not guess a replacement location when it cannot be matched. A PNG is attached when available; a selection without a PNG has limited visual context. Related decisions are source-labelled claims, not hidden reasoning or extra authorization.
<board-context-untrusted-json>
${JSON.stringify(context)}
</board-context-untrusted-json>`;
}

export class BoardService {
  readonly store: BoardStore;
  readonly journal: ServiceJournal;
  private paseo?: Paseo;
  private stopped = false;
  private flights = new Map<string, Promise<void>>();
  private preparations = new Map<string, Promise<Interaction>>();
  private agentClaims = new Set<string>();
  private histories = new Map<string, Promise<void>>();
  private outcomes = new Set<Promise<void>>();
  private subscriptions = new Map<string, ReturnType<Agent["timeline"]["subscribe"]>>();
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private scan?: Promise<void>;
  private log: (message: string) => void;

  constructor(store: BoardStore, journal: ServiceJournal, log: (message: string) => void = console.warn) {
    this.store = store; this.journal = journal; this.log = log;
  }
  capture(paseo: Paseo): void { this.paseo = paseo; }
  async requireBoard(id: string): Promise<Board> {
    const board = await this.store.read(IdSchema.parse(id));
    if (!board) throw new Error(`Board not found: ${id}`);
    return board;
  }
  private canRead(board: Board, actor: Binding): boolean {
    return board.ownerAgentId === actor.agentId || board.interactions.some((item) => item.agentId === actor.agentId);
  }
  private canWrite(board: Board, actor: Binding): boolean {
    return board.ownerAgentId === actor.agentId || board.interactions.some(item => item.kind === "fork" && item.agentId === actor.agentId);
  }
  async execute(operation: Operation, raw: unknown, actor?: Binding): Promise<unknown> {
    if (this.stopped) throw new Error("Board service is stopping");
    const input = z.record(z.string(), z.unknown()).parse(raw);
    if (operation === "list") {
      const filter = z.object({ workspaceId: z.string().optional() }).parse(input);
      const boards = await this.store.list(filter);
      if (!actor) return { boards };
      const visible = [];
      for (const summary of boards) if (this.canRead(await this.requireBoard(summary.id), actor)) visible.push(summary);
      return { boards: visible };
    }
    if (operation === "create") {
      const content = await this.withHtmlFile(input);
      const parsed = CreateInputSchema.parse(content);
      if (actor) {
        if (parsed.ownerAgentId && parsed.ownerAgentId !== actor.agentId) throw new Error("An agent may only create a board owned by itself");
        parsed.ownerAgentId = actor.agentId;
        parsed.workspaceId ??= actor.workspaceId;
      }
      const result = await this.store.create(parsed);
      void this.reconcile().catch((error) => this.log(`board reconcile: ${describe(error)}`));
      return result;
    }
    const board = await this.requireBoard(z.string().parse(input.boardId));
    if (operation === "respond") {
      const parsed = RespondInputSchema.parse(await this.withHtmlFile(input));
      const assigned = board.interactions.find(item => item.id === parsed.interactionId);
      if (!assigned) throw new Error("Interaction does not exist");
      if (actor && assigned.agentId !== actor.agentId) throw new Error("Only the agent assigned to this interaction may respond");
      return this.store.respond(parsed, actor?.agentId);
    }
    if (actor && !(operation === "read" ? this.canRead(board, actor) : this.canWrite(board, actor))) throw new Error("This agent does not own this board or belong to one of its forks");
    switch (operation) {
      case "read": return board;
      case "publish": {
        const parsed = PublishInputSchema.parse(await this.withHtmlFile(input));
        if (actor && parsed.ownerAgentId !== undefined && parsed.ownerAgentId !== board.ownerAgentId) throw new Error("Only the user can rebind board ownership");
        if (actor && parsed.interactionResult && board.interactions.find(item => item.id === parsed.interactionResult!.id)?.agentId !== actor.agentId) throw new Error("Only the agent assigned to this interaction may respond");
        if (actor && parsed.decisions) parsed.decisions = parsed.decisions.map((item) => ({ ...item, authorAgentId: actor.agentId }));
        return this.store.publish(parsed);
      }
      case "decision": {
        const parsed = DecisionUpdateInputSchema.parse(input);
        if (actor) parsed.decision.authorAgentId = actor.agentId;
        return this.store.recordDecision(parsed);
      }
      case "emit": return this.store.emit(EmitInputSchema.parse(input));
    }
  }
  private async withHtmlFile(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (input.htmlFile === undefined) return input;
    if (typeof input.htmlFile !== "string" || !isAbsolute(input.htmlFile)) throw new Error("htmlFile must be an absolute local path");
    if (input.html !== undefined) throw new Error("Use html or htmlFile, not both");
    const content = await readFile(input.htmlFile);
    if (content.byteLength > 4_000_000) throw new Error("HTML exceeds 4 MB");
    return { ...input, html: content.toString("utf8") };
  }

  async interact(raw: InteractInput): Promise<Interaction> {
    const input = InteractInputSchema.parse(raw);
    const key = deliveryKey(input.boardId, input.intentId);
    const previous = this.preparations.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.prepareInteraction(input)).finally(() => { if (this.preparations.get(key) === work) this.preparations.delete(key); });
    this.preparations.set(key, work);
    return work;
  }
  private async prepareInteraction(input: InteractInput): Promise<Interaction> {
    if (this.stopped) throw new Error("Board service stopped");
    const board = await this.requireBoard(input.boardId);
    if (!board.ownerAgentId) throw new Error("请先为这张 board 绑定负责人，再发送问题。");
    const source = input.sourceInteractionId ? board.interactions.find((item) => item.id === input.sourceInteractionId) : undefined;
    const isDiscussion = (item: Interaction | undefined): boolean => {
      const seen = new Set<string>();
      while (item && !seen.has(item.id)) {
        if (item.kind === "fork") return true;
        seen.add(item.id);
        if (item.kind !== "reply" || !item.sourceInteractionId) return false;
        const sourceId = item.sourceInteractionId;
        item = board.interactions.find((original) => original.id === sourceId);
      }
      return false;
    };
    if (input.kind === "return" && (!isDiscussion(source) || !source?.response)) throw new Error("先选择有回复的讨论分支或后续回复，再将所选建议带回主线。");
    if (input.kind === "reply" && (!isDiscussion(source) || !source?.agentId)) throw new Error("继续讨论需要一个已创建的 fork。");
    if (!input.anchor && source?.anchor && ["reply", "return"].includes(input.kind)) input = { ...input, anchor: source.anchor };
    const targetAgentId = input.kind === "reply" ? source!.agentId : input.kind === "fork" ? undefined : board.ownerAgentId;
    const key = deliveryKey(board.id, input.intentId);
    const existing = this.journal.get(key);
    if (existing?.input && JSON.stringify(existing.input) !== JSON.stringify(input)) throw new BoardStoreError("idempotency_conflict", "Intent ID already belongs to a different request");
    // The full immutable intent (including the selection snapshot and message payload) is the
    // write-ahead record. The board interaction is a recoverable user-facing projection.
    if (!existing) {
      const delivery: Delivery = {
        boardId: board.id, interactionId: input.intentId, ownerAgentId: board.ownerAgentId,
        targetAgentId, kind: input.kind, input, prompt: interactionPrompt(board, input), state: "saved",
        ...(input.anchor?.image ? { images: [{ mimeType: input.anchor.image.mimeType, data: input.anchor.image.data }] } : {}),
      };
      await this.journal.put(delivery);
    }
    const interaction = await this.store.addInteraction(input, targetAgentId);
    this.kick(key);
    return interaction;
  }

  private kick(key: string): void {
    if (this.stopped || this.flights.has(key) || !this.paseo) return;
    const work = this.dispatch(key).catch((error) => this.log(`board delivery: ${describe(error)}`)).finally(() => {
      this.flights.delete(key);
      const settled = this.journal.get(key);
      if (settled?.targetAgentId && !["saved", "creating"].includes(settled.state)) {
        const next = this.journal.all().find((item) => item.targetAgentId === settled.targetAgentId && item.state === "saved");
        if (next) this.kick(deliveryKey(next.boardId, next.interactionId));
      }
    });
    this.flights.set(key, work);
  }
  private async dispatch(key: string): Promise<void> {
    const paseo = this.paseo;
    const delivery = this.journal.get(key);
    if (!paseo || !delivery || this.stopped || !["saved", "creating"].includes(delivery.state)) return;
    let board = await this.requireBoard(delivery.boardId);
    const interaction = board.interactions.find((item) => item.id === delivery.interactionId);
    if (!interaction) return;
    if (terminal.has(interaction.status)) { await this.journal.settleUnsent(key); return; }
    if (board.ownerAgentId !== delivery.ownerAgentId) { await this.fail(delivery, "负责人已变更，旧请求未自动发给其他 agent。"); return; }
    let claimedAgent: string | undefined;
    try {
      if (delivery.kind === "fork" && !delivery.targetAgentId) {
        const source = await paseo.agents.ref(delivery.ownerAgentId).refresh();
        if (!source || source.agent.archivedAt) throw new Error("负责人已归档或不可用，无法创建讨论分支。");
        const config = await discussionConfig(paseo, source.agent);
        if (this.stopped) return;
        delivery.state = "creating";
        await this.journal.put(delivery);
        await this.store.updateInteraction(board.id, interaction.id, { status: "sending" });
        const options = {
          config, title: `Board · ${board.title.slice(0, 80)}`,
          idempotencyKey: `paseo-board-fork:${board.id}:${interaction.id}`,
          labels: { "paseo-board.id": board.id, "paseo-board.interaction": interaction.id, "paseo-board.role": "discussion" },
        };
        // A source link is sufficient; actual parent relationships cause cascade archival.
        const fork = board.workspaceId
          ? await paseo.workspaces.ref(board.workspaceId).agents.create(options)
          : await paseo.agents.create({ ...options, cwd: source.agent.cwd });
        delivery.targetAgentId = fork.id;
        delivery.state = "saved";
        await this.journal.put(delivery);
        await this.store.updateInteraction(board.id, interaction.id, { agentId: fork.id });
      }
      if (!delivery.targetAgentId) throw new Error("No agent is assigned to this interaction");
      // Object insertion order is the persisted journal order (keys are board/id, never numeric).
      // A newly submitted intent cannot jump ahead while an older turn's receipt is settling.
      const head = this.journal.all().find((item) => item.targetAgentId === delivery.targetAgentId && item.state === "saved");
      if (head && deliveryKey(head.boardId, head.interactionId) !== key) { this.kick(deliveryKey(head.boardId, head.interactionId)); return; }
      if (this.agentClaims.has(delivery.targetAgentId)) return;
      if (this.journal.all().some((item) => item.targetAgentId === delivery.targetAgentId && deliveryKey(item.boardId, item.interactionId) !== key && item.awaitingTurn && (item.state === "sending" || item.state === "delivered"))) return;
      claimedAgent = delivery.targetAgentId;
      this.agentClaims.add(claimedAgent);
      const target = paseo.agents.ref(delivery.targetAgentId);
      const fresh = await target.refresh();
      if (!fresh || fresh.agent.archivedAt || fresh.agent.status === "closed") throw new Error("目标 agent 已停止或归档，请重新绑定负责人。");
      if (isBusy(fresh.agent)) return; // Durable queue; lifecycle or bounded timer retries when idle.
      await this.watch(delivery.targetAgentId);
      board = await this.requireBoard(delivery.boardId);
      if (this.stopped || board.ownerAgentId !== delivery.ownerAgentId) return;
      if (board.interactions.some(item => item.id === interaction.id && terminal.has(item.status))) { await this.journal.settleUnsent(key); return; }
      delivery.state = "sending";
      delivery.awaitingTurn = true;
      await this.journal.put(delivery);
      await this.store.updateInteraction(board.id, interaction.id, { status: "sending", agentId: delivery.targetAgentId });
      const finalBoard = await this.requireBoard(board.id);
      if (this.stopped) return;
      if (finalBoard.ownerAgentId !== delivery.ownerAgentId) { await this.fail(delivery, "发送前负责人已变更；旧请求未投递。"); return; }
      try {
        // SDK has no atomic idle-only enqueue; steer minimizes the refresh/send race.
        await target.send(delivery.prompt, { messageId: `paseo-board:${board.id}:${interaction.id}`, activeTurnBehavior: "steer", images: delivery.images });
      } catch (error) {
        if (this.journal.get(key)?.state === "delivered") return; // Matching timeline evidence is stronger than a lost send acknowledgement.
        delivery.state = "unknown";
        delivery.error = `送达结果未知：${describe(error)}。请核对原会话；系统不会自动重发。`;
        await this.journal.patch(key, { state: delivery.state, error: delivery.error });
        await this.store.updateInteraction(board.id, interaction.id, { status: "failed", error: delivery.error });
        return;
      }
      delivery.state = "delivered";
      // A fast model may finish while send() is awaiting its acknowledgement. Merge only
      // acceptance, preserving any response fragments, turn ID and completion already observed.
      await this.journal.patch(key, { state: "delivered" });
      const current = (await this.requireBoard(board.id)).interactions.find((item) => item.id === interaction.id);
      if (current && (current.status === "sending" || current.status === "saved")) await this.store.updateInteraction(board.id, interaction.id, { status: "delivered", error: undefined });
      this.scheduleHistory(delivery.targetAgentId);
    } catch (error) {
      if (delivery.state === "creating") {
        // A create response can be lost after the native resource exists. Preserve its key for reconciliation.
        delivery.error = `讨论分支创建结果待核对：${describe(error)}`;
        await this.journal.put(delivery);
        await this.store.updateInteraction(delivery.boardId, delivery.interactionId, { status: "failed", error: delivery.error });
      } else await this.fail(delivery, describe(error));
    } finally { if (claimedAgent) this.agentClaims.delete(claimedAgent); }
  }
  private async fail(delivery: Delivery, error: string): Promise<void> {
    delivery.state = "failed"; delivery.error = error;
    await this.journal.put(delivery);
    await this.store.updateInteraction(delivery.boardId, delivery.interactionId, { status: "failed", error });
  }

  private scheduleHistory(agentId: string): void {
    if (this.stopped || this.refreshTimers.has(agentId)) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(agentId);
      void this.syncHistory(agentId).catch((error) => this.log(`board history: ${describe(error)}`));
    }, 350);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.refreshTimers.set(agentId, timer);
  }
  private async watch(agentId: string): Promise<void> {
    if (this.stopped || !this.paseo || this.subscriptions.has(agentId)) return;
    const subscription = this.paseo.agents.ref(agentId).timeline.subscribe((update) => {
      if (update.event.type === "error") { this.subscriptions.get(agentId)?.(); this.subscriptions.delete(agentId); return; }
      if (update.event.type === "replacement") {
        void this.journal.progress(agentId, undefined, undefined).then(() => this.scheduleHistory(agentId));
      } else if (update.event.type === "turn_completed" || update.event.type === "turn_failed" || update.event.type === "turn_canceled") {
        const outcome = update.event.type === "turn_completed" ? "completed" : update.event.type === "turn_failed" ? "failed" : "canceled";
        void this.onTurnEnded(agentId, outcome, update.event.turnId).catch(error => this.log(`board turn outcome: ${describe(error)}`));
      } else if (update.event.type === "subscription_restored" || (update.event.type === "timeline" && (update.event.item.type === "assistant_message" || update.event.item.type === "user_message"))) this.scheduleHistory(agentId);
    });
    this.subscriptions.set(agentId, subscription);
    try { await subscription.ready; }
    catch (error) { subscription(); this.subscriptions.delete(agentId); throw error; }
    if (this.stopped) { subscription(); this.subscriptions.delete(agentId); return; }
    // The subscription is live-only. Pull missed history, also after subscription_restored events.
    this.scheduleHistory(agentId);
  }
  async syncHistory(agentId: string): Promise<void> {
    const running = this.histories.get(agentId);
    if (running) return running;
    const work = this.readHistory(agentId).finally(() => this.histories.delete(agentId));
    this.histories.set(agentId, work);
    return work;
  }
  private async readHistory(agentId: string): Promise<void> {
    if (!this.paseo || this.stopped) return;
    const agent = this.paseo.agents.ref(agentId);
    let cursor = this.journal.cursor(agentId);
    const initialRead = !cursor;
    let active = this.journal.active(agentId);
    const summaries = (await this.store.list()).filter((board) => board.ownerAgentId === agentId);
    let budget = 8;
    for (let round = 0; round < 8 && !this.stopped; round++) {
      const page = await agent.timeline.refetch({ direction: cursor ? "after" : "tail", ...(cursor ? { cursor } : {}), limit: 200, projection: "canonical" });
      if (page.error) throw new Error(page.error);
      // Polling/reconnect verification is not a board mutation. Empty pages must neither
      // advance revisions nor retrigger clients and conflict with their real publishes.
      if (page.entries.length === 0 && !page.reset && !page.staleCursor) break;
      if (page.reset || page.staleCursor) active = undefined;
      for (const entry of page.entries) {
        if (entry.item.type === "user_message") {
          const match = /^\[paseo-board board=([a-zA-Z0-9_.:-]+) intent=([a-zA-Z0-9_.:-]+)\]/.exec(entry.item.text);
          const key = match ? deliveryKey(match[1], match[2]) : undefined;
          const delivery = key ? this.journal.get(key) : undefined;
          if (active && active !== key) {
            const previous = this.journal.get(active);
            if (previous?.awaitingTurn && !previous.outcome) await this.journal.patch(active, { needsRecovery: true });
          }
          active = delivery?.targetAgentId === agentId && delivery.prompt === entry.item.text ? key : undefined;
          if (active && delivery) {
            if (delivery.state === "unknown" || delivery.state === "sending") { delivery.state = "delivered"; delivery.error = undefined; }
            if (entry.turnId) delivery.turnId = entry.turnId;
            if (page.reset || page.staleCursor) delivery.responseChunks = {};
            await this.journal.put(delivery);
            const board = await this.requireBoard(delivery.boardId);
            const current = board.interactions.find((item) => item.id === delivery.interactionId);
            if (current && current.responseSource !== "explicit" && !terminal.has(current.status) && !delivery.outcome && current.status !== "processing") await this.store.updateInteraction(board.id, current.id, { status: "processing", error: undefined });
          }
          continue;
        }
        if (entry.item.type !== "assistant_message") continue;
        if (active) {
          const delivery = this.journal.get(active);
          if (delivery) {
            const board = await this.requireBoard(delivery.boardId);
            const current = board.interactions.find((item) => item.id === delivery.interactionId);
            if (current && board.ownerAgentId === delivery.ownerAgentId && (!terminal.has(current.status) || (current.status === "answered" && delivery.outcome === "completed")) && (!delivery.outcome || delivery.outcome === "completed") && current.responseSource !== "explicit") {
              // Journal each externally visible fragment before projecting a complete reply.
              // A crash before the cursor write replays the same key and cannot append it twice.
              delivery.responseChunks ??= {};
              const fragments = Object.entries(delivery.responseChunks);
              const contained = fragments.some(([, chunk]) => (chunk.epoch ?? page.epoch) === page.epoch && chunk.seq <= entry.seqStart && (chunk.end ?? chunk.seq) > entry.seqEnd);
              if (!contained) {
                // The SDK may return a merged projected interval even after an earlier cursor.
                // Its full replacement text supersedes overlapping old fragments.
                for (const [key, chunk] of fragments) if ((chunk.epoch ?? page.epoch) === page.epoch && chunk.seq <= entry.seqEnd && (chunk.end ?? chunk.seq) >= entry.seqStart) delete delivery.responseChunks[key];
                delivery.responseChunks[`${page.epoch}:${entry.seqStart}`] = { seq: entry.seqStart, end: entry.seqEnd, epoch: page.epoch, text: entry.item.text };
              }
              if (entry.turnId) delivery.turnId = entry.turnId;
              await this.journal.put(delivery);
              const response = Object.values(delivery.responseChunks).sort((a, b) => a.seq - b.seq).map((chunk) => chunk.text).join("").slice(-64000);
              const status = current.status === "answered" ? "answered" : "processing";
              if (response !== current.response || current.status !== status) await this.store.updateInteraction(board.id, current.id, { status, response, responseSource: "timeline" });
            }
          }
        }
        const activeBoardId = active ? this.journal.get(active)?.boardId : undefined;
        const attributed = activeBoardId ? summaries.filter((summary) => summary.id === activeBoardId) : summaries.length === 1 ? summaries : [];
        for (const summary of attributed) {
          if (entry.timestamp < summary.createdAt || budget <= 0) continue;
          for (const candidate of extractCandidates(agentId, page.epoch, entry)) {
            let board = await this.requireBoard(summary.id);
            if (board.decisions.some((item) => item.id === candidate.id || item.choice === candidate.choice)) continue;
            // One retry for a concurrent canvas update; never overwrite it.
            for (let attempt = 0; attempt < 2; attempt++) {
              try { await this.store.recordDecision({ boardId: board.id, expectedRevision: board.revision, eventId: `extract-${candidate.id}`, decision: candidate }); budget--; break; }
              catch (error) { if ((error as { code?: string }).code !== "revision_conflict" || attempt > 0) throw error; board = await this.requireBoard(board.id); }
            }
          }
        }
      }
      cursor = page.endCursor ?? cursor;
      await this.journal.progress(agentId, cursor, active);
      for (const summary of summaries) {
        await this.store.updateExtraction(summary.id, { agentId, lastCheckedAt: new Date().toISOString(), cursor: cursor ? JSON.stringify(cursor) : undefined,
          note: budget <= 0 ? "本次候选达到 8 条上限，可能存在未提取的选择；不代表完整覆盖。" : page.hasOlder && round === 0 && initialRead ? "仅检查最近 200 条可见消息；更早记录未覆盖。" : "仅检查外显 assistant 文字；推断是候选，非完整决策记录。未扫描用户消息、隐藏思考或任意工具参数。" });
      }
      if (!page.hasNewer || !page.endCursor) break;
    }
    // A completed event can arrive while another history pull is in flight. Late canonical
    // final text must still settle that exact turn instead of being dropped forever.
    for (const delivery of this.journal.all()) if (delivery.targetAgentId === agentId && delivery.outcome) await this.applyOutcome(delivery);
    await this.recoverMissedTurn(agentId);
  }

  private async applyOutcome(delivery: Delivery): Promise<void> {
    if (!delivery.outcome) return;
    const board = await this.requireBoard(delivery.boardId);
    const interaction = board.interactions.find((item) => item.id === delivery.interactionId);
    if (!interaction || terminal.has(interaction.status)) return;
    if (delivery.outcome === "completed" && interaction.responseSource !== "explicit" && ["question", "fork", "reply"].includes(delivery.kind) && interaction.response?.trim()) {
      if (interaction.status === "failed") await this.store.updateInteraction(board.id, interaction.id, { status: "processing", error: undefined });
      await this.store.updateInteraction(board.id, interaction.id, { status: "answered", error: undefined });
    } else if (delivery.outcome === "completed" && interaction.responseSource === "explicit" && interaction.status === "processing") {
      // An explicit progress receipt can outlive this model turn (for example async-shell).
      // Turn completion neither completes nor fails the user's longer-running request.
      return;
    } else if (delivery.outcome === "completed" && ["question", "fork", "reply"].includes(delivery.kind) && !interaction.response?.trim() && interaction.status !== "failed") {
      await this.store.updateInteraction(board.id, interaction.id, { status: "failed", error: "对应回合已结束，但没有收到可显示的回答。可以在这个位置继续提问。" });
    } else if (delivery.outcome !== "completed" && interaction.status !== "failed") {
      await this.store.updateInteraction(board.id, interaction.id, { status: "failed", error: delivery.outcome === "canceled" ? "对应的 agent 回合已取消；已保留收到的部分回复。" : "对应的 agent 回合失败；已保留收到的部分回复。" });
    }
  }
  private async recoverMissedTurn(agentId: string): Promise<void> {
    const uncertain = this.journal.all().filter((item) => item.targetAgentId === agentId && item.needsRecovery && item.awaitingTurn && item.state === "delivered" && !item.outcome);
    if (!uncertain.length || !this.paseo) return;
    const fresh = await this.paseo.agents.ref(agentId).refresh();
    if (!fresh || isBusy(fresh.agent)) return;
    for (const delivery of uncertain) {
      // Idle only proves no turn is running now. It does NOT prove the old turn succeeded.
      delivery.error = "服务恢复时 agent 已空闲，但对应回合的结束事件未收到；已保存回复，完成结果未知。可以继续提问。";
      await this.journal.patch(deliveryKey(delivery.boardId, delivery.interactionId), { awaitingTurn: false, needsRecovery: false, error: delivery.error });
      const board = await this.requireBoard(delivery.boardId);
      const interaction = board.interactions.find((item) => item.id === delivery.interactionId);
      if (interaction && !terminal.has(interaction.status)) await this.store.updateInteraction(board.id, interaction.id, { status: "failed", error: delivery.error });
    }
    for (const delivery of this.journal.all()) if (delivery.targetAgentId === agentId && delivery.state === "saved") this.kick(deliveryKey(delivery.boardId, delivery.interactionId));
  }
  async onTurnEnded(agentId: string, outcome: "completed" | "failed" | "canceled" = "completed", turnId?: string | null): Promise<void> {
    if (this.stopped) return;
    const work = this.finishTurn(agentId, outcome, turnId);
    this.outcomes.add(work);
    try { await work; } finally { this.outcomes.delete(work); }
  }
  private async finishTurn(agentId: string, outcome: "completed" | "failed" | "canceled", turnId?: string | null): Promise<void> {
    const relevant = (await this.store.list()).some((board) => board.ownerAgentId === agentId) || this.journal.all().some((item) => item.targetAgentId === agentId);
    if (!relevant) return; // Lifecycle hooks are global; never inspect unrelated agents' conversations.
    await this.syncHistory(agentId);
    const matching = turnId ? this.journal.all().find((item) => item.targetAgentId === agentId && item.turnId === turnId && !item.outcome) : undefined;
    const currentKey = matching ? deliveryKey(matching.boardId, matching.interactionId) : this.journal.active(agentId);
    const currentDelivery = currentKey ? this.journal.get(currentKey) : undefined;
    if (currentDelivery && !currentDelivery.outcome && (!turnId || !currentDelivery.turnId || turnId === currentDelivery.turnId)) {
      const completed = await this.journal.patch(currentKey!, { awaitingTurn: false, needsRecovery: false, outcome });
      await this.applyOutcome(completed);
    }
    // Completion may yield an explanation; it never proves an intent was applied.
    await this.reconcile();
  }
  async reconcile(): Promise<void> {
    if (this.scan) return this.scan;
    this.scan = this.reconcileNow().finally(() => { this.scan = undefined; });
    return this.scan;
  }
  private async reconcileNow(): Promise<void> {
    if (this.stopped || !this.paseo) return;
    const boards = await this.store.list();
    const wanted = new Set(boards.flatMap((board) => board.ownerAgentId ? [board.ownerAgentId] : []));
    // Recover an old-version interruption between the board projection and its delivery record.
    for (const summary of boards) {
      const board = await this.requireBoard(summary.id);
      for (const interaction of board.interactions) {
        if (interaction.status !== "saved" || this.journal.get(deliveryKey(board.id, interaction.id))) continue;
        const input = { boardId: board.id, intentId: interaction.id, kind: interaction.kind, text: interaction.text, anchor: interaction.anchor, sourceInteractionId: interaction.sourceInteractionId };
        if (!board.ownerAgentId) { await this.store.updateInteraction(board.id, interaction.id, { status: "failed", error: "请求已保存，但未绑定负责人。" }); continue; }
        const ownerAgentId = ["question", "change", "return"].includes(interaction.kind) ? interaction.agentId ?? board.ownerAgentId : board.ownerAgentId;
        const targetAgentId = interaction.agentId ?? (["question", "change", "return"].includes(interaction.kind) ? ownerAgentId : undefined);
        await this.journal.put({ boardId: board.id, interactionId: interaction.id, kind: interaction.kind, ownerAgentId, targetAgentId, input, prompt: interactionPrompt(board, input), state: "saved", ...(interaction.anchor?.image ? { images: [interaction.anchor.image] } : {}) });
      }
    }
    for (const delivery of this.journal.all()) {
      let board = await this.requireBoard(delivery.boardId);
      let interaction = board.interactions.find((item) => item.id === delivery.interactionId);
      if (!interaction && delivery.input) {
        interaction = await this.store.addInteraction(delivery.input, delivery.targetAgentId);
        board = await this.requireBoard(delivery.boardId);
      }
      if (interaction && terminal.has(interaction.status) && ["saved", "creating"].includes(delivery.state)) {
        await this.journal.settleUnsent(deliveryKey(delivery.boardId, delivery.interactionId));
        continue;
      }
      if (delivery.outcome) await this.applyOutcome(delivery);
      if (delivery.targetAgentId && delivery.state !== "failed" && interaction && !terminal.has(interaction.status)) wanted.add(delivery.targetAgentId);
      if (delivery.awaitingTurn && interaction && terminal.has(interaction.status)) { delivery.awaitingTurn = false; await this.journal.put(delivery); }
      if (delivery.state === "unknown") {
        const board = await this.requireBoard(delivery.boardId);
        const current = board.interactions.find((item) => item.id === delivery.interactionId);
        if (current && !terminal.has(current.status)) await this.store.updateInteraction(board.id, current.id, { status: "failed", error: delivery.error ?? "送达结果未知，请核对原会话。" });
      }
      if (delivery.state === "saved" || delivery.state === "creating") this.kick(deliveryKey(delivery.boardId, delivery.interactionId));
    }
    for (const agentId of [...wanted].slice(0, 100)) {
      try { await this.watch(agentId); } catch (error) { this.log(`board subscribe ${agentId}: ${describe(error)}`); }
    }
    for (const [id, subscription] of this.subscriptions) if (!wanted.has(id)) { subscription(); this.subscriptions.delete(id); }
  }
  async drain(includeOutcomes = false): Promise<void> {
    while (this.preparations.size || this.flights.size || this.histories.size || (includeOutcomes && this.outcomes.size) || this.scan) {
      await Promise.all([...this.preparations.values(), ...this.flights.values(), ...this.histories.values(), ...(includeOutcomes ? this.outcomes : []), ...(this.scan ? [this.scan] : [])]);
    }
    await this.journal.idle();
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    for (const subscription of this.subscriptions.values()) subscription();
    this.refreshTimers.clear(); this.subscriptions.clear();
    await this.drain(true);
  }
}
