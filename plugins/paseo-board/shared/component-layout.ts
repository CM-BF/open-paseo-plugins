/** A bounded layout intent, never caller-authored HTML or unrestricted CSS. */
export interface ComponentLayout {
  collapse: "none" | "contents" | "group";
  maxHeight: number | null;
  title?: string;
  placement?: Record<string, string>;
  flow?: Record<string, string>;
}

// Structural DOM types keep this factory usable by both linkedom and the browser.
interface LayoutStyle {
  getPropertyValue(name: string): string;
  getPropertyPriority?(name: string): string;
  setProperty(name: string, value: string, priority?: string): void;
  removeProperty(name: string): unknown;
}
export interface LayoutNode {
  nodeType: number; textContent: string | null; parentNode: LayoutElement | null;
  nextSibling: LayoutNode | null;
}
export interface LayoutElement extends LayoutNode {
  localName: string; namespaceURI: string | null; parentElement: LayoutElement | null;
  ownerDocument: { createElement(tag: string): LayoutElement; createComment(text: string): LayoutNode; querySelectorAll(selector: string): ArrayLike<LayoutElement>; defaultView?: { getComputedStyle?(target: LayoutElement): LayoutStyle } | null };
  children: ArrayLike<LayoutElement>; childNodes: ArrayLike<LayoutNode>; style: LayoutStyle;
  getAttribute(name: string): string | null; setAttribute(name: string, value: string): void; removeAttribute(name: string): void;
  insertBefore(node: LayoutNode, before: LayoutNode | null): unknown;
  appendChild(node: LayoutNode): unknown; removeChild(node: LayoutNode): unknown;
  querySelector(selector: string): LayoutElement | null; querySelectorAll(selector: string): ArrayLike<LayoutElement>;
}
type SavedProperty = { value: string; priority: string; applied: string };
type LayoutMetadata = { version: 1; key: string; config: ComponentLayout; properties: Record<string, SavedProperty>; hadStyle: boolean; heading: boolean };

/** Self-contained: the exact function is injected into live and standalone documents. */
export function createComponentLayoutTools() {
  const attr = "data-paseo-layout", partAttr = "data-paseo-layout-part", keyAttr = "data-paseo-layout-key";
  const placement = ["grid-column", "grid-row", "order", "flex-grow", "flex-shrink", "flex-basis", "align-self", "justify-self", "width", "min-width", "max-width", "margin-top", "margin-right", "margin-bottom", "margin-left"];
  const flow = ["display", "flex-direction", "flex-wrap", "align-items", "justify-content", "align-content", "grid-template-columns", "grid-template-rows", "grid-auto-columns", "grid-auto-rows", "grid-auto-flow", "column-gap", "row-gap"];
  const changed = [...placement, "height", "min-height", "max-height", "overflow-x", "overflow-y", "box-sizing"];
  const declarations = (raw: string) => {
    const entries: string[] = []; let start = 0, quote = "", depth = 0, comment = false;
    for (let index = 0; index < raw.length; index++) {
      const char = raw[index], next = raw[index + 1];
      if (comment) { if (char === "*" && next === "/") { comment = false; index++; } continue; }
      if (quote) { if (char === "\\") index++; else if (char === quote) quote = ""; continue; }
      if (char === "/" && next === "*") { comment = true; index++; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth++;
      else if (char === ")") depth = Math.max(0, depth - 1);
      else if (char === ";" && depth === 0) { entries.push(raw.slice(start, index)); start = index + 1; }
    }
    entries.push(raw.slice(start));
    return entries.map(raw => {
      const match = /^(?:\s|\/\*[\s\S]*?\*\/)*([-a-z]+)\s*:/i.exec(raw);
      const text = match ? raw.slice(match[0].length).trim() : "", important = /\s*!important\s*$/i.test(text);
      return { raw, name: match?.[1].toLowerCase() ?? "", value: important ? text.replace(/\s*!important\s*$/i, "").trim() : text, priority: important ? "important" : "" };
    });
  };
  const readStyle = (target: LayoutElement, name: string) => {
    const entries = declarations(target.getAttribute("style") ?? "").filter(entry => entry.name === name);
    if (entries.length > 1) throw new Error("容器含有重复内联布局声明，请由作者整理后再修改。");
    return entries[0] ?? { value: "", priority: "" };
  };
  const writeStyle = (target: LayoutElement, name: string, value: string, priority = "") => {
    // Edit only the selected declaration. Native and server CSSOM serializers differ;
    // preserving other declaration bytes also keeps anonymous authored identities stable.
    const entries = declarations(target.getAttribute("style") ?? ""), index = entries.findIndex(entry => entry.name === name);
    const declaration = `${name}:${value}${priority ? " !important" : ""}`;
    if (index >= 0) entries[index].raw = declaration; else entries.push({ raw: declaration, name, value, priority });
    target.setAttribute("style", entries.map(entry => entry.raw).filter(Boolean).join(";"));
  };
  const removeStyle = (target: LayoutElement, name: string) => target.setAttribute("style", declarations(target.getAttribute("style") ?? "").filter(entry => entry.name !== name).map(entry => entry.raw).filter(Boolean).join(";"));
  const containers = ["div", "section", "article", "main", "aside", "header", "footer", "nav", "pre"];
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const safeValue = (value: unknown, max = 240): value is string => typeof value === "string" && value.length <= max && !/[;{}<>\u0000-\u001f]/.test(value) && !/url\s*\(|expression\s*\(/i.test(value);
  const styles = (value: unknown, keys: string[]) => value === undefined || object(value) && Object.keys(value).length <= keys.length && Object.entries(value).every(([key, entry]) => keys.includes(key) && safeValue(entry));
  const validate = (value: unknown): value is ComponentLayout => object(value)
    && Object.keys(value).every(key => ["collapse", "maxHeight", "title", "placement", "flow"].includes(key))
    && ["none", "contents", "group"].includes(value.collapse as string)
    && (value.maxHeight === null || Number.isInteger(value.maxHeight) && Number(value.maxHeight) >= 80 && Number(value.maxHeight) <= 2000)
    && (value.title === undefined || typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 120)
    && styles(value.placement, placement) && styles(value.flow, flow)
    && (value.placement === undefined || value.collapse === "group") && (value.flow === undefined || value.collapse === "contents")
    && (value.flow === undefined || ["block", "flex", "grid", "inline-flex", "inline-grid", "flow-root"].includes(String((value.flow as Record<string, string>).display)));
  const read = (target: LayoutElement): LayoutMetadata | null => {
    const raw = target.getAttribute(attr);
    if (raw === null) return null;
    let value: unknown;
    try { if (raw.length > 24000) throw new Error(); value = JSON.parse(raw); } catch { throw new Error("布局记录无效，请重新选择原始容器。"); }
    if (!object(value) || Object.keys(value).some(key => !["version", "key", "config", "properties", "hadStyle", "heading"].includes(key))
      || value.version !== 1 || typeof value.key !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value.key) || !validate(value.config)
      || !object(value.properties) || Object.keys(value.properties).length > changed.length || typeof value.hadStyle !== "boolean" || typeof value.heading !== "boolean"
      || !Object.entries(value.properties).every(([key, property]) => changed.includes(key) && object(property) && Object.keys(property).every(name => ["value", "priority", "applied"].includes(name))
        && safeValue(property.value, 2000) && safeValue(property.applied, 2000) && ["", "important"].includes(String(property.priority)))) throw new Error("布局记录无效，请重新选择原始容器。");
    const metadata = value as unknown as LayoutMetadata;
    const expectedProperties: Record<string, string> = metadata.config.collapse === "group"
      ? { "margin-top": "0px", "margin-right": "0px", "margin-bottom": "0px", "margin-left": "0px", width: "100%", "min-width": "0px", "max-width": "none", "box-sizing": "border-box" }
      : metadata.config.collapse === "contents" ? { height: "auto", "min-height": "0px" }
        : metadata.config.collapse === "none" && metadata.config.maxHeight !== null
          ? { "min-height": "0px", "max-height": `${metadata.config.maxHeight}px`, "overflow-x": "auto", "overflow-y": "auto" } : {};
    if (metadata.config.collapse === "none" && metadata.config.maxHeight === null || metadata.heading && metadata.config.collapse !== "contents"
      || Object.keys(metadata.properties).length !== Object.keys(expectedProperties).length
      || Object.entries(metadata.properties).some(([name, saved]) => saved.applied !== expectedProperties[name])) throw new Error("布局恢复记录与实际操作不一致。");
    return metadata;
  };
  const part = (node: LayoutElement, name: string, key: string) => node.getAttribute(partAttr) === name && node.getAttribute(keyAttr) === key;
  const structure = (target: LayoutElement, meta: LayoutMetadata) => {
    if (meta.config.collapse === "none") return { details: null, summary: null, body: target };
    const details = meta.config.collapse === "group" ? target.parentElement?.parentElement : Array.from(target.children)[0];
    if (!details || details.localName !== "details" || details.getAttribute("id") !== `paseo-layout-${meta.key}` || !part(details, meta.config.collapse === "group" ? "group" : "details", meta.key)) throw new Error("折叠容器结构已变化，请重新选择。");
    const children = Array.from(details.children), summary = children[0], body = children[1];
    if (children.length !== 2 || details.childNodes.length !== 2 || details.childNodes[0] !== summary || details.childNodes[1] !== body || !summary || summary.localName !== "summary" || !part(summary, "summary", meta.key)
      || !body || body.localName !== "div" || !part(body, "body", meta.key)) throw new Error("折叠容器结构已变化，请重新选择。");
    if (meta.config.collapse === "group" ? body.childNodes.length !== 1 || body.childNodes[0] !== target : target.childNodes.length !== 1 || target.childNodes[0] !== details) throw new Error("折叠容器含有额外内容，不能自动恢复。");
    if (meta.heading) {
      if (summary.childNodes.length !== 1 || !/^h[1-6]$/.test(summary.children[0]?.localName ?? "")
        || Array.from(body.childNodes).filter(node => node.nodeType === 8 && node.textContent === `paseo-layout-heading:${meta.key}`).length !== 1) throw new Error("原始标题位置已变化，不能自动恢复。");
    } else if (summary.children.length) throw new Error("折叠标题已包含额外内容，不能自动恢复。");
    return { details, summary, body };
  };
  const inspect = (target: LayoutElement): ComponentLayout => {
    const meta = read(target); if (meta) structure(target, meta);
    return meta ? JSON.parse(JSON.stringify(meta.config)) as ComponentLayout : { collapse: "none", maxHeight: null };
  };
  /** A transfer must preserve managed slots before either a preview or a live mutation. */
  const transferFailure = (operation: "move" | "copy", source: LayoutElement, destination: LayoutElement | null = null, position: "before" | "after" | "append" | "prepend" = "append"): string | null => {
    try {
      if (!["move", "copy"].includes(operation) || !["before", "after", "append", "prepend"].includes(position)) return "组件移动选项无效。";
      const owners = new Set<LayoutElement>();
      const consider = (node: LayoutElement) => {
        if (node.getAttribute(attr) !== null) owners.add(node);
        if (node.getAttribute(partAttr) === null) return;
        let details: LayoutElement | null = node;
        while (details && !(details.localName === "details" && ["group", "details"].includes(details.getAttribute(partAttr) ?? ""))) details = details.parentElement;
        if (!details) throw new Error("布局部件缺少完整外层结构，不能移动或复制。");
        const owner = details.getAttribute(partAttr) === "group" ? details.children[1]?.children[0] : details.parentElement;
        if (!owner || owner.getAttribute(attr) === null) throw new Error("布局部件缺少有效恢复记录，不能移动或复制。");
        const metadata = read(owner)!;
        const managed = structure(owner, metadata);
        if (managed.details !== details || ![managed.details, managed.summary, managed.body].includes(node)) throw new Error("布局部件与恢复记录不一致，不能移动或复制。");
        owners.add(owner);
      };
      for (const start of [source, destination]) for (let node = start; node; node = node.parentElement) consider(node);
      for (const node of Array.from(source.querySelectorAll(`[${attr}],[${partAttr}]`))) consider(node);
      const layouts = Array.from(owners, owner => {
        const metadata = read(owner)!;
        return { owner, metadata, ...structure(owner, metadata) };
      });
      if (operation === "copy" && (source.getAttribute(attr) !== null || source.getAttribute(partAttr) !== null || source.querySelector(`[${attr}],[${partAttr}]`))) return "请先恢复组件布局，再复制结构；折叠和滚动容器暂不支持直接复制。";
      if (operation === "move") for (const layout of layouts) {
        if (source === layout.summary || source === layout.body && layout.details !== null
          || source === layout.details && layout.metadata.config.collapse === "contents"
          || source === layout.owner && layout.metadata.config.collapse === "group"
          || layout.metadata.heading && source === layout.summary?.children[0]) return "不能单独移动布局部件或原始标题；请选择完整容器或先恢复原布局。";
      }
      if (destination) {
        const parent = position === "before" || position === "after" ? destination.parentElement : destination;
        for (const layout of layouts) if (parent === layout.details || parent === layout.summary
          || parent === layout.body && layout.metadata.config.collapse === "group"
          || parent === layout.owner && layout.metadata.config.collapse === "contents") return "此位置属于折叠容器的固定结构；请选择内容区域或普通容器。";
      }
      return null;
    } catch (error) { return error instanceof Error ? error.message : "布局结构已变化，不能移动或复制。"; }
  };
  const supported = (target: LayoutElement) => {
    if (target.namespaceURI !== "http://www.w3.org/1999/xhtml" || !containers.includes(target.localName) || target.getAttribute(partAttr) !== null
      || target.getAttribute("contenteditable") !== null) throw new Error("请选择普通 HTML 内容容器；表格、SVG、输入控件和现有折叠结构不支持此操作。");
  };
  const capture = (target: LayoutElement, config: ComponentLayout): ComponentLayout => {
    if (!validate(config)) throw new Error("布局选项无效。");
    supported(target);
    const current = read(target); if (current) structure(target, current);
    const result: ComponentLayout = { collapse: config.collapse, maxHeight: config.maxHeight, ...(config.title ? { title: config.title } : {}) };
    const computed = target.ownerDocument.defaultView?.getComputedStyle?.(target);
    if (computed) {
      const position = computed.getPropertyValue("position"), display = computed.getPropertyValue("display");
      if (!["static", "relative", ""].includes(position) || !["block", "flex", "grid", "inline-flex", "inline-grid", "flow-root"].includes(display)) throw new Error("此容器的定位或布局需要作者调整，不能直接包装。");
      if (config.collapse === "group") {
        result.placement = current?.config.placement ?? Object.fromEntries(placement.map(key => [key, computed.getPropertyValue(key)]));
        // getComputedStyle(width) is a content width for content-box elements.
        // The replacement item uses border-box, so preserve its outer width.
        if (!current?.config.placement) {
          const contentBox = computed.getPropertyValue("box-sizing") === "content-box";
          const extra = ["padding-left", "padding-right", "border-left-width", "border-right-width"].reduce((sum, name) => sum + (parseFloat(computed.getPropertyValue(name)) || 0), 0);
          for (const name of contentBox ? ["width", "min-width", "max-width"] : []) {
            const value = result.placement[name];
            if (/^\d+(?:\.\d+)?px$/.test(value) && (parseFloat(value) > 0 || name === "width")) result.placement[name] = `${parseFloat(value) + extra}px`;
          }
          // The shell has no decoration, but the source's padding/border still occupies
          // space. Real Chromium comparisons require adding that space to content-box
          // bases and retaining its minimum outer extent for border-box bases. Keep
          // percentage expressions relative, rather than freezing the resolved width.
          const basis = result.placement["flex-basis"];
          if (/^\d+(?:\.\d+)?px$/.test(basis)) result.placement["flex-basis"] = `${contentBox ? parseFloat(basis) + extra : Math.max(parseFloat(basis), extra)}px`;
          else if (extra && (/^\d+(?:\.\d+)?%$/.test(basis) || /^(?:calc|min|max|clamp)\(/.test(basis))) result.placement["flex-basis"] = contentBox ? `calc(${basis} + ${extra}px)` : `max(${basis}, ${extra}px)`;
        }
        const inlineWidth = readStyle(target, "width").value;
        if (!current?.config.placement && (inlineWidth === "auto" || inlineWidth.includes("%")) && safeValue(inlineWidth)) result.placement.width = inlineWidth;
      }
      if (config.collapse === "contents") result.flow = current?.config.flow ?? Object.fromEntries(flow.map(key => [key, computed.getPropertyValue(key)]));
    } else {
      if (config.placement) result.placement = config.placement;
      if (config.flow) result.flow = config.flow;
    }
    if (!validate(result)) throw new Error("容器样式超出直接布局操作范围。");
    return result;
  };
  const apply = (target: LayoutElement, config: ComponentLayout, patchId: string, options: { move?: (parent: LayoutElement, node: LayoutNode, before: LayoutNode | null) => void } = {}) => {
    if (!validate(config) || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(patchId)) throw new Error("布局选项无效。");
    supported(target);
    const previous = read(target), previousStructure = previous ? structure(target, previous) : null;
    for (const name of Object.keys(previous?.properties ?? {})) readStyle(target, name);
    if (config.collapse === "contents" && target.querySelectorAll("*").length - (previous?.config.collapse === "contents" ? 3 : 0) > 1996) throw new Error("容器内容过多，不能保证后续恢复，请选择较小容器。");
    const willChange = config.collapse === "group" ? ["margin-top", "margin-right", "margin-bottom", "margin-left", "width", "min-width", "max-width", "box-sizing"]
      : config.collapse === "contents" ? ["height", "min-height"]
        : config.collapse === "none" && config.maxHeight !== null ? ["min-height", "max-height", "overflow-x", "overflow-y"] : [];
    for (const name of willChange) if (!safeValue(previous?.properties[name]?.value ?? readStyle(target, name).value, 2000)) throw new Error("原有内联样式无法安全恢复。");
    // Validate the next heading before making any live changes.
    const originalNodes = previous?.config.collapse === "contents" ? Array.from(previousStructure!.body.childNodes) : Array.from(target.childNodes);
    const originalHeading = previous?.heading ? previousStructure!.summary!.children[0] : originalNodes.find(node => node.nodeType === 1 && /^h[1-6]$/.test((node as LayoutElement).localName)) as LayoutElement | undefined;
    if (config.collapse === "contents" && originalHeading?.querySelector("a,button,input,textarea,select,[contenteditable],details,summary")) throw new Error("标题包含交互控件，请改用外套折叠分组。");
    const move = options.move ?? ((parent: LayoutElement, node: LayoutNode, before: LayoutNode | null) => { parent.insertBefore(node, before); });
    const key = previous?.key ?? patchId;
    if (config.collapse !== "none") {
      const collisions = Array.from(target.ownerDocument.querySelectorAll(`[id="paseo-layout-${key}"]`));
      if (collisions.some(node => node !== previousStructure?.details)) throw new Error("折叠分组标识已存在，请重新开始修改。");
    }
    if (previous && previousStructure) {
      const { details, summary, body } = previousStructure;
      if (details && previous.config.collapse === "group") { move(details.parentNode!, target, details); details.parentNode!.removeChild(details); }
      else if (details) {
        for (const node of Array.from(body.childNodes)) {
          if (previous.heading && node.nodeType === 8 && node.textContent === `paseo-layout-heading:${key}`) move(target, summary!.children[0], details);
          else move(target, node, details);
        }
        target.removeChild(details);
      }
      for (const [name, saved] of Object.entries(previous.properties)) {
        const current = readStyle(target, name);
        if (current.value !== saved.applied || current.priority !== "important") continue; // Preserve later author's changes.
        if (saved.value) writeStyle(target, name, saved.value, saved.priority); else removeStyle(target, name);
      }
      target.removeAttribute(attr);
      if (!previous.hadStyle && !target.getAttribute("style")) target.removeAttribute("style");
    }
    if (config.collapse === "none" && config.maxHeight === null) return { target, details: null, body: target, key };
    const meta: LayoutMetadata = { version: 1, key, config: JSON.parse(JSON.stringify(config)) as ComponentLayout, properties: {}, hadStyle: target.getAttribute("style") !== null, heading: false };
    const setTarget = (name: string, value: string) => {
      const { value: old, priority } = readStyle(target, name);
      if (!safeValue(old, 2000)) throw new Error("原有内联样式无法安全恢复。");
      meta.properties[name] = { value: old, priority, applied: value }; writeStyle(target, name, value, "important");
    };
    const create = (tag: string, name: string) => {
      const node = target.ownerDocument.createElement(tag); node.setAttribute(partAttr, name); node.setAttribute(keyAttr, key); return node;
    };
    let details: LayoutElement | null = null, body = target;
    if (config.collapse !== "none") {
      details = create("details", config.collapse === "group" ? "group" : "details"); details.setAttribute("open", "");
      details.setAttribute("id", `paseo-layout-${key}`);
      const summary = create("summary", "summary"); summary.style.setProperty("cursor", "pointer");
      body = create("div", "body"); details.appendChild(summary); details.appendChild(body);
      if (config.collapse === "group") {
        details.style.setProperty("box-sizing", "border-box");
        for (const [name, value] of Object.entries(config.placement ?? {})) details.style.setProperty(name, value);
        const margin = (name: string) => /^-?\d+(?:\.\d+)?(?:px|%)$/.test(config.placement?.[name] ?? "") ? config.placement![name] : "0px";
        const availableWidth = `max(0px, calc(100% - ${margin("margin-left")} - ${margin("margin-right")}))`;
        const originalMax = config.placement?.["max-width"];
        details.style.setProperty("max-width", originalMax && /^(?:\d+(?:\.\d+)?(?:px|%)|calc\(.+\))$/.test(originalMax) ? `min(${originalMax}, ${availableWidth})` : availableWidth);
        details.style.setProperty("min-width", "0px");
        body.style.setProperty("min-width", "0px"); body.style.setProperty("overflow-x", "auto");
        if (!target.parentNode) throw new Error("容器已移除。");
        target.parentNode.insertBefore(details, target); move(body, target, null);
        for (const name of ["margin-top", "margin-right", "margin-bottom", "margin-left"]) setTarget(name, "0px");
        setTarget("width", "100%"); setTarget("min-width", "0px"); setTarget("max-width", "none"); setTarget("box-sizing", "border-box");
        summary.textContent = config.title ?? "分组";
      } else {
        setTarget("height", "auto"); setTarget("min-height", "0px");
        const nodes = Array.from(target.childNodes), heading = nodes.find(node => node.nodeType === 1 && /^h[1-6]$/.test((node as LayoutElement).localName)) as LayoutElement | undefined;
        // The outer target remains the same grid/flex item; its original children keep their inner flow.
        details.style.setProperty("grid-column", "1 / -1"); details.style.setProperty("min-width", "0"); details.style.setProperty("width", "100%");
        for (const [name, value] of Object.entries(config.flow ?? {})) body.style.setProperty(name, value);
        target.appendChild(details);
        for (const node of nodes) {
          if (node === heading) { body.appendChild(target.ownerDocument.createComment(`paseo-layout-heading:${key}`)); move(summary, node, null); meta.heading = true; }
          else move(body, node, null);
        }
        if (!heading) summary.textContent = config.title ?? "内容";
      }
    }
    if (config.maxHeight !== null) {
      if (body === target) { setTarget("min-height", "0px"); setTarget("max-height", `${config.maxHeight}px`); setTarget("overflow-x", "auto"); setTarget("overflow-y", "auto"); }
      else { body.style.setProperty("max-height", `${config.maxHeight}px`); body.style.setProperty("overflow", "auto"); body.style.setProperty("min-height", "0"); body.style.setProperty("min-width", "0"); }
    }
    target.setAttribute(attr, JSON.stringify(meta));
    return { target, details, body, key };
  };
  return { validate, inspect, capture, apply, transferFailure };
}
