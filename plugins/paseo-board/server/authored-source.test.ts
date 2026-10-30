import { describe, expect, it } from "vitest";
import { describeAuthoring, type AuthoringCanvas } from "./authored-source";

const canvas = (html: string, patches: AuthoringCanvas["patches"] = []): AuthoringCanvas => ({ revision: 7, documentVersion: 2, html, patches });
const patch = (id: string, selector: string, operation: AuthoringCanvas["patches"][number]["operation"], html = "") => ({ id, selector, operation, html });

describe("describeAuthoring", () => {
  it("returns the updated child in a selected parent without changing base HTML or the journal", () => {
    const input = canvas('<section id="parent"><p id="child">Old</p><input value="keep"></section>', [patch("child", "#child", "replace", '<p id="child">New child</p>')]);
    const before = structuredClone(input);
    const result = describeAuthoring(input, "#parent");
    expect(result).toMatchObject({ canvasBase: { revision: 7, documentVersion: 2 }, replay: { complete: true, appliedPatchIds: ["child"] }, target: { selector: "#parent" } });
    expect(result.target!.html).toContain("New child");
    expect(result.target!.html).toContain('<input value="keep">');
    expect(result.target!.html).not.toContain(">Old<");
    expect(result.materializedAuthoredHtml).toBe(result.target!.html);
    expect(input).toEqual(before);
  });

  it("replays append, prepend, replace and remove in journal order including newly created targets", () => {
    const result = describeAuthoring(canvas('<div id="a"><i id="remove">Remove</i></div>', [
      patch("append", "#a", "append", '<span id="new">Second</span>'),
      patch("prepend", "#a", "prepend", '<b id="first">First</b>'),
      patch("replace", "#new", "replace", '<em id="new">Updated second</em>'),
      patch("remove", "#remove", "remove"),
    ]));
    expect(result.replay).toEqual({ complete: true, appliedPatchIds: ["append", "prepend", "replace", "remove"] });
    expect(result.materializedAuthoredHtml).toBe('<div id="a"><b id="first">First</b><em id="new">Updated second</em></div>');
  });

  it("stops when an earlier removal makes a later target unavailable, without exposing partial or old source", () => {
    const result = describeAuthoring(canvas('<div id="a"><p id="child">Old</p></div><div id="b"></div>', [
      patch("remove-parent", "#a", "remove"),
      patch("missing-child", "#child", "append", "New"),
      patch("later", "#b", "append", "Must not replay"),
    ]), "#b");
    expect(result.materializedAuthoredHtml).toBeNull();
    expect(result.target).toBeUndefined();
    expect(result.replay).toMatchObject({ complete: false, appliedPatchIds: ["remove-parent"], failedPatch: { id: "missing-child", selector: "#child", reason: expect.stringContaining("matched 0") } });
  });

  it.each([
    ["#missing", "matched 0"],
    [".duplicate", "matched 2"],
    ["[", ""],
  ])("rejects a non-unique or invalid patch selector %s", (selector, reason) => {
    const result = describeAuthoring(canvas('<i class="duplicate"></i><i class="duplicate"></i>', [patch("bad", selector, "append", "New")]));
    expect(result.materializedAuthoredHtml).toBeNull();
    expect(result.replay).toMatchObject({ complete: false, appliedPatchIds: [], failedPatch: { id: "bad", selector, reason: expect.stringContaining(reason) } });
  });

  it("preserves script/style contents and external resource references without executing code", () => {
    const script = 'globalThis.__boardAuthoringExecuted = true; throw new Error("must never run"); if (1 < 2) console.log("<p>raw</p>");';
    const styles = '.panel > p { color: red; } .panel::after { content: "<raw>"; }';
    const html = `<style>${styles}</style><div id="a"></div><script>${script}</script><script src="https://example.invalid/no.js"></script><img src="https://example.invalid/no.png" onload="globalThis.__boardAuthoringExecuted = true">`;
    const result = describeAuthoring(canvas(html, [patch("script", "#a", "append", `<script>${script}</script><style>${styles}</style>`)]));
    expect(result.replay.complete).toBe(true);
    expect(result.materializedAuthoredHtml).toContain(`<script>${script}</script>`);
    expect(result.materializedAuthoredHtml).toContain(`<style>${styles}</style>`);
    expect(result.materializedAuthoredHtml).toContain('src="https://example.invalid/no.js"');
    expect(globalThis).not.toHaveProperty("__boardAuthoringExecuted");
    expect(result.note).toContain("not the running browser DOM");
  });

  it("does not invent an element that scripts would generate", () => {
    const result = describeAuthoring(canvas('<div id="a"></div><script>document.querySelector("#a").innerHTML = \'<p id="dynamic">Generated</p>\';</script>', [patch("dynamic", "#dynamic", "append", "New")]));
    expect(result.materializedAuthoredHtml).toBeNull();
    expect(result.replay.failedPatch).toMatchObject({ id: "dynamic", selector: "#dynamic", reason: expect.stringContaining("matched 0") });
  });

  it("supports complete documents and selects updated head or body fragments", () => {
    const input = canvas('<!doctype html><html lang="en"><head><style id="palette">body {color: black}</style></head><body><h1 id="title">Title</h1></body></html>', [patch("palette", "#palette", "replace", '<style id="palette">body {color: blue}</style>')]);
    const result = describeAuthoring(input, "head");
    expect(result.replay.complete).toBe(true);
    expect(result.materializedAuthoredHtml).toContain('<html lang="en">');
    expect(result.materializedAuthoredHtml).toMatch(/^<!doctype html>/i);
    expect(result.target!.html).toBe('<head><style id="palette">body {color: blue}</style></head>');
    expect(describeAuthoring(input, "body").target!.html).toBe('<body><h1 id="title">Title</h1></body>');
  });

  it("preserves multi-root fragments, leading text, comments, SVG and table content", () => {
    const input = canvas('Lead<!-- keep --><svg viewBox="0 0 10 10"><circle id="dot" r="2"></circle></svg><table><tbody id="rows"><tr><td>A</td></tr></tbody></table>', [patch("row", "#rows", "append", '<tr><td>B</td></tr>')]);
    const result = describeAuthoring(input, "#rows");
    expect(result.replay.complete).toBe(true);
    expect(result.materializedAuthoredHtml).toMatch(/^Lead<!-- keep --><svg/);
    expect(result.materializedAuthoredHtml).not.toContain("<html");
    expect(result.materializedAuthoredHtml).toContain('viewBox="0 0 10 10"');
    expect(result.target!.html).toBe('<tbody id="rows"><tr><td>A</td></tr><tr><td>B</td></tr></tbody>');
  });

  it.each(["html", "head", "body"])("keeps the runtime's explicit document-root replacement boundary for %s", (selector) => {
    const result = describeAuthoring(canvas('<html><head></head><body></body></html>', [patch("root", selector, "replace", "new")]));
    expect(result.materializedAuthoredHtml).toBeNull();
    expect(result.replay.failedPatch?.reason).toContain("new document version");
  });

  it("allows replacing a fragment's top-level element and skips duplicate patch IDs like the runtime", () => {
    const one = patch("one", "#a", "replace", '<article id="a">New</article>');
    const result = describeAuthoring(canvas('<main id="a">Old</main>', [one, one]));
    expect(result.materializedAuthoredHtml).toBe('<article id="a">New</article>');
    expect(result.replay.appliedPatchIds).toEqual(["one"]);
  });

  it.each(["#missing", "i", "["])("does not return a misleading target/source for an unavailable requested selector %s", (selector) => {
    const result = describeAuthoring(canvas('<i>A</i><i>B</i>'), selector);
    expect(result.materializedAuthoredHtml).toBeNull();
    expect(result.target).toBeUndefined();
    expect(result.replay.complete).toBe(false);
    expect(result.replay.failedPatch).toBeUndefined();
    expect(result.note).toContain("Requested authored target is unavailable");
  });

  it("resolves a fragment in body context without treating its first element as the document root", () => {
    const input = canvas('<main id="parent"><p id="child">Old</p></main>', [patch("body-context", "body > #parent > #child", "replace", '<p id="child">New</p>')]);
    expect(describeAuthoring(input, "body > #parent").target?.html).toContain(">New<");
    expect(describeAuthoring(input, ":root").materializedAuthoredHtml).toBeNull();
    expect(describeAuthoring(canvas('<main id="parent">Keep</main>', [patch("root", ":root", "replace", "Wrong")])).replay.failedPatch?.reason).toContain("host document wrapper");
  });

  it("does not select inert template or scripting-disabled noscript children as live targets", () => {
    for (const tag of ["template", "noscript"]) {
      const result = describeAuthoring(canvas(`<${tag}><p id="inactive">Hidden</p></${tag}>`, [patch("inactive", "#inactive", "replace", "Wrong")]));
      expect(result.materializedAuthoredHtml).toBeNull();
      expect(result.replay.complete).toBe(false);
    }
  });

  it("handles an empty fragment without manufacturing editable host elements", () => {
    expect(describeAuthoring(canvas(""))).toMatchObject({ materializedAuthoredHtml: "", replay: { complete: true, appliedPatchIds: [] } });
    expect(describeAuthoring(canvas(""), "body").materializedAuthoredHtml).toBeNull();
  });
});
