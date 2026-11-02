import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { canRenderFrames } from "./web";
import { ColorContext, useColors } from "./ui";
import { useToolbarPopover } from "./toolbar-popover-web";

export function ToolbarPopover({ open, title, children, onClose, containerId, testID, width = 320, left, right }: {
  open: boolean; title: string; children: ReactNode; onClose(): void; containerId: string; testID: string;
  width?: number; left?: number; right?: number;
}) {
  const c = useColors(), maxHeight = useToolbarPopover(open, onClose, containerId);
  if (!open) return null;
  if (!canRenderFrames) return <Modal open title={title} onOpenChange={value => { if (!value) onClose(); }}><Modal.Content><ColorContext.Provider value={c}>{children}</ColorContext.Provider></Modal.Content></Modal>;
  return <View testID={testID} role="dialog" accessibilityLabel={title} style={{ position: "absolute", top: "100%", marginTop: 4, left, right: left === undefined ? right ?? 0 : undefined, width, maxHeight, zIndex: 100, backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border, borderRadius: 9, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 5 }, overflow: "hidden" }}>
    <View style={{ minHeight: 38, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 4, borderBottomWidth: 1, borderColor: c.border }}>
      <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12, fontWeight: "600" }}>{title}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`关闭${title}`} onPress={onClose} style={{ padding: 8 }}><Icon name="X" size={15} color={c.foregroundMuted} /></Pressable>
    </View>
    <ScrollView style={{ flexShrink: 1, minHeight: 0 }} contentContainerStyle={{ padding: 10, gap: 8 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
  </View>;
}
