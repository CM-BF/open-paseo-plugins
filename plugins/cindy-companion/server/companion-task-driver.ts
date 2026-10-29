import type { Paseo } from './runtime';
import { NativeGroupDriver, type GroupDriver, type GroupLane } from './group-driver';
import { throwIpcError } from './errors';
export interface TaskLane extends GroupLane { parentAgentId:string;taskId:string;ownedTurnId?:string;cancelMessageId?:string }
/** A delegation is a visible native child, not a teammate or a hidden discussion lane. */
export class NativeTaskDriver extends NativeGroupDriver implements GroupDriver {
  constructor(private readonly api:Paseo){super(api);}
  override async ensure(input:GroupLane){
    const lane=input as TaskLane;let agent=this.api.agents.ref(lane.agentId);
    if(typeof (agent as unknown as {sendIfIdle?:unknown}).sendIfIdle!=='function')throwIpcError('HOST_UPGRADE_REQUIRED','Delegated tasks require the public atomic sendIfIdle capability');
    if(!await agent.refresh()){
      if(lane.phase==='ready')throwIpcError('TASK_SESSION_MISSING','The delegated session is missing');
      agent=await this.api.agents.create({agentId:lane.agentId,idempotencyKey:lane.operationId,parent:lane.parentAgentId,
        config:lane.config as never,cwd:lane.cwd,title:lane.title,
        labels:{'cindy-companion.taskId':lane.taskId,'cindy-companion.requestingBotId':lane.botId,'cindy-companion.parentAgentId':lane.parentAgentId}});
      await agent.refresh();
    }
    if(agent.archivedAt||agent.cwd!==lane.cwd||agent.current()?.labels?.['cindy-companion.taskId']!==lane.taskId||agent.current()?.labels?.['cindy-companion.parentAgentId']!==lane.parentAgentId)
      throwIpcError('TASK_SESSION_MISMATCH','The native child no longer matches this task');
    return{workspaceId:agent.workspaceId??undefined};
  }
  override reply(lane:GroupLane,input:Parameters<GroupDriver['reply']>[1]){return super.reply(lane,{...input,requireIdleAdmission:true});}
  override async stop(input:GroupLane|TaskLane){
    const lane=input as TaskLane,agent=this.api.agents.ref(lane.agentId);
    if(!await agent.refresh()){
      if(lane.phase!=='ready')throwIpcError('STOP_NOT_CONFIRMED','Agent creation outcome is still unknown');return;
    }
    if(agent.cwd!==lane.cwd||agent.current()?.labels?.['cindy-companion.taskId']!==lane.taskId||agent.current()?.labels?.['cindy-companion.parentAgentId']!==lane.parentAgentId)throwIpcError('TASK_SESSION_MISMATCH','Refusing to stop a different native task');
    const exact=agent as typeof agent&{cancelTurn?:(input:{expectedTurnId:string;messageId:string})=>Promise<{status:'cancelled'|'changed'|'unavailable'}>};
    if(lane.ownedTurnId&&lane.cancelMessageId&&exact.cancelTurn){
      try{
        const result=await exact.cancelTurn({expectedTurnId:lane.ownedTurnId,messageId:lane.cancelMessageId});
        if(result.status==='cancelled'||result.status==='changed')return;
      }catch(error){if((error as {code?:string}).code!=='unsupported_capability')throw error;}
    }
    // A visible child can receive human turns. A refresh followed by ordinary
    // interrupt/CLI stop is not atomic and could stop the next user's turn.
    if(agent.activeTurn||agent.status==='running'||agent.status==='initializing'||agent.pendingPermissions?.length)
      throwIpcError('TASK_STOP_REQUIRES_NATIVE','This host cannot stop only the owned task turn; stop it in the native task session, then retry cancellation');
  }
}
