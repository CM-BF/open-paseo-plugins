/**
 * Unicode bidirectional embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069). In visitor
 * text they can make a comment or reply display in a different order than its real characters, so the owner's
 * inbox shows them as visible markers and public replies may not contain them.
 */
export const BIDI_CONTROL = /[‪-‮⁦-⁩]/;
/** Replaces each bidi control with a visible `[U+202E]` marker, for display only (stored text is unchanged). */
export function showBidiControls(text: string): string {
  return text.replace(/[‪-‮⁦-⁩]/g, char => `[U+${char.charCodeAt(0).toString(16).toUpperCase()}]`);
}
