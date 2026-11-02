import { describe, expect, it } from "vitest";
import { DOMParser } from "linkedom";
import { createComponentLayoutTools, type ComponentLayout, type LayoutElement } from "./component-layout";

const tools = createComponentLayoutTools();
function fixture(html = '<main><section id="target" style="color: red; max-height: 500px"><p>Before</p><h3 id="title">Title</h3>between<input id="input" value="original"><button id="button">Run</button><p id="counter">1</p></section></main>') {
  const document = new DOMParser().parseFromString(`<html><head></head><body>${html}</body></html>`, "text/html");
  return { document, target: document.querySelector("#target")! as unknown as LayoutElement };
}
describe("shared reversible component layouts", () => {
  it("serializes as a standalone factory with no module or host dependencies", () => {
    const standalone = new Function(`return (${createComponentLayoutTools.toString()})`)() as typeof createComponentLayoutTools;
    const { target } = fixture();
    standalone().apply(target, { collapse: "contents", maxHeight: 160 }, "standalone");
    expect(standalone().inspect(target)).toEqual({ collapse: "contents", maxHeight: 160 });
  });
  it("moves the same heading and content nodes, composes limits, and restores exact node order without resetting controls", () => {
    const { target, document } = fixture(), originalNodes = Array.from(target.childNodes);
    const heading = document.querySelector("#title")!, input = document.querySelector("#input")!, counter = document.querySelector("#counter")!;
    const folded = tools.apply(target, { collapse: "contents", maxHeight: 200 }, "layout-1");
    expect(folded.details?.getAttribute("id")).toBe("paseo-layout-layout-1");
    expect(heading.parentElement!.localName).toBe("summary");
    expect(folded.body.style.getPropertyValue("max-height")).toBe("200px");
    input.setAttribute("value", "typed later"); counter.textContent = "9";
    const unlimited = tools.apply(target, { collapse: "contents", maxHeight: null }, "layout-2");
    expect(unlimited.key).toBe("layout-1");
    expect(unlimited.body.style.getPropertyValue("max-height") || "").toBe("");
    tools.apply(target, { collapse: "none", maxHeight: null }, "layout-3");
    expect(Array.from(target.childNodes)).toEqual(originalNodes);
    expect(document.querySelector("#title")).toBe(heading); expect(document.querySelector("#input")).toBe(input);
    expect(input.getAttribute("value")).toBe("typed later"); expect(counter.textContent).toBe("9");
    expect(tools.inspect(target)).toEqual({ collapse: "none", maxHeight: null });
  });

  it("preserves original external placement and only restores properties it still owns", () => {
    const { target, document } = fixture();
    const before = target.parentNode!, next = target.nextSibling;
    const config: ComponentLayout = { collapse: "group", title: "Logs", maxHeight: 320, placement: { "grid-column": "2 / span 2", order: "3", width: "420px", "margin-left": "9px" } };
    const result = tools.apply(target, config, "wrapper");
    expect(result.details!.parentNode).toBe(before); expect(result.details!.nextSibling).toBe(next);
    expect(result.details!.style.getPropertyValue("grid-column")).toBe("2 / span 2");
    expect(target.parentNode).toBe(result.body);
    target.style.setProperty("color", "blue"); target.style.setProperty("width", "75%");
    tools.apply(target, { collapse: "none", maxHeight: null }, "restore");
    expect(target.parentNode).toBe(before); expect(target.style.getPropertyValue("color")).toBe("blue");
    expect(target.style.getPropertyValue("width")).toBe("75%");
    expect(target.style.getPropertyValue("max-height")).toBe("500px");
    expect(document.querySelector("details")).toBeNull();
  });

  it("restores scroll properties and an absent original style attribute", () => {
    const { target } = fixture('<main><div id="target">Log</div></main>');
    tools.apply(target, { collapse: "none", maxHeight: 160 }, "scroll");
    expect(target.style.getPropertyValue("overflow-y")).toBe("auto !important");
    tools.apply(target, { collapse: "none", maxHeight: null }, "reset");
    expect(target.getAttribute("style")).toBeNull();
  });

  it("manages fixed height and minimum height while folding, then restores them", () => {
    const { target } = fixture('<main><div id="target" style="height:360px;min-height:320px;color:red"><h3>Logs</h3><p>Long</p></div></main>');
    tools.apply(target, { collapse: "contents", maxHeight: null }, "height");
    expect(target.style.getPropertyValue("height")).toBe("auto !important");
    expect(target.style.getPropertyValue("min-height")).toBe("0px !important");
    tools.apply(target, { collapse: "none", maxHeight: null }, "restore");
    expect(target.style.getPropertyValue("height")).toBe("360px");
    expect(target.style.getPropertyValue("min-height")).toBe("320px");
    expect(target.style.getPropertyValue("color")).toBe("red");
  });

  it("retains the measured outer flex bases for content-box and border-box shells", () => {
    const { target } = fixture();
    const capture = (box: string, basis: string) => {
      const values: Record<string, string> = { position: "static", display: "block", "box-sizing": box, width: "500px", "min-width": "0px", "max-width": "none", "flex-basis": basis, "flex-grow": "2", "flex-shrink": "1", "padding-left": "13px", "padding-right": "13px", "border-left-width": "1px", "border-right-width": "1px" };
      const view = new Proxy(target, { get(node, key) {
        if (key === "ownerDocument") return { defaultView: { getComputedStyle: () => ({ getPropertyValue: (name: string) => values[name] ?? "" }) } };
        const value = Reflect.get(node, key); return typeof value === "function" ? value.bind(node) : value;
      } });
      return tools.capture(view, { collapse: "group", maxHeight: null }).placement!;
    };
    expect(capture("content-box", "0px")).toMatchObject({ "flex-basis": "28px", "flex-grow": "2", "flex-shrink": "1", "min-width": "0px" });
    expect(capture("content-box", "0%")["flex-basis"]).toBe("calc(0% + 28px)");
    expect(capture("content-box", "25%")["flex-basis"]).toBe("calc(25% + 28px)");
    expect(capture("border-box", "0px")["flex-basis"]).toBe("28px");
    expect(capture("border-box", "20px")["flex-basis"]).toBe("28px");
    expect(capture("border-box", "80px")["flex-basis"]).toBe("80px");
    expect(capture("border-box", "0%")["flex-basis"]).toBe("max(0%, 28px)");
    expect(capture("border-box", "25%")["flex-basis"]).toBe("max(25%, 28px)");
  });

  it("accepts a generated text title but refuses interactive original headings before mutating", () => {
    const { target } = fixture('<main><div id="target"><p>Log</p></div></main>');
    tools.apply(target, { collapse: "contents", maxHeight: null, title: "日志" }, "title");
    expect(target.querySelector("summary")!.textContent).toBe("日志");
    const interactive = fixture('<main><div id="target"><h3><button>Danger</button></h3><p>Log</p></div></main>').target;
    const before = Array.from(interactive.childNodes);
    expect(() => tools.apply(interactive, { collapse: "contents", maxHeight: null }, "bad")).toThrow("交互控件");
    expect(Array.from(interactive.childNodes)).toEqual(before);
  });

  it("refuses forged restoration metadata, extra shell content and unsupported targets", () => {
    const { target } = fixture();
    tools.apply(target, { collapse: "group", maxHeight: null }, "group");
    const metadata = JSON.parse(target.getAttribute("data-paseo-layout")!);
    metadata.properties.background = { value: "red", priority: "", applied: "red" };
    const original = target.getAttribute("data-paseo-layout")!;
    target.setAttribute("data-paseo-layout", JSON.stringify(metadata));
    expect(() => tools.inspect(target)).toThrow("记录无效");
    target.setAttribute("data-paseo-layout", original);
    const wrongOperation = JSON.parse(original); wrongOperation.properties.width.applied = "80%";
    target.setAttribute("data-paseo-layout", JSON.stringify(wrongOperation));
    expect(() => tools.inspect(target)).toThrow("实际操作不一致");
    target.setAttribute("data-paseo-layout", original);
    target.parentNode!.appendChild(target.ownerDocument.createElement("p"));
    expect(() => tools.apply(target, { collapse: "none", maxHeight: null }, "restore")).toThrow("额外内容");
    for (const tag of ["input", "table", "svg", "ul", "details"]) {
      const node = fixture(`<main><${tag} id="target"></${tag}></main>`).target;
      expect(() => tools.apply(node, { collapse: "group", maxHeight: null }, "bad")).toThrow("普通 HTML");
    }
  });

  it("limits configuration to finite values, known properties and nonexecutable metadata", () => {
    const valid = { collapse: "group", maxHeight: 200, title: "Group", placement: { "grid-column": "2 / span 2" } };
    expect(tools.validate(valid)).toBe(true);
    for (const config of [
      { ...valid, html: "<script>run()</script>" }, { ...valid, maxHeight: 79 }, { ...valid, maxHeight: 2001 }, { ...valid, maxHeight: NaN },
      { ...valid, title: "" }, { ...valid, title: "   " },
      { ...valid, placement: { position: "fixed" } }, { ...valid, placement: { width: "1px; color:red" } },
      { ...valid, placement: { width: "url(https://example.com)" } }, { ...valid, flow: { display: "contents" } },
    ]) expect(tools.validate(config)).toBe(false);
  });

  it("guards managed transfer slots while keeping complete containers and editable content movable", () => {
    const { document, target } = fixture('<main><section id="target"><h3 id="title">Title</h3><p id="content">Text</p></section><section id="outside"><p id="extra">Extra</p></section></main>');
    const node = (selector: string) => document.querySelector(selector)! as unknown as LayoutElement;
    const outside = node("#outside"), extra = node("#extra");
    const folded = tools.apply(target, { collapse: "contents", maxHeight: null }, "slots");
    const summary = folded.details!.querySelector("summary")!;
    for (const source of [folded.details!, summary, folded.body, node("#title")]) expect(tools.transferFailure("move", source, outside)).toContain("不能单独移动");
    for (const [destination, position] of [[target, "append"], [folded.details!, "prepend"], [summary, "append"], [node("#title"), "before"], [folded.body, "after"]] as const) expect(tools.transferFailure("move", extra, destination, position)).toContain("固定结构");
    expect(tools.transferFailure("move", node("#content"), outside)).toBeNull();
    expect(tools.transferFailure("move", extra, folded.body)).toBeNull();
    expect(tools.transferFailure("move", target, outside)).toBeNull();
    const grouped = tools.apply(target, { collapse: "group", maxHeight: null }, "group-slots");
    expect(tools.transferFailure("move", grouped.details!, outside)).toBeNull();
    expect(tools.transferFailure("move", target, outside)).toContain("不能单独移动");
    expect(tools.transferFailure("move", extra, grouped.body)).toContain("固定结构");
    expect(tools.transferFailure("copy", grouped.details!, outside)).toContain("先恢复组件布局");
    grouped.details!.setAttribute("data-paseo-layout-key", "forged");
    expect(tools.transferFailure("move", grouped.details!, outside)).not.toBeNull();
  });
});
