import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildBoardDocument } from "./document";
import type { FrameSnapshot } from "./frame-contract";
import { DEFAULT_DARK_COLORS, DEFAULT_LIGHT_COLORS, frameThemeFromColors } from "./frame-theme";
import { boardInstructions, skillMarkdown } from "../server/prompts";
import { LIQUID_GLASS_SCRIPT_ID, LIQUID_GLASS_STYLE_ID, LIQUID_GLASS_VERSION, canvasSources, createLiquidGlassTracker, liquidGlassAssets, liquidGlassHead, liquidGlassUsage, scanLiquidGlass } from "./liquid-glass";

type Patch = { id: string; selector: string; operation: "append" | "replace" | "text"; html?: string; text?: string; expectedText?: string };
const doc = (html: string, patches: Patch[] = [], scheme: "light" | "dark" = "light") => buildBoardDocument({
  boardId: "glass", sessionId: "s".repeat(32), title: "Glass", boardRevision: 1, userState: {},
  theme: frameThemeFromColors(scheme === "dark" ? DEFAULT_DARK_COLORS : DEFAULT_LIGHT_COLORS),
  canvas: { html, data: {}, patches: patches.map(patch => ({ html: "", ...patch })), revision: 1, documentVersion: 1 } as FrameSnapshot["canvas"],
});
const count = (text: string, needle: string) => text.split(needle).length - 1;
const head = (text: string) => text.slice(0, text.indexOf("</head>"));

describe("liquid-glass preset activation", () => {
  const activating: Array<[string, string, Patch[]]> = [
    ["base attribute", '<main data-style="liquid-glass" data-lg-page><h1>Hi</h1></main>', []],
    ["single-quoted and unquoted attributes", "<section data-style='liquid-glass'></section><div data-style=liquid-glass></div>", []],
    ["only a later patch", "<main id=\"root\"></main>", [{ id: "p1", selector: "#root", operation: "append", html: '<section data-style="liquid-glass">Island</section>' }]],
    ["script dataset assignment", "<div id=\"x\"></div><script>document.getElementById('x').dataset.style = 'liquid-glass'</script>", []],
    ["script setAttribute", "<script>el.setAttribute(\"data-style\", \"liquid-glass\")</script>", []],
    ["author CSS selector", '<style>[data-style="liquid-glass"] .x{color:red}</style>', []],
    ["markup inside a double-quoted JS string", '<div id="app"></div><script>app.innerHTML = "<main data-style=\\"liquid-glass\\" data-lg-page>…</main>";</script>', []],
    ["markup inside a single-quoted JS string", "<script>app.innerHTML = '<section data-style=\\'liquid-glass\\'>x</section>';</script>", []],
    ["a CSS selector inside a JS string", '<script>document.querySelector("[data-style=\\"liquid-glass\\"]")</script>', []],
    ["a bracketed dataset assignment", "<script>el.dataset['style'] = 'liquid-glass'</script>", []],
    ["an upper-case attribute name", '<MAIN DATA-STYLE="liquid-glass" data-lg-page></MAIN>', []],
  ];
  for (const [name, html, patches] of activating) {
    it(`inlines exactly one versioned preset for ${name}`, () => {
      const text = doc(html, patches);
      expect(count(text, `<style id="${LIQUID_GLASS_STYLE_ID}" data-version="${LIQUID_GLASS_VERSION}">`)).toBe(1);
      expect(count(text, `<script id="${LIQUID_GLASS_SCRIPT_ID}" data-version="${LIQUID_GLASS_VERSION}">`)).toBe(1);
      // After the low-priority defaults, before any authored or runtime script.
      expect(head(text).indexOf("@layer paseo-board-defaults")).toBeLessThan(head(text).indexOf(LIQUID_GLASS_STYLE_ID));
      expect(head(text)).toContain(liquidGlassHead());
      expect(text.indexOf(LIQUID_GLASS_SCRIPT_ID)).toBeLessThan(text.indexOf("<body>"));
    });
  }

  const inert: Array<[string, string, Patch[]]> = [
    ["prose with a space", "<p>A liquid glass look</p>", []],
    ["quoted prose", "<p>We could try a \"liquid-glass\" preset later.</p>", []],
    ["ids and classes", '<div id="liquid-glass-preview-20261111" class="liquid-glass"></div>', []],
    ["a longer value", '<div data-style="liquid-glassy"></div><div data-style="liquid-glass-2"></div>', []],
    ["an upper-case value (CSS values are case-sensitive)", '<div data-style="LIQUID-GLASS"></div>', []],
    ["text patches", "<p id=\"t\">x</p>", [{ id: "p1", selector: "#t", operation: "text", text: 'data-style="liquid-glass"', expectedText: "x" }]],
  ];
  for (const [name, html, patches] of inert) {
    it(`does not activate for ${name}`, () => {
      const text = doc(html, patches);
      expect(text).not.toContain(LIQUID_GLASS_STYLE_ID);
      expect(text).not.toContain("LiquidGlass");
    });
  }

  it("yields to a Board that inlines its own prototype kit, and honours the opt-out", () => {
    const marker = '<main data-style="liquid-glass" data-lg-page></main>';
    for (const own of ['<style id="lg-kit-style">x</style>', "<script id='lg-kit-script'>x</script>", '<SCRIPT ID="lg-kit-script">x</SCRIPT>', "<script>window.LiquidGlass = { scan: () => scan(), version: '0.2.0' }</script>"]) {
      expect(doc(marker + own)).not.toContain(LIQUID_GLASS_STYLE_ID);
      expect(doc(marker, [{ id: "p", selector: "main", operation: "append", html: own }])).not.toContain(LIQUID_GLASS_STYLE_ID);
    }
    expect(doc('<main data-style="liquid-glass" data-lg-builtin="off"></main>')).not.toContain(LIQUID_GLASS_STYLE_ID);
    // A defensive shim written after reading the API must not disable the preset, nor does
    // prose that shows the old markup, or the id on an element that is not a script/style.
    expect(doc(marker + "<script>window.LiquidGlass = window.LiquidGlass || { scan(){} }</script>")).toContain(LIQUID_GLASS_STYLE_ID);
    expect(doc(marker + '<p>旧写法：<code>&lt;script id="lg-kit-script"&gt;</code></p>')).toContain(LIQUID_GLASS_STYLE_ID);
    expect(doc(marker + '<pre id="lg-kit-script">kit</pre>')).toContain(LIQUID_GLASS_STYLE_ID);
  });

  it("scans only authored HTML sources and reports a declarative palette", () => {
    expect(canvasSources({ html: "base", patches: [{ html: "a" }, { html: "" }, {}] })).toEqual(["base", "a"]);
    expect(scanLiquidGlass('<div data-lg="palette"></div>').palette).toBe(true);
    expect(scanLiquidGlass("<div data-lg='dock nav palette'></div>").palette).toBe(true);
    expect(scanLiquidGlass('<div data-lg="nav"></div><p>palette</p>').palette).toBe(false);
    expect(scanLiquidGlass('<div data-lg-palette-open></div><i data-lg="dock"></i>').palette).toBe(false);
    // Palettes created by script count too (host "/" forwarding is armed for them).
    for (const source of ["<script>el.dataset.lg = 'palette'</script>", '<script>el.dataset["lg"]="dock palette"</script>', "<script>el.setAttribute('data-lg', 'palette')</script>", '<script>x.innerHTML = "<div data-lg=\\"palette\\"></div>"</script>', '<DIV DATA-LG="palette"></DIV>']) {
      expect(scanLiquidGlass(source).palette, source).toBe(true);
    }
    expect(liquidGlassUsage(['<p data-style="liquid-glass">', '<script id="lg-kit-script">'])).toMatchObject({ marker: true, authoredKit: true, preset: false });
  });
});

describe("liquid-glass preset assets", () => {
  const { css, js } = liquidGlassAssets;
  it("expose one version everywhere", () => {
    expect(LIQUID_GLASS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(js).toContain(`const VERSION = '${LIQUID_GLASS_VERSION}';`);
    expect(css.split("\n", 1)[0]).toContain(`liquid-glass preset ${LIQUID_GLASS_VERSION}`);
    expect(js.split("\n", 1)[0]).toContain(`liquid-glass preset ${LIQUID_GLASS_VERSION}`);
  });
  it("are safe to inline and work offline", () => {
    for (const asset of [css, js]) {
      expect(asset).not.toMatch(/<\/script|<\/style|<!--|@import/i);
      expect([...asset.matchAll(/https?:\/\/[^\s"')]+/g)].map(match => match[0]).filter(url => url !== "http://www.w3.org/2000/svg")).toEqual([]);
    }
    // Not layered: scoped selectors must out-rank element resets such as button{…}.
    expect(css).not.toContain("@layer");
    // Data-derived chart and palette text never goes through innerHTML.
    // Only constant kit markup (string literals or ICONS) is ever assigned to innerHTML.
    expect([...js.matchAll(/innerHTML\s*=\s*(\S+)/g)].map(match => match[1]).filter(value => !/^(?:['`]|ICONS\.)/.test(value))).toEqual([]);
  });
  it("stay within the size budget", () => {
    const bytes = (text: string) => Buffer.byteLength(text);
    expect(bytes(css)).toBeLessThanOrEqual(60 * 1024);
    expect(bytes(js)).toBeLessThanOrEqual(88 * 1024);
    expect(gzipSync(css + js).length).toBeLessThanOrEqual(38 * 1024);
  });
  it("keep secondary text and accents readable on glass over the darkest field", () => {
    const hex = (name: string) => {
      const match = css.match(new RegExp(`${name}:\\s*#([0-9a-fA-F]{6})`));
      if (!match) throw new Error(`missing ${name}`);
      return [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16));
    };
    const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v * (1 - t) + b[i] * t);
    const luminance = (rgb: number[]) => {
      const [r, g, b] = rgb.map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    // Darkest field: the grey-rose mix; glass is ≈ 63% white over it (0.56 + 0.12 + 0.05 layers).
    const field = mix(hex("--lg-rose"), [185, 167, 171], 0.18);
    const glass = mix(field, [255, 255, 255], 1 - 0.44 * 0.88 * 0.95);
    expect(contrast(hex("--lg-ink-muted"), glass)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex("--lg-accent-text"), glass)).toBeGreaterThanOrEqual(4.5);
    expect(contrast([255, 255, 255], hex("--lg-accent-deep"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hex("--lg-ink"), glass)).toBeGreaterThanOrEqual(7);
  });
});

describe("live liquid-glass tracker", () => {
  const canvas = (html: string, documentVersion: number, patches: Array<{ html?: string }>) => ({ html, documentVersion, patches });
  it("ORs base and patch flags and derives the preset without stickiness", () => {
    const tracker = createLiquidGlassTracker();
    const patches: Array<{ html?: string }> = [];
    expect(tracker.update(canvas("<main></main>", 1, patches)).preset).toBe(false);
    patches.push({ html: '<section data-style="liquid-glass"></section>' });
    expect(tracker.update(canvas("<main></main>", 1, [...patches]))).toMatchObject({ marker: true, preset: true, palette: false });
    patches.push({ html: '<div data-lg="palette"></div>' });
    expect(tracker.update(canvas("<main></main>", 1, [...patches]))).toMatchObject({ preset: true, palette: true });
    // An authored old kit added later turns the derived preset off (it is not sticky).
    patches.push({ html: '<script id="lg-kit-script"></script>' });
    expect(tracker.update(canvas("<main></main>", 1, [...patches]))).toMatchObject({ marker: true, authoredKit: true, preset: false });
    // A new document version rescans from its own base.
    expect(tracker.update(canvas("<main></main>", 2, []))).toMatchObject({ marker: false, authoredKit: false, preset: false });
    expect(tracker.update(canvas('<main data-style="liquid-glass"></main>', 3, [])).preset).toBe(true);
  });
  it("scans only patches it has not seen within a document version", () => {
    const tracker = createLiquidGlassTracker();
    let reads = 0;
    const patch = (html: string) => ({ get html() { reads++; return html; } });
    const list = [patch("<p>a</p>"), patch("<p>b</p>")];
    tracker.update(canvas("<main></main>", 1, list));
    const afterFirst = reads;
    tracker.update(canvas("<main></main>", 1, list));
    tracker.update(canvas("<main></main>", 1, [...list, patch('<i data-style="liquid-glass"></i>')]));
    // The second render reads nothing new; the third reads only the new patch (plus the
    // last-seen comparison, which reuses the same object without reading its html).
    expect(reads - afterFirst).toBe(1);
  });
});

describe("canonical liquid-glass example", () => {
  const example = readFileSync(new URL("../examples/liquid-glass.html", import.meta.url), "utf8");
  it("needs no page script and almost no page CSS", () => {
    expect(example).not.toMatch(/<script(?![^>]*type=["']application\/json)/i);
    const styles = [...example.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].reduce((sum, match) => sum + Buffer.byteLength(match[1]), 0);
    expect(styles).toBeLessThanOrEqual(1024);
    for (const role of ["nav", "card", "expand", "split", "palette", "dock", "chart"]) expect(example).toMatch(new RegExp(`data-lg="[^"]*\\b${role}\\b`));
    expect(liquidGlassUsage([example])).toMatchObject({ preset: true, palette: true });
  });
  it("renders with the preset under a dark host theme too", () => {
    const text = doc(example, [], "dark");
    expect(text).toContain('data-theme="dark"');
    expect(count(text, `<style id="${LIQUID_GLASS_STYLE_ID}"`)).toBe(1);
  });
});

describe("liquid-glass agent documentation", () => {
  const skill = skillMarkdown("/plugin/bin/paseo-board");
  const section = skill.slice(skill.indexOf("### Optional liquid-glass style preset"), skill.indexOf("### Maintain a long-lived composition"));
  it("adds one short sentence to the always-injected instructions", () => {
    const sentences = boardInstructions("/plugin/bin/paseo-board", "/plugin/SKILL.md").split(/(?<=\.)\s+/).filter(text => /liquid.glass/i.test(text));
    expect(sentences).toEqual(['For a "liquid glass" (液态玻璃) look, use the built-in preset (data-style="liquid-glass"); see the skill.']);
    expect(sentences[0].length).toBeLessThanOrEqual(160);
  });
  it("documents the versioned contract with a complete page that activates every role", () => {
    expect(section).toContain(`(v${LIQUID_GLASS_VERSION})`);
    const page = section.match(/```html\n([\s\S]*?)```/)?.[1] ?? "";
    expect(liquidGlassUsage([page])).toMatchObject({ preset: true, palette: true });
    for (const role of ["nav", "card", "expand", "split", "palette", "dock", "chart"]) expect(page).toMatch(new RegExp(`data-lg="[^"]*\\b${role}\\b`));
    expect(page).not.toMatch(/<script|<style/);
    for (const topic of ["Scope:", "Roles", "Values:", "Helpers:", "Colour scheme:", "Accessibility:", "Limits:", "reduced motion"]) expect(section).toContain(topic);
    // Every documented built-in icon exists in the stylesheet.
    const icons = section.match(/data-lg-icon="(home\|[^"]+)"/)?.[1].split("|") ?? [];
    expect(icons.length).toBeGreaterThan(10);
    for (const icon of icons) expect(liquidGlassAssets.css).toContain(`[data-lg-icon="${icon}"]`);
  });
});
