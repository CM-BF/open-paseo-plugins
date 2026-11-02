import { View } from "react-native";
import type { BoardLiveStatus } from "./board-events";
import { Copy, useColors } from "./ui";

const labels: Record<BoardLiveStatus, string> = { connecting: "状态检查中", checking: "已同步", connected: "已同步", recovering: "恢复中", disconnected: "断开", unsupported: "宿主不支持" };

export function BoardConnectionStatus({ status }: { status: BoardLiveStatus }) {
  const c = useColors();
  const color = status === "connected" || status === "checking" ? c.statusSuccess : status === "disconnected" || status === "unsupported" ? c.statusDanger : c.foregroundMuted;
  return <View testID="board-connection-status" accessibilityLabel={`实时同步：${labels[status]}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} /><Copy muted small>实时同步 · {labels[status]}</Copy></View>;
}
