import { useTranslation } from 'react-i18next';
import { CircleAlert } from 'lucide-react';
export function UnsupportedPage({ name }: { name: string }) {
  const { i18n } = useTranslation();
  return <div role="status" className="mt-4 flex items-start gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-13 text-[var(--text-secondary)]"><CircleAlert size={18} className="mt-0.5 shrink-0"/><p>{i18n.language === 'zh-CN' ? `当前 Paseo 主机尚未连接${name}服务，此页面没有修改任何配置。` : `${name} is not connected on this Paseo host. No settings have been changed.`}</p></div>;
}
export const CompanionVoiceSettings = () => <UnsupportedPage name="Voice / 语音"/>;
export const BotChannelsPage = () => <UnsupportedPage name="Messaging platforms / 消息平台"/>;
export const RemoteTeammateSettings = () => <UnsupportedPage name="Remote teammate settings"/>;
export const BotProjectsSettings = () => <UnsupportedPage name="Projects"/>;
// Merge is not applicable to a plugin-owned local companion; unlike unsupported settings it is not a menu.
export const CindyMergeSetting = () => null;

// These branches remain unreachable until a corresponding host API is connected.
export const HookConnectionsSection = () => null;
export const WechatBotSection = () => null;
export const RemoteOfficialXCard = () => null;
