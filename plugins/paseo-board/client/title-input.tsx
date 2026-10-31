import { createElement, useEffect, useRef, type ReactElement } from "react";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { canRenderFrames } from "./web";

interface Props {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  onSubmit(): void;
  onCancel(): void;
  color: string;
  backgroundColor: string;
  borderColor: string;
}

export function TitleInput(props: Props): ReactElement {
  const input = useRef<{ focus(): void; select?(): void } | null>(null);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  useEffect(() => { input.current?.focus(); input.current?.select?.(); }, []);
  const style = { flex: 1, minWidth: 80, color: props.color, backgroundColor: props.backgroundColor, borderColor: props.borderColor, borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 16, fontWeight: "600" as const };
  if (!canRenderFrames) return <TextInput ref={input as never} value={props.value} onChangeText={props.onChange} editable={!props.disabled} autoFocus selectTextOnFocus maxLength={200} accessibilityLabel="Board 名称" returnKeyType="done" onSubmitEditing={props.onSubmit} style={style} />;
  return createElement("input", {
    ref: input, value: props.value, disabled: props.disabled, maxLength: 200,
    "aria-label": "Board 名称", "data-testid": "board-title-input",
    onChange: (event: { target: { value: string } }) => props.onChange(event.target.value),
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; compositionEnded.current = Date.now(); },
    onKeyDown: (event: { key: string; keyCode: number; nativeEvent?: { isComposing?: boolean; keyCode?: number }; preventDefault(): void; stopPropagation(): void }) => {
      if (composing.current || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229 || Date.now() - compositionEnded.current < 50) return;
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation();
      if (props.disabled) return;
      if (event.key === "Enter") props.onSubmit(); else props.onCancel();
    },
    style: { flex: 1, minWidth: 80, boxSizing: "border-box", color: props.color, backgroundColor: props.backgroundColor, border: `1px solid ${props.borderColor}`, borderRadius: 6, padding: "6px 8px", font: "inherit", fontSize: 16, fontWeight: 600 },
  });
}
