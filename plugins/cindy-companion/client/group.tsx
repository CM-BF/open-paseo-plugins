import { useRef } from 'react';
import { Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { PluginScreenProps } from '@getpaseo/plugin/client';
import { SETTINGS_HTML } from './generated/settings-html';
import { canRenderSettingsFrame, SettingsFrame, type SettingsFrameHandle } from './web';
import { appearanceFromBackground } from './frame-protocol';
import { companionsKey, useSettingsInvoke } from './data';

/** Groups keep their own shared transcript; each speaker's native lane remains inspectable. */
export function CompanionGroup(props: PluginScreenProps & { onOpenGroup(groupId: string): void }) {
  const invoke = useSettingsInvoke(props.host.id);
  const queries = useQueryClient();
  const handle = useRef<SettingsFrameHandle | null>(null);
  const groupId = props.params.groupId;
  return <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}>
    {canRenderSettingsFrame && groupId ? <SettingsFrame document={SETTINGS_HTML}
      init={{ host: props.host, botId: 'cindy', view: 'group', groupId, locale: 'en', theme: appearanceFromBackground(props.theme.colors.surface0) }}
      invoke={invoke} onReady={() => {}} onHandle={value => { handle.current = value; }}
      onChanged={() => { void queries.invalidateQueries({ queryKey: companionsKey(props.host.id) }); }}
      onClose={() => { /* This is a main screen, not a dismissible dialog. */ }}
      onNavigateAgent={agentId => props.navigation?.openAgent({ agentId, serverId: props.host.id })}
      onNavigateGroup={props.onOpenGroup} />
      : <Text style={{ padding: 24, color: props.theme.colors.foregroundMuted }}>Group chat currently opens in Paseo desktop and web.</Text>}
  </View>;
}
