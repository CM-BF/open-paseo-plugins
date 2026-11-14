import type { InboxComment } from "./inbox";

/**
 * The already public context of a public comment (public-threads DESIGN §12 A1 d): its thread's visible root,
 * visible visitor replies and the owner and assistant replies attached to them. Hidden and withdrawn comments,
 * private comments and replies attached to them are left out. Pure; for a comment runner that answers in a thread.
 */
export interface PublicThreadMessage { commentId?: string; kind: "visitor" | "owner" | "agent"; text: string; createdAt: string; publicTag?: string; authorName?: string; replyToCommentId?: string }
export interface PublicThreadContext { root: PublicThreadMessage & { commentId: string }; replies: PublicThreadMessage[] }

const visible = (comment: InboxComment) => comment.visibility === "public" && !comment.publicState?.hidden && !comment.publicState?.withdrawn;

/** `comments` are read results (with `visibility`, `parentCommentId` and `publicState`); null when the comment is not in a visible public thread. */
export function publicThreadContext(comments: readonly InboxComment[], commentId: string): PublicThreadContext | null {
  const target = comments.find(comment => comment.id === commentId);
  if (!target || target.visibility !== "public") return null;
  const root = comments.find(comment => comment.id === (target.parentCommentId ?? target.id));
  if (!root || !visible(root) || root.parentCommentId) return null;
  const visitor = (comment: InboxComment): PublicThreadMessage & { commentId: string } => ({ commentId: comment.id, kind: "visitor", text: comment.text, createdAt: comment.createdAt, ...(comment.publicTag ? { publicTag: comment.publicTag } : {}), ...(comment.authorName ? { authorName: comment.authorName } : {}) });
  const members = comments.filter(comment => comment.parentCommentId === root.id && visible(comment));
  const messages: PublicThreadMessage[] = members.map(visitor);
  for (const host of [root, ...members]) for (const reply of host.replies ?? []) messages.push({ kind: reply.authorKind, text: reply.text, createdAt: reply.createdAt, ...(host.id !== root.id ? { replyToCommentId: host.id } : {}) });
  messages.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.kind === "visitor" ? 0 : 1) - (b.kind === "visitor" ? 0 : 1));
  return { root: visitor(root), replies: messages };
}
