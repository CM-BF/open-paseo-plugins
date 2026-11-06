import type { PluginTab } from "@getpaseo/plugin/client";
import { isCanvasViewState, type CanvasViewState } from "../shared/frame-contract";
import type { DraftStorage } from "./draft-store";
import { browserDraftStorage } from "./draft-storage-web";

export type BoardEntryScope = { hostId: string; surface: "agent" | "workspace" | "screen"; workspaceId?: string; agentId?: string };
export type LastBoardSelection = { kind: "board"; boardId: string } | { kind: "index" };
export type BoardViewTab = Pick<PluginTab, "state" | "setState">;
export type SavedBoardView = { view: CanvasViewState; follow: boolean };

// Optional navigation hints only. Drafts, authored state and publication requests
// have separate stores and are never scanned or evicted by this bounded cache.
export const BOARD_VIEW_STORAGE_KEY = "@paseo:board-view:v1";
export const BOARD_VIEW_MAX_RECORDS = 64;
export const BOARD_VIEW_MAX_BYTES = 512 * 1024;
export const BOARD_VIEW_MAX_INSTANCE_LENGTH = 2048;
const MAX_RECORD_BYTES = 64 * 1024;
const TAB_KEY = "paseoBoardEntry";
type EntryRecord = { kind: "entry"; scope: BoardEntryScope; selection: LastBoardSelection };
type ViewRecord = ({ kind: "view" } | { kind: "instance-view"; instance: string }) & { hostId: string; boardId: string } & SavedBoardView;
type StoredRecord = EntryRecord | ViewRecord;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const optionalId = (value: unknown) => value === undefined || id(value);
const validInstance = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= BOARD_VIEW_MAX_INSTANCE_LENGTH;

function cleanScope(value: unknown): BoardEntryScope | undefined {
  if (!object(value) || !id(value.hostId) || !["agent", "workspace", "screen"].includes(String(value.surface)) || !optionalId(value.workspaceId) || !optionalId(value.agentId)) return;
  if (value.surface === "agent" && !id(value.agentId)) return;
  return { hostId: value.hostId, surface: value.surface as BoardEntryScope["surface"],
    ...(value.workspaceId === undefined ? {} : { workspaceId: value.workspaceId as string }),
    ...(value.agentId === undefined ? {} : { agentId: value.agentId as string }) };
}
function cleanSelection(value: unknown): LastBoardSelection | undefined {
  if (!object(value)) return;
  if (value.kind === "index") return { kind: "index" };
  if (value.kind === "board" && id(value.boardId)) return { kind: "board", boardId: value.boardId };
}
function cleanView(value: unknown): CanvasViewState | undefined {
  if (!isCanvasViewState(value)) return;
  return { documentVersion: value.documentVersion, canvasRevision: value.canvasRevision, x: value.x, y: value.y,
    ...(value.anchor ? { anchor: { selector: value.anchor.selector, offsetX: value.anchor.offsetX, offsetY: value.anchor.offsetY } } : {}),
    scrolls: value.scrolls.map(item => ({ selector: item.selector, x: item.x, y: item.y })) };
}
function cleanRecord(value: unknown): StoredRecord | undefined {
  if (!object(value)) return;
  if (value.kind === "entry") {
    const scope = cleanScope(value.scope), selection = cleanSelection(value.selection);
    if (scope && selection) return { kind: "entry", scope, selection };
  }
  if ((value.kind === "view" || value.kind === "instance-view" && validInstance(value.instance)) && id(value.hostId) && id(value.boardId) && typeof value.follow === "boolean") {
    const view = cleanView(value.view);
    if (view) return { ...(value.kind === "instance-view" ? { kind: "instance-view", instance: value.instance as string } as const : { kind: "view" } as const), hostId: value.hostId, boardId: value.boardId, view, follow: value.follow };
  }
}
const scopeKey = (scope: BoardEntryScope) => JSON.stringify([scope.hostId, scope.surface, scope.workspaceId ?? null, scope.agentId ?? null]);
// Preserve the original key and record kind for ordinary visits. A distinct
// kind also makes older clients ignore embedded hints instead of folding them
// into the source Board's ordinary reading position.
const viewKey = (hostId: string, boardId: string, instance?: string) => instance === undefined
  ? "view:" + JSON.stringify([hostId, boardId]) : "instance-view:" + JSON.stringify([hostId, boardId, instance]);
const recordKey = (value: StoredRecord) => value.kind === "entry" ? "entry:" + scopeKey(value.scope) : viewKey(value.hostId, value.boardId, value.kind === "instance-view" ? value.instance : undefined);
const isViewRecord = (value?: StoredRecord): value is ViewRecord => value?.kind === "view" || value?.kind === "instance-view";
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const samePageChanges = new Set<() => void>();
const WRITE_INTERVAL_MS = 500;
type CachedRecord = { value: StoredRecord; json: string };
type BrowserLifecycle = {
  addEventListener?(name: string, listener: () => void): void;
  removeEventListener?(name: string, listener: () => void): void;
  document?: { hidden?: boolean; addEventListener?(name: string, listener: () => void): void; removeEventListener?(name: string, listener: () => void): void };
};

/** Factory keeps storage failures testable and gives each client one bounded memory fallback. */
export function createBoardViewStore(storage: DraftStorage | null | (() => DraftStorage | null) = browserDraftStorage) {
  let memory = new Map<string, CachedRecord>();
  const unsaved = new Set<string>();
  const pendingTabs = new WeakMap<BoardViewTab["setState"], Map<string, EntryRecord>>();
  let db: DraftStorage | null = null, lastRaw: string | null | undefined, externalChange = true;
  let owners = 0, removeListeners: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let lastWrite: number | undefined;
  const changed = () => { externalChange = true; };
  const encode = () => '{"version":1,"records":[' + [...memory.values()].map(item => item.json).join(",") + "]}";
  const trim = () => {
    let bytes = 50 + [...memory.values()].reduce((total, item) => total + (item.json.length + 1) * 2, 0);
    while (memory.size > BOARD_VIEW_MAX_RECORDS || memory.size > 0 && bytes > BOARD_VIEW_MAX_BYTES) {
      const oldest = memory.keys().next().value!;
      bytes -= (memory.get(oldest)!.json.length + 1) * 2;
      memory.delete(oldest); unsaved.delete(oldest);
    }
  };
  const synchronize = (force = false): DraftStorage | null => {
    try {
      db ??= typeof storage === "function" ? storage() : storage;
      if (!db) return null;
      if (!force && !externalChange && lastRaw !== undefined) return db;
      const raw = db.getItem(BOARD_VIEW_STORAGE_KEY);
      externalChange = false;
      if (raw === lastRaw) return db;
      lastRaw = raw;
      let records: unknown[] = [];
      if (raw && raw.length * 2 <= BOARD_VIEW_MAX_BYTES) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (object(parsed) && parsed.version === 1 && Array.isArray(parsed.records) && parsed.records.length <= BOARD_VIEW_MAX_RECORDS) records = parsed.records;
        } catch { /* Invalid optional hints never prevent opening a Board. */ }
      }
      const next = new Map<string, CachedRecord>();
      for (const rawRecord of records) {
        const value = cleanRecord(rawRecord);
        if (value) {
          const json = JSON.stringify(value);
          if (json.length * 2 <= MAX_RECORD_BYTES) next.set(recordKey(value), { value, json });
        }
      }
      // A quota/refusal must not let older disk data overwrite this client's last visit.
      for (const key of unsaved) { const value = memory.get(key); if (value) { next.delete(key); next.set(key, value); } }
      memory = next; trim();
      return db;
    } catch { externalChange = true; return null; }
  };
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer); timer = undefined;
    if (!unsaved.size) return;
    const current = synchronize(!owners);
    lastWrite = Date.now();
    if (!current) return;
    const encoded = encode();
    try {
      if (encoded !== lastRaw) current.setItem(BOARD_VIEW_STORAGE_KEY, encoded);
      lastRaw = encoded; externalChange = false; unsaved.clear();
      for (const listener of samePageChanges) if (listener !== changed) listener();
    } catch { /* Keep the newest in-memory hint; another user action can retry persistence. */ }
  };
  const put = (value: StoredRecord, important: boolean) => {
    const json = JSON.stringify(value);
    if (json.length * 2 > MAX_RECORD_BYTES) return;
    synchronize();
    const key = recordKey(value), previous = memory.get(key);
    if (previous?.json === json) { if (important && unsaved.size) flush(); return; }
    memory.delete(key); memory.set(key, { value: copy(value), json }); unsaved.add(key); trim();
    if (important || lastWrite === undefined || Date.now() - lastWrite >= WRITE_INTERVAL_MS) flush();
    else if (timer === undefined) timer = setTimeout(flush, WRITE_INTERVAL_MS - (Date.now() - lastWrite));
  };
  const tabRecord = (tab?: BoardViewTab) => {
    try { return object(tab?.state) ? cleanRecord(tab.state[TAB_KEY]) : undefined; } catch { return; }
  };
  return {
    // Listeners exist only while a mounted entry/Board uses this store. Reentry
    // reconciles once; ordinary scroll captures never reread the whole catalog.
    retain(): () => void {
      if (owners++ === 0) {
        synchronize(true);
        let offStorage: (() => void) | undefined;
        try { offStorage = db?.subscribe?.(key => { if (key === null || key === BOARD_VIEW_STORAGE_KEY) changed(); }); } catch { /* Persistence remains optional. */ }
        const browser = (globalThis as unknown as { window?: BrowserLifecycle }).window;
        const onHidden = () => { if (browser?.document?.hidden) flush(); };
        browser?.addEventListener?.("pagehide", flush);
        browser?.document?.addEventListener?.("visibilitychange", onHidden);
        samePageChanges.add(changed);
        removeListeners = () => {
          offStorage?.(); samePageChanges.delete(changed);
          browser?.removeEventListener?.("pagehide", flush);
          browser?.document?.removeEventListener?.("visibilitychange", onHidden);
        };
      }
      let released = false;
      return () => {
        if (released) return; released = true;
        if (--owners === 0) { flush(); removeListeners?.(); removeListeners = undefined; }
      };
    },
    flush,
    readLastBoard(scope: BoardEntryScope, tab?: BoardViewTab): LastBoardSelection | undefined {
      const validScope = cleanScope(scope); if (!validScope) return;
      const key = scopeKey(validScope), savedTab = tabRecord(tab);
      const pending = tab && pendingTabs.get(tab.setState)?.get(key);
      if (pending) {
        if (savedTab?.kind === "entry" && JSON.stringify(savedTab) === JSON.stringify(pending)) pendingTabs.get(tab!.setState)!.delete(key);
        else return copy(pending.selection);
      }
      if (savedTab?.kind === "entry" && scopeKey(savedTab.scope) === key) return copy(savedTab.selection);
      synchronize(!owners);
      const saved = memory.get("entry:" + key)?.value;
      return saved?.kind === "entry" ? copy(saved.selection) : undefined;
    },
    writeLastBoard(scope: BoardEntryScope, selection: LastBoardSelection, tab?: BoardViewTab): void {
      const validScope = cleanScope(scope), validSelection = cleanSelection(selection);
      if (!validScope || !validSelection) return;
      const value: EntryRecord = { kind: "entry", scope: validScope, selection: validSelection };
      put(value, true);
      if (tab && typeof tab.setState === "function") {
        const writes = pendingTabs.get(tab.setState) ?? new Map<string, EntryRecord>(), key = scopeKey(validScope);
        writes.delete(key); writes.set(key, value);
        if (writes.size > BOARD_VIEW_MAX_RECORDS) writes.delete(writes.keys().next().value!);
        pendingTabs.set(tab.setState, writes);
      }
      try { tab?.setState({ ...(object(tab.state) ? tab.state : {}), [TAB_KEY]: value }); } catch { /* Local hints still remember this choice when the host refuses tab state. */ }
    },
    readBoardView(hostId: string, boardId: string, documentVersion: number, instance?: string): SavedBoardView | undefined {
      if (!id(hostId) || !id(boardId) || !Number.isSafeInteger(documentVersion) || documentVersion < 0 || instance !== undefined && !validInstance(instance)) return;
      synchronize(!owners);
      const saved = memory.get(viewKey(hostId, boardId, instance))?.value;
      if (isViewRecord(saved) && saved.view.documentVersion === documentVersion) return copy({ view: saved.view, follow: saved.follow });
    },
    writeBoardView(hostId: string, boardId: string, rawView: CanvasViewState, follow: boolean, instance?: string): void {
      const view = cleanView(rawView);
      if (!id(hostId) || !id(boardId) || !view || typeof follow !== "boolean" || instance !== undefined && !validInstance(instance)) return;
      const previous = memory.get(viewKey(hostId, boardId, instance))?.value;
      const value: ViewRecord = { ...(instance === undefined ? { kind: "view" } as const : { kind: "instance-view", instance } as const), hostId, boardId, view, follow };
      put(value, !isViewRecord(previous) || previous.view.documentVersion !== view.documentVersion || previous.follow !== follow);
    },
  };
}

const store = createBoardViewStore();
export const readLastBoard = store.readLastBoard;
export const writeLastBoard = store.writeLastBoard;
export const readBoardView = store.readBoardView;
export const writeBoardView = store.writeBoardView;
export const retainBoardViewStore = store.retain;
export const flushBoardViewStore = store.flush;
