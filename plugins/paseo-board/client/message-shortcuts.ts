export type MessageShortcut = "stage" | "main" | "side" | "new-side";

/** Exact modifiers avoid interpreting a text-editing chord as a send request. */
export function messageShortcut(event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): MessageShortcut | null {
  if (event.key !== "Enter") return null;
  const command = event.ctrlKey || event.metaKey;
  if (command) return !event.altKey && !event.shiftKey ? "main" : null;
  if (event.altKey) return event.shiftKey ? "new-side" : "side";
  return event.shiftKey ? null : "stage";
}
