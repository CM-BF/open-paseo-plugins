import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { defineTranslations, useTranslation, type PluginClientContext } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import { DM_QUOTE_CONTEXT_ID, dmQuoteDisplaySchema, dmQuoteSelectionSchema } from '../shared/dm-quotes';
import { dmMessageSourceSchema, type DmMessageSource } from '../shared/dm-conversation';
import { chatReplyQuoteExcerpt } from '../shared/vendor/chatReplyQuote';
import { appearanceFromBackground } from './frame-protocol';
import { useSettingsInvoke } from './data';
import { quoteHost, type QuoteHost, type QuoteHostProps, type QuoteMessageProps, type QuoteComposerProps } from './dm-quote-host';

const messages = defineTranslations({ resources: {
  en: { reply: 'Quote reply', owner: 'You', companion: 'Teammate', replyingTo: 'Quoting {{name}}', remove: 'Remove quote',
    jumpLabel: 'Go to {{name}}’s original message: {{summary}}', unavailable: 'The original message isn’t in the history you can view',
    loading: 'Loading the original message…', readError: 'The original message could not be read. Try again later.',
    selectError: 'This conversation cannot accept a quote right now. Your draft has been kept.',
    locateError: 'The original message could not be located.', attachments: 'Quoting an attachment-only message is not available yet.' },
  'zh-CN': { reply: '引用回复', owner: '你', companion: '伙伴', replyingTo: '引用 {{name}}', remove: '取消引用',
    jumpLabel: '查看 {{name}} 的原消息：{{summary}}', unavailable: '原消息不在可查看的记录里',
    loading: '正在读取原消息…', readError: '暂时无法读取原消息，请稍后重试。',
    selectError: '当前会话暂时无法添加引用，输入的内容已保留。', locateError: '暂时无法定位原消息。', attachments: '暂不支持引用只有附件的消息。' },
} });
// Exact path from Cindy's ChatReplyIcon; the host renders the same SVG on web and native.
const replyIcon = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8a5 5 0 0 1 5 5v3.5a5 5 0 0 1-5 5h-4l-4 3v-3a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5Z"/></svg>' };
const profileList = z.object({ profiles: z.array(z.object({ id: z.string(), name: z.string(), enabled: z.boolean(),
  status: z.enum(['active', 'paused', 'archived']), canonicalSessionId: z.string().optional() })) });
const sourceSnapshot = z.object({ status: z.literal('available'), snapshot: z.object({
  botId: z.string(), source: dmMessageSourceSchema, text: z.string(),
}) });
function matchesRequestedSource(requested: DmMessageSource, returned: DmMessageSource): boolean {
  return requested.agentId === returned.agentId && requested.reference.role === returned.reference.role &&
    (['providerMessageId', 'clientMessageId', 'turnId'] as const).every(key =>
      requested.reference[key] === undefined || requested.reference[key] === returned.reference[key]);
}

function useProfiles(hostId: string) {
  const invoke = useSettingsInvoke(hostId);
  return useQuery({ queryKey: ['cindy-companion', hostId, 'dm-quote-profiles'], queryFn: async () => {
    const result = await invoke('profile.list', {});
    if (!result.ok) throw new Error(result.message);
    return profileList.parse(result.value).profiles;
  }, staleTime: 5000 }).data ?? [];
}
function useCurrentScope(key: string) {
  const scope = useMemo(() => ({ active: false }), [key]);
  const latest = useRef(scope); latest.current = scope;
  useLayoutEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  return useMemo(() => () => scope.active && latest.current === scope, [scope]);
}

/** Native counterpart of BotGroupQuoteBlock/Preview: the original rail, spacing and line limits. */
function QuoteBlock(props: QuoteHostProps & { name: string; excerpt: string; compact?: boolean; unavailable?: boolean;
  onRemove?: () => void; onLocate?: () => void }) {
  const { t } = useTranslation(messages), dark = appearanceFromBackground(props.theme.colors.surface0) === 'dark';
  const primary = dark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.88)';
  const secondary = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.56)';
  const tertiary = dark ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.44)';
  const rail = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const [hovered, setHovered] = useState(false);
  const body = <>
    {props.compact && <View style={{ flexShrink: 0 }}><Icon icon={replyIcon} size={14} color={secondary}/></View>}
    <View style={{ width: 2, flexShrink: 0, backgroundColor: rail, ...(props.compact ? { height: 16 } : { alignSelf: 'stretch' }) }}/>
    <View style={{ minWidth: 0, flex: 1, flexDirection: props.compact ? 'row' : 'column', gap: props.compact ? 6 : 0, alignItems: props.compact ? 'baseline' : 'stretch' }}>
      <Text numberOfLines={1} style={{ minWidth: 0, maxWidth: props.compact ? '50%' : undefined, color: secondary, fontSize: 12, lineHeight: 18, fontWeight: '500', flexShrink: 0 }}>
        {props.compact ? t('replyingTo', { name: props.name }) : props.name}
      </Text>
      <Text numberOfLines={props.compact ? 1 : 2} style={{ minWidth: 0, flexShrink: 1, color: props.unavailable ? tertiary : primary, fontSize: 12, lineHeight: 18 }}>{props.excerpt}</Text>
    </View>
    {props.onRemove && <Pressable accessibilityRole="button" accessibilityLabel={t('remove')} onPress={props.onRemove}
      style={{ width: 24, height: 24, flexShrink: 0, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="X" size={12} color={tertiary}/>
    </Pressable>}
  </>;
  const style = { minWidth: 0, maxWidth: '100%' as const, flexDirection: 'row' as const, gap: 8, borderRadius: 8,
    paddingVertical: props.compact ? 8 : 2, paddingHorizontal: props.compact ? 12 : 0,
    alignItems: props.compact ? 'center' as const : 'stretch' as const, opacity: hovered ? 0.75 : 1 };
  return props.onLocate ? <Pressable testID="cindy-dm-quote" accessibilityRole="button"
    accessibilityLabel={t('jumpLabel', { name: props.name, summary: props.excerpt })} onPress={props.onLocate}
    onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={style}>{body}</Pressable>
    : <View testID={props.compact ? 'cindy-dm-quote-preview' : 'cindy-dm-quote'} style={style}>{body}</View>;
}

export function DmQuoteAction(props: QuoteMessageProps & { hostApi: QuoteHost }) {
  const { t } = useTranslation(messages), profiles = useProfiles(props.host.id);
  const source = useMemo(() => dmMessageSourceSchema.safeParse({ agentId: props.agentId, reference: props.message.reference,
    position: props.message.position }), [props.agentId, props.message]);
  const scopeKey = JSON.stringify([props.host.id, props.agentId, props.message.reference]);
  const current = useCurrentScope(scopeKey);
  const busy = useMemo(() => ({ pending: false }), [current]), [errorKey, setErrorKey] = useState<string | null>(null);
  const owner = profiles.find(p => p.canonicalSessionId === props.agentId && p.enabled && p.status === 'active');
  if (!owner || !source.success) return null;
  const select = async () => {
    if (!current() || busy.pending) return;
    busy.pending = true; setErrorKey(null);
    try { await props.hostApi.setComposerContext({ id: DM_QUOTE_CONTEXT_ID, agentId: props.agentId,
      value: { source: source.data }, focus: true }); }
    catch { if (current()) setErrorKey(scopeKey); }
    finally { busy.pending = false; }
  };
  return <View><Pressable accessibilityRole="button" accessibilityLabel={t('reply')}
    onPress={() => { void select(); }} style={{ padding: 4 }}><Icon icon={replyIcon} size={14} color={props.theme.colors.foregroundMuted}/></Pressable>
    {errorKey === scopeKey && <Text accessibilityRole="alert" style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{t('selectError')}</Text>}
  </View>;
}

export function DmQuotePreview(props: QuoteComposerProps) {
  const { t } = useTranslation(messages), invoke = useSettingsInvoke(props.host.id), profiles = useProfiles(props.host.id);
  const selection = useMemo(() => dmQuoteSelectionSchema.safeParse(props.context.value), [props.context.value]);
  const scopeKey = JSON.stringify([props.host.id, props.agentId, props.context.version]);
  const current = useCurrentScope(scopeKey);
  const [view, setView] = useState<{ key: string; text: string; botId?: string; unavailable?: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!selection.success || selection.data.source.agentId !== props.agentId) return;
    let active = true;
    void invoke('companion.dm.source', { source: selection.data.source }).then(result => {
      if (!active || !current()) return;
      const parsed = result.ok ? sourceSnapshot.safeParse(result.value) : null;
      if (parsed?.success && matchesRequestedSource(selection.data.source, parsed.data.snapshot.source))
        setView({ key: scopeKey, text: chatReplyQuoteExcerpt(parsed.data.snapshot.text), botId: parsed.data.snapshot.botId });
      else setView({ key: scopeKey, text: '', unavailable: true });
    }).catch(() => { if (active && current()) setView({ key: scopeKey, text: '', unavailable: true }); });
    return () => { active = false; };
  }, [selection, invoke, props.agentId, scopeKey, current]);
  if (!selection.success || selection.data.source.agentId !== props.agentId) return null;
  const displayed = view?.key === scopeKey ? view : null;
  const name = selection.data.source.reference.role === 'user' ? t('owner') : profiles.find(p => p.id === displayed?.botId)?.name ?? t('companion');
  return <QuoteBlock {...props} compact name={name} excerpt={displayed ? displayed.unavailable ? t('readError') : displayed.text || t('attachments') : t('loading')} unavailable={displayed?.unavailable}
    onRemove={() => { if (current()) { props.focusInput(); props.clear(props.context.version); } }}/>
  ;
}

export function DmQuotePrefix(props: QuoteMessageProps) {
  const { t } = useTranslation(messages), profiles = useProfiles(props.host.id);
  const entry = props.message.inputContexts?.find(item => item.pluginId === 'cindy-companion' && item.id === DM_QUOTE_CONTEXT_ID);
  const parsed = dmQuoteDisplaySchema.safeParse(entry?.data);
  const scopeKey = JSON.stringify([props.host.id, props.agentId, props.message.reference, entry?.version]);
  const current = useCurrentScope(scopeKey);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  if (props.message.reference.role !== 'user' || !parsed.success || parsed.data.source.agentId !== props.agentId) return null;
  const quote = parsed.data, excerpt = quote.status === 'available' ? quote.excerpt : t('unavailable');
  const name = quote.source.reference.role === 'user' ? t('owner') : profiles.find(p => quote.status === 'available' && p.id === quote.botId)?.name ?? t('companion');
  const locate = props.navigation?.locateMessage;
  const onLocate = locate && quote.status === 'available' ? () => {
    if (!current()) return;
    setErrorKey(null);
    void locate(quote.source).then(result => { if (current()) setErrorKey(result.status === 'found' ? null : scopeKey); })
      .catch(() => { if (current()) setErrorKey(scopeKey); });
  } : undefined;
  return <View style={{ alignSelf: 'flex-end', maxWidth: '100%' }}>
    <QuoteBlock {...props} name={name} excerpt={excerpt} unavailable={quote.status !== 'available'} onLocate={onLocate}/>
    {errorKey === scopeKey && <Text accessibilityRole="alert" style={{ color: props.theme.colors.foregroundMuted, fontSize: 12 }}>{t('locateError')}</Text>}
  </View>;
}

export function contributeDmQuotes(client: PluginClientContext) {
  const hostApi = quoteHost(client);
  if (!hostApi) return () => {};
  const Action = (props: QuoteMessageProps) => <DmQuoteAction {...props} hostApi={hostApi}/>;
  const removals: (() => void)[] = [];
  try {
    removals.push(hostApi.addComposerContext({ id: DM_QUOTE_CONTEXT_ID, Component: DmQuotePreview }));
    removals.push(hostApi.addMessagePrefix({ id: DM_QUOTE_CONTEXT_ID, Component: DmQuotePrefix }));
    removals.push(hostApi.addMessageAction({ id: DM_QUOTE_CONTEXT_ID, Component: Action }));
  } catch (error) { for (const remove of removals.reverse()) remove(); throw error; }
  return () => { for (const remove of removals.splice(0).reverse()) remove(); };
}
