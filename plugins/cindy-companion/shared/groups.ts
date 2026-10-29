/** Cindy groupSingleSpeaker semantics adapted to owned Paseo lanes. */
import type { BotGroupTrackedMention } from './vendor/botGroupMentions';
export type { BotGroupTrackedMention };
export type GroupRoundStatus = 'queued' | 'running' | 'permission' | 'waiting' | 'completed' | 'stopping' | 'stopped' | 'interrupted' | 'failed' | 'unknown';
export interface GroupMember { botId: string; name: string; avatar: string; avatarColor: string; status: string }
export interface GroupMessage {
  id: string; sequence: number; authorKind: 'user' | 'bot' | 'system'; authorBotId?: string;
  authorName: string; content: string; createdAt: number; roundId?: string;
  kind: 'message' | 'round-end' | 'notice'; mentions?: { all: boolean; botIds: string[] };
  code?: string; agentId?: string;
  delivery?: 'deferred' | 'delivered';
  deliveryBotId?: string;
}
export interface GroupStep {
  botId: string; botName: string; status: 'queued' | 'running' | 'permission' | 'completed' | 'silent' | 'failed' | 'stopped' | 'unknown';
  agentId?: string; workspaceId?: string; messageId?: string; code?: string;
}
export interface GroupRound {
  id: string; sourceMessageId: string; status: GroupRoundStatus; steps: GroupStep[];
  position: number; autoThrough: number; createdAt: number; updatedAt: number; code?: string;
  kind?: 'talk' | 'reply'; noteMessageIds?: string[];
}
export interface GroupSummary {
  id: string; name: string; description: string; replyMode: 'all' | 'mentioned'; revision: number;
  members: GroupMember[]; createdAt: number; updatedAt: number; lastMessage?: GroupMessage;
  round: GroupRound | null;
  pendingReplies?: GroupRound[];
}
export interface GroupSnapshot {
  group: GroupSummary; messages: GroupMessage[]; hasOlder: boolean; hasNewer: boolean;
}
export interface GroupSendInput {
  groupId: string; text: string; clientMessageId: string; trackedMentions?: BotGroupTrackedMention[];
}
/** All operations use settings.invoke and its standard {ok,value}/{ok:false,code,message} envelope.
 * groups.list {} -> {groups:GroupSummary[]}
 * groups.get {groupId,beforeSequence?,limit?} -> GroupSnapshot
 * groups.create {operationId,name,botIds,description?,replyMode?} -> GroupSnapshot
 * groups.update {groupId,expectedRevision,name?,description?,replyMode?} -> GroupSnapshot
 * groups.setMembers {groupId,expectedRevision,botIds} -> GroupSnapshot
 * groups.send GroupSendInput -> {accepted:true,message:GroupMessage,round:GroupRound|null}
 * groups.continue {groupId,roundId,operationId} -> {accepted:true,round:GroupRound}
 * groups.stop {groupId,roundId} -> {accepted:true,round:GroupRound}
 * groups.delete {groupId,expectedRevision} -> {deleted:true,groupId}
 * Native permission requests are answered in the returned step.agentId's Paseo session.
 */
