import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { UpdateRow } from "../shared/contracts";

function headline(data: UpdateRow): string {
  if (data.trigger === "remember") return data.status === "updated" ? "Remembered" : "Already in memory";
  return HEADLINE[data.status];
}

const HEADLINE: Record<UpdateRow["status"], string> = {
  running: "Learning loop is reviewing this conversation…",
  updated: "Learning loop saved what this conversation taught",
  staged: "Learning loop staged updates for your approval",
  nothing: "Learning loop review: nothing worth saving",
  failed: "Learning loop review failed",
};

export function UpdateRowView({ item, theme }: PluginTimelineItemProps<UpdateRow>) {
  const data = item.data;
  const [open, setOpen] = useState(false);
  const color = data.status === "failed" ? theme.colors.statusDanger : data.status === "staged" ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  const shown = open ? data.actions : data.actions.slice(0, 3);
  const meta = [data.model, data.costUsd !== null ? `$${data.costUsd.toFixed(3)}` : null, data.trigger !== "threshold" && data.trigger !== "remember" ? data.trigger : null].filter(Boolean).join(" · ");
  return (
    <View style={{ borderLeftWidth: 2, borderColor: color, paddingLeft: 10, paddingVertical: 4, gap: 4, marginVertical: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="BrainCircuit" size={14} color={color} />
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>{headline(data)}</Text>
      </View>
      {shown.map((action, index) => (
        <Text key={index} selectable style={{ color: theme.colors.foreground, fontSize: 12.5 }}>
          • {action}
        </Text>
      ))}
      {data.actions.length > 3 ? (
        <Pressable accessibilityRole="button" onPress={() => setOpen((v) => !v)}>
          <Text style={{ color: theme.colors.accent, fontSize: 12.5 }}>{open ? "Show less" : `Show ${data.actions.length - 3} more`}</Text>
        </Pressable>
      ) : null}
      {data.note ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{data.note}</Text> : null}
      {meta ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>{meta}</Text> : null}
    </View>
  );
}
