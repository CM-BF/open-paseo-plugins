import { Pressable, Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import type { Interaction } from "../shared/contracts";
import type { InteractionMarker } from "../shared/frame-contract";
import { useColors } from "./ui";
import { discussionGroups } from "./interaction-layout";

/** Always occupies the same space, including while empty or a thread is open. */
export function DiscussionRail({ markers, tags, compact, selectedId, disabled, statusNames, onOpen }: {
  markers: InteractionMarker[]; compact: boolean; selectedId?: string; disabled: boolean;
  /** Short provenance per root interaction (Sides created with the owner's history); the description is read by screen readers. */
  tags?: ReadonlyMap<string, { tag: string; description: string }>;
  statusNames: Record<Interaction["status"], string>; onOpen(id: string): void;
}) {
  const c = useColors();
  const groups = discussionGroups(markers);
  return <View testID="board-discussion-rail" accessibilityLabel="画布讨论索引" style={{ width: compact ? 52 : 168, flexShrink: 0, minHeight: 0, borderLeftWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }}>
    <View style={{ paddingHorizontal: compact ? 4 : 12, paddingVertical: 12, borderBottomWidth: 1, borderColor: c.border }}>
      <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, textAlign: compact ? "center" : "left" }}>{compact ? `${groups.length}` : `讨论 · ${groups.length}`}</Text>
    </View>
    <ScrollView testID="board-discussion-list" style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: compact ? 4 : 6, gap: 4 }} keyboardShouldPersistTaps="handled">
      {!groups.length ? <Text style={{ paddingVertical: 12, color: c.foregroundMuted, fontSize: 12, textAlign: "center" }}>{compact ? "—" : "讨论会留在这里"}</Text> : null}
      {groups.map(group => {
        const marker = group.marker;
        const selected = group.id === selectedId || group.markerIds.includes(selectedId ?? "");
        const active = ["saved", "sending", "delivered", "processing"].includes(marker.status);
        const color = marker.status === "failed" ? c.statusDanger : active ? c.accent : c.foregroundMuted;
        const countLabel = group.commentCount ? ` · ${group.commentCount} 条评论` : "";
        const side = tags?.get(marker.interactionId ?? marker.id);
        const tagLabel = side ? ` · ${side.tag}` : "";
        const label = `${marker.number}${countLabel} · ${statusNames[marker.status]} · ${marker.text}${side ? ` · ${side.description}` : ""}`;
        return <Pressable key={group.id} testID={`board-discussion-${group.id}`} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={() => onOpen(marker.id)} style={({ pressed }) => ({ flexDirection: "row", gap: 7, alignItems: "flex-start", paddingHorizontal: compact ? 3 : 6, paddingVertical: 9, borderRadius: 7, borderWidth: 1, borderColor: selected ? c.accent : "transparent", backgroundColor: selected || pressed ? c.surface2 : "transparent", opacity: disabled ? 0.5 : 1 })}>
          <View style={{ width: 24, height: 24, flexShrink: 0, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: color, borderRadius: 12, backgroundColor: c.surface1 }}>
            <Text style={{ fontSize: marker.number > 99 ? 9 : 11, fontWeight: "600", color }}>{marker.number}</Text>
          </View>
          {!compact ? <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Text numberOfLines={2} style={{ color: c.foreground, fontSize: 12, lineHeight: 17, maxHeight: 34, overflow: "hidden" }}>{marker.text.replace(/\s+/g, " ")}</Text>
            <Text numberOfLines={1} style={{ color, fontSize: 10 }}>{statusNames[marker.status]}{countLabel}{tagLabel}</Text>
          </View> : null}
        </Pressable>;
      })}
    </ScrollView>
  </View>;
}
