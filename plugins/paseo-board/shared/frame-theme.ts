import type { PluginTheme } from "@getpaseo/plugin";
import type { FrameTheme } from "./frame-contract";

type Colors = PluginTheme["colors"];

/**
 * Paseo's default light theme exactly as `toPluginTheme` hands it to plugins
 * (packages/app/src/styles/theme.ts and plugins/theme.ts at v0.11.1).
 */
export const DEFAULT_LIGHT_COLORS: Colors = {
  surface0: "#ffffff",
  surface1: "#fafafa",
  surface2: "#f4f4f5",
  border: "#e4e4e7",
  foreground: "#1a1a1e",
  foregroundMuted: "#71717a",
  accent: "#20744A",
  accentForeground: "#ffffff",
  statusSuccess: "#3e704a",
  statusWarning: "#7b5d39",
  statusDanger: "#9d433b",
};

/** Paseo's default dark theme ("Paseo", the teal-green tint) as plugins receive it, same sources. */
export const DEFAULT_DARK_COLORS: Colors = {
  surface0: "#181B1A",
  surface1: "#1E2120",
  surface2: "#272A29",
  border: "#252B2A",
  foreground: "#fafafa",
  foregroundMuted: "#A1A5A4",
  accent: "#20744A",
  accentForeground: "#ffffff",
  statusSuccess: "#6cb17b",
  statusWarning: "#c09664",
  statusDanger: "#d8847b",
};

/**
 * Characters a color or a derived color expression needs. Anything else (`;`, braces, quotes,
 * backslashes) could break out of a declaration in the frame's `style` attribute.
 */
const SAFE_TOKEN_VALUE = /^[#a-zA-Z0-9(),.%+*/ -]{1,200}$/;

export function isSafeTokenValue(value: string): boolean {
  return SAFE_TOKEN_VALUE.test(value);
}

/**
 * The frame's palette. PluginTheme carries no light/dark flag, so the scheme comes from luminance:
 * a sheet darker than its ink is a dark theme. the upstream `--rx-*` tokens become `--host-*`; the three
 * it derives are written with the literal colors so the frame needs nothing but the values.
 */
export function frameThemeFromColors(colors: Colors): FrameTheme {
  const scheme = schemeOf(colors);
  const fallback = scheme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS;
  const pick = (key: keyof Colors): string => {
    const value = typeof colors[key] === "string" ? colors[key].trim() : "";
    return isSafeTokenValue(value) ? value : fallback[key];
  };
  const sheet = pick("surface0");
  const ink = pick("foreground");
  const accent = pick("accent");
  const dark = scheme === "dark";
  return {
    scheme,
    tokens: {
      "host-sheet": sheet,
      "host-ink": ink,
      "host-ink-3": pick("foregroundMuted"),
      "host-canvas": dark ? sheet : pick("surface1"),
      "host-raised": dark ? pick("surface1") : sheet,
      "host-on-ink": pick("accentForeground"),
      "host-line": pick("border"),
      "host-line-strong": `color-mix(in oklab, ${ink} 20%, ${sheet})`,
      "host-iris": accent,
      // Raw accent is too dim for link text on a dark sheet (#20744A on #181B1A is 3:1).
      "host-iris-ink": dark
        ? `oklch(from ${accent} calc(l + 0.11) calc(c * 0.66) h)`
        : `color-mix(in oklab, ${accent} 80%, ${ink})`,
      "host-iris-soft": `color-mix(in oklab, ${accent} ${dark ? 18 : 12}%, ${sheet})`,
      "host-ok-ink": pick("statusSuccess"),
      "host-warn-ink": pick("statusWarning"),
      "host-bad-ink": pick("statusDanger"),
    },
  };
}

function schemeOf(colors: Colors): FrameTheme["scheme"] {
  const sheet = relativeLuminance(colors.surface0);
  const ink = relativeLuminance(colors.foreground);
  return sheet !== null && ink !== null && sheet < ink ? "dark" : "light";
}

/** WCAG relative luminance of a hex color; null for anything else. Every Paseo theme color is hex. */
function relativeLuminance(color: unknown): number | null {
  if (typeof color !== "string") return null;
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length <= 4) {
    let expanded = "";
    for (const digit of digits) expanded += digit + digit;
    digits = expanded;
  }
  const channel = (offset: number): number => {
    const value = parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
