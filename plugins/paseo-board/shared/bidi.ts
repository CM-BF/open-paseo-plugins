/**
 * Unicode bidirectional embedding, override and isolate controls (U+202A–U+202E, U+2066–U+2069). In visitor
 * text they can make a comment or reply display in a different order than its real characters, so the owner's
 * inbox shows them as visible markers and public replies may not contain them.
 */
export const BIDI_CONTROL = /[‪-‮⁦-⁩]/;
/**
 * Characters a reader cannot see but that change what text says or how it reads (public-threads §12 A5, review fix):
 * - bidi embeddings, overrides, isolates and marks (U+061C, U+200E–U+200F, U+202A–U+202E, U+2066–U+2069);
 * - zero-width and invisible format characters (U+00AD, U+200B–U+200D, U+2060–U+2064, U+206A–U+206F, U+FEFF,
 *   U+FFF9–U+FFFB, U+180B–U+180F, U+034F, U+17B4–U+17B5) and blank fillers (U+115F, U+1160, U+3164, U+FFA0);
 * - Unicode tag characters (U+E0000–U+E007F), which can spell hidden ASCII text that a language model still reads,
 *   and other invisible astral format controls (U+1BCA0–U+1BCA3, U+1D173–U+1D17A);
 * - runs of two or more variation selectors (U+FE00–U+FE0F, U+E0100–U+E01EF), which can carry hidden data; a
 *   single selector after an emoji or ideograph is ordinary text and stays.
 * Written without the `u` flag (surrogate pairs) for every JavaScript engine the plugin runs in; the published
 * viewer (shared/public-threads.ts) uses the same source.
 */
export const INVISIBLE_SOURCE = String.raw`[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯ㅤ﻿ﾠ￹-￻]|\uDB40[\uDC00-\uDC7F]|\uD82F[\uDCA0-\uDCA3]|\uD834[\uDD73-\uDD7A]|(?:[︀-️]|\uDB40[\uDD00-\uDDEF]){2,}`;
const INVISIBLE = new RegExp(INVISIBLE_SOURCE, "g");
/**
 * Replaces each such character with a visible `[U+202E]` marker, for display only (stored text is unchanged), so a
 * visitor's name or text cannot hide text from the people reading it or reorder what they see.
 */
export function showBidiControls(text: string): string {
  return text.replace(INVISIBLE, run => Array.from(run, char => `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`).join(""));
}
