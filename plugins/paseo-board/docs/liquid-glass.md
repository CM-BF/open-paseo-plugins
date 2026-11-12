# Liquid-glass style preset (v1.0.0)

An optional, built-in visual preset for Board canvases: a warm peach/rose/apricot field with white light arcs, white frosted cards (thin white border, inner top highlight, 24px radius), a copper accent (`#B66D44`), a `#E7A471 → #C5A0AB` chart gradient, 48px+ titles and monospace numbers, plus seven declarative interactions. Agents opt in with markup; nothing else changes for other Boards.

- Assets: `shared/assets/liquid-glass.css.txt`, `shared/assets/liquid-glass.js.txt` (readable source, no build step).
- Activation and head markup: `shared/liquid-glass.ts` (`LIQUID_GLASS_VERSION`, `liquidGlassUsage`, `liquidGlassHead`, `createLiquidGlassTracker`).
- Canonical page: [`examples/liquid-glass.html`](../examples/liquid-glass.html) (no page script, no page CSS). The installed skill carries a complete minimal page.

## Activation and coverage

The preset is inlined in the document `<head>`, after the low-priority defaults stylesheet, as `<style id="paseo-board-liquid-glass-style" data-version="1.0.0">` and `<script id="paseo-board-liquid-glass-script" data-version="1.0.0">`, only when authored source contains the marker in one of these contexts:

- the attribute `data-style="liquid-glass"` (quoted or unquoted, any attribute-name case, also with escaped quotes inside a JS string: `"<main data-style=\"liquid-glass\">"`);
- a CSS attribute selector such as `[data-style="liquid-glass"]` (also inside a JS string);
- `el.dataset.style = "liquid-glass"`, `el.dataset['style'] = "liquid-glass"` or `el.setAttribute("data-style", "liquid-glass")` in a script.

Prose ("liquid glass", a quoted "liquid-glass"), ids such as `liquid-glass-preview-1`, classes, other value cases (`LIQUID-GLASS`, which the case-sensitive CSS selector would not match anyway) and longer values (`liquid-glassy`) never activate it. The preset is **not** inlined when the source also contains `data-lg-builtin="off"` or the prototype kit's own copy: a real `<script id="lg-kit-script">`/`<style id="lg-kit-style">` tag (any tag-name case, also inside a JS string) or its `window.LiquidGlass = { scan:` assignment. Prose that shows that markup (`&lt;script id="lg-kit-script"&gt;`), the id on another element and a defensive `window.LiquidGlass = window.LiquidGlass || …` shim do not disable it; the kit's runtime hand-over uses the same script/style rule.

The palette flag (which arms host `/` forwarding) follows the same contexts: `data-lg="… palette …"` in markup or a JS string, `el.dataset.lg = "palette"` (or `dataset['lg']`) and `setAttribute("data-lg", "…palette…")`.

| Situation | Covered | How |
| --- | --- | --- |
| Marker in the base document | Yes | Build-time detection in `buildBoardDocument` |
| Marker first added by a patch; Board reopened, reloaded or opened elsewhere | Yes | Every patch's `html` is scanned |
| Marker first added by a live patch while the Board is open | Yes | `CanvasFrame` tracks usage incrementally and rebuilds the frame **once** per (board, document version) when the canvas is idle (no selection mode, no interaction lock, not typing or dragging), restoring the latest reading position and without replaying update highlights. Unsaved transient DOM state of that canvas resets once. |
| Scope created at runtime by authored script that contains the literal marker (plain or escaped quotes, `dataset.style`, `dataset['style']`, `setAttribute`) | Yes | Build-time detection plus the kit's MutationObserver |
| Marker assembled at runtime (`['liquid','glass'].join('-')`) or loaded from a CDN | No | Write the literal marker in source |
| Exported/published releases, GitHub Pages, `board-release` CLI, offline exports | Yes | `buildRelease` scans the materialized source; the preset is inline and not counted as a dependency |
| Response canvases and composition children | Yes (rendering) | Both use `buildBoardDocument`; host `/` forwarding is not armed for them |
| Native mobile | n/a | No canvas renders there |

Documents and releases without an activating marker are byte-identical to Board without the preset (`shared/document-identity.test.ts` compares against a frozen copy of the previous template and pinned digests; the pinned release test is unchanged). The one later change to every Board's frame runtime is that it no longer reports the browser's benign "ResizeObserver loop …" notices; the test undoes exactly that change and gets back the 4f88cd7 digests.

## Markup contract

### Scope

- `<main data-style="liquid-glass" data-lg-page>` (or the same attributes on `<body>` in a full authored document; never on `<html>`): **page mode**. Paints the field and arcs, takes over the Board body (no 960px limit, no padding), centres content up to `--lg-max` (1120px) and stacks direct children with a `--lg-gap` (20px) flow gap. Reserves bottom space when it contains a dock.
- `<section data-style="liquid-glass">` without `data-lg-page`: **island mode**, a self-contained glass panel with its own field background inside an ordinary (host-adaptive) Board.
- Only the **outermost** marker is a scope. A nested marker (for example on a section patched into a glass page) is inert: no second field, and its keyed values follow the page's controls.
- `data-lg-scope` on any ancestor narrows which values a split/nav updates (default: the outermost scope).
- Every scope sets `color-scheme: light`, its own text colour and re-points Board's injected tokens (`--background`, `--foreground`, `--card`, `--primary`, `--muted-foreground`, `--border`, `--destructive/--success/--warning`, `--viz-neutral-*`, `--viz-recede*`, `--shadow-*` …) so `.btn`, `.form-control` and `.viz-plot` stay readable under a dark host.

### Roles (`data-lg`, space separated)

| Role | Markup | Behaviour |
| --- | --- | --- |
| `nav` | Direct children `a`, `button` or `[data-lg-item]`; current item via `aria-current`/`aria-selected="true"`/`.is-active`; optional `data-lg-value`, `data-lg-target="#id"`, `data-lg-spy` on the nav, `data-lg-name` | Liquid capsule (spring edges) under the current item; arrows/Home/End; emits `lg:change` |
| `card` | Any element | Frosted card with cursor light, edge glow and gentle tilt (desktop pointers; none for touch, `hover:none` and reduced motion) |
| `expand` | Children `[data-lg-module]` with `[data-lg-summary]` and `[data-lg-detail]`; optional `data-lg-title`, `[data-lg-icon]`, `data-lg-strip-label`, `--lg-expand-col`, `--lg-expand-min` | Module opens in place, the others fly into a thumbnail strip; the page scrolls so the module and strip are in view (above the dock when the module's top allows), and the dock gives way wherever it would still cover them; Esc or the close button restores focus to the module's trigger |
| `split` | Children `button[data-lg-option="key"]`, current `aria-pressed="true"`; author writes `role="group" aria-label`; optional `data-lg-label`, `data-lg-anchor="end"`, `data-lg-name` | One droplet splits into the options and merges back after a choice; updates `[data-lg-by]` values; emits `lg:change`. Only the closed droplet takes space in the flow: the open row floats (moved inwards to stay inside the scope and the viewport, tighter spacing at ≤ 560px), so opening never re-flows the page; the other children of `.lg-actions`/`.lg-card-head`/`.lg-section-head` fade while it is open |
| `palette` | One empty element; optional `data-lg-label`, `data-lg-placeholder`, `data-lg-keys` (default `/`) | Centred glass command palette with dim+blur, live filter and highlight, live result count; entries are elements with `data-lg-command` (+ `data-lg-group`, `data-lg-keywords`); `[data-lg-palette-open]` opens it. The open palette is a manual popover in the browser's top layer (where supported), so Board's comment markers and overlays never paint over it; it closes when focus leaves the canvas or the page is hidden |
| `dock` | Children `[data-lg-dock-item]` with `data-lg-label` and an icon (`svg` child or `data-lg-icon`), `data-lg-target`, `[data-lg-dock-sep]`, `data-lg-magnify`; usually `data-lg="dock nav"` | Floating glass dock, neighbour magnification and a name label (also briefly after a touch tap); compact and tucked at rest on narrow panes; at every width it gives way (slides down, no pointer events) wherever it would cover an open module or its strip, and comes back once they are out of its way (keyboard focus in the dock keeps it); sticky inside an island. With `data-lg-spy`, the very top of the page selects the first target and the very end the last |
| `chart` | `<figure data-lg="chart" aria-label="…">` (empty) | Bar (default) or `data-lg-type="line"` chart, see below |

### Values and named controls

- `data-lg-count="1234.5"`: rolling digits; the element's plain text stays the accessible, selectable value. Write the text exactly as it should read (`126`, `15,872`, `98.6%`): while it shows the count it is never rewritten (Board text edits compare the live text with the source), and a new value keeps its prefix, suffix and grouping (`98.6%` → `96%`, `126` → `1,486`, `1234` → `2048`). Text without a number is replaced by the en-US formatted count. Changing the attribute rolls to the new value.
- `data-lg-by="7d:126, 30d:512"`: a key → value map (no ASCII commas inside values). On a `data-lg-count` element it sets the count; on any other element it sets the text.
- A split or nav with `data-lg-name="range"` publishes its value (the chosen `data-lg-option`, or the active item's `data-lg-value`/text). `data-lg-key="{metric}/{range}"` resolves a key from the named values in the same scope. Elements added later by a patch resolve immediately.
- Without `data-lg-key`, `[data-lg-by]` follows whichever split changed (0.2 behaviour).
- `lg:change` bubbles from nav and split with `detail = { name, value, item }`.

### Chart

Data, one of:

- `data-lg-values="14,19,22"` with optional `data-lg-labels="一,二,三"`;
- `data-lg-series='{"pub/7d": {"labels": […], "values": […]}, …}'`: JSON keyed by one name, chosen by `data-lg-key` (resolved from named controls) or `data-lg-select` (default: the first key);
- `data-lg-path="/json/pointer"`: Board data through `board.watch` (live in the Board, frozen or live in releases). The value may be a series shape or an object of series.

Accepted series shapes: `number[]`, `{labels, values}`, `[{label, value}]`. Options: `data-lg-unit`, `data-lg-avg` (dashed average with a 「均值」 tag). At most 200 points, 64 series, 64 KB of JSON. Bars should be non-negative. Invalid or empty data shows 「暂无数据」. Labels are shortened to fit. All data-derived strings are set as text (never parsed as HTML). A visually hidden table (「项目 / 数值」, caption from `aria-label`) serves screen readers; the SVG is `aria-hidden`. Hand-written SVG charts can still use `.lg-chart`, `.lg-chart-grid`, `.lg-chart-label`, `.lg-chart-bar` (gradient `#lg-chart-fill`) and `.lg-chart-tag`.

### Helpers, icons and variables

- Layout: `.lg-header` + `.lg-actions`, `.lg-section` + `.lg-section-head` + `.lg-section-title`, `.lg-grid` (`data-lg-cols="2|3|4"` or `--lg-min`), `.lg-columns` (`--lg-ratio`), `.lg-card-head`.
- Content: `.lg-title`, `.lg-eyebrow`, `.lg-lede`, `.lg-muted`, `.lg-stat` (`-label`, `-value`, `-foot`, `-spark`), `.lg-module-head`, `.lg-icon`, `.lg-meta`, `.lg-big`, `.lg-list`, `.lg-dot[data-tone]`, `.lg-grow`, `.lg-table`, `.lg-scroll` (horizontal scrolling box for a wide table in a card; `[data-lg-detail]` already scrolls), `.lg-num`, `.lg-meter` (`--lg-value` 0–1; author supplies `role="meter"` and aria values), `.lg-avatar`, `.lg-pill`, `.lg-chip[data-tone=good|warn|bad]`, `.lg-glass`, `kbd`, `.lg-sr`.
- Icons: `data-lg-icon="home|chart|trend|list|grid|search|clock|users|chat|data|upload|settings|doc|bell|check|star|spark|code"` on an empty element (CSS masks: no network, no DOM change, captured in screenshots). An `svg` child takes precedence.
- Colour scheme: `--lg-peach #E4C0A6`, `--lg-rose #D488AC`, `--lg-apricot #EBD7CC`, `--lg-accent #B66D44`, `--lg-accent-text`, `--lg-accent-deep`, `--lg-accent-soft`, `--lg-chart-top #E7A471`, `--lg-chart-bottom #C5A0AB`, `--lg-ink #2B1D1A`, `--lg-ink-muted`, `--lg-ink-faint`, `--lg-good/--lg-warn/--lg-bad`. Glass: `--lg-glass`, `--lg-glass-strong`, `--lg-stroke`, `--lg-highlight`, `--lg-blur`, `--lg-radius`. Layout: `--lg-max`, `--lg-gap`, `--lg-chart-h`, `--lg-dock-size`, `--lg-title-size`.
- The CSS is **not** in a cascade layer: every selector is scope-prefixed, so element resets (`*{margin:0;padding:0}`, `button{background:none}`, `h1{font-size:…}`) do not strip the preset. Override deliberately with variables or `#page-id .class`.

### JavaScript API

`window.LiquidGlass = { version: "1.0.0", builtin: true, scan(el?), api(el, kind), destroy(el), teardown() }`. `scan(el)` mounts synchronously (queued before `DOMContentLoaded`); `api(el, "split")` exposes `choose`, `openUp`, `close`, `value`; `api(el, "palette")` exposes `open`, `close`; `api(el, "chart")` exposes `update`, `select`, `data`.

## Keyboard

Inside the canvas, `/` (outside text fields, IME composition and modifier chords) opens the first palette whose keys include `/`; so does the same key reported as 「、」 or 「／」 (`code` `Slash`) by a Chinese IME in Chinese punctuation mode. `⌘K`/`Ctrl+K` is only bound with `data-lg-keys="/ mod+k"`, because inside the canvas it would shadow Paseo's Command Center.

**Host forwarding (Paseo, web/desktop).** Paseo keeps keyboard focus outside the canvas until the user clicks into it. `CanvasFrame` with `presetKeys` forwards a bare `/` when all of these hold:

1. the current document carries the preset, the live source still uses it (not handed over to an old kit copy) and contains a declarative palette, and this canvas session has not let a forward time out (see below);
2. the keydown is a bare `/` (or 「、」/「／」 from the `Slash` key), unhandled (`defaultPrevented` false), with no Ctrl/Meta/Alt, not a repeat, IME composition or `?`;
3. host focus is not text entry (input, textarea, select, contenteditable, textbox/searchbox/combobox/spinbutton roles), not inside a terminal, the message composer, the Command Center, a dialog, menu or listbox, and not an iframe;
4. focus is inside **this Board's own screen root** (`[data-testid="board-screen"]`: toolbar, discussion rail, footer), or, **only when the Board is the route screen** (`surface === "screen"`), nothing is focused or focus is on Paseo's "Boards" sidebar row (`[data-testid="plugin-sidebar-paseo-board-boards"]`, which reopens the last Board and keeps focus). Agent and workspace panels never take those;
5. no composer, discussion, drawer, release/live/sources/inbox panel, selection mode or interaction lock is active, the frame is ready and visible.

The host then prevents the default, focuses the iframe and posts `{type:"preset-key", key:"/"}`. The preset opens the palette and replies `preset-key-ack {opened}`. Focus goes back to the previously focused host element when the palette is cancelled (Esc, scrim, toggle: `preset-focus-return`), when the reply says nothing opened, when no reply arrives within 250 ms, or when the frame session is replaced while the palette is open. Enter on a result is deliberate in-canvas navigation: focus stays at the target, exactly as after any click into a canvas, and the preset sends `preset-handoff-end` so the host forgets the handoff (a later session change never refocuses the old host control); Esc or a click on the host gives Paseo its shortcuts back. When host focus moves elsewhere while the palette is open, the palette closes without pulling focus back (also `preset-handoff-end`).

**Slow or silent canvases.** A session that lets a forward time out is muted: later `/` presses are left to Paseo (not swallowed) until that session replies again. If an `opened` reply arrives after the fallback, the palette keeps focus only when the user has not focused anything else in Paseo since; otherwise the host sends `preset-close` (the palette closes) and returns focus to what the user chose.

**Esc ownership.** Components close on their own Escape keydown. A press none of them saw closes the topmost open palette/split/module on keyup only when nobody else used it: it reached the window unprevented (focus elsewhere in the page), or the Board runtime stopped it while clearing a comment selection (text/region/point mode), so one Esc does both. An Escape that authored code prevented (an authored dialog), and one the runtime used in component mode (component text editing, layout, drag), leaves preset components open.

**Published pages.** A glass release opened top-level focuses its canvas once loaded, so `/` works before the first click. Inside the host's release preview this does nothing.

## Versions and old kit copies

| Case | Result |
| --- | --- |
| Board source inlines the prototype kit 0.1/0.2 (e.g. `liquid-glass-preview-20261111`) | Built-in not inlined; the document is byte-identical to before; the old kit runs alone |
| Built-in running, then a live patch adds a 0.2 copy | The 0.2 guard defers to 1.0.0; the built-in then hands over: tears itself down, disables its stylesheet and re-runs the authored kit once, so the session matches what a reopen shows |
| Built-in running, then an unguarded script overwrites `window.LiquidGlass` | The built-in tears down on its next mutation pass |
| Built-in script evaluated twice | The second evaluation returns immediately |

The version is exposed as `LIQUID_GLASS_VERSION`, the `data-version` attributes and `window.LiquidGlass.version`. Live Boards always use the installed plugin's preset, so 1.x stays markup-compatible; releases freeze the preset bytes they were exported with. A breaking change would need a new marker value.

## Narrow panes, motion and accessibility

- ≤ 900px: four/three-column grids become two columns and `.lg-columns` stacks. ≤ 720px: compact dock (40px items, magnification capped at 1.3) that **rests tucked away** (so it covers nothing at rest) and shows at the end of the page, while it has focus or the pointer, when the pointer nears the bottom edge, for 2.5 s after scrolling up and briefly after a tap on one of its items. ≤ 560px: one-column grids, tighter page/island padding, wrapping module heads and a tighter open split. The page always reserves room below its last content for the dock. Above 720px the dock floats over the bottom of the page by design (like a desktop dock); the reserve lets everything scroll above it, and it gives way to an open module and its thumbnail strip.
- Opened modules never outgrow the pane: their `[data-lg-detail]` scrolls horizontally (a wide table) and the close button stays visible. `.lg-section` columns never grow past the pane. Chart data tables are clipped, so long labels never widen the page.
- No layout shift on mount: splits and navs render a static pill before the kit mounts, chart figures have a fixed height, rolling numbers keep their text in place (measured cumulative layout shift 0).
- `prefers-reduced-motion`: animations and transitions of the role roots (`[data-lg]`), their preset-styled items (nav items, `data-lg-option`, modules, details, dock items) and `lg-*` classes collapse to one 1 ms iteration; other descendants (an authored spinner inside a card, `col-lg-6`) keep their own policy, so give your own animations a reduced-motion rule. Cards do not tilt, splits do not merge, modules open without animation. `prefers-reduced-transparency`: opaque glass. `forced-colors`: outlined surfaces without backdrop blur; built-in icons, status dots and meters are painted `CanvasText`, the current dock item and the chosen split option `Highlight`, and the droplet filter is off.
- Generated labels are Chinese: 切换模块, 切换到 {标题}, 展开/收起 {标题}, 命令面板, 搜索或跳转…, 结果, ↑ ↓ 选择 · ↵ 跳转 · esc 关闭, 没有匹配的结果, {n} 个结果, 模块/筛选/跳转, 均值 {值}{单位}, {标签} · {值}{单位}, 项目/数值, 暂无数据.

## Component editing and comments (measured)

Decorative generated nodes (capsules, droplet layers, dock label, ghost layer, palette chrome, `#lg-defs`) carry `data-board-overlay`, which Board excludes from component identity, comment anchors, layout observation and screenshots. Card light/tilt and dock magnification run as Web Animations, so no authored element is mutated, and pointer effects pause while the user presses, selects text or uses a Board selection mode, so comment screenshots stay stable.

Measured by the browser suite (live fingerprint compared with the authored source after mounting and interacting):

| Component | Same identity as authored | Notes |
| --- | --- | --- |
| KPI card with a rolling number, KPI grid, list card | Yes | Text comments over a KPI quote the real value (e.g. `126`) and capture successfully |
| `nav`, `split`, `dock` | Yes | Their state (`aria-current`, `aria-pressed`, classes) is not part of identity |
| `chart` figure | No | Generated SVG and data table |
| `expand` container and modules | No | Generated trigger/close buttons and strip |

Board UI move/copy/layout of a component whose subtree contains a chart or an expand module (including an un-id'd ancestor) reports a changed structure; edit its source instead.

## Known limitations

- The live-patch activation reloads the canvas once (transient DOM state of that canvas resets; scroll position is kept).
- Forwarding relies on Paseo's capture-phase shortcut handler preventing default and on its current test ids for terminal/composer/Command Center and the plugin sidebar row (`plugin-sidebar-{plugin}-{item}`). Text entry is protected by role/element checks regardless. A Chinese IME that turns the slash key into a composition (key `Process`/229) cannot be told apart from typing and does not open the palette; switch to English punctuation or click 搜索.
- A text edit (Board UI) of a value that a named control has changed is refused until the control shows the authored value again: the live text differs from the source.
- On desktop the floating dock covers the bottom strip of the viewport (by design), except over an open module and its strip, where it gives way; narrow panes keep it tucked at rest. An island dock (sticky, no `data-lg-page`) does not give way.
- Browsers report a ResizeObserver whose callback resizes what it observes as "ResizeObserver loop completed with undelivered notifications". Board ignores these notices for every Board (they are benign); the preset's own observers write in the next frame and never raise them. Authored code that loops this way still does extra layout work.
- Capture fidelity: `backdrop-filter` and fixed page pseudo-elements render approximately in comment screenshots; overlay chrome (nav capsule, dock label) is not captured by design.
- CSS `d` transitions animate chart bars in Chromium only; other engines jump to the new shape. `:has()` is required for page mode body takeover (Safari ≥ 15.4).
- The client bundle and store worker carry the preset as string constants (see README for the measured growth).

## Verification

Automated (repository harnesses, isolated Chrome; not the native Paseo app):

- `shared/liquid-glass.test.ts`, `shared/document-identity.test.ts`, `client/preset-keys.test.ts`, `shared/frame-contract.test.ts`, `server/static-release.test.ts`: activation, no-op identity, version, safety, size budget, contrast, tracker, forwarding rules, docs.
- `npm run test:browser` (`scripts/liquid-glass-checks.mjs`, or `BOARD_BROWSER_SCOPE=glass`): the real document wrapper and `CanvasFrame`; every interaction in light/dark at 1100px and at 480/360px; split reflow/fit and table modules at 856/420/300px; forced colours; body page mode; forwarding scope (toolbar, sidebar row, IME 「、」) and fail-safes (timeouts, muting, late replies, stale handoffs, host focus moves); Esc ownership; the palette above Board markers; live-patch rebuild and focus-update resend; legacy hand-over; reduced motion (including authored animations); rolling-number text; identity; capture. `BOARD_GLASS_SHOT_DIR` saves screenshots.
- Also in `scripts/liquid-glass-checks.mjs`: an open module's strip against the dock at 950x787 (the size of the real-app finding), 420x787 and 320x640 (hit-tests of every thumbnail, real clicks, the dock never over the module or its close button and back when out of the way, keyboard focus versus a mouse click); benign ResizeObserver notices on a 0.2-kit Board (loops, resizes, a patch running meanwhile, a frame posting one) and real errors still reported; no notice at all from the preset while resizing; dark Paseo theme colours equal to light inside the scope. `BOARD_LEGACY_BOARD_HTML=<0.2 Board source>` also runs a real 0.2 Board (old kit alone, palette, dock, resizing).
- `npm run test:release` (`scripts/release-glass-checks.mjs`) and `npm run test:host` (`scripts/glass-host-checks.mjs`, or `BOARD_HOST_TEST_SCOPE=glass`; it also resizes the real BoardView while a canvas observer loops: no banner, while a real script error still shows one).

Manual checklist for a later, user-approved check in the real Paseo app:

1. Open a glass Board as the Boards screen, as an agent panel and as an explorer/workspace panel.
2. Press `/` with focus on the Boards sidebar row, the Board toolbar, the chat transcript, a terminal and the message composer: only the Board toolbar (any surface) and, on the Boards screen, nothing focused or the Boards sidebar row open the palette; text fields receive `/`. Repeat with a Chinese IME in Chinese punctuation mode.
3. After Esc, and after Enter on a result followed by a click on the host, `⌘K` opens Paseo's Command Center.
4. Light and dark Paseo themes; a narrow agent panel (dock tucks, nothing hidden behind it). Open a module near the bottom of the page: its thumbnail strip is visible and clickable, the dock gives way.
5. Drag the window or pane width back and forth with a glass Board and with a Board that inlines the 0.2 kit: no "ResizeObserver loop" banner.
6. Publish a glass Board and open the share link: `/` works before clicking.
