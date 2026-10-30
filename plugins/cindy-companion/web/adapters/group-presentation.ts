import { BOT_GROUP_MAX_MEMBERS, BOT_GROUP_MIN_MEMBERS } from '../../shared/vendor/botGroupChat';
export { BOT_GROUP_MAX_MEMBERS, BOT_GROUP_MIN_MEMBERS };
export const BOT_GROUP_SETTINGS_PARAM = 'groupSettings';
export const isActiveBotGroupMember = (member: { status: string }) => member.status === 'active';
/** Original create dialog error projection for operations exposed by the Paseo host. */
export function botGroupErrorKey(code: string | null | undefined, fallback: string) {
  const variant: Record<string, string> = { MEMBER_LIMIT: 'memberLimit', MEMBER_UNAVAILABLE: 'memberUnavailable',
    MENTION_UNAVAILABLE: 'mentionUnavailable', NOT_FOUND: 'notFound', HOST_NOT_READY: 'hostNotReady', PERMISSION_DENIED: 'permissionDenied' };
  return code && variant[code] ? `bots.groupChat.errors.${variant[code]}` : fallback;
}
