import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import {
  COMPOSITION_SOURCE_LIMIT, boardRefKey, compositionSourcesRpc, inspectCompositionSourceRpc,
  setCompositionSourcesRpc, syncCompositionSourceRpc, type BoardRef, type CompositionSourcesState, type CompositionSourceSelection,
} from "../shared/composition";
import { useBoardList } from "./data";
import { compositionSourceSignal, hasCompositionSource, mergeCompositionSources, newerSourceReceipt } from "./composition-source-cache";
import { BoardServicesProvider, useBoardRpc, useBoardServices, useBoardTransports, type BoardServices } from "./transport";
import { Action, Copy, Notice, errorMessage, timeLabel, useColors } from "./ui";

export function useCompositionSources(parent: BoardRef, enabled = true) {
  const service = useBoardServices(parent.hostId);
  const read = useBoardRpc(compositionSourcesRpc, parent.hostId);
  const set = useBoardRpc(setCompositionSourcesRpc, parent.hostId);
  const sendSnapshot = useBoardRpc(syncCompositionSourceRpc, parent.hostId);
  const cache = useQueryClient();
  const scope = useMemo(() => ({}), [parent.hostId, parent.boardId, service?.generation, enabled]);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const active = Boolean(enabled && service?.isCurrent());
  const current = useCallback(() => enabled && scopeRef.current === scope && Boolean(service?.isCurrent()), [enabled, scope, service]);
  useEffect(() => { scopeRef.current = scope; return () => { if (scopeRef.current === scope) scopeRef.current = {}; }; }, [scope]);
  const key = useMemo(() => ["paseo-board-composition-sources", parent.hostId, parent.boardId, service?.generation] as const, [parent.hostId, parent.boardId, service?.generation]);
  const query = useQuery({
    queryKey: key,
    queryFn: async () => {
      if (!current()) throw new Error("来源连接已变更，请重新打开。");
      const result = await read({ boardId: parent.boardId });
      if (!current()) throw new Error("来源连接已变更，请重新打开。");
      return result;
    },
    structuralSharing: (previous, incoming) => mergeCompositionSources(previous as CompositionSourcesState | undefined, incoming as CompositionSourcesState),
    enabled: active, staleTime: 10_000, refetchInterval: active ? 10_000 : false, refetchIntervalInBackground: false,
  });
  const [problems, setProblems] = useState<Record<string, string>>({});
  useEffect(() => { setProblems({}); }, [scope, query.data?.revision]);
  const report = useCallback((ref: BoardRef, error?: unknown) => {
    if (!current()) return;
    setProblems(previous => {
      const id = boardRefKey(ref), next = error === undefined ? undefined : errorMessage(error);
      if (previous[id] === next) return previous;
      const result = { ...previous };
      if (next) result[id] = next; else delete result[id];
      return result;
    });
  }, [current]);
  const save = async (sources: CompositionSourceSelection[], expectedRevision: number) => {
    if (!current()) throw new Error("来源连接已变更，请重新打开。");
    const accepted = await set({ boardId: parent.boardId, expectedRevision, sources });
    if (!current()) throw new Error("保存结果需要重新核对，请重新打开来源列表。");
    cache.setQueryData<CompositionSourcesState>(key, previous => mergeCompositionSources(previous, accepted));
    return accepted;
  };
  const canSynchronize = useCallback((revision: number, ref: BoardRef) => current() && hasCompositionSource(cache.getQueryData<CompositionSourcesState>(key), revision, ref), [cache, key, current]);
  const sync = async (input: Parameters<typeof sendSnapshot>[0]) => {
    if (input.boardId !== parent.boardId || !canSynchronize(input.expectedSourcesRevision, input.ref)) throw new Error("来源授权已变更，已丢弃待同步资料。");
    const accepted = await sendSnapshot(input);
    if (!canSynchronize(input.expectedSourcesRevision, input.ref)) throw new Error("来源授权已变更，已丢弃旧同步回执。");
    return accepted;
  };
  const acceptedReceipt = (ref: BoardRef, revision: number, receipt: CompositionSourcesState["sources"][number]["snapshot"]) => {
    if (!canSynchronize(revision, ref)) return;
    cache.setQueryData<CompositionSourcesState>(key, state => state?.revision === revision
      ? { ...state, sources: state.sources.map(source => boardRefKey(source.ref) === boardRefKey(ref) && receipt && (!source.sourceCreatedAt || source.sourceCreatedAt === receipt.sourceCreatedAt)
        ? { ...source, sourceCreatedAt: receipt.sourceCreatedAt, snapshot: newerSourceReceipt(source.snapshot, receipt) } : source) }
      : state);
  };
  return { ...query, data: active ? query.data : undefined, enabled: active, scope, save, sync, problems, report, acceptedReceipt, canSynchronize };
}
export type CompositionSourceController = ReturnType<typeof useCompositionSources>;

/** Only user-granted sources are copied to the parent's bounded, agent-readable store. */
export function CompositionSourceSync({ parent, controller }: { parent: BoardRef; controller: CompositionSourceController }) {
  const services = useBoardTransports();
  return <>{controller.enabled ? controller.data?.sources.map(({ ref }) => {
    if (ref.hostId === parent.hostId) return null; // The server reads local sources directly.
    const service = services.find(item => item.hostId === ref.hostId);
    return service ? <BoardServicesProvider key={boardRefKey(ref)} services={service}>
      <SourceObservation parent={parent} source={ref} service={service} controller={controller} sourcesRevision={controller.data!.revision} />
    </BoardServicesProvider> : null;
  }) : null}</>;
}

function SourceObservation({ parent, source, service, controller, sourcesRevision }: {
  parent: BoardRef; source: BoardRef; service: BoardServices; controller: CompositionSourceController; sourcesRevision: number;
}) {
  // Existing per-host cursor checks are shared with open canvases and the source picker.
  const list = useBoardList(source.hostId);
  const summary = list.data?.boards.find(board => board.id === source.boardId);
  const available = Boolean(summary);
  const sourceSignal = compositionSourceSignal(summary);
  const sourceEpoch = list.data?.cursor.epoch;
  const connected = !list.liveError && list.liveStatus !== "disconnected";
  useEffect(() => {
    if (!available || !connected || !service.isCurrent() || !controller.canSynchronize(sourcesRevision, source)) return;
    let live = true, attempts = 0, retry: ReturnType<typeof setTimeout> | undefined;
    const valid = () => live && service.isCurrent() && controller.canSynchronize(sourcesRevision, source);
    const observe = async () => {
      try {
        const snapshot = await service.rpc(inspectCompositionSourceRpc, { boardId: source.boardId });
        if (!valid()) return;
        if (boardRefKey(snapshot.sourceRef) !== boardRefKey(source)) throw new Error("来源身份与请求不符，未同步。");
        const receipt = await controller.sync({ boardId: parent.boardId, expectedSourcesRevision: sourcesRevision, ref: source, snapshot });
        if (!valid()) return;
        controller.acceptedReceipt(source, sourcesRevision, receipt); controller.report(source);
      } catch (error) {
        if (!valid()) return;
        controller.report(source, error);
        // Only read/observation synchronization retries. It never changes grants or sends messages.
        if (++attempts < 3) retry = setTimeout(() => { retry = undefined; if (valid()) void observe(); }, attempts * 2_000);
      }
    };
    void observe();
    return () => { live = false; if (retry !== undefined) clearTimeout(retry); };
    // Receipt changes do not start another read; scope/grant/connection/content changes do.
  }, [parent.hostId, parent.boardId, source.hostId, source.boardId, service.generation, available, connected, sourceEpoch, sourceSignal, sourcesRevision, controller.scope]);
  return null;
}

export function CompositionSourcesPanel({ parent, controller }: { parent: BoardRef; controller: CompositionSourceController }) {
  const c = useColors();
  const services = useBoardTransports();
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Array<BoardRef & { sourceCreatedAt?: string }>>();
  const [baseRevision, setBaseRevision] = useState<number>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const panelScope = useRef(controller.scope); panelScope.current = controller.scope;
  useEffect(() => { setDraft(undefined); setBaseRevision(undefined); setPending(false); setFailure(undefined); }, [controller.scope]);
  const selected = draft ?? controller.data?.sources.map(source => ({ ...source.ref, sourceCreatedAt: source.sourceCreatedAt })) ?? [];
  const selectedKeys = useMemo(() => new Set(selected.map(boardRefKey)), [selected]);
  const toggle = (ref: BoardRef & { sourceCreatedAt?: string }) => {
    if (pending || !controller.data) return;
    const id = boardRefKey(ref);
    if (!selectedKeys.has(id) && selected.length >= COMPOSITION_SOURCE_LIMIT) { setFailure(`每张 Board 最多选择 ${COMPOSITION_SOURCE_LIMIT} 个来源。`); return; }
    setBaseRevision(value => value ?? controller.data!.revision);
    setDraft(selectedKeys.has(id) ? selected.filter(item => boardRefKey(item) !== id) : [...selected, ref]);
    setFailure(undefined);
  };
  const save = async () => {
    if (pending || !draft || baseRevision === undefined) return;
    if (draft.some(source => !source.sourceCreatedAt)) { setFailure("请移除并重新选择尚未核对身份的来源，再保存。"); return; }
    const scope = controller.scope;
    setPending(true); setFailure(undefined);
    try { await controller.save(draft as CompositionSourceSelection[], baseRevision); if (panelScope.current === scope) { setDraft(undefined); setBaseRevision(undefined); } }
    catch (error) { if (panelScope.current === scope) { setFailure(errorMessage(error)); void controller.refetch(); } }
    finally { if (panelScope.current === scope) setPending(false); }
  };
  return <View testID="board-composition-sources" style={{ gap: 14 }}>
    <Copy>选择这张 Board 的 agent 可以读取的来源，用于汇总、比较或生成简报。源画板仍由原来的 agent 负责。</Copy>
    <Copy small muted>保存后，让 agent 使用这些来源组合页面。它可以自由安排交互画板和缩略预览；来源读取不会发送消息。</Copy>
    {controller.isPending ? <Copy muted>正在读取来源…</Copy> : null}
    {controller.error ? <Notice error text={errorMessage(controller.error)} /> : null}
    <TextInput accessibilityLabel="查找来源 Board" value={filter} onChangeText={setFilter} placeholder="按 Board 或 host 名称查找" placeholderTextColor={c.foregroundMuted} style={{ color: c.foreground, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10 }} />
    <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 18 }}>
      {services.map(service => <BoardServicesProvider key={`${service.hostId}:${service.generation}`} services={service}>
        <HostSourceChoices parent={parent} service={service} filter={filter} selected={selectedKeys} selectedRefs={selected} disabled={pending || !controller.data} toggle={toggle} />
      </BoardServicesProvider>)}
      {selected.filter(ref => !services.some(service => service.hostId === ref.hostId)).map(ref => <View key={boardRefKey(ref)} style={{ gap: 4 }}>
        <Action label={`${ref.boardId} · ${ref.hostId}`} active disabled={pending} onPress={() => toggle(ref)} />
        <Copy small muted>该 host 当前未提供兼容的 Board 连接，已保存的来源仍保留。</Copy>
      </View>)}
      {services.length === 0 ? <Copy muted>尚无可用来源。请先连接安装了兼容 Board 插件的 host。</Copy> : null}
    </ScrollView>
    {controller.data?.sources.map(source => controller.problems[boardRefKey(source.ref)] ? <Notice key={boardRefKey(source.ref)} error text={`${source.ref.boardId}：${controller.problems[boardRefKey(source.ref)]}`} /> : null)}
    {controller.data?.sources.some(source => source.snapshot) ? <Copy small muted>远端资料以各来源最近同步的版本提供，agent 会看到采集时间和记录范围。</Copy> : null}
    {failure ? <Notice error text={failure} /> : null}
    {draft && controller.data && controller.data.revision !== baseRevision ? <Notice error text="来源选择已在别处修改。请重新载入后再选择，以免覆盖另一处修改。" /> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
      <Copy small muted>已选 {selected.length} / {COMPOSITION_SOURCE_LIMIT}</Copy>
      {draft ? <Action label="放弃这次选择" disabled={pending} onPress={() => { setDraft(undefined); setBaseRevision(undefined); setFailure(undefined); }} /> : null}
      <Action label={pending ? "保存中…" : "保存来源"} primary disabled={pending || !draft || controller.data?.revision !== baseRevision} onPress={() => { void save(); }} />
    </View>
  </View>;
}

function HostSourceChoices({ parent, service, filter, selected, selectedRefs, disabled, toggle }: {
  parent: BoardRef; service: BoardServices; filter: string; selected: Set<string>; selectedRefs: BoardRef[]; disabled: boolean; toggle(ref: BoardRef & { sourceCreatedAt?: string }): void;
}) {
  const c = useColors();
  const query = useBoardList(service.hostId);
  const text = filter.trim().toLocaleLowerCase();
  const boards = query.data?.boards.filter(board => !(parent.hostId === service.hostId && parent.boardId === board.id) && (!text || `${service.label} ${board.title} ${board.id}`.toLocaleLowerCase().includes(text))) ?? [];
  return <View style={{ gap: 7 }}>
    <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{service.label}</Text>
    {query.isPending ? <Copy small muted>正在读取…</Copy> : null}
    {query.error ? <Notice error text={errorMessage(query.error)} /> : null}
    {boards.map(board => {
      const ref = { hostId: service.hostId, boardId: board.id, sourceCreatedAt: board.createdAt };
      return <View key={board.id} style={{ gap: 3 }}>
        <Action label={board.title} active={selected.has(boardRefKey(ref))} disabled={disabled} icon={selected.has(boardRefKey(ref)) ? "Check" : "Plus"} onPress={() => toggle(ref)} />
        <Copy small muted>{board.unreadUpdateCount ? `${board.unreadUpdateCount} 处未看更新 · ` : ""}{timeLabel(board.updatedAt)}</Copy>
      </View>;
    })}
    {selectedRefs.filter(ref => ref.hostId === service.hostId && !query.data?.boards.some(board => board.id === ref.boardId)).map(ref => <View key={boardRefKey(ref)} style={{ gap: 3 }}>
      <Action label={ref.boardId} active disabled={disabled} icon="Check" onPress={() => toggle(ref)} />
      <Copy small muted>这个已选来源暂不可读，仍可从来源中移除。</Copy>
    </View>)}
    {!query.isPending && !query.error && !boards.length ? <Copy small muted>没有符合条件的 Board。</Copy> : null}
  </View>;
}
