import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
export interface Themed {
  theme: PluginTheme;
}
export function Row({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      {children}
    </View>
  );
}
export function Body({
  theme,
  children,
  muted,
  mono,
}: Themed & { children: ReactNode; muted?: boolean; mono?: boolean }) {
  return (
    <Text
      selectable
      style={{
        color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: mono ? 12 : 13.5,
        lineHeight: mono ? 19 : 21,
        ...(mono ? { fontFamily: "Menlo" } : {}),
      }}
    >
      {children}
    </Text>
  );
}
export function Title({ theme, children }: Themed & { children: ReactNode }) {
  return (
    <Text
      style={{
        color: theme.colors.foreground,
        fontSize: 16,
        fontWeight: "600",
      }}
    >
      {children}
    </Text>
  );
}
export function Panel({ theme, children }: Themed & { children: ReactNode }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        padding: 16,
        gap: 12,
      }}
    >
      {children}
    </View>
  );
}
export function Badge({
  theme,
  label,
  warning,
}: Themed & { label: string; warning?: boolean }) {
  return (
    <Text
      style={{
        fontSize: 11,
        color: warning
          ? theme.colors.statusWarning
          : theme.colors.foregroundMuted,
        backgroundColor: theme.colors.surface2,
        borderRadius: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
      }}
    >
      {label}
    </Text>
  );
}
export function Button({
  theme,
  label,
  onPress,
  disabled,
  busy,
  primary,
  icon,
  danger,
}: Themed & {
  label: string;
  onPress(): void;
  disabled?: boolean;
  busy?: boolean;
  primary?: boolean;
  icon?: string;
  danger?: boolean;
}) {
  const color = primary
    ? theme.colors.accentForeground
    : danger
      ? theme.colors.statusDanger
      : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        borderRadius: 7,
        paddingHorizontal: 12,
        paddingVertical: 9,
        borderWidth: 1,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary
          ? theme.colors.accent
          : pressed
            ? theme.colors.surface2
            : theme.colors.surface1,
        opacity: disabled || busy ? 0.5 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={color} />
      ) : icon ? (
        <Icon name={icon} size={15} color={color} />
      ) : null}
      <Text style={{ fontSize: 13, fontWeight: "500", color }}>{label}</Text>
    </Pressable>
  );
}
export function Field({
  theme,
  value,
  onChange,
  placeholder,
  onSubmit,
  multiline = false,
}: Themed & {
  value: string;
  onChange(value: string): void;
  placeholder: string;
  onSubmit?(): void;
  multiline?: boolean;
}) {
  return (
    <TextInput
      accessibilityLabel={placeholder}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      onSubmitEditing={onSubmit}
      multiline={multiline}
      autoCapitalize="none"
      autoCorrect={false}
      style={{
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 7,
        padding: 11,
        fontSize: 13.5,
        minWidth: 0,
        flexGrow: 1,
        minHeight: multiline ? 88 : undefined,
        textAlignVertical: multiline ? "top" : "center",
      }}
    />
  );
}
export function Tabs<T extends string>({
  theme,
  items,
  value,
  onChange,
}: Themed & {
  items: readonly { id: T; label: string }[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <Row>
      {items.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === item.id }}
          onPress={() => onChange(item.id)}
          style={{
            paddingHorizontal: 12,
            paddingVertical: 9,
            borderBottomWidth: 2,
            borderColor:
              value === item.id ? theme.colors.accent : "transparent",
          }}
        >
          <Text
            style={{
              color:
                value === item.id
                  ? theme.colors.foreground
                  : theme.colors.foregroundMuted,
              fontSize: 13,
              fontWeight: value === item.id ? "600" : "400",
            }}
          >
            {item.label}
          </Text>
        </Pressable>
      ))}
    </Row>
  );
}
export function ErrorText({ theme, error }: Themed & { error: unknown }) {
  return error ? (
    <Text
      selectable
      accessibilityRole="alert"
      style={{ color: theme.colors.statusDanger, fontSize: 13, lineHeight: 20 }}
    >
      {error instanceof Error ? error.message : String(error)}
    </Text>
  ) : null;
}
export function Loading({
  theme,
  label = "Loading…",
}: Themed & { label?: string }) {
  return (
    <Row>
      <ActivityIndicator color={theme.colors.foregroundMuted} />
      <Body theme={theme} muted>
        {label}
      </Body>
    </Row>
  );
}
export function timestamp(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
