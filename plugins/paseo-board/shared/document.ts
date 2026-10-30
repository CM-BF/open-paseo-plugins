import stylesheet from "./assets/visualize.css.txt";
import icons from "./assets/runtime-icons.txt";
import tooltips from "./assets/runtime-tooltips.txt";
import runtime from "./assets/board-runtime.txt";
import htmlToImage from "./assets/html-to-image.txt";
import type { FrameSnapshot } from "./frame-contract";
import { FRAME_CHANNEL } from "./frame-contract";
import { isSafeTokenValue } from "./frame-theme";

// Same external library policy as paseo-visualize. No host cookies/storage, arbitrary network,
// navigation, embedded frames or SDK access is granted to the agent-authored document.
const CDNS = "https://unpkg.com https://cdn.jsdelivr.net https://esm.sh https://cdnjs.cloudflare.com";
export const BOARD_CSP = ["default-src 'none'", `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDNS}`, `style-src 'unsafe-inline' ${CDNS}`, `font-src data: ${CDNS}`, `img-src data: blob: ${CDNS}`, "media-src data: blob:", `connect-src ${CDNS}`, "worker-src blob:", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'"].join("; ");

export function buildBoardDocument(input: FrameSnapshot & { boardId: string; sessionId: string; title: string }): string {
  const tokens = Object.entries(input.theme.tokens).filter(([k, v]) => /^host-[a-z0-9-]+$/.test(k) && isSafeTokenValue(v)).map(([k, v]) => `--${k}:${v}`).join(";");
  const { html, ...canvas } = input.canvas;
  const initial = { channel: FRAME_CHANNEL, boardId: input.boardId, sessionId: input.sessionId, canvas, boardRevision: input.boardRevision, userState: input.userState, theme: input.theme, captureModule: htmlToImage };
  const bootstrap = `<script>(${runtime})(${scriptJson(initial)});</script>`;
  return `<!doctype html><html lang="en" data-surface="page" data-palette="custom" data-theme="${input.theme.scheme}" style="${escapeHtml(tokens)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${BOARD_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>@layer paseo-board-defaults {${stylesheet}\n}</style></head><body>${bootstrap}${html.replace(/^\uFEFF/, "")}\n${/data-tooltip|dataset\.tooltip|floatingui/i.test(html) ? tooltips : ""}${/lucide/i.test(html) ? icons : ""}</body></html>`;
}

function scriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
