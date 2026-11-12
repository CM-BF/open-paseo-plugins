import stylesheet from "./assets/visualize.css.txt";
import icons from "./assets/runtime-icons.txt";
import tooltips from "./assets/runtime-tooltips.txt";
import runtime from "./assets/board-runtime.txt";
import compositionRuntime from "./assets/composition-runtime.txt";
import layoutState from "./assets/component-layout-state.txt";
import { createComponentLayoutTools } from "./component-layout";
import frameDelta from "./assets/frame-delta.txt";
import htmlToImage from "./assets/html-to-image.txt";
import type { FrameSnapshot } from "./frame-contract";
import { FRAME_CHANNEL } from "./frame-contract";
import { isSafeTokenValue } from "./frame-theme";
import { canvasSources, liquidGlassHead, liquidGlassUsage } from "./liquid-glass";

// Same external library policy as paseo-visualize. No host cookies/storage, arbitrary network,
// navigation or SDK access is granted to the agent-authored document. Composition
// parents may create opaque local blob frames; only managed slots receive a source capability.
const CDNS = "https://unpkg.com https://cdn.jsdelivr.net https://esm.sh https://cdnjs.cloudflare.com";
export const BOARD_CSP = ["default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDNS}`, `style-src 'unsafe-inline' ${CDNS}`, `font-src data: ${CDNS}`, `img-src data: blob: ${CDNS}`, "media-src data: blob:", `connect-src ${CDNS}`, "worker-src blob:", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'"].join("; ");

export function buildBoardDocument(input: FrameSnapshot & { boardId: string; sessionId: string; title: string; compositionHostId?: string; compositionSecret?: string }): string {
  const tokens = Object.entries(input.theme.tokens).filter(([k, v]) => /^host-[a-z0-9-]+$/.test(k) && isSafeTokenValue(v)).map(([k, v]) => `--${k}:${v}`).join(";");
  const { html, ...canvas } = input.canvas;
  const initial = { channel: FRAME_CHANNEL, boardId: input.boardId, sessionId: input.sessionId, canvas, boardRevision: input.boardRevision, userState: input.userState, theme: input.theme, captureModule: htmlToImage, compositionHostId: input.compositionHostId, compositionSecret: input.compositionSecret };
  const bootstrap = `<script>(${runtime})(${scriptJson(initial)}, (${frameDelta}), (${createComponentLayoutTools.toString()}), (${layoutState}), (${compositionRuntime}));</script>`;
  // Only the host can navigate an opaque author's child to its host-owned blob.
  // Child documents retain the ordinary no-frames policy (one composition level).
  const csp = input.compositionHostId && !input.compositionSecret ? BOARD_CSP.replace("frame-src 'none'", "frame-src blob:") : BOARD_CSP;
  // Optional liquid-glass preset: inlined only when base HTML or a patch carries its marker.
  const preset = liquidGlassUsage(canvasSources(input.canvas)).preset ? liquidGlassHead() : "";
  return `<!doctype html><html lang="en" data-surface="page" data-palette="custom" data-theme="${input.theme.scheme}" style="${escapeHtml(tokens)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>@layer paseo-board-defaults {${stylesheet}\n}</style>${preset}</head><body>${bootstrap}${html.replace(/^\uFEFF/, "")}\n${/data-tooltip|dataset\.tooltip|floatingui/i.test(html) ? tooltips : ""}${/lucide/i.test(html) ? icons : ""}</body></html>`;
}

function scriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
