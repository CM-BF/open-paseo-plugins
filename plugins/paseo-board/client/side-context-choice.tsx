import { Pressable, Text, View } from "react-native";
import type { SideContext } from "../shared/contracts";
import { SIDE_CONTEXT_LABELS } from "./side-context";
import { Copy, useColors } from "./ui";

const CHOICES: SideContext[] = ["blank", "owner-history"];

/** Always-visible choice for any send that creates a new Side; hotkeys use the visible value. */
export function SideContextChoice({ testID = "board-side-context", value, disabled, notes, onChange }: {
  testID?: string; value: SideContext; disabled: boolean; notes: string[]; onChange(value: SideContext): void;
}) {
  const c = useColors();
  return <View style={{ gap: 4 }}>
    <View testID={testID} accessibilityRole="radiogroup" accessibilityLabel="新建 Side 时" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Copy small muted>新建 Side 时</Copy>
      {CHOICES.map(choice => {
        const checked = value === choice;
        return <Pressable key={choice} testID={`${testID}-${choice}`} accessibilityRole="radio" accessibilityLabel={SIDE_CONTEXT_LABELS[choice]} accessibilityState={{ checked, disabled }} disabled={disabled} onPress={() => { if (!checked) onChange(choice); }}
          style={({ pressed }) => ({ minHeight: 30, justifyContent: "center", paddingHorizontal: 9, borderRadius: 7, borderWidth: 1, borderColor: checked ? c.accent : c.border, backgroundColor: checked || pressed ? c.surface2 : c.surface0, opacity: disabled ? 0.45 : 1 })}>
          <Text style={{ color: c.foreground, fontSize: 12, fontWeight: checked ? "600" : "500" }}>{checked ? "● " : "○ "}{SIDE_CONTEXT_LABELS[choice]}</Text>
        </Pressable>;
      })}
    </View>
    {notes.map(note => <Copy key={note} small muted>{note}</Copy>)}
  </View>;
}
