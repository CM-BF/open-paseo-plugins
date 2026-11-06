import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DOMParser } from "linkedom";
import { BoardStore } from "./store";
import { describeAuthoring } from "./authored-source";
import { componentIdentityFor } from "../shared/component-identity";
import { EditInputSchema, type Board, type EditInput } from "../shared/contracts";
import { serialized } from "./store-format";

const base = (board: Board) => ({ revision: board.canvas.revision, documentVersion: board.canvas.documentVersion });
const documentFor = (board: Board) => {
  const source = describeAuthoring(board.canvas);
  expect(source.replay.complete).toBe(true);
  return new DOMParser().parseFromString(`<html><head></head><body>${source.materializedAuthoredHtml}</body></html>`, "text/html");
};
const html = '<main id="board"><section id="left"><article id="a"><h3 id="heading">Original</h3><p id="mixed">Before <b id="bold">bold</b> after</p><button id="button" onclick="count++">Go</button></article><article id="b">B</article></section><section id="right"><p id="tail">Tail</p></section></main>';

// Browser SVG names use their adjusted camelCase spelling. This view changes only
// that parser difference; the actual browser parity test lives in browser-test.mjs.
function browserSvgNames(element: Parameters<typeof componentIdentityFor>[0]) {
  type ElementShape = Parameters<typeof componentIdentityFor>[0];
  const nodes = [element, ...Array.from(element.querySelectorAll("*"))];
  const copies = new Map<ElementShape, ElementShape>();
  for (const node of nodes) copies.set(node, {
    localName: ({ foreignobject: "foreignObject", lineargradient: "linearGradient" } as Record<string, string>)[node.localName] ?? node.localName,
    id: node.id, outerHTML: node.outerHTML,
    get parentElement() { return node.parentElement ? copies.get(node.parentElement) ?? null : null; },
    getAttribute: name => node.getAttribute(name),
    querySelectorAll: selector => Array.from(node.querySelectorAll(selector)).map(child => copies.get(child)!),
  });
  return copies.get(element)!;
}

describe("durable user component edits", () => {
  let root: string, store: BoardStore;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "board-components-")); store = new BoardStore(root); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const create = (source = html) => store.create({ id: "fixture", title: "Components", ownerAgentId: "owner", html: source, data: { n: 1 } });
  function request(board: Board, operation: "move" | "copy" | "text", selector: string, extra: Partial<EditInput["patch"]> = {}): EditInput {
    const document = documentFor(board);
    return {
      boardId: board.id, canvasBase: base(board), eventId: `edit-${board.canvas.revision}`,
      patch: { id: `patch-${board.canvas.revision}`, operation, selector, sourceIdentity: componentIdentityFor(document.querySelector(selector)!),
        ...(operation === "text" ? { text: "Changed", expectedText: document.querySelector(selector)!.textContent! }
          : { destination: "#right", destinationIdentity: componentIdentityFor(document.querySelector("#right")!), position: "append", ...(operation === "copy" ? { copyIdPrefix: "copied" } : {}) }),
        ...extra },
    };
  }

  it("commits a local move in the existing document and replays after restart while preserving data and state", async () => {
    const initial = await create();
    await store.saveState({ boardId: initial.id, state: { draft: "retained", tab: 2 } });
    const moved = await store.edit(request(initial, "move", "#a"));
    expect(moved.canvas.html).toBe(html);
    expect(moved.canvas.documentVersion).toBe(1);
    expect(moved.canvas.revision).toBe(2);
    expect(moved.canvas.data).toEqual({ n: 1 });
    expect(moved.userState).toEqual({ draft: "retained", tab: 2 });
    const document = documentFor((await new BoardStore(root).read(initial.id))!);
    expect(document.querySelector("#a")!.parentElement!.id).toBe("right");
    expect(document.querySelector("#left")!.innerHTML).toBe('<article id="b">B</article>');
    expect(document.querySelector("#button")!.getAttribute("onclick")).toBe("count++");
    expect(moved.events.at(-1)).toMatchObject({ source: "user", kind: "component-edit" });
    expect(moved.updates.at(-1)).toMatchObject({ kind: "patch", targets: [{ selector: "#right", operation: "move", patchId: "patch-1" }] });
  });

  it("checks canvas CAS and retains exact receipts across later edits without replaying the move", async () => {
    const initial = await create();
    const move = request(initial, "move", "#a");
    const moved = await store.edit(move);
    await expect(store.edit({ ...move, eventId: "stale", patch: { ...move.patch, id: "stale" } })).rejects.toMatchObject({ code: "revision_conflict" });
    const renamed = await store.rename({ boardId: initial.id, title: "Renamed", expectedTitle: "Components", eventId: "rename" });
    expect(await new BoardStore(root).edit(move)).toEqual(renamed);
    await expect(store.edit({ ...move, patch: { ...move.patch, position: "prepend" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(store.edit({ ...request(moved, "text", "#heading"), patch: { ...request(moved, "text", "#heading").patch, id: move.patch.id } })).rejects.toMatchObject({ code: "idempotency_conflict" });
    const envelope = JSON.parse(await readFile(join(root, "boards", "fixture.json"), "utf8"));
    expect(envelope.history.filter((entry: { operation: string }) => entry.operation === "edit")).toHaveLength(1);
  });

  it("rejects an old queued edit under the lock even when replacement canvas versions and source identity match", async () => {
    const initial = await create(), input = { ...request(initial, "text", "#heading"), expectedCreatedAt: initial.createdAt };
    const path = join(root, "boards", `${initial.id}.json`);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
    let replacementBytes = "";
    const replacing = serialized(path, async () => {
      enter(); await released;
      const envelope = JSON.parse(await readFile(path, "utf8"));
      envelope.board.createdAt = new Date(Date.parse(initial.createdAt) + 1000).toISOString();
      replacementBytes = JSON.stringify(envelope); await writeFile(path, replacementBytes);
    });
    await entered;
    const rejected = expect(store.edit(input)).rejects.toMatchObject({ code: "board_identity_changed" });
    release(); await replacing; await rejected;
    expect(await readFile(path, "utf8")).toBe(replacementBytes);
    const current = (await store.read(initial.id))!;
    const valid = { ...input, expectedCreatedAt: current.createdAt };
    expect(documentFor(await store.edit(valid)).querySelector("#heading")!.textContent).toBe("Changed");
    expect(await store.edit(valid)).toEqual(await store.read(initial.id));
    // The precondition also runs before returning a successful historical receipt.
    await expect(store.edit(input)).rejects.toMatchObject({ code: "board_identity_changed" });
  });

  it("lets only one concurrent change from the same source canvas commit", async () => {
    const initial = await create();
    const move = request(initial, "move", "#a");
    const edit = request(initial, "text", "#heading"); edit.eventId = "text"; edit.patch.id = "text";
    const results = await Promise.allSettled([store.edit(move), store.edit(edit)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "revision_conflict" } });
    expect((await store.read(initial.id))!.canvas.patches).toHaveLength(1);
  });

  it("guards source and destination identity independently of changing live text", async () => {
    const initial = await create();
    const move = request(initial, "move", "#a");
    const live = documentFor(initial); live.querySelector("#heading")!.textContent = "A live counter now says 98";
    expect(componentIdentityFor(live.querySelector("#a")!)).toEqual(move.patch.sourceIdentity);
    await expect(store.edit({ ...move, patch: { ...move.patch, sourceIdentity: { ...move.patch.sourceIdentity!, fingerprint: "00000000" } } })).rejects.toMatchObject({ code: "edit_conflict" });
    await expect(store.edit({ ...move, patch: { ...move.patch, destinationIdentity: { ...move.patch.destinationIdentity!, tag: "article" } } })).rejects.toMatchObject({ code: "edit_conflict" });
    expect(await store.read(initial.id)).toEqual(initial);
    expect((await store.edit(move)).canvas.revision).toBe(2);
  });

  it("refuses cycles, ambiguous/missing selectors, document roots and runtime-only components without changing storage", async () => {
    const initial = await create();
    const move = request(initial, "move", "#a");
    const document = documentFor(initial);
    for (const patch of [
      { ...move.patch, destination: "#a", destinationIdentity: move.patch.sourceIdentity },
      { ...move.patch, destination: "#heading", destinationIdentity: componentIdentityFor(document.querySelector("#heading")!) },
      { ...move.patch, selector: "article" },
      { ...move.patch, selector: "#runtime-created" },
      { ...move.patch, destination: "#missing" },
      { ...move.patch, destination: "body", destinationIdentity: componentIdentityFor(document.querySelector("body")!) },
    ]) await expect(store.edit({ ...move, patch })).rejects.toMatchObject({ code: "edit_conflict" });
    expect(await store.read(initial.id)).toEqual(initial);
  });

  it("refuses duplicate IDs even when a class selector happens to select one matching node", async () => {
    const initial = await create('<main><article class="one" id="same">First</article><article id="same">Second</article><section id="right"></section></main>');
    await expect(store.edit(request(initial, "move", ".one"))).rejects.toMatchObject({ code: "edit_conflict" });
    expect(await store.read(initial.id)).toEqual(initial);
  });

  it("edits leaf text as text and edits one direct mixed text run while keeping child elements intact", async () => {
    const initial = await create();
    const first = await store.edit(request(initial, "text", "#heading", { text: '<img onerror="bad()"> & plain' }));
    const heading = documentFor(first).querySelector("#heading")!;
    expect(heading.children.length).toBe(0); expect(heading.textContent).toBe('<img onerror="bad()"> & plain');
    const mixed = request(first, "text", "#mixed", { textNodeIndex: 0, expectedText: "Before ", text: "After " });
    const second = await store.edit(mixed);
    expect(documentFor(second).querySelector("#mixed")!.innerHTML).toBe('After <b id="bold">bold</b> after');
    const invalid = request(second, "text", "#mixed");
    await expect(store.edit(invalid)).rejects.toMatchObject({ code: "edit_conflict" });
    await expect(store.edit({ ...invalid, patch: { ...invalid.patch, textNodeIndex: 1 } })).rejects.toMatchObject({ code: "edit_conflict" });
    await expect(store.edit(request(second, "text", "#heading", { expectedText: "stale" }))).rejects.toMatchObject({ code: "edit_conflict" });
    expect(await store.read(initial.id)).toEqual(second);
  });

  it("copies authored structure with deterministic IDs/internal references and removes only copied executable content", async () => {
    const original = '<main><article id="a" onclick="fire()"><label for="control">Label</label><input id="control" value="authored"><a href="#control">Jump</a><svg><defs><linearGradient id="paint"></linearGradient></defs><rect fill="url(#paint)" aria-labelledby="control paint outside"></rect><use href="#paint"></use></svg><script id="boot">globalThis.shouldNotRun=true</script><button onmouseover="run()">No listener</button></article><section id="right"></section></main>';
    const initial = await create(original);
    const copy = request(initial, "copy", "#a");
    const copied = await store.edit(copy);
    const document = documentFor(copied), clone = document.querySelector("#copied-0")!;
    expect(clone.parentElement!.id).toBe("right");
    expect(clone.querySelector("input")!.id).toBe("copied-1");
    expect(clone.querySelector("input")!.getAttribute("value")).toBe("authored");
    expect(clone.querySelector("label")!.getAttribute("for")).toBe("copied-1");
    expect(clone.querySelector("a")!.getAttribute("href")).toBe("#copied-1");
    expect(clone.querySelector("rect")!.getAttribute("fill")).toBe("url(#copied-2)");
    expect(clone.querySelector("rect")!.getAttribute("aria-labelledby")).toBe("copied-1 copied-2 outside");
    expect(clone.querySelector("use")!.getAttribute("href")).toBe("#copied-2");
    expect(clone.querySelector("script")).toBeNull();
    expect(clone.hasAttribute("onclick")).toBe(false);
    expect(clone.querySelector("button")!.hasAttribute("onmouseover")).toBe(false);
    expect(document.querySelector("#a")!.getAttribute("onclick")).toBe("fire()");
    expect(document.querySelector("#boot")).not.toBeNull();
    expect(globalThis).not.toHaveProperty("shouldNotRun");
    expect(copied.canvas.patches[0].html).toBe(clone.outerHTML);
    expect(await new BoardStore(root).edit(copy)).toEqual(copied);
    const collision = request(copied, "copy", "#a");
    await expect(store.edit(collision)).rejects.toMatchObject({ code: "edit_conflict" });
  });

  it("copies managed Board declarations with unique stable slots and preserves their source references across cold replay", async () => {
    const initial = await create('<main><section id="a"><paseo-board slot-id="original" host-id="remote" board-id="source"></paseo-board><paseo-board id="fallback" board-id="local"></paseo-board><paseo-board board-id="anonymous"></paseo-board></section><section id="right"></section></main>');
    const copy = request(initial, "copy", "#a");
    const copied = await store.edit(copy);
    const document = documentFor((await new BoardStore(root).read(initial.id))!);
    const cloned = Array.from(document.querySelectorAll("#right paseo-board")) as Array<{ getAttribute(name: string): string | null }>;
    expect(cloned.map(node => node.getAttribute("slot-id"))).toEqual(["copied-slot-0", "copied-slot-1", "copied-slot-2"]);
    expect(cloned.map(node => [node.getAttribute("host-id"), node.getAttribute("board-id")])).toEqual([["remote", "source"], [null, "local"], [null, "anonymous"]]);
    expect(document.querySelector('#a [slot-id="original"]')).not.toBeNull();
    expect(document.querySelector("#a #fallback")!.hasAttribute("slot-id")).toBe(false);
    expect(copied.canvas.patches[0].html).toContain('slot-id="copied-slot-2"');
    expect(await new BoardStore(root).edit(copy)).toEqual(copied);
    const next = await store.edit(request(copied, "copy", "#a", { copyIdPrefix: "second" }));
    expect((Array.from(documentFor(next).querySelectorAll("#right paseo-board")) as Array<{ getAttribute(name: string): string | null }>).map(node => node.getAttribute("slot-id")))
      .toEqual(["copied-slot-0", "copied-slot-1", "copied-slot-2", "second-slot-0", "second-slot-1", "second-slot-2"]);
  });

  it.each(["slot-id", "id"])("rejects managed copy slot collisions with existing %s without persisting an edit", async attribute => {
    const initial = await create(`<main><section id="a"><paseo-board slot-id="source-slot" board-id="source"></paseo-board></section><paseo-board ${attribute}="copied-slot-0" board-id="another"></paseo-board><section id="right"></section></main>`);
    await expect(store.edit(request(initial, "copy", "#a"))).rejects.toMatchObject({ code: "edit_conflict" });
    expect(await store.read(initial.id)).toEqual(initial);
  });

  it("permits safe anonymous authored targets without introducing IDs or a component registry", async () => {
    const initial = await create('<main><section><p>First</p><p>Second</p></section><section id="right"></section></main>');
    const moved = await store.edit(request(initial, "move", "main > section:first-child > p:nth-child(2)"));
    const node = documentFor(moved).querySelector("#right > p")!;
    expect(node.textContent).toBe("Second"); expect(node.id).toBe("");
  });

  it("refuses an anonymous selector displaced onto a structurally identical authored sibling", async () => {
    const initial = await create('<main><section><p>First</p><p>Second</p></section><section id="right"></section></main>');
    const move = request(initial, "move", "main > section:first-child > p:nth-child(2)");
    // A script inserted another same-shaped p before this node. Its current nth selector
    // still resolves, but against the static authored source it now denotes another p.
    const displaced = { ...move, patch: { ...move.patch, selector: "main > section:first-child > p:nth-child(1)" } };
    await expect(store.edit(displaced)).rejects.toMatchObject({ code: "edit_conflict" });
    expect(await store.read(initial.id)).toEqual(initial);
  });

  it("moves into the real fixture's anonymous footer while its unique output holds a live runtime marker", async () => {
    const source = '<main><article id="a">Source</article><footer class="muted">\n      <span>本页运行标记：<output id="demo-runtime-token"></output></span>\n      <span>输入、计数、标签和展开状态自动保存；不会自动发送消息。</span>\n    </footer><section id="right"></section></main>';
    const initial = await create(source);
    const live = documentFor(initial);
    live.querySelector("#demo-runtime-token")!.textContent = "native-live-marker";
    const move = request(initial, "move", "#a", { destination: "footer", destinationIdentity: componentIdentityFor(live.querySelector("footer")!) });
    const moved = await store.edit(move);
    expect(documentFor(moved).querySelector("footer > #a")!.textContent).toBe("Source");
    expect(documentFor(moved).querySelector("#demo-runtime-token")!.textContent).toBe("");
    expect(describeAuthoring((await new BoardStore(root).read(initial.id))!.canvas).replay.complete).toBe(true);
    expect(await store.edit(move)).toEqual(moved);
  });

  it("copies an anonymous source using unique descendant identity but only the authoritative authored markup", async () => {
    const initial = await create('<main><footer class="status"><span>Run: <output id="runtime">Authored</output></span><span>Keep</span></footer><section id="right"></section></main>');
    const live = documentFor(initial), output = live.querySelector("#runtime")!;
    output.textContent = "Live value must not be persisted";
    output.setAttribute("data-live", "local state");
    output.setAttribute("onmouseover", "runtimeOnly()");
    const copy = request(initial, "copy", "footer", { sourceIdentity: componentIdentityFor(live.querySelector("footer")!) });
    const copied = await store.edit(copy), clone = documentFor(copied).querySelector("#copied-0")!;
    expect(clone.querySelector("output")!.textContent).toBe("Authored");
    expect(clone.outerHTML).not.toContain("Live value");
    expect(clone.outerHTML).not.toContain("data-live");
    expect(clone.outerHTML).not.toContain("runtimeOnly");
    expect(describeAuthoring((await new BoardStore(root).read(initial.id))!.canvas).replay.complete).toBe(true);
  });

  it("keeps anonymous text, attributes, containment and ambiguous descendant IDs guarded on both edit sides", async () => {
    const initial = await create('<main><article id="a">Source</article><footer class="status"><span>Run: <output id="runtime">0</output></span><span>Keep</span></footer><section id="right"></section></main>');
    const document = documentFor(initial), footer = document.querySelector("footer")!;
    const mutate = (change: (live: typeof document) => void) => { const live = documentFor(initial); change(live); return componentIdentityFor(live.querySelector("footer")!); };
    const changed = [
      mutate(live => { live.querySelector("footer > span:last-child")!.textContent = "Another anonymous sibling"; }),
      mutate(live => { live.querySelector("footer")!.setAttribute("class", "other-parent"); }),
      mutate(live => { live.querySelector("footer > span:first-child")!.append(live.querySelector("footer > span:last-child")!); }),
      mutate(live => { live.querySelector("#runtime")!.setAttribute("role", "button"); }),
      mutate(live => { live.querySelector("#runtime")!.innerHTML = "<b>New structural child</b>"; }),
      mutate(live => { live.querySelector("footer > span:last-child")!.append(live.querySelector("#runtime")!); }),
      mutate(live => { live.querySelector("footer > span:last-child")!.innerHTML = '<output id="runtime">Duplicate</output>'; }),
    ];
    for (const identity of changed) {
      await expect(store.edit(request(initial, "move", "#a", { destination: "footer", destinationIdentity: identity }))).rejects.toMatchObject({ code: "edit_conflict", details: { componentTarget: "destination", componentSelector: "footer" } });
      await expect(store.edit(request(initial, "copy", "footer", { sourceIdentity: identity }))).rejects.toMatchObject({ code: "edit_conflict", details: { componentTarget: "source", componentSelector: "footer" } });
    }
    expect(componentIdentityFor(footer).authoredHtml).toContain("Keep");
    expect(await store.read(initial.id)).toEqual(initial);
  });

  it("refuses a changed anonymous container when its otherwise stable descendant ID is duplicated elsewhere", async () => {
    const initial = await create('<main><article id="a">Source</article><footer><output id="runtime">0</output></footer><aside><output id="runtime">Other</output></aside><section id="right"></section></main>');
    const live = documentFor(initial); live.querySelector("footer output")!.textContent = "Live";
    await expect(store.edit(request(initial, "move", "#a", { destination: "footer", destinationIdentity: componentIdentityFor(live.querySelector("footer")!) }))).rejects.toMatchObject({ code: "edit_conflict", details: { componentTarget: "destination" } });
    expect(await store.read(initial.id)).toEqual(initial);
  });

  it("compares anonymous parsed content without mistaking entity spelling or attribute order for a different component", async () => {
    const initial = await create('<main><p title="A &amp; B" class="copy">A &amp; B</p><section id="right"></section></main>');
    const edit = request(initial, "text", "p", { text: "Edited" });
    edit.patch.sourceIdentity!.authoredHtml = '<p class="copy" title="A &#38; B">A &#38; B</p>';
    expect(documentFor(await store.edit(edit)).querySelector("p")!.textContent).toBe("Edited");
  });

  it("includes actual containment in structural identity rather than only preorder tags", async () => {
    const document = new DOMParser().parseFromString('<main><section id="one"><div><i></i></div><b></b></section><section id="two"><div><i></i><b></b></div></section></main>', "text/html");
    const one = document.querySelector("#one")!, two = document.querySelector("#two")!;
    one.id = "same"; two.id = "same";
    expect(componentIdentityFor(one).fingerprint).not.toBe(componentIdentityFor(two).fingerprint);
  });

  it("matches browser SVG adjusted names and replays authoritative lowercase copied markup", async () => {
    const initial = await create('<main><svg><g id="svg-component"><foreignObject id="foreign" width="100" height="30"><div id="html-content">HTML in SVG</div></foreignObject><defs><linearGradient id="gradient"></linearGradient></defs><rect fill="url(#gradient)"></rect></g></svg><svg id="right"></svg></main>');
    const document = documentFor(initial), source = document.querySelector("#svg-component")!;
    expect(document.querySelector("#foreign")!.localName).toBe("foreignobject");
    const browserSource = browserSvgNames(source);
    expect(Array.from(browserSource.querySelectorAll("*")).map(node => node.localName)).toContain("foreignObject");
    expect(Array.from(browserSource.querySelectorAll("*")).map(node => node.localName)).toContain("linearGradient");
    expect(componentIdentityFor(browserSource)).toEqual(componentIdentityFor(source));
    expect(componentIdentityFor(browserSvgNames(document.querySelector("#foreign")!)).tag).toBe("foreignobject");
    const copy = request(initial, "copy", "#svg-component", { sourceIdentity: componentIdentityFor(browserSource) });
    const copied = await store.edit(copy);
    expect(copied.canvas.patches[0].html).toContain("<foreignobject");
    expect(copied.canvas.patches[0].html).toContain("<lineargradient");
    const restored = (await new BoardStore(root).read(initial.id))!;
    const clone = documentFor(restored).querySelector("#copied-0")!;
    expect(componentIdentityFor(browserSvgNames(clone))).toEqual(componentIdentityFor(clone));
    expect(clone.querySelector("div")!.textContent).toBe("HTML in SVG");
  });

  it("replays a copy followed by a cloned text edit and move across a cold store read", async () => {
    const initial = await create();
    const copied = await store.edit(request(initial, "copy", "#a"));
    // Source root is copied-0, the first existing descendant ID (heading) is copied-1.
    const edited = await store.edit(request(copied, "text", "#copied-1", { text: "Only the copy changed" }));
    const destination = documentFor(edited).querySelector("#left")!;
    const moved = await store.edit(request(edited, "move", "#copied-0", { destination: "#left", destinationIdentity: componentIdentityFor(destination), position: "prepend" }));
    const restored = (await new BoardStore(root).read(initial.id))!;
    expect(restored).toEqual(moved);
    const document = documentFor(restored);
    expect(document.querySelector("#copied-0")!.parentElement!.id).toBe("left");
    expect(document.querySelector("#copied-1")!.textContent).toBe("Only the copy changed");
    expect(document.querySelector("#heading")!.textContent).toBe("Original");
    expect(document.querySelectorAll("#copied-0").length).toBe(1);
  });

  it("requires identity, explicit source revision and bounded plain text without caller HTML", async () => {
    const initial = await create();
    const text = request(initial, "text", "#heading");
    for (const input of [
      { ...text, canvasBase: undefined },
      { ...text, patch: { ...text.patch, sourceIdentity: undefined } },
      { ...text, patch: { ...text.patch, text: "x".repeat(24001) } },
      { ...text, patch: { ...text.patch, html: "<script>run()</script>" } },
      { ...text, patch: { ...text.patch, operation: "remove" } },
    ]) expect(EditInputSchema.safeParse(input).success).toBe(false);
    expect(await store.read(initial.id)).toEqual(initial);
  });

  it("materializes the same semantic copy through agent publish and response patches", async () => {
    const initial = await create();
    const copy = request(initial, "copy", "#a");
    const published = await store.publish({ boardId: initial.id, canvasBase: base(initial), expectedRevision: initial.revision, eventId: "agent-copy", patch: copy.patch }, "owner");
    expect(published.canvas.patches[0].html).toContain('id="copied-0"');
    await store.addInteraction({ boardId: initial.id, intentId: "question", kind: "question", text: "Explain" }, "owner");
    await store.respond({ boardId: initial.id, interactionId: "question", eventId: "response", expectedResponseRevision: 0, response: "Figure", html }, "owner");
    const response = await store.respond({ boardId: initial.id, interactionId: "question", eventId: "response-copy", expectedResponseRevision: 1, response: "Figure copied", patch: copy.patch }, "owner");
    expect(response.responseCanvas!.patches[0].html).toBe(published.canvas.patches[0].html);
    expect(describeAuthoring(response.responseCanvas!).replay.complete).toBe(true);
  });
});
