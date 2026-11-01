import { DOMParser } from "linkedom";
import type { Canvas, CanvasPatch, ComponentIdentity } from "../shared/contracts";
import { componentIdentityFor } from "../shared/component-identity";
import { createComponentLayoutTools, type LayoutElement } from "../shared/component-layout";

export type AuthoringCanvas = Pick<Canvas, "revision" | "documentVersion" | "html" | "patches">;
export type AuthoringDescription = {
  canvasBase: { revision: number; documentVersion: number };
  materializedAuthoredHtml: string | null;
  target?: { selector: string; html: string };
  replay: {
    complete: boolean;
    appliedPatchIds: string[];
    failedPatch?: { id: string; selector: string; reason: string; componentTarget?: "source" | "destination"; componentSelector?: string };
  };
  note: string;
};

const SOURCE_NOTE = "Static authored source after replaying committed patches, not the running browser DOM. Scripts, event handlers and network resources are not executed or loaded. Runtime-generated elements and host-injected wrappers are not represented. HTML serialization may normalize markup.";
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
type AuthoredDocument = ReturnType<DOMParser["parseFromString"]>;
type AuthoredElement = NonNullable<ReturnType<AuthoredDocument["querySelector"]>>;
const rootTags = new Set(["html", "head", "body"]);
const nonComponents = new Set(["script", "style", "link", "meta", "base", "title", "template", "noscript"]);
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export class ComponentSourceMismatch extends Error {
  constructor(message: string, readonly componentTarget: "source" | "destination", readonly componentSelector: string) {
    super(message);
    this.name = "ComponentSourceMismatch";
  }
}

/**
 * Anonymous selectors need content evidence in addition to their structural hash.
 * Compare actual parsed nodes, not serializer bytes or string placeholders. A
 * globally unique authored descendant ID has the same identity semantics as an
 * ID-selected component: its live text/state may change while its complete
 * structure remains the same. Everything outside those anchored descendants is
 * still compared exactly, including anonymous text and attributes.
 */
function matchesAnonymousSource(document: AuthoredDocument, target: AuthoredElement, html: string | undefined): boolean {
  if (html === undefined) return false;
  if (html === target.outerHTML) return true;
  const template = document.createElement("template", undefined);
  template.innerHTML = html;
  const roots = Array.from(template.content.childNodes) as Array<{ nodeType: number }>;
  if (roots.length !== 1 || roots[0].nodeType !== 1) return false;
  const captured = roots[0] as AuthoredElement;
  const authoredIds = new Map<string, number>();
  for (const element of Array.from(document.querySelectorAll("[id]")) as AuthoredElement[]) authoredIds.set(element.id, (authoredIds.get(element.id) ?? 0) + 1);
  const capturedIds = new Map<string, number>();
  for (const element of [captured, ...Array.from(captured.querySelectorAll("[id]")) as AuthoredElement[]]) if (element.id) capturedIds.set(element.id, (capturedIds.get(element.id) ?? 0) + 1);
  type NodeShape = { nodeType: number; textContent: string | null; childNodes: ArrayLike<NodeShape> };
  const attributes = (element: AuthoredElement) => JSON.stringify((Array.from(element.attributes) as Array<{ name: string; value: string }>).map(attribute => [attribute.name, attribute.value]).sort((a, b) => a[0].localeCompare(b[0])));
  let visited = 0;
  const matches = (authoredNode: NodeShape, capturedNode: NodeShape): boolean => {
    if (++visited > 10000 || authoredNode.nodeType !== capturedNode.nodeType) return false;
    if (authoredNode.nodeType !== 1) return authoredNode.textContent === capturedNode.textContent;
    const authoredElement = authoredNode as AuthoredElement, capturedElement = capturedNode as AuthoredElement;
    if (authoredElement.localName.toLowerCase() !== capturedElement.localName.toLowerCase() || authoredElement.id !== capturedElement.id) return false;
    if (authoredElement !== target && authoredElement.id) {
      if (authoredIds.get(authoredElement.id) !== 1 || capturedIds.get(capturedElement.id) !== 1) return false;
      const authoredIdentity = componentIdentityFor(authoredElement), capturedIdentity = componentIdentityFor(capturedElement);
      return authoredIdentity.tag === capturedIdentity.tag && authoredIdentity.id === capturedIdentity.id && authoredIdentity.fingerprint === capturedIdentity.fingerprint;
    }
    if (attributes(authoredElement) !== attributes(capturedElement)) return false;
    const authoredChildren = Array.from(authoredNode.childNodes), capturedChildren = Array.from(capturedNode.childNodes);
    return authoredChildren.length === capturedChildren.length && authoredChildren.every((node, index) => matches(node, capturedChildren[index]));
  };
  return matches(target, captured);
}

function expectIdentity(document: AuthoredDocument, target: AuthoredElement, expected: ComponentIdentity | undefined, side: "source" | "destination", selector: string) {
  const mismatch = (message: string): never => { throw new ComponentSourceMismatch(message, side, selector); };
  if (!expected) return mismatch("Component identity is required");
  if (target.id && (Array.from(document.querySelectorAll("[id]")) as AuthoredElement[]).filter(node => node.id === target.id).length !== 1) return mismatch("Component has a duplicate ID");
  const current = componentIdentityFor(target);
  if (current.tag !== expected.tag || current.id !== expected.id || current.fingerprint !== expected.fingerprint) {
    return mismatch("Component structure differs from the authored source; select an authored component again");
  }
  if (!target.id && !matchesAnonymousSource(document, target, expected.authoredHtml)) return mismatch("Anonymous component no longer matches its authored source; select it again");
}

function applyComponentPatch(document: AuthoredDocument, target: AuthoredElement, patch: CanvasPatch, targetFor: (selector: string) => AuthoredElement) {
  if (rootTags.has(target.localName) || nonComponents.has(target.localName)) throw new Error("Document roots and executable metadata cannot be edited as components");
  expectIdentity(document, target, patch.sourceIdentity, "source", patch.selector);
  if (patch.operation === "layout") {
    if (!patch.layout) throw new Error("Layout edits require bounded options");
    createComponentLayoutTools().apply(target as unknown as LayoutElement, patch.layout, patch.id);
    return;
  }
  if (patch.operation === "text") {
    if (["input", "textarea", "select"].includes(target.localName)) throw new Error("Use the control's native editing behavior");
    if (patch.text === undefined || patch.expectedText === undefined) throw new Error("Text edits require current and replacement text");
    if (patch.textNodeIndex !== undefined) {
      const node = target.childNodes[patch.textNodeIndex];
      if (!node || node.nodeType !== 3 || node.textContent !== patch.expectedText) throw new Error("Selected text node changed; select the text again");
      node.textContent = patch.text;
    } else {
      if (target.children.length) throw new Error("Mixed markup requires a direct text-node selection; child elements are preserved");
      if (target.textContent !== patch.expectedText) throw new Error("Selected text changed; select the text again");
      target.textContent = patch.text;
    }
    return;
  }
  if (!patch.destination || !patch.position) throw new Error("Component placement requires a destination and position");
  const destination = targetFor(patch.destination);
  expectIdentity(document, destination, patch.destinationIdentity, "destination", patch.destination);
  const transferFailure = createComponentLayoutTools().transferFailure(patch.operation as "move" | "copy", target as unknown as LayoutElement, destination as unknown as LayoutElement, patch.position);
  if (transferFailure) throw new Error(transferFailure);
  if (rootTags.has(destination.localName) || nonComponents.has(destination.localName)) throw new Error("Select an authored content container instead of a document root");
  if (target === destination || target.contains(destination)) throw new Error("A component cannot be placed inside or relative to itself or its descendants");
  if (["append", "prepend"].includes(patch.position) && voidTags.has(destination.localName)) throw new Error("This element cannot contain components");
  let inserted = target;
  if (patch.operation === "copy") {
    if (!patch.copyIdPrefix) throw new Error("Copies require an immutable ID prefix");
    inserted = target.cloneNode(true) as AuthoredElement;
    const sourceNodes: AuthoredElement[] = [target, ...Array.from(target.querySelectorAll("[id]")) as AuthoredElement[]];
    const cloneNodes: AuthoredElement[] = [inserted, ...Array.from(inserted.querySelectorAll("[id]")) as AuthoredElement[]];
    const ids = new Map<string, string>();
    const documentIds = (Array.from(document.querySelectorAll("[id]")) as AuthoredElement[]).map(node => node.id);
    sourceNodes.forEach((node, index) => {
      const newId = `${patch.copyIdPrefix}-${index}`;
      if (documentIds.includes(newId)) throw new Error("Copy ID already exists; choose a new copy identity");
      if (node.id) {
        if (ids.has(node.id) || documentIds.filter(id => id === node.id).length !== 1) throw new Error("Copied component contains an ambiguous ID");
        ids.set(node.id, newId);
      }
      cloneNodes[index].id = newId;
    });
    const references = new Set(["for", "list", "form", "headers", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-flowto", "aria-activedescendant", "aria-details", "aria-errormessage"]);
    const rewriteUrls = (value: string) => value.replace(/url\(\s*(['"]?)#([^\s)'"\\]+)\1\s*\)/g, (match, _quote, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : match);
    for (const node of [inserted, ...Array.from(inserted.querySelectorAll("*")) as AuthoredElement[]]) {
      if (node.localName === "script") { node.remove(); continue; }
      for (const attribute of Array.from(node.attributes) as Array<{ name: string; value: string }>) {
        if (/^on/i.test(attribute.name)) { node.removeAttribute(attribute.name); continue; }
        let value = attribute.value;
        if (references.has(attribute.name)) value = value.replace(/\S+/g, id => ids.get(id) ?? id);
        else if (["href", "xlink:href"].includes(attribute.name) && value.startsWith("#")) value = ids.has(value.slice(1)) ? `#${ids.get(value.slice(1))}` : value;
        value = rewriteUrls(value);
        if (value !== attribute.value) node.setAttribute(attribute.name, value);
      }
      if (node.localName === "style") node.textContent = rewriteUrls(node.textContent ?? "");
    }
  }
  if (patch.position === "before") destination.before(inserted);
  else if (patch.position === "after") destination.after(inserted);
  else if (patch.position === "prepend") destination.prepend(inserted);
  else destination.append(inserted);
}

/** Component edits are validated against the committed authored source, never live DOM guesses. */
export function prepareComponentPatch(canvas: AuthoringCanvas, patch: CanvasPatch): CanvasPatch {
  const next = { ...canvas, patches: [...canvas.patches, patch] };
  const selector = patch.operation === "copy" ? `#${patch.copyIdPrefix}-0` : undefined;
  const result = describeAuthoring(next, selector);
  if (!result.replay.complete) {
    const failed = result.replay.failedPatch;
    if (failed?.componentTarget && failed.componentSelector) throw new ComponentSourceMismatch(failed.reason, failed.componentTarget, failed.componentSelector);
    throw new Error(failed?.reason ?? result.note);
  }
  // Copies are authored snapshots. The browser must not accidentally copy ephemeral
  // rendered data, saved controls, closures or execute duplicate inline handlers.
  if (patch.operation === "copy" && result.target!.html.length > 2000000) throw new Error("Copied component exceeds the 2000000-character patch limit");
  return patch.operation === "copy" ? { ...patch, html: result.target!.html } : patch;
}

/** Replays source edits in isolation. Neither the canvas nor its patch journal is modified. */
export function describeAuthoring(canvas: AuthoringCanvas, selector?: string): AuthoringDescription {
  const result: AuthoringDescription = {
    canvasBase: { revision: canvas.revision, documentVersion: canvas.documentVersion },
    materializedAuthoredHtml: null,
    replay: { complete: false, appliedPatchIds: [] },
    note: SOURCE_NOTE,
  };
  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(canvas.html, "text/html");
    const isDocument = Array.from(parsed.childNodes).some(node => node.nodeType === 10 ||
      (node.nodeType === 1 && ["html", "head", "body"].includes((node as { localName?: string }).localName ?? "")));
    // Give fragment selectors their body context, but never expose these virtual roots
    // as authored content. A fragment's first <main> must not accidentally become :root.
    const document = isDocument ? parsed : parser.parseFromString("<html><head></head><body></body></html>", "text/html");
    const fragmentBody = isDocument ? undefined : document.querySelector("body")!;
    if (fragmentBody) fragmentBody.innerHTML = canvas.html;
    const virtualRoots = fragmentBody ? new Set([document.documentElement, document.querySelector("head")!, fragmentBody]) : new Set();
    const applied = new Set<string>();
    const targetFor = (query: string) => {
      const matches = document.querySelectorAll(query);
      if (matches.length !== 1) throw new Error(`Selector must match exactly one authored element; matched ${matches.length}`);
      const target = matches[0];
      if (virtualRoots.has(target)) throw new Error("Selector identifies a host document wrapper, not an authored element");
      if (target.parentElement?.closest("noscript")) throw new Error("Selector identifies inactive noscript content, not a running Board element");
      return target;
    };
    for (const patch of canvas.patches) {
      // The browser also applies a journal ID at most once, even across replay.
      if (applied.has(patch.id)) continue;
      try {
        const target = targetFor(patch.selector);
        if (["html", "head", "body"].includes(target.localName) && ["replace", "remove"].includes(patch.operation)) {
          throw new Error("Replacing document roots requires publishing a new document version");
        }
        if (["move", "copy", "text", "layout"].includes(patch.operation)) applyComponentPatch(document, target, patch, targetFor);
        else if (patch.operation === "remove") target.remove();
        else {
          const template = document.createElement("template", undefined);
          template.innerHTML = patch.html;
          if (patch.operation === "append") target.append(template.content);
          else if (patch.operation === "prepend") target.prepend(template.content);
          else if (patch.operation === "replace") target.replaceWith(template.content);
          else throw new Error("Unknown patch operation");
        }
        applied.add(patch.id);
        result.replay.appliedPatchIds.push(patch.id);
      } catch (error) {
        result.replay.failedPatch = { id: patch.id, selector: patch.selector, reason: errorMessage(error), ...(error instanceof ComponentSourceMismatch ? { componentTarget: error.componentTarget, componentSelector: error.componentSelector } : {}) };
        result.note += " Replay stopped at the failed patch; no current source is returned. Inspect canvas.html together with the original canvas.patches journal.";
        return result;
      }
    }
    if (selector !== undefined) {
      try { result.target = { selector, html: targetFor(selector).outerHTML }; }
      catch (error) {
        result.note += ` Requested authored target is unavailable: ${errorMessage(error)}. No current source is returned; inspect the original canvas and patch journal.`;
        return result;
      }
    }
    result.materializedAuthoredHtml = fragmentBody ? fragmentBody.innerHTML : document.toString();
    result.replay.complete = true;
  } catch (error) {
    result.note += ` Authored source could not be parsed: ${errorMessage(error)}. Inspect the original canvas and patch journal.`;
  }
  return result;
}
