import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { createBoardRpc, listBoardsRpc } from "../shared/contracts";
import { Action, ColorContext, Copy, Notice, errorMessage, localId, timeLabel, useColors } from "./ui";
import { BoardView } from "./board";

interface Props extends PluginSurfaceProps { initialBoardId?: string; workspaceId?: string; agentId?: string }
const EMPTY_CANVAS = `<style>main{padding:clamp(24px,8vw,100px);max-width:760px;margin:auto}h1{font-size:clamp(30px,5vw,54px);letter-spacing:-.04em}p{line-height:1.8;opacity:.65}#content{min-height:30vh}</style><main><p>YOUR SHARED SURFACE</p><h1>从一个问题开始。</h1><p>让 agent 根据眼前的任务组织这里。解释、图表、动画和互动工具，都可以在同一块画布上不断生长。</p><div id="content"></div></main>`;

export function BoardHome(props: Props) {
  const [selected, setSelected] = useState(props.initialBoardId);
  return selected ? <BoardView key={`${props.host.id}:${selected}`} {...props} boardId={selected} onBack={() => setSelected(undefined)} /> : <ColorContext.Provider value={props.theme.colors}><BoardIndex {...props} onSelect={setSelected} /></ColorContext.Provider>;
}

function BoardIndex({ host, workspaceId, agentId, onSelect }: Props & { onSelect(id: string): void }) {
  const c = useColors();
  const list = useRpc(listBoardsRpc);
  const create = useRpc(createBoardRpc);
  const paseo = usePaseo();
  const boards = useQuery({ queryKey: ["paseo-board-list", host.id, workspaceId ?? "all"], queryFn: () => list({ workspaceId }), refetchInterval: 4000 });
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState(agentId);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [draftId, setDraftId] = useState(() => localId("board"));
  const agents = useQuery({ queryKey: ["paseo-board-owners", host.id], queryFn: () => paseo.agents.list(), enabled: creating });
  const newBoard = async () => {
    if (pending || !title.trim() || !owner) return;
    setPending(true); setFailure(null);
    try {
      const chosen = agents.data?.entries.find(entry => entry.agent.id === owner)?.agent;
      const board = await create({ id: draftId, title: title.trim(), ownerAgentId: owner, workspaceId: workspaceId ?? chosen?.workspaceId ?? undefined, html: EMPTY_CANVAS, data: { summary: "新画布，等待 agent 根据任务组织内容。" } });
      setCreating(false); onSelect(board.id);
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setPending(false); }
  };
  return <View style={{ flex: 1, backgroundColor: c.surface0 }}>
    <ScrollView contentContainerStyle={{ padding: 28, gap: 24, maxWidth: 1100, width: "100%", alignSelf: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}><View style={{ flex: 1, gap: 7 }}><Text style={{ color: c.foreground, fontSize: 28, fontWeight: "600", letterSpacing: -0.7 }}>Boards</Text><Copy muted>回到项目的现状，指着内容与 agent 交流。</Copy></View><Action label="新建 Board" icon="Plus" primary onPress={() => { setDraftId(localId("board")); setCreating(true); }} /></View>
      {boards.error ? <Notice error text={errorMessage(boards.error)} /> : null}
      {boards.isPending ? <Copy muted>正在读取…</Copy> : null}
      {boards.data?.boards.length === 0 ? <View style={{ paddingVertical: 60, gap: 14 }}><Copy>还没有 Board。</Copy><Copy muted>你可以让 agent 为当前任务建立一块持续更新的自由画布，或先关联一个 agent 开始。</Copy></View> : null}
      {boards.data?.boards.map(board => <Pressable key={board.id} accessibilityRole="button" accessibilityLabel={`打开 ${board.title}`} onPress={() => onSelect(board.id)} style={({ pressed }) => ({ paddingVertical: 20, paddingHorizontal: 18, borderWidth: 1, borderColor: c.border, borderRadius: 10, backgroundColor: pressed ? c.surface2 : c.surface1, gap: 10 })}>
        <Text style={{ color: c.foreground, fontSize: 19, fontWeight: "500" }}>{board.title}</Text>
        <Copy muted small>{board.decisionCount} 个 agent 决策 · {board.pendingCount} 个待落实交流</Copy>
        <Copy muted small>更新于 {timeLabel(board.updatedAt)}</Copy>
      </Pressable>)}
    </ScrollView>
    <Modal title="新建 Board" open={creating} onOpenChange={open => { if (!pending) setCreating(open); }}><Modal.Content><View style={{ gap: 16 }}>
      <Copy>关联负责的 agent。画布内容和布局由它随任务自由构建。</Copy>
      <TextInput value={title} onChangeText={setTitle} editable={!pending} maxLength={200} placeholder="项目 / Board 名称" accessibilityLabel="Board 名称" placeholderTextColor={c.foregroundMuted} style={{ color: c.foreground, borderColor: c.border, borderWidth: 1, borderRadius: 8, padding: 12 }} />
      <Copy muted small>负责的 agent</Copy>
      {agents.error ? <Notice error text={errorMessage(agents.error)} /> : null}
      {agents.isPending ? <Copy muted>读取会话…</Copy> : null}
      <ScrollView style={{ maxHeight: 250 }} contentContainerStyle={{ gap: 7 }}>{agents.data?.entries.filter(entry => entry.agent.status !== "closed" && (!workspaceId || entry.agent.workspaceId === workspaceId)).map(({ agent }) => <Action key={agent.id} label={agent.title || `Agent ${agent.id.slice(0, 8)}`} active={owner === agent.id} disabled={pending} onPress={() => setOwner(agent.id)} />)}</ScrollView>
      {failure ? <Notice error text={failure} /> : null}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}><Action label="取消" disabled={pending} onPress={() => setCreating(false)} /><Action label={pending ? "创建中…" : "创建"} primary disabled={pending || !owner || !title.trim()} onPress={() => { void newBoard(); }} /></View>
    </View></Modal.Content></Modal>
  </View>;
}
