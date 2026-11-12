import css from "./assets/liquid-glass.css.txt";
import js from "./assets/liquid-glass.js.txt";

/**
 * Optional built-in "liquid glass" style preset. Board inlines it only when authored source
 * (base HTML or any patch's HTML) contains the marker data-style="liquid-glass"; every other
 * document is byte-identical to a Board without the preset.
 */
export const LIQUID_GLASS_VERSION = "1.0.0";
export const LIQUID_GLASS_STYLE_ID = "paseo-board-liquid-glass-style";
export const LIQUID_GLASS_SCRIPT_ID = "paseo-board-liquid-glass-script";

/** Flags found in one source string. Usage over several sources is their OR. */
export interface LiquidGlassScan { marker: boolean; authoredKit: boolean; optOut: boolean; palette: boolean }
export interface LiquidGlassUsage extends LiquidGlassScan { preset: boolean }

// The marker only in contexts that create or select a scope: the attribute, a CSS attribute
// selector, a dataset assignment or setAttribute. Prose such as "liquid glass" or ids such as
// liquid-glass-preview-1 never match.
const MARKER = [
  /\bdata-style\s*=\s*(?:"liquid-glass"|'liquid-glass'|liquid-glass(?![\w-]))/,
  /\[\s*data-style\s*[~|^$*]?=\s*["']?liquid-glass["']?\s*(?:[is]\s*)?\]/,
  /\bdataset\.style\s*=\s*["'`]liquid-glass["'`]/,
  /\bsetAttribute\(\s*["'`]data-style["'`]\s*,\s*["'`]liquid-glass["'`]\s*\)/,
];
// A Board that inlines its own copy of the prototype kit (0.1/0.2): the built-in steps aside.
// Only the prototype's element ids or its exact global assignment count; a defensive
// `window.LiquidGlass = window.LiquidGlass || …` shim does not disable the preset.
const AUTHORED_KIT = /\bid\s*=\s*["']?lg-kit-(?:script|style)\b|\bwindow\.LiquidGlass\s*=\s*\{\s*scan\s*:/;
const OPT_OUT = /\bdata-lg-builtin\s*=\s*["']?off\b/;
const PALETTE = /\bdata-lg\s*=\s*(?:"[^"]*\bpalette\b[^"]*"|'[^']*\bpalette\b[^']*'|palette\b)/;

export function scanLiquidGlass(source: string): LiquidGlassScan {
  return { marker: MARKER.some(pattern => pattern.test(source)), authoredKit: AUTHORED_KIT.test(source), optOut: OPT_OUT.test(source), palette: PALETTE.test(source) };
}

export function combineLiquidGlass(scans: Iterable<LiquidGlassScan>): LiquidGlassUsage {
  const usage = { marker: false, authoredKit: false, optOut: false, palette: false };
  for (const scan of scans) {
    usage.marker ||= scan.marker; usage.authoredKit ||= scan.authoredKit;
    usage.optOut ||= scan.optOut; usage.palette ||= scan.palette;
  }
  return { ...usage, preset: usage.marker && !usage.authoredKit && !usage.optOut };
}

/** Authored sources of a canvas: base HTML and every patch's HTML (text/layout patches carry none). */
export function canvasSources(canvas: { html: string; patches: readonly { html?: string }[] }): string[] {
  return [canvas.html, ...canvas.patches.map(patch => patch.html ?? "").filter(Boolean)];
}

export function liquidGlassUsage(sources: Iterable<string>): LiquidGlassUsage {
  return combineLiquidGlass(Array.from(sources, scanLiquidGlass));
}

/** The inline preset for a document head. No network, no layer: see the CSS header. */
export function liquidGlassHead(): string {
  return `<style id="${LIQUID_GLASS_STYLE_ID}" data-version="${LIQUID_GLASS_VERSION}">${css}</style><script id="${LIQUID_GLASS_SCRIPT_ID}" data-version="${LIQUID_GLASS_VERSION}">${js}</script>`;
}

export const liquidGlassAssets = { css, js } as const;

type TrackedCanvas = { html: string; documentVersion: number; patches: readonly { html?: string }[] };
/**
 * Incremental usage for a live canvas. Patches are append-only within a document version, so a
 * render scans only the patches it has not seen; a new base HTML or document version rescans.
 * The usage is always the OR over every source (never sticky beyond that).
 */
export function createLiquidGlassTracker() {
  let html: string | undefined, version = -1, patches: readonly { html?: string }[] | undefined, seen = 0;
  let acc: LiquidGlassScan = { marker: false, authoredKit: false, optOut: false, palette: false };
  return {
    update(canvas: TrackedCanvas): LiquidGlassUsage {
      // A shorter list or a different last-seen patch means the journal was rebuilt: rescan.
      const last = seen > 0 ? canvas.patches[seen - 1] : undefined, before = seen > 0 ? patches?.[seen - 1] : undefined;
      const restart = canvas.html !== html || canvas.documentVersion !== version || canvas.patches.length < seen || (last !== before && last?.html !== before?.html);
      if (restart) { html = canvas.html; version = canvas.documentVersion; seen = 0; acc = scanLiquidGlass(canvas.html); }
      for (; seen < canvas.patches.length; seen++) {
        const source = canvas.patches[seen].html;
        if (source) acc = combineLiquidGlass([acc, scanLiquidGlass(source)]);
      }
      patches = canvas.patches;
      return combineLiquidGlass([acc]);
    },
  };
}
