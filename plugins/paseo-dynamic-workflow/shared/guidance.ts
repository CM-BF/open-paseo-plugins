/** How large a workflow should be when the agent is not in Ultracode, mirroring Claude Code's levels. */
export const WORKFLOW_SIZES = ["unrestricted", "small", "medium", "large"] as const;
export type WorkflowSize = (typeof WORKFLOW_SIZES)[number];
export const DEFAULT_WORKFLOW_SIZE: WorkflowSize = "medium";
export const SIZE_AGENTS: Readonly<Record<Exclude<WorkflowSize, "unrestricted">, number>> = { small: 5, medium: 10, large: 50 };

/** What the workflow tool tells one agent about scale. */
export interface ToolGuidance {
  ultracode: boolean;
  size: WorkflowSize;
}

export function isWorkflowSize(value: unknown): value is WorkflowSize {
  return typeof value === "string" && (WORKFLOW_SIZES as readonly string[]).includes(value);
}

export function sizeLabel(size: WorkflowSize): string {
  return size === "unrestricted" ? "unrestricted" : `${size} (under ${SIZE_AGENTS[size]} agents)`;
}
