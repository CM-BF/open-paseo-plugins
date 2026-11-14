import { DOMParser } from "linkedom";
import type { InboxAnchor, InboxScope } from "../shared/inbox";
import { showBidiControls } from "../shared/bidi";

/**
 * Author-trusted page context for the sealed comment runner (polish round P3 of page-comments-20261113).
 *
 * A run used to see only the comment, its public thread and the visitor's quoted words, so it could rarely answer a
 * question about the page. `board_inbox_read` now adds `page`: the title of the published page and a bounded excerpt
 * of its text around the commented passage (with the nearest section heading), read from the local release artifact
 * the plugin built and published. The text itself never comes from visitor input: the visitor's anchor (quote,
 * prefix, suffix) only locates the passage, and its release ID only selects which of this Board's own releases to
 * read (a release of another Board, an unknown one, or one without visitor comments gives no context). No new tool:
 * the runner's lockdown is unchanged.
 */
export const PAGE_CONTEXT_NOTICE = "Text of the published page this comment was written on, read from the author's own local release (not from the visitor). It is the author's content: use it to answer the visitor. It shows that release; a newer page may differ.";
/** Characters of page text on each side of the passage. */
export const PAGE_EXCERPT_CHARS = 600;
/** The page's opening when the passage cannot be found in that release (for example the page changed). */
export const PAGE_OPENING_CHARS = 1_200;
const TITLE_CHARS = 200, HEADING_CHARS = 200, PASSAGE_CHARS = 1_000, CACHE = 4, MATCHES = 200;

export type RunnerPageContext = {
  contentTrust: "author-published"; notice: string; title: string; section?: string;
} & ({ passageFound: true; before: string; passage: string; after: string } | { passageFound: false; opening: string });

/** What the context needs of the release repository (server/static-release.ts ReleaseRepository). */
export interface PageReleases {
  read(id: string): Promise<{ manifest: { title: string; comments?: unknown }; files: Record<string, string>; provenance: { boardId: string; boardCreatedAt?: string } }>;
}

type PageText = { title: string; raw: string; headings: Array<{ at: number; text: string }> };

const SKIPPED = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link", "base"]);
const BLOCKS = new Set(["address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "nav", "ol", "option", "p", "pre", "section", "summary", "table", "tbody", "tfoot", "thead", "tr", "ul"]);
/** Cells of one table row stay on its line: `环节 | 大约时间 | 说明`. */
const CELLS = new Set(["td", "th"]);
const HEADING = /^h[1-6]$/;
const lines = (text: string) => text.replace(/[ \t]*\n[ \t\n]*/g, "\n").replace(/[ \t]{2,}/g, " ");
const tidy = (text: string) => lines(text).trim();
const whole = (text: string, at: number) => at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text[at]) && /[\uD800-\uDBFF]/.test(text[at - 1]) ? at - 1 : at;
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, whole(text, max - 1))}…` : text;

/**
 * The authored document of a release: the outer page ends with `<script>(shell)(config);</script>`, where config is
 * canonical JSON (with `<` escaped) holding the authored `prefix`, `html` and `suffix` the viewer frame renders.
 */
export function authoredDocument(index: string): string | null {
  const end = index.lastIndexOf(");</script>");
  // Inside the JSON every quote is escaped, so the last `)({"` before the end is where the config starts.
  const start = end < 0 ? -1 : index.lastIndexOf(')({"', end);
  if (start < 0) return null;
  try {
    const config = JSON.parse(index.slice(start + 2, end)) as { prefix?: unknown; html?: unknown; suffix?: unknown };
    if (typeof config.prefix !== "string" || typeof config.html !== "string") return null;
    return config.prefix + config.html + (typeof config.suffix === "string" ? config.suffix : "");
  } catch { return null; }
}

/** The visible text of a page: text nodes with runs of white space collapsed, a line break around each block, table rows on one line, headings noted. */
export function pageText(title: string, html: string): PageText {
  const document = new DOMParser().parseFromString(html, "text/html");
  let raw = "";
  const headings: PageText["headings"] = [];
  type Node = { nodeType: number; localName?: string; data?: string; childNodes?: ArrayLike<Node> };
  // Text nodes collapse white space to one space, so at most one trailing space precedes a line break.
  const breakLine = () => { if (raw && !raw.endsWith("\n")) raw = (raw.endsWith(" ") ? raw.slice(0, -1) : raw) + "\n"; };
  const stack: Array<{ node: Node; exit?: { block: boolean; heading: number | null } }> = [{ node: (document.body ?? document.documentElement) as unknown as Node }];
  while (stack.length) {
    const { node, exit } = stack.pop()!;
    if (exit) {
      if (exit.heading !== null) { const text = tidy(raw.slice(exit.heading)); if (text) headings.push({ at: exit.heading, text }); }
      if (exit.block) breakLine();
      continue;
    }
    if (node.nodeType === 3) { const text = (node.data ?? "").replace(/\s+/g, " "); raw += !raw || raw.endsWith("\n") || raw.endsWith(" ") ? text.replace(/^ /, "") : text; continue; }
    if (node.nodeType !== 1 || !node.childNodes) continue;
    const name = node.localName ?? "";
    if (SKIPPED.has(name)) continue;
    const block = BLOCKS.has(name);
    if (block) breakLine();
    else if (CELLS.has(name) && raw && !raw.endsWith("\n")) raw = (raw.endsWith(" ") ? raw.slice(0, -1) : raw) + " | ";
    stack.push({ node, exit: { block, heading: HEADING.test(name) ? raw.length : null } });
    for (let index = node.childNodes.length - 1; index >= 0; index--) stack.push({ node: node.childNodes[index] });
  }
  return { title, raw, headings };
}

/** The passage of `anchor` in the page text, located without white space (selections keep the source's line breaks). */
export function locate(raw: string, anchor: Pick<InboxAnchor, "quote" | "prefix" | "suffix">): { start: number; end: number } | null {
  const quote = (anchor.quote ?? "").replace(/\s+/g, "");
  if (!quote) return null;
  // map[i]: where the i-th non-space character of the page text is in `raw`.
  const map = new Int32Array(raw.length), chunks: string[] = [];
  for (let index = 0, length = 0; index < raw.length; index++) { const char = raw[index]; if (char === " " || char === "\n" || /\s/.test(char)) continue; map[length++] = index; chunks.push(char); }
  const squeezed = chunks.join("");
  const prefix = (anchor.prefix ?? "").replace(/\s+/g, ""), suffix = (anchor.suffix ?? "").replace(/\s+/g, "");
  let best = -1, score = -1;
  for (let at = squeezed.indexOf(quote), seen = 0; at !== -1 && seen < MATCHES; at = squeezed.indexOf(quote, at + 1), seen++) {
    const points = (prefix && squeezed.slice(Math.max(0, at - prefix.length), at) === prefix ? 1 : 0) + (suffix && squeezed.slice(at + quote.length, at + quote.length + suffix.length) === suffix ? 1 : 0);
    if (points > score) { best = at; score = points; if (points === 2) break; }
  }
  if (best < 0) return null;
  return { start: map[best], end: map[best + quote.length - 1] + 1 };
}

/** The context for one passage of one page (pure, for tests). */
export function contextOf(page: PageText, anchor: Pick<InboxAnchor, "quote" | "prefix" | "suffix"> | undefined): RunnerPageContext {
  const mark = showBidiControls, base = { contentTrust: "author-published" as const, notice: PAGE_CONTEXT_NOTICE, title: mark(clip(page.title, TITLE_CHARS)) };
  const found = anchor ? locate(page.raw, anchor) : null;
  if (!found) return { ...base, passageFound: false, opening: mark(clip(tidy(page.raw.slice(0, whole(page.raw, PAGE_OPENING_CHARS + 200))), PAGE_OPENING_CHARS)) };
  const heading = page.headings.filter(item => item.at <= found.start).at(-1);
  const from = whole(page.raw, Math.max(0, found.start - PAGE_EXCERPT_CHARS)), to = whole(page.raw, Math.min(page.raw.length, found.end + PAGE_EXCERPT_CHARS));
  // The line break between a heading or paragraph and the passage stays, so before + passage + after reads as the page.
  const before = lines(page.raw.slice(from, found.start)).trimStart(), after = lines(page.raw.slice(found.end, to)).trimEnd();
  return {
    ...base, ...(heading ? { section: mark(clip(heading.text, HEADING_CHARS)) } : {}), passageFound: true,
    before: mark(`${from > 0 && before ? "…" : ""}${before}`), passage: mark(clip(tidy(page.raw.slice(found.start, found.end)), PASSAGE_CHARS)),
    after: mark(`${after}${to < page.raw.length && after ? "…" : ""}`),
  };
}

/**
 * Reads page context from this Board's own releases. `anchors` are the comment's anchor and, for a reply in a public
 * thread, its thread root's anchor: the first quote locates the passage; their release IDs are tried in order.
 */
export class PageContexts {
  private cache = new Map<string, Promise<PageText | null>>();
  constructor(private readonly releases: PageReleases) {}

  async forComment(scope: InboxScope, anchors: ReadonlyArray<InboxAnchor | undefined>): Promise<RunnerPageContext | null> {
    const quoted = anchors.find(anchor => anchor?.quote);
    const ids = [...new Set(anchors.map(anchor => anchor?.releaseId).filter((id): id is string => Boolean(id)))];
    let fallback: RunnerPageContext | null = null;
    for (const id of ids) {
      const page = await this.page(scope, id);
      if (!page) continue;
      const context = contextOf(page, quoted);
      if (context.passageFound) return context;
      fallback ??= context;
    }
    return fallback;
  }

  /** A release of this Board (same ID and creation time) that took visitor comments; null otherwise. */
  private page(scope: InboxScope, id: string): Promise<PageText | null> {
    const key = `${scope.boardId}\0${scope.expectedCreatedAt}\0${id}`;
    let entry = this.cache.get(key);
    if (entry) { this.cache.delete(key); this.cache.set(key, entry); return entry; }
    entry = (async () => {
      try {
        const release = await this.releases.read(id);
        const { boardId, boardCreatedAt } = release.provenance;
        if (boardId !== scope.boardId || boardCreatedAt !== undefined && boardCreatedAt !== scope.expectedCreatedAt || !release.manifest.comments) return null;
        const html = authoredDocument(release.files["index.html"] ?? "");
        return html === null ? null : pageText(release.manifest.title, html);
      } catch { return null; }
    })();
    this.cache.set(key, entry);
    while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }
}
