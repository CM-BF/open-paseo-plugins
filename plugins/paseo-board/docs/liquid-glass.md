# Liquid-glass style preset (v1.0.0)

An optional, built-in visual preset for Board canvases: a warm peach/rose/apricot field with white light arcs, white frosted cards (thin white border, inner top highlight, 24px radius), a copper accent (`#B66D44`), a `#E7A471 → #C5A0AB` chart gradient, 48px+ titles and monospace numbers, plus seven declarative interactions. Agents opt in with markup; nothing else changes for other Boards.

- Assets: `shared/assets/liquid-glass.css.txt`, `shared/assets/liquid-glass.js.txt` (readable source, no build step).
- Activation and head markup: `shared/liquid-glass.ts` (`LIQUID_GLASS_VERSION`, `liquidGlassUsage`, `liquidGlassHead`, `createLiquidGlassTracker`).
- Canonical page: [`examples/liquid-glass.html`](../examples/liquid-glass.html) (no page script, no page CSS). The installed skill carries a complete minimal page.

## Activation and coverage

The preset is inlined in the document `<head>`, after the low-priority defaults stylesheet, as `<style id="paseo-board-liquid-glass-style" data-version="1.0.0">` and `<script id="paseo-board-liquid-glass-script" data-version="1.0.0">`, only when authored source contains the marker in one of these contexts:

- the attribute `data-style="liquid-glass"` (quoted or unquoted);
- a CSS attribute selector such as `[data-style="liquid-glass"]`;
- `el.dataset.style = "liquid-glass"` or `el.setAttribute("data-style", "liquid-glass")` in a script.

Prose ("liquid glass", a quoted "liquid-glass"), ids such as `liquid-glass-preview-1`, classes and longer values (`liquid-glassy`) never activate it. The preset is **not** inlined when the source also contains `data-lg-builtin="off"` or the prototype kit's own copy (`id="lg-kit-script"`/`"lg-kit-style"`, or its `window.LiquidGlass = { scan:` assignment). A defensive `window.LiquidGlass = window.LiquidGlass || …` shim does not disable it.

| Situation | Covered | How |
| --- | --- | --- |
| Marker in the base document | Yes | Build-time detection in `buildBoardDocument` |
| Marker first added by a patch; Board reopened, reloaded or opened elsewhere | Yes | Every patch's `html` is scanned |
| Marker first added by a live patch while the Board is open | Yes | `CanvasFrame` tracks usage incrementally and rebuilds the frame **once** per (board, document version) when the canvas is idle (no selection mode, no interaction lock, not typing or dragging), restoring the latest reading position and without replaying update highlights. Unsaved transient DOM state of that canvas resets once. |
| Scope created at runtime by authored script that contains the literal marker | Yes | Build-time detection plus the kit's MutationObserver |
| Marker assembled at runtime (`['liquid','glass'].join('-')`) or loaded from a CDN | No | Write the literal marker in source |
| Exported/published releases, GitHub Pages, `board-release` CLI, offline exports | Yes | `buildRelease` scans the materialized source; the preset is inline and not counted as a dependency |
| Response canvases and composition children | Yes (rendering) | Both use `buildBoardDocument`; host `/` forwarding is not armed for them |
| Native mobile | n/a | No canvas renders there |

Documents and releases without an activating marker are byte-identical to Board without the preset (`shared/document-identity.test.ts` compares against a frozen copy of the previous template and pinned digests; the pinned release test is unchanged).

## Markup contract

### Scope

- `<main data-style="liquid-glass" data-lg-page>`: **page mode**. Paints the field and arcs, takes over the Board body (no 960px limit, no padding), centres content up to `--lg-max` (1120px) and stacks direct children with a `--lg-gap` (20px) flow gap. Reserves bottom space when it contains a dock.
- `<section data-style="liquid-glass">` without `data-lg-page`: **island mode**, a self-contained glass panel with its own field background inside an ordinary (host-adaptive) Board.
- Only the **outermost** marker is a scope. A nested marker (for example on a section patched into a glass page) is inert: no second field, and its keyed values follow the page's controls.
- `data-lg-scope` on any ancestor narrows which values a split/nav updates (default: the outermost scope).
- Every scope sets `color-scheme: light`, its own text colour and re-points Board's injected tokens (`--background`, `--foreground`, `--card`, `--primary`, `--muted-foreground`, `--border`, `--destructive/--success/--warning`, `--viz-neutral-*`, `--viz-recede*`, `--shadow-*` …) so `.btn`, `.form-control` and `.viz-plot` stay readable under a dark host.

### Roles (`data-lg`, space separated)

| Role | Markup | Behaviour |
| --- | --- | --- |
| `nav` | Direct children `a`, `button` or `[data-lg-item]`; current item via `aria-current`/`aria-selected="true"`/`.is-active`; optional `data-lg-value`, `data-lg-target="#id"`, `data-lg-spy` on the nav, `data-lg-name` | Liquid capsule (spring edges) under the current item; arrows/Home/End; emits `lg:change` |
| `card` | Any element | Frosted card with cursor light, edge glow and gentle tilt (desktop pointers; none for touch, `hover:none` and reduced motion) |
| `expand` | Children `[data-lg-module]` with `[data-lg-summary]` and `[data-lg-detail]`; optional `data-lg-title`, `[data-lg-icon]`, `data-lg-strip-label`, `--lg-expand-col`, `--lg-expand-min` | Module opens in place, the others fly into a thumbnail strip kept above the dock; Esc or the close button restores focus to the module's trigger |
| `split` | Children `button[data-lg-option="key"]`, current `aria-pressed="true"`; author writes `role="group" aria-label`; optional `data-lg-label`, `data-lg-anchor="end"`, `data-lg-name` | One droplet splits into the options and merges back after a choice; updates `[data-lg-by]` values; emits `lg:change` |
| `palette` | One empty element; optional `data-lg-label`, `data-lg-placeholder`, `data-lg-keys` (default `/`) | Centred glass command palette with dim+blur, live filter and highlight, live result count; entries are elements with `data-lg-command` (+ `data-lg-group`, `data-lg-keywords`); `[data-lg-palette-open]` opens it |
| `dock` | Children `[data-lg-dock-item]` with `data-lg-label` and an icon (`svg` child or `data-lg-icon`), `data-lg-target`, `[data-lg-dock-sep]`, `data-lg-magnify`; usually `data-lg="dock nav"` | Floating glass dock, neighbour magnification and a name label; compact and auto-tucking on narrow panes; sticky inside an island |
| `chart` | `<figure data-lg="chart" aria-label="…">` (empty) | Bar (default) or `data-lg-type="line"` chart, see below |

### Values and named controls

- `data-lg-count="1234.5"`: rolling digits; the element's plain text stays the accessible, selectable value. Changing the attribute rolls to the new value.
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
- Content: `.lg-title`, `.lg-eyebrow`, `.lg-lede`, `.lg-muted`, `.lg-stat` (`-label`, `-value`, `-foot`, `-spark`), `.lg-module-head`, `.lg-icon`, `.lg-meta`, `.lg-big`, `.lg-list`, `.lg-dot[data-tone]`, `.lg-grow`, `.lg-table`, `.lg-num`, `.lg-meter` (`--lg-value` 0–1; author supplies `role="meter"` and aria values), `.lg-avatar`, `.lg-pill`, `.lg-chip[data-tone=good|warn|bad]`, `.lg-glass`, `kbd`, `.lg-sr`.
- Icons: `data-lg-icon="home|chart|trend|list|grid|search|clock|users|chat|data|upload|settings|doc|bell|check|star|spark|code"` on an empty element (CSS masks: no network, no DOM change, captured in screenshots). An `svg` child takes precedence.
- Colour scheme: `--lg-peach #E4C0A6`, `--lg-rose #D488AC`, `--lg-apricot #EBD7CC`, `--lg-accent #B66D44`, `--lg-accent-text`, `--lg-accent-deep`, `--lg-accent-soft`, `--lg-chart-top #E7A471`, `--lg-chart-bottom #C5A0AB`, `--lg-ink #2B1D1A`, `--lg-ink-muted`, `--lg-ink-faint`, `--lg-good/--lg-warn/--lg-bad`. Glass: `--lg-glass`, `--lg-glass-strong`, `--lg-stroke`, `--lg-highlight`, `--lg-blur`, `--lg-radius`. Layout: `--lg-max`, `--lg-gap`, `--lg-chart-h`, `--lg-dock-size`, `--lg-title-size`.
- The CSS is **not** in a cascade layer: every selector is scope-prefixed, so element resets (`*{margin:0;padding:0}`, `button{background:none}`, `h1{font-size:…}`) do not strip the preset. Override deliberately with variables or `#page-id .class`.

### JavaScript API

`window.LiquidGlass = { version: "1.0.0", builtin: true, scan(el?), api(el, kind), destroy(el), teardown() }`. `scan(el)` mounts synchronously (queued before `DOMContentLoaded`); `api(el, "split")` exposes `choose`, `openUp`, `close`, `value`; `api(el, "palette")` exposes `open`, `close`; `api(el, "chart")` exposes `update`, `select`, `data`.

## Keyboard

Inside the canvas, `/` (outside text fields, IME composition and modifier chords) opens the first palette whose keys include `/`. `⌘K`/`Ctrl+K` is only bound with `data-lg-keys="/ mod+k"`, because inside the canvas it would shadow Paseo's Command Center.

**Host forwarding (Paseo, web/desktop).** Paseo keeps keyboard focus outside the canvas until the user clicks into it. `CanvasFrame` with `presetKeys` forwards a bare `/` when all of these hold:

1. the current document carries the preset and the live source contains a declarative palette;
2. the keydown is unhandled (`defaultPrevented` false), has no Ctrl/Meta/Alt, is not a repeat, IME composition or `?`;
3. host focus is not text entry (input, textarea, select, contenteditable, textbox/searchbox/combobox/spinbutton roles), not inside a terminal, the message composer, the Command Center, a dialog, menu or listbox, and not an iframe;
4. focus is inside **this Board's own screen root** (`[data-testid="board-screen"]`: toolbar, discussion rail, footer), or nothing is focused **and** the Board is the route screen (`surface === "screen"`). Agent and workspace panels never take a body-level `/`;
5. no composer, discussion, drawer, release/live/sources/inbox panel, selection mode or interaction lock is active, the frame is ready and visible.

The host then prevents the default, focuses the iframe and posts `{type:"preset-key", key:"/"}`. The preset opens the palette and replies `preset-key-ack {opened}`. Focus goes back to the previously focused host element when the palette is cancelled (Esc, scrim, toggle), when the reply says nothing opened, when no reply arrives within 250 ms, or when the frame session is replaced. Enter on a result is deliberate in-canvas navigation: focus stays at the target, exactly as after any click into a canvas; Esc or a click on the host gives Paseo its shortcuts back.

**Esc with a Board selection.** The Board runtime consumes an Escape keydown while it clears a comment selection; the preset closes the topmost open palette/split/module on the matching keyup, so one Esc does both.

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

- ≤ 900px: four/three-column grids become two columns and `.lg-columns` stacks. ≤ 720px: compact dock (40px items, magnification capped at 1.3) that tucks away while scrolling down and returns on scroll up, near the top or end, on focus, or when the pointer nears the bottom edge. ≤ 560px: one-column grids and tighter page/island padding. The page always reserves room below its last content for the dock.
- No layout shift on mount: splits and navs render a static pill before the kit mounts, chart figures have a fixed height, rolling numbers keep their text in place (measured cumulative layout shift 0).
- `prefers-reduced-motion`: preset-owned animations and transitions collapse (authored animations keep their own policy), cards do not tilt, splits do not merge, modules open without animation. `prefers-reduced-transparency`: opaque glass. `forced-colors`: outlined surfaces without backdrop blur.
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
- Forwarding relies on Paseo's capture-phase shortcut handler preventing default and on its current test ids for terminal/composer/Command Center. Text entry is protected by role/element checks regardless.
- Capture fidelity: `backdrop-filter` and fixed page pseudo-elements render approximately in comment screenshots; overlay chrome (nav capsule, dock label) is not captured by design.
- CSS `d` transitions animate chart bars in Chromium only; other engines jump to the new shape. `:has()` is required for page mode body takeover (Safari ≥ 15.4).
- The client bundle and store worker carry the preset as string constants (see README for the measured growth).

## Verification

Automated (repository harnesses, isolated Chrome; not the native Paseo app):

- `shared/liquid-glass.test.ts`, `shared/document-identity.test.ts`, `client/preset-keys.test.ts`, `shared/frame-contract.test.ts`, `server/static-release.test.ts`: activation, no-op identity, version, safety, size budget, contrast, tracker, forwarding rules, docs.
- `npm run test:browser` (`scripts/liquid-glass-checks.mjs`, or `BOARD_BROWSER_SCOPE=glass`): the real document wrapper and `CanvasFrame`; every interaction in light/dark at 1100px and at 480/360px; forwarding scope and fail-safes; live-patch rebuild; legacy hand-over; reduced motion; identity; capture. `BOARD_GLASS_SHOT_DIR` saves screenshots.
- `npm run test:release` (`scripts/release-glass-checks.mjs`) and `npm run test:host` (`scripts/glass-host-checks.mjs`, or `BOARD_HOST_TEST_SCOPE=glass`).

Manual checklist for a later, user-approved check in the real Paseo app:

1. Open a glass Board as the Boards screen, as an agent panel and as an explorer/workspace panel.
2. Press `/` with focus on the sidebar row, the Board toolbar, the chat transcript, a terminal and the message composer: only the Board toolbar (any surface) and nothing-focused on the Boards screen open the palette; text fields receive `/`.
3. After Esc, and after Enter on a result followed by a click on the host, `⌘K` opens Paseo's Command Center.
4. Light and dark Paseo themes; a narrow agent panel (dock tucks, nothing hidden behind it).
5. Publish a glass Board and open the share link: `/` works before clicking.
