import { Pressable, Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { Interaction } from "../shared/contracts";
import type { InteractionMarker } from "../shared/frame-contract";
import { useColors } from "./ui";

/** Always occupies the same space, including while empty or a thread is open. */
export function DiscussionRail({ markers, compact, selectedId, disabled, statusNames, onOpen }: {
  markers: InteractionMarker[]; compact: boolean; selectedId?: string; disabled: boolean;
  statusNames: Record<Interaction["status"], string>; onOpen(id: string): void;
}) {
  const c = useColors();
  return <View testID="board-discussion-rail" accessibilityLabel="画布讨论索引" style={{ width: compact ? 52 : 168, flexShrink: 0, minHeight: 0, borderLeftWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }}>
    <View style={{ paddingHorizontal: compact ? 4 : 12, paddingVertical: 12, borderBottomWidth: 1, borderColor: c.border }}>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, textAlign: compact ? "center" : "left" }}>{compact ? `${markers.length}` : `讨论 · ${markers.length}`}</Text>
    </View>
    <ScrollView testID="board-discussion-list" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: compact ? 4 : 6, gap: 4 }} keyboardShouldPersistTaps="handled">
      {!markers.length ? <Text style={{ paddingVertical: 12, color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>{compact ? "—" : "讨论会留在这里"}</Text> : null}
      {markers.map(marker => {
        const selected = marker.id === selectedId;
        const active = ["saved", "sending", "delivered", "processing"].includes(marker.status);
        const color = marker.status === "failed" ? c.statusDanger : active ? c.accent : c.foregroundMuted;
        const label = `${marker.number} · ${statusNames[marker.status]} · ${marker.text}`;
        return <Pressable key={marker.id} testID={`board-discussion-${marker.id}`} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={() => onOpen(marker.id)} style={({ pressed }) => ({ flexDirection: "row", gap: 7, alignItems: "flex-start", paddingHorizontal: compact ? 3 : 6, paddingVertical: 9, borderRadius: 7, borderWidth: 1, borderColor: selected ? c.accent : "transparent", backgroundColor: selected || pressed ? c.surface2 : "transparent", opacity: disabled ? 0.5 : 1 })}>
          <View style={{ width: 24, height: 24, flexShrink: 0, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color, borderRadius: 12, backgroundColor: c.surface1 }}>
            <Text style={{ fontSize: marker.number > 99 ? 9 : 11, fontWeight: "600", color }}>{marker.number}</Text>
          </View>
          {!compact ? <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 12, lineHeight: 17, maxHeight: 34, overflow: "hidden" }}>{marker.text.replace(/\s+/g, " ")}</Text>
            <Text numberOfLines={1} style={{ color, fontSize: 10 }}>{statusNames[marker.status]}</Text>
          </View> : null}
        </Pressable>;
      })}
    </ScrollView>
  </View>;
}
