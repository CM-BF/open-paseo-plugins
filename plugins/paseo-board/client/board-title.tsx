import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { renameBoardRpc, type Board, type RenameInput } from "../shared/contracts";
import { Action, Copy, errorMessage, localId, useColors } from "./ui";
import { TitleInput } from "./title-input";
import { ToolbarPopover } from "./toolbar-popover";

interface Draft { value: string; baseTitle: string; request?: RenameInput; error?: string }
interface Props { board: Board; onAccepted(board: Board): void; onRefresh(): Promise<unknown>; compact?: boolean; menuWidth?: number; menuOffset?: number; onEditStart?(): void }

export function BoardTitle({ board, onAccepted, onRefresh, compact, menuWidth, menuOffset, onEditStart }: Props) {
  const c = useColors();
  const rename = useRpc(renameBoardRpc);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const changedElsewhere = !!draft && board.title !== draft.baseTitle;
  const cancel = () => { if (!pending.current) setDraft(null); };
  const submit = async () => {
    if (!draft || pending.current || !draft.value.trim() || draft.value.trim().length > 200) return;
    // Preserve the exact request after an uncertain response. Replaying its receipt
    // is safe even when an event already delivered the committed title to this view.
    if (!draft.request && changedElsewhere) return;
    if (!draft.request && draft.value.trim() === board.title) { setDraft(null); return; }
    const request = draft.request ?? { boardId: board.id, expectedTitle: draft.baseTitle, title: draft.value.trim(), eventId: localId("rename") };
    pending.current = true; setSaving(true); setDraft({ ...draft, request, error: undefined });
    try {
      const result = await rename(request);
      if (!mounted.current) return;
      onAccepted(result); setDraft(null);
    } catch (error) {
      if (!mounted.current) return;
      setDraft(current => current ? { ...current, error: errorMessage(error) } : current);
      // An event may have been lost along with the response. Reconcile once after
      // this action, keeping the user's text and original CAS/receipt intact.
      void onRefresh().catch(() => undefined);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const start = () => { if (pending.current) return; onEditStart?.(); setDraft(current => current ?? { value: board.title, baseTitle: board.title }); };
  if (compact) return <View testID="board-title" style={{ flex: 1, minWidth: 0, flexShrink: 1, position: "relative", overflow: "visible", zIndex: draft ? 120 : 0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", minWidth: 0, gap: 2 }}>
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 14, fontWeight: "600", minWidth: 0, flexShrink: 1 }}>{board.title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="修改 Board 名称" onPress={start} style={({ pressed }) => ({ padding: 6, flexShrink: 0, borderRadius: 5, backgroundColor: pressed || draft ? c.surface2 : "transparent" })}><Icon name="Pencil" size={14} color={c.foregroundMuted} /></Pressable>
    </View>
    <ToolbarPopover open={!!draft} title="修改 Board 名称" onClose={cancel} containerId="board-title" testID="board-title-popup" width={menuWidth ?? 320} left={menuOffset ?? 0}>
      {draft ? <>
        <View style={{ flexDirection: "row" }}><TitleInput value={draft.value} disabled={saving} color={c.foreground} backgroundColor={c.surface0} borderColor={c.border} onChange={value => { if (!pending.current) setDraft({ ...draft, value, request: undefined, error: undefined }); }} onSubmit={() => { void submit(); }} onCancel={cancel} /></View>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}><Action label={saving ? "保存中…" : draft.request ? "重试保存" : "保存名称"} disabled={saving || !draft.value.trim() || changedElsewhere && !draft.request} onPress={() => { void submit(); }} /><Action label="取消改名" disabled={saving} onPress={cancel} /></View>
        {draft.error ? <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 12 }}>{draft.error}</Text> : null}
        {changedElsewhere && !saving ? <><Copy muted small>当前名称已变为「{board.title}」。你的输入已保留。</Copy><Action label="确认当前名称后继续编辑" onPress={() => setDraft({ ...draft, baseTitle: board.title, request: undefined, error: undefined })} /></> : null}
      </> : null}
    </ToolbarPopover>
  </View>;
  return <View style={{ flex: 1, minWidth: 160, gap: 6 }} testID="board-title">
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {draft ? <>
        <TitleInput value={draft.value} disabled={saving} color={c.foreground} backgroundColor={c.surface0} borderColor={c.border} onChange={value => { if (!pending.current) setDraft({ ...draft, value, request: undefined, error: undefined }); }} onSubmit={() => { void submit(); }} onCancel={cancel} />
        <Action label={saving ? "保存中…" : draft.request ? "重试保存" : "保存名称"} disabled={saving || !draft.value.trim() || changedElsewhere && !draft.request} onPress={() => { void submit(); }} />
        <Action label="取消改名" disabled={saving} onPress={cancel} />
      </> : <>
        <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 16, fontWeight: "600", flexShrink: 1 }}>{board.title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="修改 Board 名称" onPress={start} style={({ pressed }) => ({ padding: 7, borderRadius: 5, backgroundColor: pressed ? c.surface2 : "transparent" })}><Icon name="Pencil" size={15} color={c.foregroundMuted} /></Pressable>
      </>}
    </View>
    {draft?.error ? <Text accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 12 }}>{draft.error}</Text> : null}
    {draft && changedElsewhere && !saving ? <View style={{ gap: 5 }}><Copy muted small>当前名称已变为「{board.title}」。你的输入已保留。</Copy><Action label="确认当前名称后继续编辑" onPress={() => setDraft({ ...draft, baseTitle: board.title, request: undefined, error: undefined })} /></View> : null}
  </View>;
}
