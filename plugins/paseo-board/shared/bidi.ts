/**
 * Unicode bidirectional embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069). In visitor
 * text they can make a comment or reply display in a different order than its real characters, so the owner's
 * inbox shows them as visible markers and public replies may not contain them.
 */
export const BIDI_CONTROL = /[‪-‮⁦-⁩]/;
/**
 * Replaces each bidi control with a visible `[U+202E]` marker, for display only (stored text is unchanged). Directional
 * marks and invisible zero-width characters (U+061C, U+200B–U+200F, U+2060, U+FEFF) are shown the same way, so a
 * visitor's name or text cannot hide or imitate anything (public-threads §12 A5).
 */
export function showBidiControls(text: string): string {
  return text.replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, char => `[U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}]`);
}
