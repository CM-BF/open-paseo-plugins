import { DOMParser } from "linkedom";
import type { Canvas } from "../shared/contracts";

export type AuthoringCanvas = Pick<Canvas, "revision" | "documentVersion" | "html" | "patches">;
export type AuthoringDescription = {
  canvasBase: { revision: number; documentVersion: number };
  materializedAuthoredHtml: string | null;
  target?: { selector: string; html: string };
  replay: {
    complete: boolean;
    appliedPatchIds: string[];
    failedPatch?: { id: string; selector: string; reason: string };
  };
  note: string;
};

const SOURCE_NOTE = "Static authored source after replaying committed patches, not the running browser DOM. Scripts, event handlers and network resources are not executed or loaded. Runtime-generated elements and host-injected wrappers are not represented. HTML serialization may normalize markup.";
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
        if (patch.operation === "remove") target.remove();
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
        result.replay.failedPatch = { id: patch.id, selector: patch.selector, reason: errorMessage(error) };
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
