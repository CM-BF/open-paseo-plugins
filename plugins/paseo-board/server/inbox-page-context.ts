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
 * read (a release of another Board, an unknown one, one without the comment's kind of visitor comments, or one its
 * share link replaced without keeping it online gives no context). No new tool: the runner's lockdown is unchanged.
 * The text is computed in the plugin's store workers, linear in the page and capped (review fix).
 */
export const PAGE_CONTEXT_NOTICE = "Text of the published page this comment names: one of this Board's own releases that visitors can still open, read from the author's local copy of it (not from the visitor). It is the author's content: use it to answer the visitor. The page the visitor sees now may be a newer version.";
/** Characters of page text on each side of the passage. */
export const PAGE_EXCERPT_CHARS = 600;
/** The page's opening when the passage cannot be found in that release (for example the page changed). */
export const PAGE_OPENING_CHARS = 1_200;
/** Page text read from one release at most: a passage further down gives the page's opening instead. */
export const PAGE_TEXT_CHARS = 400_000;
const TITLE_CHARS = 200, HEADING_CHARS = 200, HEADING_SCAN = 2_000, PASSAGE_CHARS = 1_000, CACHE = 4, MATCHES = 200;

export type RunnerPageContext = {
  contentTrust: "author-published"; notice: string; title: string; section?: string;
} & ({ passageFound: true; before: string; passage: string; after: string } | { passageFound: false; opening: string });

/** What the context needs of the release repository (server/static-release.ts ReleaseRepository). */
export interface PageReleases {
  read(id: string): Promise<{ manifest: { title: string; comments?: unknown }; files: Record<string, string>; provenance: { boardId: string; boardCreatedAt?: string } }>;
}

export type PageText = { title: string; raw: string; headings: Array<{ at: number; text: string }> };

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

/**
 * The visible text of a page: text nodes with runs of white space collapsed, a line break around each block, table rows
 * on one line, headings noted. Linear in the page (review fix: the first version re-read `childNodes` for every child,
 * which linkedom rebuilds on each read, and tested and sliced the growing text, so a large release stalled the plugin's
 * main thread for seconds to minutes). Text past PAGE_TEXT_CHARS is not read.
 */
export function pageText(title: string, html: string): PageText {
  const document = new DOMParser().parseFromString(html, "text/html");
  // The text so far is parts.join("") followed by one space when `space` is set: a trailing space is held back until
  // the next text, and a line break or cell separator drops it, so nothing already written is ever edited.
  const parts: string[] = [], headings: PageText["headings"] = [];
  let size = 0, last = "", space = false;
  const write = (text: string) => { parts.push(text); size += text.length; last = text[text.length - 1]; };
  const breakLine = () => { if (size && last !== "\n") { space = false; write("\n"); } };
  /** Text written since part `from`, at most HEADING_SCAN characters (a heading is clipped to HEADING_CHARS anyway). */
  const since = (from: number) => { let text = ""; for (let index = from; index < parts.length && text.length < HEADING_SCAN; index++) text += parts[index]; return text.slice(0, HEADING_SCAN); };
  type Node = { nodeType: number; localName?: string; data?: string; childNodes?: ArrayLike<Node> };
  const stack: Array<{ node: Node; exit?: { block: boolean; heading: { at: number; part: number } | null } }> = [{ node: (document.body ?? document.documentElement) as unknown as Node }];
  while (stack.length && size < PAGE_TEXT_CHARS) {
    const { node, exit } = stack.pop()!;
    if (exit) {
      if (exit.heading) { const text = tidy(since(exit.heading.part)); if (text) headings.push({ at: exit.heading.at, text }); }
      if (exit.block) breakLine();
      continue;
    }
    if (node.nodeType === 3) {
      let text = (node.data ?? "").replace(/\s+/g, " ");
      if (space || !size || last === "\n") text = text.replace(/^ /, "");
      if (!text) continue;
      const trailing = text.endsWith(" "), core = trailing ? text.slice(0, -1) : text;
      if (core) { write(space ? ` ${core}` : core); space = trailing; } else space = true;
      continue;
    }
    if (node.nodeType !== 1 || !node.childNodes) continue;
    const name = node.localName ?? "";
    if (SKIPPED.has(name)) continue;
    const block = BLOCKS.has(name);
    if (block) breakLine();
    else if (CELLS.has(name) && size && last !== "\n") { write(" |"); space = true; }
    stack.push({ node, exit: { block, heading: HEADING.test(name) ? { at: size + (space ? 1 : 0), part: parts.length } : null } });
    // Read once: each read of childNodes builds a new list.
    const children = node.childNodes;
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index] });
  }
  const raw = parts.join("") + (space ? " " : "");
  return { title, raw: raw.length > PAGE_TEXT_CHARS ? raw.slice(0, whole(raw, PAGE_TEXT_CHARS)) : raw, headings };
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

/** The page text of a release's `index.html`, or null when it carries no authored document (store worker: compute). */
export function releasePageText(index: string, title: string): PageText | null {
  const html = authoredDocument(index);
  return html === null ? null : pageText(title, html);
}

export interface PageContextOptions {
  /**
   * Where the page text is computed. The plugin passes its store workers (BoardStorePool.pageText), so parsing a large
   * release never runs on the plugin's main thread; without it (tests) it runs in this process.
   */
  compute?: (boardId: string, index: string, title: string) => Promise<PageText | null>;
  /**
   * Whether visitors can still open this release (publication-rpc.ts releaseStillOnline). A release its share link
   * replaced without keeping an archive gives no context, so a visitor cannot name an old release ID to have the
   * assistant restate text the author has since removed.
   */
  online?: (releaseId: string) => Promise<boolean>;
}

/**
 * Reads page context from this Board's own releases. `anchors` are the comment's anchor and, for a reply in a public
 * thread, its thread root's anchor: the first quote locates the passage; their release IDs are tried in order. Only a
 * release with the comment's own kind of comments (public threads for a public comment, private comments otherwise)
 * that visitors can still open is read.
 */
export class PageContexts {
  private cache = new Map<string, Promise<{ text: PageText; public: boolean } | null>>();
  constructor(private readonly releases: PageReleases, private readonly options: PageContextOptions = {}) {}

  async forComment(scope: InboxScope, anchors: ReadonlyArray<InboxAnchor | undefined>, visibility?: "public"): Promise<RunnerPageContext | null> {
    const quoted = anchors.find(anchor => anchor?.quote);
    const ids = [...new Set(anchors.map(anchor => anchor?.releaseId).filter((id): id is string => Boolean(id)))];
    let fallback: RunnerPageContext | null = null;
    for (const id of ids) {
      if (this.options.online && !(await this.options.online(id).catch(() => false))) continue;
      const page = await this.page(scope, id);
      if (!page || page.public !== (visibility === "public")) continue;
      const context = contextOf(page.text, quoted);
      if (context.passageFound) return context;
      fallback ??= context;
    }
    return fallback;
  }

  /** A release of this Board (same ID and creation time) that took visitor comments; null otherwise. */
  private page(scope: InboxScope, id: string): Promise<{ text: PageText; public: boolean } | null> {
    const key = `${scope.boardId}\0${scope.expectedCreatedAt}\0${id}`;
    let entry = this.cache.get(key);
    if (entry) { this.cache.delete(key); this.cache.set(key, entry); return entry; }
    const loading = (async () => {
      const release = await this.releases.read(id);
      const { boardId, boardCreatedAt } = release.provenance, comments = release.manifest.comments as { visibility?: unknown } | undefined;
      if (boardId !== scope.boardId || boardCreatedAt !== undefined && boardCreatedAt !== scope.expectedCreatedAt || !comments) return null;
      const index = release.files["index.html"] ?? "", title = release.manifest.title;
      const text = this.options.compute ? await this.options.compute(scope.boardId, index, title) : releasePageText(index, title);
      return text ? { text, public: comments.visibility === "public" } : null;
    })();
    // A release that cannot be read now (missing, or a busy worker) is not remembered: the next read tries again.
    const settled: Promise<{ text: PageText; public: boolean } | null> = loading.catch(() => { if (this.cache.get(key) === settled) this.cache.delete(key); return null; });
    entry = settled;
    this.cache.set(key, entry);
    while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }
}
