import { createElement, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import type { SideContext } from "../shared/contracts";
import { SIDE_CONTEXT_LABELS, SIDE_CONTEXT_SCOPE } from "./side-context";
import { Copy, useColors } from "./ui";
import { canRenderFrames } from "./web";

const CHOICES: SideContext[] = ["blank", "owner-history"];
/** `keepFocus` is set for arrow-key moves inside the group; a click or Space returns focus to the message input. */
export type SideContextChange = (value: SideContext, options?: { keepFocus?: boolean }) => void;
type KeyEvent = { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; preventDefault(): void };

/**
 * Always-visible choice for any send that creates a new Side; hotkeys use the visible value.
 * Pressing an option always reports it (even when already checked) so the caller can restore input focus.
 * On the web it is a real radio group: one Tab stop on the checked option, arrow keys/Home/End move the selection.
 */
export function SideContextChoice({ testID = "board-side-context", value, disabled, notes, onChange }: {
  testID?: string; value: SideContext; disabled: boolean; notes: string[]; onChange: SideContextChange;
}) {
  const c = useColors();
  const options = useRef<Partial<Record<SideContext, { focus(): void } | null>>>({});
  const caption = <Copy small muted>新建 Side 时</Copy>;
  const text = (choice: SideContext) => `${value === choice ? "● " : "○ "}${SIDE_CONTEXT_LABELS[choice]}`;
  const group = canRenderFrames ? createElement("div", {
    role: "radiogroup", "aria-label": "新建 Side 时", "data-testid": testID,
    style: { display: "flex", flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 },
    onKeyDown: (event: KeyEvent) => {
      if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
      const index = CHOICES.indexOf(value);
      const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? CHOICES[(index + 1) % CHOICES.length]
        : event.key === "ArrowLeft" || event.key === "ArrowUp" ? CHOICES[(index + CHOICES.length - 1) % CHOICES.length]
          : event.key === "Home" ? CHOICES[0] : event.key === "End" ? CHOICES[CHOICES.length - 1] : undefined;
      if (!next) return;
      event.preventDefault();
      onChange(next, { keepFocus: true });
      options.current[next]?.focus();
    },
  }, caption, ...CHOICES.map(choice => {
    const checked = value === choice;
    return createElement("button", {
      key: choice, ref: (node: { focus(): void } | null) => { options.current[choice] = node; },
      type: "button", role: "radio", "aria-checked": checked, "aria-label": SIDE_CONTEXT_LABELS[choice], "data-testid": `${testID}-${choice}`,
      ...(choice === "owner-history" ? { title: SIDE_CONTEXT_SCOPE } : {}),
      tabIndex: checked ? 0 : -1, disabled,
      onClick: () => onChange(choice),
      style: {
        display: "inline-flex", alignItems: "center", boxSizing: "border-box", minHeight: 30, margin: 0, padding: "0 9px",
        borderRadius: 7, border: `1px solid ${checked ? c.accent : c.border}`, background: checked ? c.surface2 : c.surface0,
        color: c.foreground, font: "inherit", fontSize: 12, lineHeight: "16px", fontWeight: checked ? 600 : 500,
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1, whiteSpace: "nowrap",
      },
    }, text(choice));
  })) : <View testID={testID} accessibilityRole="radiogroup" accessibilityLabel="新建 Side 时" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
    {caption}
    {CHOICES.map(choice => {
      const checked = value === choice;
      return <Pressable key={choice} testID={`${testID}-${choice}`} accessibilityRole="radio" accessibilityLabel={SIDE_CONTEXT_LABELS[choice]} accessibilityHint={choice === "owner-history" ? SIDE_CONTEXT_SCOPE : undefined} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => onChange(choice)}
        style={({ pressed }) => ({ minHeight: 30, justifyContent: "center", paddingHorizontal: 9, borderRadius: 7, borderWidth: 1, borderColor: checked ? c.accent : c.border, backgroundColor: checked || pressed ? c.surface2 : c.surface0, opacity: disabled ? 0.45 : 1 })}>
        <Text style={{ color: c.foreground, fontSize: 12, fontWeight: checked ? "600" : "500" }}>{text(choice)}</Text>
      </Pressable>;
    })}
  </View>;
  return <View style={{ gap: 4 }}>
    {group}
    {notes.map(note => <Copy key={note} small muted>{note}</Copy>)}
  </View>;
}
