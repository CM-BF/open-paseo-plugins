import type { BotDelegationView } from './vendor/botDelegation';
export interface TaskResultReceipt {
  id:string; runSequence:number; text:string; status:'completed'|'failed'|'cancelled';
  title:string; workingDir:string; artifacts:BotDelegationView['artifacts']; createdAt:number;
}
export interface CompanionTask extends BotDelegationView {
  revision:number; groupId?:string; workspaceId?:string; workingDir:string|null;
  control:'active'|'pausing'|'paused'|'stopping'|'stopped'|'unknown';
  activity:'queued'|'running'|'permission'|'idle'|'unknown';
  responsibility:'owned'|'released'; runSequence:number;
  queue:Array<{id:string;text:string;status:'queued'|'consuming'|'unknown';createdAt:number}>;
  results:TaskResultReceipt[];
  blocked?:{code:'HOST_UPGRADE_REQUIRED'|'PROVIDER_ADMISSION_UNAVAILABLE'|'PROVIDER_QUEUE_UNAVAILABLE';message:string};
}
/** settings.invoke envelope. UI authority comes from the host's authenticated plugin RPC.
 * companion.tasks.list {botId,groupId?} -> {tasks:CompanionTask[]}
 * companion.tasks.get {botId,taskId} -> {task:CompanionTask}
 * companion.tasks.start {botId,parentAgentId,operationId,instruction,title?,working_dir?,use_worktree?,context_refs?,timeout_ms?} -> {accepted:true,task}
 * companion.tasks.message {botId,taskId,operationId,message?,mode?:queue|resume|edit|withdraw,queued_message_id?} -> {accepted:true,task}
 * companion.tasks.stop {botId,taskId,mode?:cancel|request-stop|pause} -> {accepted:true,task}
 * companion.tasks.responsibility {botId,taskId,action:release|claim} -> {task}
 * companion.tasks.owner {agentId,workspaceId?} -> {owner:null|{botId,name,avatar,avatarColor,taskId,responsibility,canonicalSessionId?}}
 * companion.tasks.artifact {botId,taskId,receiptId?,path,parentAgentId?,groupId?} -> {workspaceId,path}
 * Releasing follow-up responsibility preserves the immutable creator identity and result history.
 * Native execution completion is not human acceptance. Results are frozen per run.
 */
