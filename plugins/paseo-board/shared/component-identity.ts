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
  // HTML source parsers may lowercase SVG adjusted names (foreignObject,
  // linearGradient) that browsers retain. Case is not an edit identity boundary.
  const input = JSON.stringify(nodes.map(node => {
    const identity: Array<string | number | string[]> = [indexes.get(node.parentElement!) ?? -1, node.localName.toLowerCase(), node.id || "", node.getAttribute("role") || "", node.getAttribute("name") || "", node.getAttribute("type") || ""];
    const layout = ["data-paseo-layout", "data-paseo-layout-part", "data-paseo-layout-key"].map(name => node.getAttribute(name));
    // Keep legacy identities byte-identical; only managed layouts add restoration evidence.
    if (layout.some(value => value !== null)) identity.push(layout.map(value => value ?? ""));
    return identity;
  }));
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
  if (!element.id && element.outerHTML.length > 240000) throw new Error("Anonymous component is too large to identify safely");
  return { tag: element.localName.toLowerCase(), ...(element.id ? { id: element.id } : { authoredHtml: element.outerHTML }), fingerprint: (hash >>> 0).toString(16).padStart(8, "0") };
}
