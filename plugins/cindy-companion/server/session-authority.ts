import type { SessionScope } from '../shared/session-scope';
import { sessionScopeSchema } from '../shared/session-scope';
import type { CompanionStore, SavedState } from './store';
import type { Paseo } from './runtime';
import { throwIpcError } from './errors';

/** The signed scope is a lookup key, never evidence by itself. Check live owned state on every call. */
export function sessionBinding(state:SavedState,botId:string,input:SessionScope):{cwd:string;workspaceId?:string} {
  const scope=sessionScopeSchema.parse(input),profile=state.profiles[botId];
  if(!profile||!profile.enabled||profile.status!=='active'||state.profileDeletions?.[botId])throwIpcError('SESSION_SCOPE_REVOKED','The companion is no longer active');
  let binding:{cwd:string;workspaceId?:string;sessionScope?:SessionScope}|undefined;
  if(scope.role==='canonical')binding=state.bindings[botId]?.agentId===scope.agentId?state.bindings[botId]:undefined;
  if(scope.role==='group'||scope.role==='plan'){
    const group=scope.groupId?state.groups?.[scope.groupId]:undefined;
    if(!group||group.deletedAt||group.mutation||!group.botIds.includes(botId))throwIpcError('SESSION_SCOPE_REVOKED','This companion no longer belongs to the group');
    const plan=scope.planId?state.groupPlans?.[scope.planId]:undefined;
    if(scope.role==='plan'&&(!plan||plan.view.groupId!==group.id||plan.view.status!=='running'||!['running','permission'].includes(plan.view.execution.state)))throwIpcError('SESSION_SCOPE_REVOKED','This work step is no longer executing');
    if(scope.role==='plan'){
      const step=plan!.view.currentStep===null?undefined:plan!.view.steps[plan!.view.currentStep];
      if(!step||step.botId!==botId||step.agentId!==scope.agentId||step.status!=='running')throwIpcError('SESSION_SCOPE_REVOKED','This work session no longer owns the active step');
    }
    const lanes=scope.role==='group'?Object.values(group.lanes):Object.values(plan!.lanes);
    binding=lanes.find(lane=>lane.botId===botId&&lane.agentId===scope.agentId&&!lane.retired);
  }
  if(scope.role==='routine'){
    const routine=state.routines[scope.routineId??''],saved=state.routineAgents?.[scope.agentId];
    if(routine?.botId===botId&&routine.phase==='ready'&&saved?.botId===botId&&saved.routineId===scope.routineId)binding=saved;
  }
  // Installed 0.13.2's public creation hook omits the native id. Routine tokens remain memory-only.
  if(!binding||!binding.sessionScope||JSON.stringify(sessionScopeSchema.parse(binding.sessionScope))!==JSON.stringify(scope))throwIpcError('SESSION_SCOPE_REVOKED','The session does not have this collaboration grant');
  return{cwd:binding.cwd,workspaceId:binding.workspaceId};
}
export async function validateSessionBinding(store:CompanionStore,paseo:Paseo,botId:string,scope:SessionScope):Promise<void>{
  const binding=sessionBinding(await store.snapshot(),botId,scope),agent=paseo.agents.ref(scope.agentId);
  if(!await agent.refresh()||agent.archivedAt||agent.cwd!==binding.cwd||(binding.workspaceId&&agent.workspaceId!==binding.workspaceId))
    throwIpcError('SESSION_SCOPE_REVOKED','The native session no longer matches its owned binding');
  const current=sessionBinding(await store.snapshot(),botId,scope);
  if(current.cwd!==binding.cwd||current.workspaceId!==binding.workspaceId)throwIpcError('SESSION_SCOPE_REVOKED','The session binding changed');
}
