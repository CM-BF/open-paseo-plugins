import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { editBoardRpc, type Board } from "../shared/contracts";
import type { ComponentEditRequest, ComponentEditResult } from "../shared/frame-contract";
import { Action, localId, useColors } from "./ui";
import { ComponentEditWriter, type EditDraft } from "./component-edit-writer";

// Retain an ambiguous save while navigating away and back in this host session.
// Completed/cancelled writers are removed on view disposal; no history or clipboard is persisted here.
const writers = new Map<string, ComponentEditWriter>();
export function useComponentEditor(hostId: string, boardId: string, board: Board | null | undefined, accept: (board: Board) => void, refresh: () => Promise<unknown>) {
  const key = JSON.stringify([hostId, boardId]);
  const writerRef = useRef<{ key: string; writer: ComponentEditWriter } | undefined>(undefined);
  if (writerRef.current?.key !== key) {
    let writer = writers.get(key); if (!writer) { writer = new ComponentEditWriter(); writers.set(key, writer); }
    writerRef.current = { key, writer };
  }
  const writer = writerRef.current.writer;
  const [draft, setDraft] = useState<EditDraft | null>(writer.snapshot());
  const edit = useRpc(editBoardRpc);
  const currentBoard = useRef(board); currentBoard.current = board;
  useEffect(() => {
    setDraft(writer.snapshot());
    const dispose = writer.subscribe(() => setDraft(writer.snapshot()));
    return () => { dispose(); writer.cancel(); if (!writer.snapshot()) writers.delete(key); };
  }, [writer, key]);
  useEffect(() => { if (board) writer.invalidate(board.canvas); }, [writer, board?.canvas.revision, board?.canvas.documentVersion]);
  const propose = useCallback((request: ComponentEditRequest): Promise<ComponentEditResult> => {
    const live = currentBoard.current;
    if (!live || live.canvas.revision !== request.canvasBase.revision || live.canvas.documentVersion !== request.canvasBase.documentVersion) return Promise.resolve({ status: "rejected", message: "画布已更新，请重新选择组件。" });
    return writer.propose(boardId, request, localId("component-edit"));
  }, [writer, boardId]);
  return { draft, propose, invalidate: () => writer.invalidate(), cancel: () => writer.cancel(), editText: (text: string) => writer.editText(text), save: () => {
    if (currentBoard.current) writer.invalidate(currentBoard.current.canvas);
    return writer.save(edit, accept, refresh);
  } };
}
export function ComponentEditPanel({ editor }: { editor: ReturnType<typeof useComponentEditor> }) {
  const c = useColors(), draft = editor.draft;
  if (!draft) return null;
  const patch = draft.request.patch;
  const destination = { before: "之前", after: "之后", prepend: "内部开头", append: "内部末尾" }[patch.position ?? "append"];
  const source = draft.sourceLabel || patch.selector;
  return <View testID="board-component-edit" style={{ position: "absolute", bottom: 10, right: 10, width: 340, maxWidth: "95%", padding: 9, gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 9, backgroundColor: c.surface0, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 12 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ color: c.foreground, fontWeight: "600", fontSize: 12 }}>{patch.operation === "text" ? "修改文字" : patch.operation === "copy" ? "复制组件" : "移动组件"}</Text>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, flex: 1 }}>{patch.operation === "text" ? source : `${source} → ${draft.destinationLabel || patch.destination} · ${destination}`}</Text>
    </View>
    {patch.operation === "text" && (draft.status === "rejected" || draft.status === "unknown") ? <>
      <TextInput testID="board-component-edit-text" accessibilityLabel="保留的文字草稿" value={patch.text ?? ""} multiline maxLength={24000} readOnly style={{ color: c.foreground, backgroundColor: c.surface1, padding: 7, minHeight: 40, maxHeight: 96, borderWidth: 1, borderColor: c.border, borderRadius: 5 }} />
      {draft.status === "rejected" ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>文字草稿已保留，可复制后重新选择。</Text> : null}
    </> : null}
    {draft.error ? <Text numberOfLines={3} accessibilityRole="alert" style={{ color: c.statusDanger, fontSize: 12 }}>{draft.error}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {draft.status !== "rejected" ? <Action primary label={draft.status === "saving" ? "保存修改中…" : draft.status === "unknown" ? "重试同一次修改" : "保存修改"} disabled={draft.status === "saving"} onPress={() => { void editor.save(); }} /> : null}
      <Action label={draft.status === "rejected" ? "关闭修改提示" : "取消修改"} disabled={draft.status === "saving" || draft.status === "unknown"} onPress={editor.cancel} />
    </View>
  </View>;
}
