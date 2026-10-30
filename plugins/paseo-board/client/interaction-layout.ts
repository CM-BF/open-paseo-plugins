import type { Anchor, Interaction } from "../shared/contracts";

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

export function anchorPoint(anchor?: Anchor): Point {
  if (!anchor?.rect) return { x: 24, y: 24 };
  return { x: anchor.rect.x - (anchor.viewport?.scrollX ?? 0), y: anchor.rect.y - (anchor.viewport?.scrollY ?? 0) };
}

/** Keep the requested point visible, flipping at the viewport edges without changing its size. */
export function popoverPlacement(point: Point, viewport: Size, contentHeight: number) {
  const margin = 8;
  const width = Math.min(420, Math.max(1, viewport.width - margin * 2));
  const maxHeight = Math.max(1, Math.min(520, viewport.height - margin * 2));
  const height = Math.min(contentHeight, maxHeight);
  const clamp = (value: number, maximum: number) => Math.max(margin, Math.min(value, maximum));
  const left = clamp(point.x + 14 + width <= viewport.width - margin ? point.x + 14 : point.x - width - 14, viewport.width - width - margin);
  const top = clamp(point.y + 14 + height <= viewport.height - margin ? point.y + 14 : point.y - height - 14, viewport.height - height - margin);
  return { left, top, width, maxHeight };
}

/** Follow explicit ancestry only; malformed cycles and missing parents remain local. */
export function interactionRoot(id: string, interactions: Interaction[]): string {
  const lookup = new Map(interactions.map(item => [item.id, item]));
  const seen = new Set<string>();
  let current = lookup.get(id);
  while (current?.sourceInteractionId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = lookup.get(current.sourceInteractionId);
    if (!parent || seen.has(parent.id)) break;
    current = parent;
  }
  return current?.id ?? id;
}

export function interactionThread(id: string | undefined, interactions: Interaction[]): Interaction[] {
  if (!id) return [];
  const root = interactionRoot(id, interactions);
  return interactions.filter(item => interactionRoot(item.id, interactions) === root);
}

export function mergeInteractions(saved: Interaction[], optimistic: Interaction[]): Interaction[] {
  const ids = new Set(saved.map(item => item.id));
  return [...saved, ...optimistic.filter(item => !ids.has(item.id))];
}

export function visualQuestion(item: Interaction, request: { prompt?: string; anchor?: Anchor; kind?: string }): string {
  const anchor = request.anchor;
  const reference = {
    interactionId: item.id, responseRevision: item.responseRevision ?? 0,
    responseCanvasRevision: item.responseCanvas?.revision,
    kind: request.kind ?? "question",
    selection: anchor ? { kind: anchor.kind, quote: anchor.text, selector: anchor.selector, rect: anchor.rect, viewport: anchor.viewport } : undefined,
  };
  return `关于这条回答的交互图解（以下选区坐标属于回答图解，不是主画布；可用 board_read 查看对应 responseCanvas）：\n${JSON.stringify(reference)}\n\n${request.prompt ?? ""}`.slice(0, 24000);
}
