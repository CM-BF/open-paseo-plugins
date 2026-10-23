import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { TransferData } from "../shared/contracts";

const PHASE_LABELS: Readonly<Record<string, string>> = {
  fallback: "已交接给 GPT 备用会话",
  returning: "正在交回原会话并继续",
  returned: "已返回原会话",
  paused: "会话交接已暂停",
  blocked: "等待额度恢复",
};

export function TransferRow({ item, theme, layout }: PluginTimelineItemProps<TransferData>) {
  const { mainAgentId, fallbackAgentId, phase, message } = item.data;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <View
      style={{
        gap: 8,
        padding: layout.compact ? 12 : 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
        {PHASE_LABELS[phase] ?? "模型会话交接"}
      </Text>
      <Text selectable style={{ color: theme.colors.foreground, fontSize: 13, lineHeight: 20 }}>
        {message}
      </Text>
      <View style={{ gap: 4 }}>
        <Text selectable style={muted}>原会话：{mainAgentId}</Text>
        <Text selectable style={muted}>备用会话：{fallbackAgentId}</Text>
      </View>
    </View>
  );
}
