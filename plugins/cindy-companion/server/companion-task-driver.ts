import type { Paseo } from './runtime';
import { NativeGroupDriver, type GroupDriver, type GroupLane, type LaneDispatch } from './group-driver';
import { throwIpcError } from './errors';
import { nativeConfigOnly } from './native-skills';
export interface TaskLane extends GroupLane { parentAgentId:string;taskId:string;ownedTurnId?:string;cancelMessageId?:string }
/** A delegation is a visible native child, not a teammate or a hidden discussion lane. */
export class NativeTaskDriver extends NativeGroupDriver implements GroupDriver {
  constructor(private readonly api:Paseo){super(api);}
  protected override creationOptions(input:GroupLane) {
    const lane=input as TaskLane;
    return { idempotencyKey:lane.operationId,parent:lane.parentAgentId,config:nativeConfigOnly(lane.config),cwd:lane.cwd,title:lane.title,
      labels:{'cindy-companion.taskId':lane.taskId,'cindy-companion.requestingBotId':lane.botId,'cindy-companion.parentAgentId':lane.parentAgentId} };
  }
  protected override async verifyLane(input:GroupLane) {
    const lane=input as TaskLane,agent=this.api.agents.ref(lane.agentId);
    if(!await agent.refresh())return null;
    if(agent.archivedAt||agent.cwd!==lane.cwd||(lane.workspaceId&&agent.workspaceId!==lane.workspaceId)
      ||agent.current()?.labels?.['cindy-companion.taskId']!==lane.taskId||agent.current()?.labels?.['cindy-companion.parentAgentId']!==lane.parentAgentId)
      throwIpcError('TASK_SESSION_MISMATCH','The native child no longer matches this task');
    return agent;
  }
  override async stop(input:GroupLane|TaskLane,persist?:(receipt:LaneDispatch)=>Promise<void>){
    if(input.dispatch?.native){
      try{return await super.stop(input,persist);}
      catch(error){if((error as {code?:string}).code==='GROUP_STOP_REQUIRES_NATIVE')throwIpcError('TASK_STOP_REQUIRES_NATIVE','Stop the owned turn in the native task session, then retry cancellation');throw error;}
    }
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
