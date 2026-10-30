import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { Interaction } from "../shared/contracts";
import { Action, Copy, useColors } from "./ui";

export function SideAgentPicker({ interactions, selectedId, pending, disabled, onSelect }: {
  interactions: Interaction[]; selectedId?: string; pending: boolean; disabled: boolean; onSelect(agentId: string): Promise<boolean>;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const choices = useMemo(() => {
    const agents = new Map<string, { id: string; label: string; text: string }>();
    for (const item of interactions) if (item.kind === "fork" && item.agentId && !agents.has(item.agentId)) agents.set(item.agentId, { id: item.agentId, label: `旁支 ${agents.size + 1}`, text: item.text.replace(/\s+/g, " ").slice(0, 90) });
    return [...agents.values()];
  }, [interactions]);
  const current = choices.find(item => item.id === selectedId);
  return <View testID="board-side-agent-picker" style={{ gap: 6 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Copy small muted>Side 目标</Copy>
      <Action label={`${pending ? "旁支建立中" : selectedId ? current?.label ?? "当前旁支" : "首次发送时新建"} ▾`} disabled={disabled} onPress={() => setOpen(value => !value)} />
    </View>
    {pending ? <Copy small muted>Side 发送将继续正在建立的旁支；也可改选以前的旁支。</Copy> : null}
    {open ? <View testID="board-side-agent-options" style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, overflow: "hidden" }}>
      <ScrollView style={{ maxHeight: 156 }} contentContainerStyle={{ padding: 4, gap: 3 }} keyboardShouldPersistTaps="handled">
        {!choices.length ? <Copy small muted>还没有旁支。Side 发送会建立一个，并在之后继续使用。</Copy> : null}
        {choices.map(item => <Pressable key={item.id} testID={`board-side-agent-${item.id}`} accessibilityRole="button" accessibilityLabel={`使用${item.label}：${item.text}`} accessibilityState={{ selected: !pending && selectedId === item.id, disabled }} disabled={disabled} onPress={() => { void onSelect(item.id).then(changed => { if (changed) setOpen(false); }); }} style={({ pressed }) => ({ padding: 8, gap: 3, borderRadius: 5, backgroundColor: pressed || !pending && selectedId === item.id ? c.surface2 : c.surface0 })}>
          <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "600" }}>{item.label}{!pending && selectedId === item.id ? " · 当前" : ""}</Text>
          <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{item.text}</Text>
        </Pressable>)}
      </ScrollView>
    </View> : null}
  </View>;
}
