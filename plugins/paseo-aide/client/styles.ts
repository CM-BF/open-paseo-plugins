import type { PluginTheme } from "@getpaseo/plugin";
import { Platform, StyleSheet } from "react-native";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, Consolas, monospace" });

export function createStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: compact ? 14 : 24, gap: compact ? 16 : 20, maxWidth: 920, width: "100%", alignSelf: "center" },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    wrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
    between: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
    grow: { flex: 1, minWidth: 0 },
    heading: { color: colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "700", flexShrink: 1 },
    subheading: { color: colors.foregroundMuted, fontSize: 13 },
    sectionTitle: { color: colors.foregroundMuted, fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4 },
    section: { gap: 8 },
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface1,
      overflow: "hidden",
    },
    item: { paddingHorizontal: compact ? 12 : 14, paddingVertical: compact ? 10 : 12, gap: 4 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
    title: { color: colors.foreground, fontSize: 14, fontWeight: "600", flexShrink: 1 },
    text: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
    muted: { color: colors.foregroundMuted, fontSize: 12 },
    mutedText: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    danger: { color: colors.statusDanger, fontSize: 13 },
    mono: { color: colors.foreground, fontSize: 12, fontFamily: MONO },
    empty: { color: colors.foregroundMuted, fontSize: 13, paddingHorizontal: compact ? 12 : 14, paddingVertical: 12 },
    pill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, borderWidth: 1 },
    pillText: { fontSize: 12, fontWeight: "600" },
    button: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
      backgroundColor: colors.surface2,
    },
    buttonText: { color: colors.foreground, fontSize: 13, fontWeight: "600" },
    primary: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.accent },
    primaryText: { color: colors.accentForeground, fontSize: 13, fontWeight: "700" },
    small: { borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4, backgroundColor: colors.surface2 },
    smallText: { color: colors.foreground, fontSize: 12, fontWeight: "600" },
    link: { color: colors.accent, fontSize: 13, fontWeight: "600" },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: colors.foreground,
      backgroundColor: colors.surface0,
      fontSize: 13,
    },
    textarea: { minHeight: compact ? 150 : 180, textAlignVertical: "top", fontFamily: MONO, fontSize: 12 },
    label: { color: colors.foreground, fontSize: 13, fontWeight: "600" },
    field: { gap: 6 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    choice: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.surface0 },
    choiceActive: { borderColor: colors.accent, backgroundColor: colors.surface2 },
    choiceText: { color: colors.foreground, fontSize: 12 },
    grid: { flexDirection: compact ? "column" : "row", gap: compact ? 16 : 20, alignItems: "flex-start" },
    column: { flex: 1, minWidth: 0, gap: compact ? 16 : 20, width: compact ? "100%" : undefined },
  });
}

export type Styles = ReturnType<typeof createStyles>;
