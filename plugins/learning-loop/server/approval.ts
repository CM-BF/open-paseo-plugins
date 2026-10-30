import type { Actor } from "../shared/contracts";
import type { WriteApproval } from "../shared/settings";

export function shouldStage(mode: WriteApproval, actor: Actor): boolean {
  if (actor.kind === "user") return false;
  return mode === "all" || (mode === "background" && (actor.kind === "review" || actor.kind === "curator"));
}
