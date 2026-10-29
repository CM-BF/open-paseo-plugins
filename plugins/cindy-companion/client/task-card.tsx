import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation, type PluginTimelineItemProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/ui';
import type { TaskCardData } from '../shared/task-card';
import { projectTaskCard } from '../shared/task-card';
import { useCompanionTask } from './task-data';
import { taskMessages } from './task-messages';
import { executionMessage } from '../shared/execution-notice';

type FileNavigation = { openFile?: (input: { workspaceId: string; path: string; serverId?: string }) => Promise<void> };
type TaskProps = PluginTimelineItemProps<TaskCardData> & { navigation?: FileNavigation; onOpenAgent(agentId: string): void };

/** Native equivalent of original BotCollaborationCard; no per-card iframe or injected HTML. */
export function NativeCompanionTaskCard(props: TaskProps) {
  const { t, locale } = useTranslation(taskMessages), colors = props.theme.colors, data = props.item.data;
  const controller = useCompanionTask(props.host.id, props.agentId, data);
  const task = controller.task, receipt = task?.results.find(value => value.id === data.receiptId);
  const view = task ? projectTaskCard(task, receipt) : null;
  const [expanded, setExpanded] = useState(Boolean(data.receiptId)), [noteOpen, setNoteOpen] = useState(false), [note, setNote] = useState('');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [clock, setClock] = useState(Date.now());
  const scope = useMemo(() => ({ active: false, busy: false }), [props.host.id, props.agentId, data.parentAgentId, data.botId, data.taskId, data.receiptId]);
  const owner = useRef(scope); owner.current = scope;
  const current = () => scope.active && owner.current === scope && controller.current();
  useLayoutEffect(() => {
    scope.active = true; setError(''); setNotice(''); setExpanded(Boolean(data.receiptId)); setNoteOpen(false); setNote('');
    return () => { scope.active = false; };
  }, [scope]);
  const state = receipt?.status ?? view?.state;
  const live = !receipt && ['starting', 'running', 'waiting'].includes(state ?? '');
  useLayoutEffect(() => {
    if (!live) return; setClock(Date.now());
    const timer = setInterval(() => { if (scope.active) setClock(Date.now()); }, 1000);
    return () => clearInterval(timer);
  }, [live, scope]);
  const duration = (from: number, to: number) => {
    const seconds = Math.max(0, Math.floor((to - from) / 1000)), minutes = Math.floor(seconds / 60);
    if (seconds < 60) return t('duration.seconds', { n: seconds });
    if (minutes < 60) return t('duration.minutes', { n: minutes });
    if (seconds < 86400) return t('duration.hoursMinutes', { h: Math.floor(minutes / 60), m: minutes % 60 });
    return t('duration.daysHoursMinutes', { d: Math.floor(seconds / 86400), h: Math.floor(seconds % 86400 / 3600), m: minutes % 60 });
  };
  const run = async (operation: () => Promise<void>) => {
    if (!current() || scope.busy) return;
    scope.busy = true; setError('');
    try { await operation(); } catch (reason) { if (current()) setError(executionMessage(reason, locale)); }
    finally { scope.busy = false; }
  };
  const open = () => { if (current() && view?.agentId) props.onOpenAgent(view.agentId); };
  const stop = () => { void run(async () => { await controller.stop(); }); };
  const resume = () => { void run(async () => { await controller.resume(); }); };
  const submit = () => {
    const text = note.trim(); if (!text || text.length > 4000 || !view?.canAddNote) return;
    void run(async () => {
      const saved = await controller.note(text);
      if (saved && current()) { setNote(''); setNoteOpen(false); setNotice(t('queuedNote')); }
    });
  };
  const openFile = (path: string) => { void run(async () => {
    if (!props.navigation?.openFile) throw new Error(t('upgradeFiles'));
    const result = await controller.invoke('companion.tasks.artifact', { botId: data.botId, taskId: data.taskId, parentAgentId: data.parentAgentId, ...(data.receiptId ? { receiptId: data.receiptId } : {}), path });
    if (!current() || !result) return;
    const file = result as { workspaceId?: unknown; path?: unknown };
    if (typeof file.workspaceId !== 'string' || !file.workspaceId || typeof file.path !== 'string' || !file.path || /^(?:[/\\]|[a-z]:)/i.test(file.path) || file.path.split(/[\\/]/).some(part => part === '..') || /[\u0000-\u001f]/.test(file.path)) throw new Error('The host did not return a valid task file.');
    await props.navigation.openFile({ workspaceId: file.workspaceId, path: file.path, serverId: props.host.id });
  }); };
  function Chip({ label, icon, onPress, danger = false, disabled = false }: { label: string; icon?: string; onPress(): void; danger?: boolean; disabled?: boolean }) {
    const color = danger ? colors.statusDanger : colors.foregroundMuted;
    return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={{ height: 24, maxWidth: '100%', borderRadius: 9999, backgroundColor: colors.surface2, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 4, opacity: disabled ? .5 : 1 }}>
      {icon && <Icon name={icon} size={12} color={color}/>}<Text style={{ color, fontSize: 11 }}>{label}</Text>
    </Pressable>;
  }
  const alert = executionMessage(error || controller.mutationError || controller.readError, locale);
  const taskError = executionMessage(view?.errorCode ?? view?.error, locale);
  if (!view) return <View style={{ width: '100%', maxWidth: 560, marginVertical: 8, borderWidth: 1, borderRadius: 12, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, gap: 8, backgroundColor: colors.surface1 }}>
    <Text accessibilityRole={alert ? 'alert' : undefined} style={{ color: colors.foregroundMuted, fontSize: 12 }}>{alert || t('loading')}</Text>
    {alert && <Chip label={t('retry')} onPress={controller.refresh}/>}
  </View>;
  const title = receipt?.title || view.title || view.objective.split('\n')[0] || t('backgroundTask');
  const resultText = receipt?.text ?? view.resultText, files = receipt?.artifacts.map(file => file.path) ?? view.files;
  const status = state === 'starting' ? 'queued' : state!;
  const meta = [t('backgroundTask'), !live && !receipt && view.completedAt != null ? t('tookTime', { duration: duration(view.createdAt, view.completedAt) }) : null].filter(Boolean).join(' · ');
  const hasResult = Boolean(receipt) || ['completed', 'failed', 'cancelled'].includes(state ?? '');
  const color = state === 'completed' ? colors.statusSuccess : state === 'failed' ? colors.statusDanger : state === 'waiting' ? colors.accent : colors.foregroundMuted;
  let secondary: ReactNode = null;
  if (!receipt && (task?.control === 'stopping' || task?.control === 'pausing')) secondary = t('stopping');
  else if (task?.control === 'paused' && !receipt) secondary = taskError || t('paused');
  else if (state === 'unknown') secondary = taskError || t('unknown');
  else if (state === 'starting' || state === 'running') secondary = `${state === 'starting' ? t('status.queued') : t('processing')} · ${t('elapsed', { duration: duration(view.acceptedAt ?? view.createdAt, clock) })}`;
  else if (state === 'waiting') secondary = view.waitingSummary ? t('awaitingConfirm', { summary: view.waitingSummary }) : t('awaitingConfirmGeneric');
  else if (!expanded && state === 'completed') secondary = resultText.trim();
  else if (!expanded && state === 'failed') secondary = taskError;
  return <View testID="cindy-task-card" accessibilityLabel={t(`status.${status}`)} style={{ width: '100%', minWidth: 0, maxWidth: 560, marginVertical: 8, borderWidth: 1, borderRadius: 12, borderColor: colors.border, backgroundColor: colors.surface1, paddingHorizontal: 12, paddingVertical: 10 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {state === 'starting' || state === 'running' ? <ActivityIndicator size={12} color={colors.accent}/> : <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }}/>}
      <Pressable accessibilityRole="button" disabled={!view.agentId} onPress={open} style={{ minWidth: 0, flex: 1 }}><Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: '500' }}>{title}</Text></Pressable>
      <Text numberOfLines={1} style={{ color: colors.foregroundMuted, maxWidth: '55%', flexShrink: 1, fontSize: 11 }}>{meta}</Text>
    </View>
    {secondary ? <Text numberOfLines={state === 'unknown' ? undefined : 2} style={{ marginTop: 4, color: state === 'failed' ? colors.statusDanger : colors.foregroundMuted, fontSize: state === 'completed' ? 13 : 12, lineHeight: 19 }}>{secondary}</Text> : null}
    {noteOpen && <TextInput autoFocus accessibilityLabel={t('addNote')} value={note} maxLength={4000} editable={!controller.busy} onChangeText={setNote} onSubmitEditing={submit} placeholder={t('addNotePlaceholder')} placeholderTextColor={colors.foregroundMuted} style={{ marginTop: 8, height: 32, paddingHorizontal: 12, borderWidth: 1, borderRadius: 9999, borderColor: colors.border, color: colors.foreground, backgroundColor: colors.surface0, fontSize: 12 }}/>}
    {expanded && hasResult && <View style={{ marginTop: 8, paddingTop: 8, gap: 8, borderTopWidth: 1, borderColor: colors.border }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 21 }}>{resultText || t('noWrittenResult')}</Text>
      {files.map(path => <Pressable key={path} accessibilityRole="button" onPress={() => openFile(path)}><Text style={{ color: colors.foreground, fontSize: 13, textDecorationLine: 'underline' }}>{path.split(/[\\/]/).at(-1)}</Text></Pressable>)}
      {!receipt && taskError && <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{taskError}</Text>}
    </View>}
    <View style={{ marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      {state === 'waiting' && view.agentId && <Chip label={t('lookAt')} icon="Eye" onPress={open}/>}
      {(state === 'running' || state === 'starting') && view.agentId && <Chip label={t('watchWork')} icon="SquareArrowOutUpRight" onPress={open}/>}
      {!receipt && view.canAddNote && <Chip label={t('addNote')} icon="Megaphone" disabled={controller.busy} onPress={() => { if (current()) setNoteOpen(value => !value); }}/>}
      {!live && files.length > 0 && <Chip label={t('artifactCount', { count: files.length })} icon="FileText" onPress={() => { if (current()) setExpanded(true); }}/>}
      <View style={{ marginLeft: 'auto', flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
        {!live && hasResult && <Chip label={t(state === 'completed' ? expanded ? 'collapseResult' : 'expandResult' : expanded ? 'collapseDetails' : 'expandDetails')} icon={expanded ? 'ChevronUp' : 'ChevronDown'} onPress={() => { if (current()) setExpanded(value => !value); }}/>}
        {!live && view.agentId && <Chip label={t('watchWork')} icon="SquareArrowOutUpRight" onPress={open}/>}
        {!receipt && view.canResume && <Chip label={t('resume')} icon="Play" disabled={controller.busy} onPress={resume}/>}
        {!receipt && view.canStop && <Chip label={t('stop')} icon="Square" danger disabled={controller.busy} onPress={stop}/>}
      </View>
    </View>
    {notice && <Text accessibilityRole="text" style={{ marginTop: 6, color: colors.foregroundMuted, fontSize: 11 }}>{notice}</Text>}
    {alert && <View style={{ marginTop: 6, gap: 6 }}><Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 11 }}>{alert}</Text>{controller.readError && <Chip label={t('retry')} onPress={controller.refresh}/>}</View>}
  </View>;
}
