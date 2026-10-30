import { useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { defineTranslations, useTranslation, type PluginClientContext, type PluginHostProps } from '@getpaseo/plugin/client';
import { taskOwnerSchema, type TaskOwner } from '../shared/task-owner';
import { useSettingsInvoke } from './data';
import { avatarPresentation } from './assets/avatar-presentation';
import { appearanceFromBackground } from './frame-protocol';

const messages = defineTranslations({ resources: {
  en: { back: 'Back to {{name}}', owner: "{{name}}'s background task" },
  'zh-CN': { back: '回到 {{name}}', owner: '{{name}} 的后台任务' },
} });
export interface TaskOwnerHeaderProps extends PluginHostProps { workspaceId: string; agentId: string }

/** Original BotTaskOwnerChip geometry. Creation ownership is distinct from ongoing responsibility. */
export function TaskOwnerChip(props: TaskOwnerHeaderProps & { onOpenBot(botId: string, canonicalSessionId?: string): void }) {
  const invoke = useSettingsInvoke(props.host.id), { t } = useTranslation(messages);
  const scope = useMemo(() => ({ active: false }), [props.host.id, props.workspaceId, props.agentId]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const [value, setValue] = useState<{ scope: typeof scope; owner: TaskOwner | null }>({ scope, owner: null });
  const [hovered, setHovered] = useState(false);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const current = () => scope.active && currentScope.current === scope;
  useLayoutEffect(() => {
    scope.active = true; setValue({ scope, owner: null }); setFailedUri(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!current()) return;
      try {
        const result = await invoke('companion.tasks.owner', { agentId: props.agentId, workspaceId: props.workspaceId });
        if (!current()) return;
        const parsed = result.ok ? taskOwnerSchema.safeParse(result.value) : null;
        setValue({ scope, owner: parsed?.success ? parsed.data.owner : null });
      } catch { if (current()) setValue({ scope, owner: null }); }
      finally { if (current()) timer = setTimeout(() => { timer = undefined; void refresh(); }, 5000); }
    };
    void refresh();
    return () => { scope.active = false; if (timer) clearTimeout(timer); };
  }, [scope, invoke]);
  const owner = value.scope === scope ? value.owner : null;
  if (!owner) return null;
  const colors = props.theme.colors;
  const avatar = avatarPresentation(owner, appearanceFromBackground(colors.surface0));
  const uri = avatar.uri !== failedUri ? avatar.uri : null;
  return <Pressable accessibilityRole="button" accessibilityLabel={t('back', { name: owner.name })}
    onPress={() => { if (current()) props.onOpenBot(owner.botId, owner.canonicalSessionId); }}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
    style={{ marginLeft: 6, height: 24, minWidth: 0, maxWidth: 200, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 9999, paddingHorizontal: 8, backgroundColor: hovered ? colors.surface2 : 'transparent' }}>
    <View style={{ width: 20, height: 20, borderRadius: 10, overflow: 'hidden', backgroundColor: avatar.backgroundColor, alignItems: 'center', justifyContent: 'center' }}>
      {uri ? <Image accessibilityIgnoresInvertColors source={{ uri }} resizeMode="cover" onError={() => { if (current()) setFailedUri(uri); }} style={{ width: 20, height: 20, borderRadius: 10 }}/>
        : <Text style={{ color: colors.foreground, fontSize: 11 }}>{avatar.glyph}</Text>}
    </View>
    <Text numberOfLines={1} style={{ flexShrink: 1, color: hovered ? colors.foreground : colors.foregroundMuted, fontSize: 12 }}>{t('owner', { name: owner.name })}</Text>
  </Pressable>;
}

/** Optional new host slot: older apps keep their native header without a misplaced substitute. */
export function contributeTaskOwner(client: PluginClientContext) {
  const host = client as PluginClientContext & { addAgentHeaderItem?: (value: { id: string; Component: ComponentType<TaskOwnerHeaderProps> }) => (() => void) };
  if (!host.addAgentHeaderItem) return () => {};
  function Owner(props: TaskOwnerHeaderProps) {
    return <TaskOwnerChip {...props} onOpenBot={(botId, canonicalSessionId) => client.openScreen({ screenId: 'conversation', params: canonicalSessionId ? { agentId: canonicalSessionId } : { botId } })}/>;
  }
  return host.addAgentHeaderItem({ id: 'task-owner', Component: Owner });
}
