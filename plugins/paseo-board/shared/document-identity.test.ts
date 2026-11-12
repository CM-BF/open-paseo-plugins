import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import stylesheet from "./assets/visualize.css.txt";
import icons from "./assets/runtime-icons.txt";
import tooltips from "./assets/runtime-tooltips.txt";
import runtime from "./assets/board-runtime.txt";
import compositionRuntime from "./assets/composition-runtime.txt";
import layoutState from "./assets/component-layout-state.txt";
import frameDelta from "./assets/frame-delta.txt";
import htmlToImage from "./assets/html-to-image.txt";
import { createComponentLayoutTools } from "./component-layout";
import { BOARD_CSP, buildBoardDocument } from "./document";
import { FRAME_CHANNEL, type FrameSnapshot } from "./frame-contract";
import { frameThemeFromColors, DEFAULT_DARK_COLORS, DEFAULT_LIGHT_COLORS, isSafeTokenValue } from "./frame-theme";

type DocumentInput = FrameSnapshot & { boardId: string; sessionId: string; title: string; compositionHostId?: string; compositionSecret?: string };

// Frozen copy of the document template at origin/main 4f88cd7, before the optional
// liquid-glass preset existed. A canvas without the preset marker must keep producing
// exactly this string. If the template changes on purpose, update this copy in the same
// commit and say why; never refresh it to make an unexplained difference pass.
function frozenBuildBoardDocument(input: DocumentInput): string {
  const tokens = Object.entries(input.theme.tokens).filter(([k, v]) => /^host-[a-z0-9-]+$/.test(k) && isSafeTokenValue(v)).map(([k, v]) => `--${k}:${v}`).join(";");
  const { html, ...canvas } = input.canvas;
  const initial = { channel: FRAME_CHANNEL, boardId: input.boardId, sessionId: input.sessionId, canvas, boardRevision: input.boardRevision, userState: input.userState, theme: input.theme, captureModule: htmlToImage, compositionHostId: input.compositionHostId, compositionSecret: input.compositionSecret };
  const bootstrap = `<script>(${runtime})(${scriptJson(initial)}, (${frameDelta}), (${createComponentLayoutTools.toString()}), (${layoutState}), (${compositionRuntime}));</script>`;
  const csp = input.compositionHostId && !input.compositionSecret ? BOARD_CSP.replace("frame-src 'none'", "frame-src blob:") : BOARD_CSP;
  return `<!doctype html><html lang="en" data-surface="page" data-palette="custom" data-theme="${input.theme.scheme}" style="${escapeHtml(tokens)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>@layer paseo-board-defaults {${stylesheet}\n}</style></head><body>${bootstrap}${html.replace(/^﻿/, "")}\n${/data-tooltip|dataset\.tooltip|floatingui/i.test(html) ? tooltips : ""}${/lucide/i.test(html) ? icons : ""}</body></html>`;
}
function scriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

const light = frameThemeFromColors(DEFAULT_LIGHT_COLORS), dark = frameThemeFromColors(DEFAULT_DARK_COLORS);
const canvas = (html: string, patches: Array<{ id: string; selector: string; operation: "append" | "replace" | "text"; html?: string; text?: string; expectedText?: string }> = []) =>
  ({ html, data: { n: 1 }, patches: patches.map(patch => ({ html: "", ...patch })), revision: 3, documentVersion: 2 }) as FrameSnapshot["canvas"];
const base = { boardId: "pin-board", sessionId: "0123456789abcdef0123456789abcdef", title: "Pinned <fixture>", boardRevision: 4, userState: { saved: true } };

/** Inputs that contain no liquid-glass marker; several mention nearby words on purpose. */
const MARKER_FREE_FIXTURES: Record<string, DocumentInput> = {
  plainLight: { ...base, theme: light, canvas: canvas('<main id="pin"><h1>Pinned</h1><p>Plain fragment.</p></main>') },
  fullDocumentDarkWithPatches: { ...base, theme: dark, canvas: canvas('<!doctype html><html><head><style>body{margin:0}</style></head><body><section id="a">A</section></body></html>', [
    { id: "p1", selector: "#a", operation: "append", html: '<p id="b">B appended</p>' },
    { id: "p2", selector: "#b", operation: "replace", html: '<p id="b" class="glass-note">liquid glass is mentioned as prose, liquid-glass-preview-20261111 as an id</p>' },
  ]) },
  helpers: { ...base, theme: light, canvas: canvas('<button data-tooltip="Hint">i</button><i data-lucide="sparkles"></i><script>window.lucide&&lucide.createIcons()</script>') },
  compositionHost: { ...base, theme: dark, compositionHostId: "host-1", canvas: canvas('<paseo-board board-id="child"></paseo-board><p data-style="glassy">near miss</p>') },
};

describe("marker-free Board documents", () => {
  it("are byte-identical to the frozen pre-preset template", () => {
    for (const [name, input] of Object.entries(MARKER_FREE_FIXTURES)) {
      expect(buildBoardDocument(input), name).toBe(frozenBuildBoardDocument(input));
    }
  });
  it("stay identical when the marker is present but the preset is off (own kit or opt-out)", () => {
    const own = { ...base, theme: light, canvas: canvas('<main data-style="liquid-glass" data-lg-page></main><style id="lg-kit-style"></style><script id="lg-kit-script"></script>') };
    const optOut = { ...base, theme: dark, canvas: canvas('<main data-style="liquid-glass" data-lg-builtin="off"></main>') };
    for (const input of [own, optOut]) expect(buildBoardDocument(input)).toBe(frozenBuildBoardDocument(input));
  });
  it("match pinned digests recorded at 4f88cd7 before the preset existed", () => {
    const digests = Object.fromEntries(Object.entries(MARKER_FREE_FIXTURES).map(([name, input]) => [name, createHash("sha256").update(buildBoardDocument(input)).digest("hex")]));
    // These pins also depend on how vitest transpiles createComponentLayoutTools.toString().
    // If that code changes on purpose, refresh them deliberately in the same commit.
    expect(digests).toEqual(PINNED_DIGESTS);
  });
});

const PINNED_DIGESTS: Record<string, string> = {
  plainLight: "5a4176fb88073ded24a233a0ac4b2990fde9d68b2255dbda6c541353377ababe",
  fullDocumentDarkWithPatches: "28bd56e34421c3107b9f0c6980c21944703932264bf34cb2a82cb51e1a33f9c7",
  helpers: "5cc0c9b5941f4e90ce8fb70edb6a3ae26f5d253602689f0abc04909a09710d5d",
  compositionHost: "e63ff792f07d4a24f18c7548ef28ce5c5e061e9c770d0a826f3e0e523466db76",
};
