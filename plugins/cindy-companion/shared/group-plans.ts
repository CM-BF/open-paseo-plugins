import type { BotGroupPlanView, BotGroupPlanStepView } from './vendor/botGroupChat';

export interface GroupPlanArtifact { path: string; size: number }
export interface GroupPlanStep extends BotGroupPlanStepView {
  /** Original server wire uses zero-based position/currentStep; rendered step labels add one. */
  agentId?: string; workspaceId?: string; startedAt?: number; completedAt?: number;
  artifacts: GroupPlanArtifact[]; code?: string;
}
/** Original work-plan state stays separate from native delivery uncertainty. */
export interface GroupWorkPlan extends Omit<BotGroupPlanView, 'steps'> {
  groupId: string; revision: number; request: string; sourceMessageId: string;
  kind: 'work'; steps: GroupPlanStep[];
  execution: { state: 'idle' | 'preparing' | 'queued' | 'running' | 'permission' | 'stopping' | 'unknown'; code?: string };
}
export interface GroupPlanSettings {
  revision: number; organizerBotId: string | null; projectDir: string | null; autoContinue: boolean;
}
export interface GroupPlanRequest {
  id: string; groupId: string; request: string; organizerBotId: string; organizerName: string;
  sourceMessageId: string;
  /** Confirmed native organizer lane, retained for manual stop/recovery. */
  agentId?:string;
  cleanupPending?:boolean;cleanupCode?:string;
  status: 'planning'|'complete'|'failed'|'unknown'; planId?: string; code?: string; createdAt: number; updatedAt: number;
}
export interface GroupPlanSnapshot { plans: GroupWorkPlan[]; settings: GroupPlanSettings; requests?: GroupPlanRequest[] }
export interface GroupPlanActionInput { groupId: string; planId: string; expectedRevision: number; operationId: string }
/** settings.invoke envelope is unchanged. Native acceptance never means step completion.
 * groups.plans.list {groupId} -> GroupPlanSnapshot
 * groups.plans.create {groupId,operationId,request,steps?:[{botId,task}],start?:boolean,trackedMentions?}
 *   -> {plan} for explicit steps, or {accepted:true,request:GroupPlanRequest} while organizer works.
 * groups.plans.start/continue/retry/stop/dismiss GroupPlanActionInput -> {accepted:true,plan}
 * groups.plans.edit {...GroupPlanActionInput,position,action:'reassign'|'remove',botId?} -> {plan}
 * groups.plans.revise {...GroupPlanActionInput,text} -> {accepted:true,request:GroupPlanRequest}
 * groups.plans.cancelRequest {groupId,requestId} -> {accepted:true,request}; terminal requests only reconcile pending manual native archive.
 * groups.plans.note {...GroupPlanActionInput,text} -> {accepted:true,plan,delivery:'queued'|'started'}
 * groups.plans.settings {groupId,expectedRevision,organizerBotId?,projectDir?,autoContinue?} -> {settings}
 * groups.plans.artifact {groupId,planId,position,path} -> {workspaceId,path} after realpath containment;
 * path is relative to the step's native workspace working directory, never an OS-open command.
 * All action/artifact positions are zero-based, matching Cindy chatServer.ts and its plan tests.
 * Same operationId + same immutable input replays its receipt; changed payload rejects.
 * Notes during execution are durable follow-up work for the SAME member after its current turn.
 * A waiting done step receives a redo; a failed step needs explicit retry (which may include a note).
 * Unknown native outcomes never auto resend; stop must reconcile the exact owned agent first.
 * `done` means all step results are committed, not a human acceptance or release of responsibility.
 */
