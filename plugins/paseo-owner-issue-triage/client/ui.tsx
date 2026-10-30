import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { PLUGIN_ID, type Item, type Overview } from "../shared/types";

export const overviewKey = [PLUGIN_ID, "overview"] as const;
export type Theme = PluginScreenProps["theme"];
export type Styles = ReturnType<typeof createStyles>;

export const STATUS_LABELS: Record<Item["status"], string> = {
  discovered: "已发现", queued: "待处理", analyzing: "分析中", completed: "已完成",
  failed: "失败", claimed: "人工接管", closed: "已关闭",
};
export const STATUSES = Object.keys(STATUS_LABELS) as Item["status"][];

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function dateLabel(value: string | number | null | undefined): string {
  if (!value) return "尚无";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
}

export function useOverviewAction<Input>(mutationFn: (input: Input) => Promise<Overview>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data) => queryClient.setQueryData(overviewKey, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: overviewKey }),
  });
}

export function Button({ label, onPress, disabled = false, primary = false, styles, selected = false }: {
  label: string; onPress(): void; disabled?: boolean; primary?: boolean; styles: Styles; selected?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, primary ? styles.primary : null, selected ? styles.selected : null, disabled ? styles.disabled : null, pressed ? styles.pressed : null]}>
      <Text style={primary ? styles.primaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, hint, value, onChange, styles, multiline = false, numeric = false, disabled = false, placeholder, maxLength = 2000 }: {
  label: string; hint?: string; value: string; onChange(value: string): void; styles: Styles;
  multiline?: boolean; numeric?: boolean; disabled?: boolean; placeholder?: string; maxLength?: number;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} value={value} onChangeText={onChange} editable={!disabled}
        autoCapitalize="none" autoCorrect={false} multiline={multiline} keyboardType={numeric ? "number-pad" : "default"}
        placeholder={placeholder} placeholderTextColor={styles.muted.color} maxLength={maxLength}
        style={[styles.input, multiline ? styles.multiline : null, disabled ? styles.disabled : null]} />
      {hint ? <Text style={styles.muted}>{hint}</Text> : null}
    </View>
  );
}

export function Section({ title, children, styles, hint }: { title: string; children: ReactNode; styles: Styles; hint?: string }) {
  return <View style={styles.section}>
    <Text style={styles.sectionTitle}>{title}</Text>
    {hint ? <Text style={styles.muted}>{hint}</Text> : null}
    {children}
  </View>;
}

export function ErrorText({ error, styles }: { error: unknown; styles: Styles }) {
  return error ? <Text accessibilityRole="alert" selectable style={styles.error}>{messageOf(error)}</Text> : null;
}

export function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.surface0 },
    content: { padding: compact ? 14 : 28, paddingBottom: 48, gap: compact ? 18 : 24, width: "100%", maxWidth: 1180, alignSelf: "center" },
    section: { gap: 12 },
    heading: { color: c.foreground, fontSize: compact ? 23 : 28, fontWeight: "700", flexShrink: 1 },
    sectionTitle: { color: c.foreground, fontSize: 18, fontWeight: "600" },
    title: { color: c.foreground, fontSize: 16, lineHeight: 23, fontWeight: "600", flexShrink: 1 },
    text: { color: c.foreground, fontSize: 14, lineHeight: 21 },
    muted: { color: c.foregroundMuted, fontSize: 12, lineHeight: 18 },
    label: { color: c.foreground, fontSize: 13, fontWeight: "600", lineHeight: 19 },
    error: { color: c.statusDanger, fontSize: 13, lineHeight: 20 },
    warning: { color: c.statusWarning, fontSize: 13, lineHeight: 20 },
    success: { color: c.statusSuccess, fontSize: 13, lineHeight: 20 },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    wrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
    between: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" },
    grid: { flexDirection: compact ? "column" : "row", gap: 16 },
    column: { flex: compact ? undefined : 1, minWidth: 0, gap: 12 },
    grow: { flex: 1, minWidth: 0 },
    panel: { backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: compact ? 14 : 18, gap: 12 },
    issue: { borderTopColor: c.border, borderTopWidth: 1, paddingTop: 18, paddingBottom: 2, gap: 10 },
    divider: { borderTopWidth: 1, borderTopColor: c.border, marginVertical: 4 },
    button: { paddingHorizontal: 12, paddingVertical: 9, minHeight: 38, justifyContent: "center", borderWidth: 1, borderColor: c.border, borderRadius: 7, backgroundColor: c.surface2, maxWidth: "100%" },
    buttonText: { color: c.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 },
    primary: { backgroundColor: c.accent, borderColor: c.accent },
    primaryText: { color: c.accentForeground, fontSize: 13, fontWeight: "600", flexShrink: 1 },
    selected: { borderColor: c.accent },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.7 },
    field: { gap: 6, minWidth: 0 },
    input: { color: c.foreground, backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: 7, paddingHorizontal: 11, paddingVertical: 10, minHeight: 42, fontSize: 14 },
    multiline: { minHeight: 96, textAlignVertical: "top" },
    tag: { borderColor: c.border, borderWidth: 1, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
    tagText: { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 },
    result: { gap: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: c.accent },
    step: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    choices: { maxHeight: 230 },
    choiceContent: { gap: 8 },
  });
}
