import type { ComponentIdentity } from "./contracts";

type ComponentElement = {
  localName: string; id: string; outerHTML: string; parentElement: ComponentElement | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<ComponentElement>;
};

/** Matches the iframe's edit identity, intentionally independent of live text/state. */
export function componentIdentityFor(element: ComponentElement): ComponentIdentity {
  const nodes = [element, ...Array.from(element.querySelectorAll("*"))];
  if (nodes.length > 2000) throw new Error("Component is too large to identify safely (maximum 2000 elements)");
  const indexes = new Map(nodes.map((node, index) => [node, index]));
  const input = JSON.stringify(nodes.map(node => [indexes.get(node.parentElement!) ?? -1, node.localName, node.id || "", node.getAttribute("role") || "", node.getAttribute("name") || "", node.getAttribute("type") || ""]));
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  if (!element.id && element.outerHTML.length > 240000) throw new Error("Anonymous component is too large to identify safely");
  return { tag: element.localName, ...(element.id ? { id: element.id } : { authoredHtml: element.outerHTML }), fingerprint: (hash >>> 0).toString(16).padStart(8, "0") };
}
