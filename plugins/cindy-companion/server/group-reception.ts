import { createHash } from 'node:crypto';
import type { GroupOutboxInput, GroupOutboxTarget } from '../shared/group-outbox';
import { resolveBotGroupMentions } from '../shared/vendor/botGroupMentions';
import type { SavedState } from './store';
import { groupSendFingerprint, parseTrackedMentions } from './groups';
import { mediaGroup } from './group-media';
import { record, string, throwIpcError } from './errors';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function mainWorkRoute(state:SavedState,input:GroupOutboxInput){
  const group=mediaGroup(state,input.groupId),mentions=resolveBotGroupMentions(input.text,{members:group.botIds.map(id=>({botId:id,name:state.profiles[id]?.name??id})),tracked:parseTrackedMentions(input.trackedMentions),allLabels:['all','everyone','所有人','全部','大家']});
  const openPlan=Object.values(state.groupPlans??{}).find(p=>p.view.groupId===input.groupId&&['proposed','running','waiting'].includes(p.view.status));
  return {group,mentions,plan:!input.quote&&group.replyMode==='all'&&!mentions.all&&!mentions.botIds.length?openPlan:undefined};
}
export function validateMainReception(state:SavedState,input:GroupOutboxInput){
  const route=mainWorkRoute(state,input);
  if(input.attachments?.length&&(input.division||route.plan))throwIpcError('ATTACHMENT_ROUTE_UNSUPPORTED','Attachments cannot be used for work arrangements yet; keep this draft');
  if(input.attachments?.length){const current=route.group.rounds.find(r=>r.id===route.group.activeRoundId)??route.group.rounds.at(-1);
    const responds=route.mentions.all||route.mentions.botIds.length||route.group.replyMode==='all';
    if(responds&&current&&['queued','running','permission','stopping'].includes(current.status))throwIpcError('ATTACHMENT_ROUTE_UNSUPPORTED','Attachments cannot be added to an active discussion; keep this draft');
  }
}
/** Pure durable local receipt lookup. No native observations or acceptance side effects. */
export function lookupMainReception(state:SavedState,input:GroupOutboxInput):GroupOutboxTarget|null{
  const group=state.groups?.[input.groupId];if(!group)return null;
  const conflict=()=>throwIpcError('IDEMPOTENCY_CONFLICT','Message identity belongs to different received content');
  const receipt=group.receipts[hash(input.clientMessageId)];
  if(receipt){const frozen=group.messages.find(message=>message.id===receipt.messageId)?.attachments;
    if(input.division||receipt.fingerprint!==groupSendFingerprint(input.text,parseTrackedMentions(input.trackedMentions),input.quote?.messageId,(input.attachments??[]).map(item=>({mediaId:item.mediaId,sha256:frozen?.find(a=>a.mediaId===item.mediaId)?.sha256}))))conflict();
    return{kind:'message',messageId:receipt.messageId,...(receipt.roundId?{roundId:receipt.roundId}:{})};}
  const request=state.groupPlanRequests?.[hash([input.groupId,input.clientMessageId])];
  if(request){const revision=request.supersedesPlanId?{planId:request.supersedesPlanId,expectedRevision:request.expectedRevision}:null;
    if(input.attachments?.length||input.quote||Boolean(input.division)===Boolean(revision)||request.fingerprint!==hash([input.groupId,input.text,input.trackedMentions??[],revision]))conflict();
    return{kind:'plan-request',requestId:request.view.id,messageId:request.view.sourceMessageId};}
  for(const plan of Object.values(state.groupPlans??{}))if(plan.view.groupId===input.groupId){
    const note=plan.notes.find(note=>note.operationId===input.clientMessageId);
    if(note){if(input.division||input.attachments?.length||input.quote||note.text!==input.text)conflict();return{kind:'plan-note',planId:plan.view.id,messageId:note.id};}
  }
  const operation=state.groupPlanOperations?.[hash(['create',input.groupId,input.clientMessageId])];
  if(operation){const plan=state.groupPlans?.[operation.planId];if(!plan||plan.view.groupId!==input.groupId||!input.division||input.attachments?.length||input.quote||plan.view.request!==input.text)conflict();
    return{kind:'plan',planId:operation.planId,messageId:plan!.view.sourceMessageId};}
  return null;
}
export function receptionTarget(result:unknown):GroupOutboxTarget{
  const value=record(result);
  if(value.request){const request=record(value.request);return{kind:'plan-request',requestId:string(request.id,'request id',200),...(typeof request.sourceMessageId==='string'?{messageId:request.sourceMessageId}:{})};}
  if(value.plan){const plan=record(value.plan);if(value.message){const message=record(value.message);return{kind:'plan-note',planId:string(plan.id,'plan id',200),messageId:string(message.id,'message id',200)};}
    return{kind:'plan',planId:string(plan.id,'plan id',200),...(typeof plan.sourceMessageId==='string'?{messageId:plan.sourceMessageId}:{})};}
  if(value.message){const message=record(value.message),round=value.round?record(value.round):null;return{kind:'message',messageId:string(message.id,'message id',200),...(round?{roundId:string(round.id,'round id',200)}:{})};}
  throwIpcError('OUTBOX_OUTCOME_UNKNOWN','Message reception returned no durable target');
}
