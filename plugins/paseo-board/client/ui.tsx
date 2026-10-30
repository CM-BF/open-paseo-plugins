import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { PluginHostProps } from "@getpaseo/plugin/client";

type Colors = PluginHostProps["theme"]["colors"];
export const ColorContext = createContext<Colors | null>(null);
export function useColors(): Colors {
  const value = useContext(ColorContext);
  if (!value) throw new Error("Board theme is missing");
  return value;
}
export function Action({ label, icon, onPress, active, disabled, primary }: {
  label: string; icon?: string; onPress: () => void; active?: boolean; disabled?: boolean; primary?: boolean;
}) {
  const c = useColors();
  const color = primary ? c.accentForeground : c.foreground;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected: active }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 8,
      borderRadius: 7, borderWidth: 1, borderColor: active ? c.accent : primary ? c.accent : c.border,
      backgroundColor: primary ? c.accent : pressed || active ? c.surface2 : c.surface0, opacity: disabled ? 0.45 : 1,
    })}>
    {icon ? <Icon name={icon} size={15} color={color} /> : null}
    <Text style={{ color, fontSize: 12, fontWeight: "500" }}>{label}</Text>
  </Pressable>;
}
export function Copy({ children, muted = false, small = false }: { children: ReactNode; muted?: boolean; small?: boolean }) {
  const c = useColors();
  return <Text selectable style={{ color: muted ? c.foregroundMuted : c.foreground, fontSize: small ? 12 : 14, lineHeight: small ? 18 : 22 }}>{children}</Text>;
}
export function Notice({ text, error = false }: { text: string; error?: boolean }) {
  const c = useColors();
  return <View accessibilityRole={error ? "alert" : undefined} style={{ padding: 12, backgroundColor: c.surface1, borderLeftWidth: 3, borderColor: error ? c.statusDanger : c.accent }}><Copy>{text}</Copy></View>;
}
export function localId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function timeLabel(at: string): string { return new Date(at).toLocaleString(); }
