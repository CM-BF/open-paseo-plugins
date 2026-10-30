import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { usePaseo, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import type { OpeningData, OpeningStatus } from '../shared/opening';
import { useSettingsInvoke } from './data';

/** Native timeline version of Cindy's package-authored greeting and starter buttons. */
export function PresetOpening(props: PluginTimelineItemProps<OpeningData>) {
  const paseo = usePaseo();
  const invoke = useSettingsInvoke(props.host.id);
  const [status, setStatus] = useState<OpeningStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const actionEpoch = useRef(0);
  const sending = useRef(false);
  const refresh = useRef<() => void>(() => {});
  const data = props.item.data;
  const scope = useMemo(() => ({}), [props.host.id, props.agentId, data.botId]);
  const currentScope = useRef(scope); currentScope.current = scope;
  useLayoutEffect(() => {
    const owner = ++generation.current;
    sending.current = false; setBusy(false); setStatus(null); setError('');
    let disposed = false; let checking = false; let again = false;
    const check = async () => {
      if (disposed) return;
      if (checking) { again = true; return; }
      checking = true;
      const epoch = actionEpoch.current;
      try {
        const result = await invoke('preset.opening.status', { botId: data.botId, agentId: props.agentId });
        if (disposed || generation.current !== owner || epoch !== actionEpoch.current) return;
        if (!result.ok) throw new Error(result.message);
        setStatus(result.value as OpeningStatus); setError('');
      } catch (error) {
        if (!disposed && generation.current === owner && epoch === actionEpoch.current) { setStatus(null); setError(error instanceof Error ? error.message : 'Could not check the conversation'); }
      } finally {
        checking = false;
        if (again && !disposed) { again = false; void check(); }
      }
    };
    refresh.current = () => { void check(); };
    const subscription = paseo.agents.ref(props.agentId).timeline.subscribe(() => { void check(); });
    void subscription.ready.then(check, error => { if (!disposed) setError(error instanceof Error ? error.message : 'Conversation connection lost'); });
    void check();
    return () => { disposed = true; generation.current++; subscription(); refresh.current = () => {}; };
  }, [paseo, invoke, props.host.id, props.agentId, data.botId]);
  const choose = async (option: string) => {
    if (currentScope.current !== scope || sending.current || !status?.available) return;
    const owner = generation.current;
    actionEpoch.current++;
    sending.current = true; setBusy(true); setError('');
    try {
      const result = await invoke('preset.opening.choose', { botId: data.botId, agentId: props.agentId, option });
      if (generation.current !== owner) return;
      actionEpoch.current++;
      if (!result.ok) throw new Error(result.message);
      setStatus(result.value as OpeningStatus);
    } catch (error) {
      if (generation.current === owner) {
        actionEpoch.current++;
        // A transport failure does not prove the send failed. Status reconciles the saved receipt.
        setStatus(null); setError(error instanceof Error ? error.message : 'Could not confirm the starter choice'); refresh.current();
      }
    } finally { if (generation.current === owner) { sending.current = false; setBusy(false); } }
  };
  return <View style={{ gap: 12, paddingVertical: 4 }}>
    <Text style={{ color: props.theme.colors.foreground, fontSize: 15, lineHeight: 23 }}>{data.greeting}</Text>
    {status?.available ? <View accessibilityLabel="Starter choices" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {data.options.map(option => <Pressable key={option} accessibilityRole="button" disabled={busy} onPress={() => { void choose(option); }}
        style={{ backgroundColor: props.theme.colors.surface1, borderRadius: 9999, paddingHorizontal: 24, height: 28, alignItems: 'center', justifyContent: 'center', opacity: busy ? .5 : 1 }}>
        <Text style={{ color: props.theme.colors.foreground, fontSize: 13, fontWeight: '500' }}>{option}</Text>
      </Pressable>)}
    </View> : null}
    {status?.uncertain || error ? <View style={{ gap: 8 }}>
      <Text accessibilityRole="alert" style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{error || 'The starter choice may have been sent. Check its status before continuing.'}</Text>
      <Pressable accessibilityRole="button" onPress={() => refresh.current()}><Text style={{ color: props.theme.colors.foreground, fontSize: 13 }}>Check status</Text></Pressable>
    </View> : null}
  </View>;
}
