// Small themed building blocks. Every color comes from the host theme; layout follows `compact`.

import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";

export interface Themed {
  theme: PluginTheme;
}

export function Card({ theme, children, style }: Themed & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      style={[
        { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 10, padding: 14, gap: 8 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Title({ theme, children, size = 15 }: Themed & { children: ReactNode; size?: number }) {
  return <Text style={{ color: theme.colors.foreground, fontSize: size, fontWeight: "600" }}>{children}</Text>;
}

export function Body({ theme, children, muted, mono, selectable, style, numberOfLines }: Themed & { children: ReactNode; muted?: boolean; mono?: boolean; selectable?: boolean; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  return (
    <Text
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[
        { color: muted ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: mono ? 12.5 : 13.5, lineHeight: mono ? 18 : 19 },
        mono ? { fontFamily: "Menlo" } : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
}

type Tone = "default" | "accent" | "danger" | "success" | "warning";

function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "accent":
      return theme.colors.accent;
    case "danger":
      return theme.colors.statusDanger;
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function Badge({ theme, label, tone = "default" }: Themed & { label: string; tone?: Tone }) {
  const color = toneColor(theme, tone);
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 11.5, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Button({
  theme,
  label,
  icon,
  onPress,
  tone = "default",
  primary,
  disabled,
  busy,
  accessibilityLabel,
}: Themed & { label: string; icon?: string; onPress(): void; tone?: Tone; primary?: boolean; disabled?: boolean; busy?: boolean; accessibilityLabel?: string }) {
  const color = primary ? theme.colors.accentForeground : tone === "default" ? theme.colors.foreground : toneColor(theme, tone);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: primary ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : pressed ? theme.colors.surface2 : theme.colors.surface1,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={{ color, fontSize: 13, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function Tabs<T extends string>({ theme, tabs, value, onChange }: Themed & { tabs: ReadonlyArray<{ id: T; label: string; icon: string; badge?: number }>; value: T; onChange(id: T): void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        const color = active ? theme.colors.accentForeground : theme.colors.foreground;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(tab.id)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: 999,
              backgroundColor: active ? theme.colors.accent : theme.colors.surface1,
              borderWidth: 1,
              borderColor: active ? theme.colors.accent : theme.colors.border,
            }}
          >
            <Icon name={tab.icon} size={14} color={color} />
            <Text style={{ color, fontSize: 13, fontWeight: "600" }}>{tab.label}</Text>
            {tab.badge ? (
              <View style={{ backgroundColor: active ? theme.colors.accentForeground : theme.colors.statusWarning, borderRadius: 999, paddingHorizontal: 6 }}>
                <Text style={{ color: active ? theme.colors.accent : theme.colors.surface0, fontSize: 11, fontWeight: "700" }}>{tab.badge}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

export function UsageBar({ theme, used, limit }: Themed & { used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const color = ratio >= 0.95 ? theme.colors.statusDanger : ratio >= 0.8 ? theme.colors.statusWarning : theme.colors.accent;
  return (
    <View style={{ gap: 4 }}>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        <View style={{ width: `${Math.round(ratio * 100)}%`, height: 6, backgroundColor: color }} />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
        {Math.round(ratio * 100)}% · {used.toLocaleString()}/{limit.toLocaleString()} chars
      </Text>
    </View>
  );
}

export function Row({ children, gap = 8, wrap, style }: { children: ReactNode; gap?: number; wrap?: boolean; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap, flexWrap: wrap ? "wrap" : "nowrap" }, style]}>{children}</View>;
}

export function Empty({ theme, icon, text }: Themed & { icon: string; text: string }) {
  return (
    <View style={{ alignItems: "center", gap: 8, paddingVertical: 28 }}>
      <Icon name={icon} size={22} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

export function ErrorText({ theme, error }: Themed & { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  return <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{message}</Text>;
}

export function Loading({ theme }: Themed) {
  return (
    <View style={{ paddingVertical: 24, alignItems: "center" }}>
      <ActivityIndicator color={theme.colors.foregroundMuted} />
    </View>
  );
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}
