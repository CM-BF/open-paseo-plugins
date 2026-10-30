import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  BoardSchema, CreateInputSchema, DecisionUpdateInputSchema, EmitInputSchema, InteractInputSchema,
  InteractionSchema, PublishInputSchema, RespondInputSchema, StateInputSchema, MarkUpdatesSeenInputSchema,
  type Board, type BoardSummary, type CreateInput, type DecisionInput, type EmitInput, type CanvasUpdate,
  type InteractInput, type Interaction, type PublishInput, type RespondInput, type MarkUpdatesSeenInput,
} from "../shared/contracts";
import { assertId, assertJson, BoardStoreError, canonicalJson, ensureDirectory, fingerprint, parseInput, readEnvelope, serialized, writeEnvelope, type Envelope } from "./store-format";

export { BoardStoreError } from "./store-format";
export type InteractionUpdate = Partial<Pick<Interaction, "status" | "agentId" | "response" | "responseRevision" | "responseSource" | "responseMethod" | "responseCanvas" | "resultReferences" | "error">>;
type DecisionUpdateInput = z.input<typeof DecisionUpdateInputSchema>;
type StateInput = z.input<typeof StateInputSchema>;
type Mutation = (board: Board, at: string) => void;

const InteractionUpdateSchema = InteractionSchema.pick({ status: true, agentId: true, response: true, responseRevision: true, responseSource: true, responseMethod: true, responseCanvas: true, resultReferences: true, error: true }).partial();
const transitions: Record<Interaction["status"], readonly Interaction["status"][]> = {
  saved: ["sending", "delivered", "processing", "answered", "applied", "rejected", "failed"],
  sending: ["delivered", "processing", "answered", "applied", "rejected", "failed"],
  delivered: ["processing", "answered", "applied", "rejected", "failed"],
  processing: ["answered", "applied", "rejected", "failed"],
  failed: ["sending", "processing", "answered", "applied", "rejected"],
  answered: ["applied"], applied: [], rejected: [],
};

export class BoardStore {
  readonly rootDir: string;
  private readonly directory: string;
  private initialization?: Promise<void>;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.directory = join(this.rootDir, "boards");
  }

  init(): Promise<void> {
    this.initialization ??= this.initialize();
    return this.initialization;
  }

  private async initialize(): Promise<void> {
    await ensureDirectory(this.rootDir);
    await ensureDirectory(this.directory);
    for (const filename of await readdir(this.directory)) {
      if (filename.endsWith(".json")) {
        const id = assertId(filename.slice(0, -5));
        await serialized(this.path(id), () => readEnvelope(this.path(id), id));
      }
    }
  }

  async list(filter: { workspaceId?: string } = {}): Promise<BoardSummary[]> {
    await this.init();
    const boards = await Promise.all((await readdir(this.directory)).filter(name => name.endsWith(".json")).map(name => this.read(name.slice(0, -5))));
    return boards.filter((board): board is Board => board !== null && (filter.workspaceId === undefined || board.workspaceId === filter.workspaceId))
      .map(({ id, title, projectId, workspaceId, ownerAgentId, revision, createdAt, updatedAt, decisions, interactions, updates, seenUpdateIds }) => ({
        id, title, projectId, workspaceId, ownerAgentId, revision, createdAt, updatedAt,
        decisionCount: decisions.filter(item => item.status !== "dismissed" && item.status !== "superseded").length,
        pendingCount: interactions.filter(item => !["answered", "applied", "rejected"].includes(item.status)).length,
        unreadUpdateCount: updates.filter(item => !seenUpdateIds.includes(item.id)).length,
        latestUpdateRevision: updates.at(-1)?.boardRevision ?? 0,
      })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async read(boardId: string): Promise<Board | null> {
    const path = this.path(boardId);
    await this.init();
    return serialized(path, async () => (await readEnvelope(path, boardId))?.board ?? null);
  }

  async create(raw: CreateInput): Promise<Board> {
    const input = parseInput(CreateInputSchema, raw);
    assertJson(input.data, "Canvas data");
    const id = assertId(input.id ?? randomUUID());
    const payload = { ...input, id };
    const digest = fingerprint("create", payload);
    const path = this.path(id);
    await this.init();
    return serialized(path, async () => {
      const existing = await readEnvelope(path, id);
      if (existing) {
        if (!this.checkReceipt(existing, `create:${id}`, digest)) throw new BoardStoreError("idempotency_conflict", `Board ${id} already exists`);
        return existing.board;
      }
      const at = new Date().toISOString();
      const board = BoardSchema.parse({
        ...input, id, schemaVersion: 1, revision: 1, createdAt: at, updatedAt: at,
        canvas: { revision: 1, documentVersion: 1, html: input.html, data: input.data, patches: [] },
        decisions: [], interactions: [], observations: [], userState: {}, extraction: {},
        events: [{ id: `create:${fingerprint("board-id", id).slice(0, 32)}`, source: "board", kind: "created", summary: "Board created", at, revision: 1 }],
      });
      const envelope: Envelope = { storageVersion: 1, board, receipts: [{ key: `create:${id}`, fingerprint: digest, revision: 1 }], history: [{ revision: 1, at, operation: "create", payload }] };
      await writeEnvelope(path, envelope);
      return board;
    });
  }

  async publish(raw: PublishInput, actorAgentId?: string): Promise<Board> {
    const input = parseInput(PublishInputSchema, raw);
    if (input.html !== undefined && input.patch !== undefined) throw new BoardStoreError("invalid_input", "Publish accepts either a full document or a patch, not both");
    if (input.focusSelectors !== undefined && (input.data === undefined || input.html !== undefined || input.patch !== undefined)) throw new BoardStoreError("invalid_input", "focusSelectors describe data-only canvas updates");
    if (input.data !== undefined) assertJson(input.data, "Canvas data");
    return this.mutate(input.boardId, "publish", input, (board, at) => {
      this.expectRevision(board, input.expectedRevision);
      if (input.title !== undefined) board.title = input.title;
      if (input.ownerAgentId !== undefined) board.ownerAgentId = input.ownerAgentId;
      if (input.html !== undefined) {
        board.canvas.html = input.html;
        board.canvas.documentVersion++;
        board.canvas.patches = [];
      }
      if (input.patch) {
        if (board.canvas.patches.some(patch => patch.id === input.patch!.id)) throw new BoardStoreError("idempotency_conflict", `Patch ${input.patch.id} already exists in this document`);
        board.canvas.patches.push(input.patch);
      }
      const nextData = input.data === undefined ? board.canvas.data : { ...board.canvas.data, ...input.data };
      const dataChanged = canonicalJson(nextData) !== canonicalJson(board.canvas.data);
      board.canvas.data = nextData;
      if (input.html !== undefined || input.patch !== undefined || dataChanged) {
        board.canvas.revision++;
        const kind = input.html !== undefined ? "document" : input.patch ? "patch" : "data";
        const targets = input.patch ? [{ selector: input.patch.selector, operation: input.patch.operation, patchId: input.patch.id }] : kind === "data" ? [...new Set(input.focusSelectors ?? [])].map(selector => ({ selector })) : [];
        this.canvasUpdate(board, input.eventId, at, kind, targets, actorAgentId);
      }
      for (const decision of input.decisions ?? []) this.putDecision(board, decision, at);
      if (input.interactionResult) {
        const { id, ...update } = input.interactionResult;
        const current = board.interactions.find(item => item.id === id);
        this.changeInteraction(board, id, { ...update, error: undefined, responseSource: "explicit", responseMethod: "publish", responseRevision: (current?.responseRevision ?? 0) + 1 }, at);
      }
      this.event(board, input.eventId, "agent", "publish", input.summary, at);
    }, input.eventId);
  }

  async respond(raw: RespondInput, actorAgentId?: string): Promise<Interaction> {
    const input = parseInput(RespondInputSchema, raw);
    if (input.html !== undefined && input.patch !== undefined) throw new BoardStoreError("invalid_input", "Respond accepts either a full document or a patch, not both");
    if (input.data !== undefined) assertJson(input.data, "Response data");
    const board = await this.mutate(input.boardId, "respond", input, (board, at) => {
      const interaction = board.interactions.find(item => item.id === input.interactionId);
      if (!interaction) throw new BoardStoreError("not_found", "Interaction does not exist");
      // Check assignment inside the serialized mutation as well as at the transport boundary.
      if (actorAgentId && interaction.agentId !== actorAgentId) throw new BoardStoreError("forbidden", "Only the agent assigned to this interaction may respond");
      const currentRevision = interaction.responseRevision ?? 0;
      if (currentRevision !== input.expectedResponseRevision) throw new BoardStoreError("revision_conflict", `Response changed: expected revision ${input.expectedResponseRevision}, current revision ${currentRevision}`, { currentResponseRevision: currentRevision });
      const update: InteractionUpdate = { status: input.status, response: input.response, responseSource: "explicit", responseMethod: "respond", responseRevision: currentRevision + 1, error: undefined };
      if (input.resultReferences !== undefined) update.resultReferences = input.resultReferences;
      if (input.html !== undefined || input.patch !== undefined || input.data !== undefined) {
        if (input.patch && !interaction.responseCanvas) throw new BoardStoreError("invalid_input", "Publish response HTML before applying a response patch");
        const canvas = structuredClone(interaction.responseCanvas ?? { revision: 0, documentVersion: 0, html: "", data: {}, patches: [] });
        if (input.html !== undefined) { canvas.html = input.html; canvas.documentVersion++; canvas.patches = []; }
        if (input.patch) {
          if (canvas.patches.some(patch => patch.id === input.patch!.id)) throw new BoardStoreError("idempotency_conflict", `Response patch ${input.patch.id} already exists`);
          canvas.patches.push(input.patch);
        }
        if (input.data !== undefined) canvas.data = { ...canvas.data, ...input.data };
        canvas.revision++;
        update.responseCanvas = canvas;
      }
      this.changeInteraction(board, input.interactionId, update, at);
      this.event(board, input.eventId, "agent", "response", input.response.slice(0, 4000), at);
    }, input.eventId);
    return board.interactions.find(item => item.id === input.interactionId)!;
  }

  async emit(raw: EmitInput, actorAgentId?: string): Promise<Board> {
    const input = parseInput(EmitInputSchema, raw);
    if (input.focusSelectors !== undefined && input.data === undefined) throw new BoardStoreError("invalid_input", "focusSelectors require canvas data");
    if (input.data !== undefined) assertJson(input.data, "Event data");
    if (input.observation) assertJson(input.observation.value, "Observation value");
    return this.mutate(input.boardId, "emit", input, (board, at) => {
      if (input.data !== undefined) {
        const nextData = { ...board.canvas.data, ...input.data };
        if (canonicalJson(nextData) !== canonicalJson(board.canvas.data)) {
          board.canvas.data = nextData;
          board.canvas.revision++;
          this.canvasUpdate(board, input.eventId, at, "data", [...new Set(input.focusSelectors ?? [])].map(selector => ({ selector })), actorAgentId);
        }
      }
      if (input.observation) this.observe(board, input, at);
      this.event(board, input.eventId, input.source, input.kind, input.summary, at, input.data);
    }, input.eventId);
  }

  async recordDecision(raw: DecisionUpdateInput): Promise<Board> {
    const input = parseInput(DecisionUpdateInputSchema, raw);
    return this.mutate(input.boardId, "decision", input, (board, at) => {
      this.expectRevision(board, input.expectedRevision);
      this.putDecision(board, input.decision, at);
      this.event(board, input.eventId, "agent", "decision", input.decision.choice, at);
    }, input.eventId);
  }

  async saveState(raw: StateInput): Promise<Board> {
    const input = parseInput(StateInputSchema, raw);
    assertJson(input.state, "User state");
    return this.mutate(input.boardId, "state", input, board => {
      board.userState = { ...board.userState, ...input.state };
      assertJson(board.userState, "User state");
    });
  }

  /** User attention state is independent of author state and content revisions. */
  async markUpdatesSeen(raw: MarkUpdatesSeenInput): Promise<Board> {
    const input = parseInput(MarkUpdatesSeenInputSchema, raw);
    const path = this.path(input.boardId);
    await this.init();
    return serialized(path, async () => {
      const envelope = await readEnvelope(path, input.boardId);
      if (!envelope) throw new BoardStoreError("not_found", `Board ${input.boardId} does not exist`);
      const seen = new Set([...envelope.board.seenUpdateIds, ...input.updateIds]);
      // Unknown/pruned IDs never acknowledge future updates; repeats are a no-op.
      const next = envelope.board.updates.filter(update => seen.has(update.id)).map(update => update.id);
      if (canonicalJson(next) === canonicalJson(envelope.board.seenUpdateIds)) return envelope.board;
      envelope.board.seenUpdateIds = next;
      await writeEnvelope(path, envelope);
      return envelope.board;
    });
  }

  async addInteraction(raw: InteractInput, agentId?: string, sourceSnapshot?: Interaction["sourceSnapshot"]): Promise<Interaction> {
    const input = parseInput(InteractInputSchema, raw);
    const payload = sourceSnapshot ? { ...input, sourceSnapshot } : input;
    const board = await this.mutate(input.boardId, "interaction", payload, (board, at) => {
      if (input.anchor && (input.anchor.boardRevision > board.revision || input.anchor.canvasRevision > board.canvas.revision)) throw new BoardStoreError("invalid_input", "Selection refers to a future board or canvas revision");
      if (input.sourceInteractionId && !board.interactions.some(item => item.id === input.sourceInteractionId)) throw new BoardStoreError("not_found", "Source interaction does not exist");
      board.interactions.push(InteractionSchema.parse({ ...payload, id: input.intentId, agentId, status: "saved", createdAt: at, updatedAt: at }));
      this.event(board, input.intentId, "user", input.kind, input.text.slice(0, 4000), at);
    }, input.intentId);
    return board.interactions.find(item => item.id === input.intentId)!;
  }

  async updateInteraction(boardId: string, id: string, raw: InteractionUpdate): Promise<Interaction> {
    assertId(id);
    const update = parseInput(InteractionUpdateSchema, raw);
    const board = await this.mutate(boardId, "interaction-update", { id, ...update }, (board, at) => this.changeInteraction(board, id, update, at));
    return board.interactions.find(item => item.id === id)!;
  }

  /** Side routing is owned by the service journal; this is its versioned UI projection. */
  async projectSideAgent(boardId: string, route: { agentId?: string; pendingInteractionId?: string; version: number }): Promise<Board> {
    return this.mutate(boardId, "side-agent", route, (board, at) => {
      if ((board.sideAgentRevision ?? 0) >= route.version) return;
      board.sideAgentId = route.agentId;
      board.pendingSideInteractionId = route.pendingInteractionId;
      board.sideAgentRevision = route.version;
      this.event(board, `side-agent:${route.version}`, "user", "side-agent", route.pendingInteractionId ? "Creating a side conversation" : "Side conversation selected", at);
    });
  }

  async updateExtraction(boardId: string, raw: Partial<Board["extraction"]>): Promise<Board> {
    const update = parseInput(BoardSchema.shape.extraction, raw);
    const path = this.path(boardId);
    await this.init();
    return serialized(path, async () => {
      const envelope = await readEnvelope(path, boardId);
      if (!envelope) throw new BoardStoreError("not_found", `Board ${boardId} does not exist`);
      const next = { ...envelope.board.extraction, ...update };
      if (canonicalJson(next) === canonicalJson(envelope.board.extraction)) return envelope.board;
      // Scan checkpoints are operational metadata. Persist them atomically with current
      // content, while leaving user-visible revisions and the content journal untouched.
      envelope.board.extraction = next;
      await writeEnvelope(path, envelope);
      return envelope.board;
    });
  }

  private path(id: string): string { return join(this.directory, `${assertId(id)}.json`); }

  private async mutate(boardId: string, operation: string, payload: unknown, change: Mutation, eventId?: string): Promise<Board> {
    const path = this.path(boardId);
    const digest = fingerprint(operation, payload);
    await this.init();
    return serialized(path, async () => {
      const envelope = await readEnvelope(path, boardId);
      if (!envelope) throw new BoardStoreError("not_found", `Board ${boardId} does not exist`);
      if (eventId && this.checkReceipt(envelope, eventId, digest)) return envelope.board;
      const before = canonicalJson(envelope.board);
      const at = new Date().toISOString();
      change(envelope.board, at);
      if (!eventId && canonicalJson(envelope.board) === before) return envelope.board;
      envelope.board.revision++;
      envelope.board.updatedAt = at;
      envelope.history.push({ revision: envelope.board.revision, at, operation, payload });
      if (eventId) envelope.receipts.push({ key: eventId, fingerprint: digest, revision: envelope.board.revision });
      assertJson(envelope.board.canvas.data, "Canvas data");
      await writeEnvelope(path, envelope);
      return envelope.board;
    });
  }

  private checkReceipt(envelope: Envelope, key: string, digest: string): boolean {
    const receipt = envelope.receipts.find(item => item.key === key);
    if (!receipt) return false;
    if (receipt.fingerprint !== digest) throw new BoardStoreError("idempotency_conflict", `Event ID ${key} was already used with a different payload`, { eventId: key, appliedRevision: receipt.revision });
    return true;
  }

  private expectRevision(board: Board, expected: number): void {
    if (board.revision !== expected) throw new BoardStoreError("revision_conflict", `Board changed: expected revision ${expected}, current revision ${board.revision}`, { expectedRevision: expected, currentRevision: board.revision });
  }

  private event(board: Board, id: string, source: string, kind: string, summary: string, at: string, data?: Board["canvas"]["data"]): void {
    if (board.events.some(event => event.id === id)) throw new BoardStoreError("idempotency_conflict", `Event ID ${id} already exists`);
    board.events.push({ id, source, kind, summary, at, revision: board.revision + 1, ...(data === undefined ? {} : { data }) });
  }

  private canvasUpdate(board: Board, eventId: string, at: string, kind: CanvasUpdate["kind"], targets: CanvasUpdate["targets"], actorAgentId?: string): void {
    board.updates.push({ id: eventId, eventId, at, boardRevision: board.revision + 1, canvasRevision: board.canvas.revision, documentVersion: board.canvas.documentVersion, kind, targets, ...(actorAgentId ? { actorAgentId } : {}) });
    board.updates = board.updates.slice(-80);
    const retained = new Set(board.updates.map(update => update.id));
    board.seenUpdateIds = board.seenUpdateIds.filter(id => retained.has(id));
  }

  private putDecision(board: Board, input: DecisionInput, at: string): void {
    if (input.supersedes) {
      const previous = board.decisions.find(item => item.id === input.supersedes);
      if (!previous || previous.id === input.id) throw new BoardStoreError("invalid_input", "Superseded decision must identify another existing decision");
      const visited = new Set([input.id]);
      let predecessor: typeof previous | undefined = previous;
      while (predecessor) {
        if (visited.has(predecessor.id)) throw new BoardStoreError("invalid_input", "Decision replacement cannot create a cycle");
        visited.add(predecessor.id);
        const previousId: string | undefined = predecessor.supersedes;
        predecessor = board.decisions.find(item => item.id === previousId);
      }
      previous.status = "superseded";
      previous.updatedAt = at;
    }
    const index = board.decisions.findIndex(item => item.id === input.id);
    const existing = board.decisions[index];
    const decision = { ...input, createdAt: existing?.createdAt ?? at, updatedAt: at };
    if (existing) board.decisions[index] = decision;
    else board.decisions.push(decision);
  }

  private observe(board: Board, input: z.infer<typeof EmitInputSchema>, at: string): void {
    const observation = input.observation!;
    const previous = board.observations.find(item => item.id === observation.id);
    if (previous && canonicalJson(previous.value) !== canonicalJson(observation.value)) {
      const describe = (value: unknown) => { const text = canonicalJson(value); return text.length > 1400 ? `${text.slice(0, 1399)}…` : text; };
      this.putDecision(board, {
        id: `observed:${fingerprint("observation", { eventId: input.eventId, id: observation.id }).slice(0, 32)}`,
        choice: `${observation.name}: ${describe(previous.value)} → ${describe(observation.value)}`,
        impact: "Observed value changed. The reason and significance have not been established.",
        basis: "observed", status: "active", related: [observation.id],
        evidence: [previous.evidence, observation.evidence, { kind: "event", reference: input.eventId }],
      }, at);
    }
    if (previous) Object.assign(previous, observation, { updatedAt: at });
    else board.observations.push({ ...observation, updatedAt: at });
  }

  private changeInteraction(board: Board, id: string, update: InteractionUpdate, at: string): void {
    const interaction = board.interactions.find(item => item.id === id);
    if (!interaction) throw new BoardStoreError("not_found", `Interaction ${id} does not exist`);
    // A later chat/history projection must not replace an explicit, versioned Board answer.
    if (interaction.responseSource === "explicit" && update.responseSource === "timeline") return;
    const next = { ...interaction, ...update };
    if (next.status === "answered" && !next.response?.trim()) throw new BoardStoreError("invalid_input", "Answered requires a non-empty response");
    if (next.status === "applied" && !next.resultReferences.some(reference => reference.trim().length > 0)) throw new BoardStoreError("invalid_input", "Applied requires at least one non-empty result reference; this records an agent claim, not independent verification");
    if (next.status !== interaction.status && !transitions[interaction.status].includes(next.status)) throw new BoardStoreError("invalid_transition", `Interaction cannot transition from ${interaction.status} to ${next.status}`);
    if (canonicalJson(next) !== canonicalJson(interaction)) Object.assign(interaction, next, { updatedAt: at });
  }
}
