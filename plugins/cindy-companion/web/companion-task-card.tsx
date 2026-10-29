// Original BotCollaborationCard JSX; only host projections and mutation boundaries are replaced.
import { useId, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Eye, FileText, Megaphone, Square, SquareArrowOutUpRight, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { executionErrorText, executionMessage } from '../shared/execution-notice';
import { Spinner } from '../vendor/renderer/components/ui/spinner';
import { cn } from '../vendor/renderer/lib/utils';
import { useBotGroupNow } from '../vendor/renderer/features/bots/BotGroupElapsed';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '../vendor/renderer/contexts/dataOwnerGeneration';
import { BOT_INTERJECTION_MAX_CHARS } from '../shared/vendor/botCollaboration';
import { MarkdownRenderer } from './adapters/memory-markdown';
import type { CompanionTaskCardView, CompanionTaskCardActions } from './task-card-model';
export function formatBotCollaborationDuration(
  t: (key: string, options?: Record<string, unknown>) => string,
  startedAt: number,
  endedAt: number,
): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return t('bots.collab.duration.seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('bots.collab.duration.minutes', { n: minutes });
  if (seconds >= 86_400) {
    return t('bots.collab.duration.daysHoursMinutes', {
      d: Math.floor(seconds / 86_400),
      h: Math.floor((seconds % 86_400) / 3_600),
      m: minutes % 60,
    });
  }
  return t('bots.collab.duration.hoursMinutes', {
    h: Math.floor(minutes / 60),
    m: minutes % 60,
  });
}

type CardState = 'starting' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown';

const HARNESS_LABEL: Record<string, string> = { cc: 'Claude Code', codex: 'Codex', pi: 'Pi' };

function Chip({
  children,
  onClick,
  tone = 'default',
  disabled,
  expanded,
  controls,
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      aria-controls={controls}
      className={cn(
        'inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-full bg-[var(--surface-chip)] px-2.5 text-11 transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-default disabled:opacity-50',
        tone === 'danger'
          ? 'text-[var(--error-fg)]'
          : 'text-[var(--text-secondary)] enabled:hover:text-[var(--text-primary)]',
      )}
    >
      {children}
    </button>
  );
}

function StatusGlyph({ state }: { state: CardState }) {
  if (state === 'starting' || state === 'running') {
    return <Spinner size={12} className="shrink-0 text-[var(--status-bar-accent)]" aria-hidden="true" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-[7px] shrink-0 rounded-full',
        state === 'waiting' && 'bg-[var(--status-info)]',
        state === 'completed' && 'bg-[var(--status-success)]',
        state === 'failed' && 'bg-[var(--error-fg)]',
        (state === 'cancelled' || state === 'unknown') && 'bg-[var(--text-tertiary)]',
      )}
    />
  );
}


export function CompanionTaskCard({ view, actions, attached = false, inset = false }: {
  view: CompanionTaskCardView; actions: CompanionTaskCardActions; attached?: boolean; inset?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [resultOpen, setResultOpen] = useState(attached), [noteOpen, setNoteOpen] = useState(false), [note, setNote] = useState('');
  const [pending, setPending] = useState(false), [actionError, setActionError] = useState<string | null>(null), [queuedNotice, setQueuedNotice] = useState('');
  const owner = getDataOwnerGeneration();
  const scope = useMemo(() => ({ active: false, busy: false, owner }), [view.id, view.receipt?.runSequence, owner.dataOwnerId, owner.generation]);
  const current = () => scope.active && isDataOwnerGenerationCurrent(scope.owner);
  useLayoutEffect(() => {
    scope.active = true; setPending(false); setActionError(null); setQueuedNotice(''); setNote(''); setNoteOpen(false); setResultOpen(attached);
    return () => { scope.active = false; };
  }, [scope]);
  const frozen = view.receipt;
  const state: CardState = frozen ? frozen.status === 'completed' ? 'completed' : frozen.status === 'cancelled' ? 'cancelled' : 'failed' : view.state;
  const live = state === 'starting' || state === 'running' || state === 'waiting';
  const active = !frozen && view.canStop;
  const now = useBotGroupNow(live && !frozen);
  const resultId = useId();
  const card = { delegationId: view.id }, parentSessionId = view.id, childSessionId = view.agentId;
  const row = { pendingInteraction: { summary: view.waitingSummary } };
  const statusLabel = t(`bots.collab.status.${state === 'starting' ? 'queued' : state}`);
  const title = frozen?.title?.trim() || view.title || view.objective.trim().split('\n')[0] || t('bots.collab.backgroundTask');
  const harness = view.harness ? HARNESS_LABEL[view.harness] ?? view.harness : undefined;
  const elapsed = live && !frozen ? formatBotCollaborationDuration(t, view.acceptedAt ?? view.createdAt, now) : null;
  const took = !frozen && !live && view.completedAt != null ? formatBotCollaborationDuration(t, view.createdAt, view.completedAt) : null;
  const currentAction = view.currentAction || t('ccAgent.agentStatus.processing');
  const resultText = frozen ? frozen.text : view.resultText;
  const errorText = executionMessage(frozen ? frozen.error : view.errorCode ?? view.error, i18n.language);
  const files = frozen ? frozen.artifacts.map(file => file.absolutePath) : view.files;
  const fileCount = files.length, workingDir = frozen?.workingDir ?? view.workingDir;
  const stale = view.stale;
  const canOpen = Boolean(view.agentId), canAddNote = !frozen && state === 'running' && view.canAddNote;
  const resultLabel = state === 'completed' ? t(resultOpen ? 'bots.collab.collapseResult' : 'bots.collab.expandResult') : t(resultOpen ? 'bots.collab.collapseDetails' : 'bots.collab.expandDetails');
  const hasResultBody = Boolean(frozen) || state === 'completed' || state === 'failed' || state === 'cancelled';
  const open = () => { if (current() && canOpen) actions.open(); };
  const openFile = (path: string) => current() ? actions.openFile(path) : Promise.resolve();
  const stop = async () => {
    if (!current() || scope.busy || !active) return;
    scope.busy = true; setPending(true); setActionError(null);
    try { await actions.stop(); }
    catch (reason) { if (current()) setActionError(executionErrorText(reason)); }
    finally { scope.busy = false; if (current()) setPending(false); }
  };
  const resume = async () => {
    if (!current() || scope.busy || frozen || !view.canResume || !actions.resume) return;
    scope.busy = true; setPending(true); setActionError(null);
    try { await actions.resume(); } catch (reason) { if (current()) setActionError(executionErrorText(reason)); }
    finally { scope.busy = false; if (current()) setPending(false); }
  };
  const submitNote = async () => {
    const text = note.trim();
    if (!current() || scope.busy || !canAddNote || !text || text.length > BOT_INTERJECTION_MAX_CHARS) return;
    scope.busy = true; setPending(true); setActionError(null); setQueuedNotice('');
    try {
      const result = await actions.note(text);
      if (!current()) return;
      if (result.delivery === 'unknown') { setActionError(t('paseoTasks.noteUnknown')); return; }
      setNote(''); setNoteOpen(false);
      setQueuedNotice(t(result.delivery === 'queued' ? 'paseoWork.noteQueued' : 'bots.collab.addNoteSent'));
    } catch (reason) { if (current()) setActionError(executionErrorText(reason)); }
    finally { scope.busy = false; if (current()) setPending(false); }
  };
  const meta = [t('bots.collab.backgroundTask'), harness, took ? t('bots.collab.tookTime', { duration: took }) : null].filter(Boolean).join(' · ');
  let line2: ReactNode = null;
  if (state === 'running' || state === 'starting') {
    line2 = (
      <>
        <span className="min-w-0 truncate text-[var(--status-bar-accent)]">
          {state === 'starting' ? t('bots.collab.status.queued') : currentAction}
        </span>
        {elapsed ? (
          <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">
            · {t('bots.collab.elapsed', { duration: elapsed })}
          </span>
        ) : null}
      </>
    );
  } else if (state === 'waiting') {
    const summary = row?.pendingInteraction?.summary?.trim();
    line2 = (
      <span className="min-w-0 line-clamp-2 break-words">
        {summary
          ? t('bots.collab.awaitingConfirm', { summary })
          : t('bots.collab.awaitingConfirmGeneric')}
      </span>
    );
  } else if (state === 'completed' && resultText.trim() && !resultOpen) {
    line2 = (
      <span className="min-w-0 line-clamp-2 whitespace-pre-wrap break-words text-13 leading-[1.6] text-[var(--text-primary)]">
        {resultText.trim()}
      </span>
    );
  } else if (state === 'failed' && errorText && !resultOpen) {
    line2 = <span className="min-w-0 truncate text-[var(--error-fg)]">{errorText}</span>;
  }

  if (state === 'unknown') line2 = <span className="min-w-0 break-words">{errorText || t('paseoTasks.unknown')}</span>;
  return (
    <div
      data-bot-task-card={state}
      className={inset
        ? 'w-full min-w-0 rounded-lg bg-[var(--surface)] px-3 py-2.5'
        : 'my-2 w-full min-w-0 max-w-[560px] rounded-xl border border-[var(--msg-tool-card-border)] bg-[var(--msg-tool-card-bg)] px-3 py-2.5'}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusGlyph state={state} />
        <span className="sr-only">{statusLabel}</span>
        <button
          type="button"
          disabled={!canOpen}
          onClick={open}
          title={statusLabel}
          className="min-w-0 flex-1 truncate text-left text-13 font-medium text-[var(--text-primary)] underline-offset-[3px] enabled:hover:underline disabled:cursor-default"
        >
          {title}
        </button>
        {/* The title keeps its room in a narrow column (Thread open); the meta line gives way first. */}
        <span className="min-w-0 max-w-[55%] shrink truncate text-11 text-[var(--text-tertiary)]">{meta}</span>
      </div>
      {line2 ? (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
          {line2}
        </div>
      ) : null}
      {stale ? (
        <p className="mt-1 flex items-center gap-1.5 text-12 text-[var(--text-tertiary)]">
          <TriangleAlert size={12} aria-hidden="true" />
          {t('bots.collab.stale')}
        </p>
      ) : null}
      {noteOpen ? (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitNote();
          }}
        >
          <input
            autoFocus
            value={note}
            maxLength={BOT_INTERJECTION_MAX_CHARS}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setNoteOpen(false);
              }
            }}
            aria-label={t('bots.collab.addNote')}
            placeholder={t('bots.collab.addNotePlaceholder')}
            className="h-8 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
          />
        </form>
      ) : null}
      {resultOpen && hasResultBody ? (
        <div
          id={resultId}
          className="mt-2 space-y-2 border-t border-[var(--border-default)] pt-2 text-13 text-[var(--text-primary)]"
        >
          <>
              {resultText ? (
                <MarkdownRenderer
                  workingDir={workingDir}
                  currentSessionId={childSessionId ?? undefined}
                  renderRichAnswers
                  streamFadeKey={`bot-result:${childSessionId ?? parentSessionId}:${card.delegationId}`}
                  content={resultText}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                  {t('bots.collab.noWrittenResult')}
                </p>
              )}
              {files.map((path) => (
                <MarkdownRenderer
                  key={path}
                  onOpenLink={() => openFile(path)}
                  workingDir={workingDir}
                  currentSessionId={childSessionId ?? undefined}
                  content={`[${
                    path
                      .split(/[\\/]/)
                      .pop()
                      ?.replace(/[[\]\\]/g, '\\$&') ?? t('bots.collab.viewResult')
                  }](<${encodeURI(path).replace(/[<>?#]/g, encodeURIComponent)}>)`}
                />
              ))}
          </>
          {errorText ? (
            <details>
              <summary className="flex min-h-8 cursor-pointer items-center rounded-lg text-12 text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2">
                {t('appError.details')}
              </summary>
              <p className="whitespace-pre-wrap break-words text-12 text-[var(--text-secondary)]">
                {errorText}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
        {state === 'waiting' && canOpen ? (
          <Chip onClick={open}>
            <Eye size={12} aria-hidden="true" />
            {t('bots.collab.lookAt')}
          </Chip>
        ) : null}
        {(state === 'running' || state === 'starting') && canOpen ? (
          <Chip onClick={open}>
            <SquareArrowOutUpRight size={12} aria-hidden="true" />
            {t('bots.collab.watchWork')}
          </Chip>
        ) : null}
        {canAddNote ? (
          <Chip onClick={() => setNoteOpen((open) => !open)} expanded={noteOpen} disabled={pending}>
            <Megaphone size={12} aria-hidden="true" />
            {t('bots.collab.addNote')}
          </Chip>
        ) : null}
        {!live && fileCount > 0 ? (
          <Chip onClick={() => setResultOpen(true)} controls={resultId}>
            <FileText size={12} aria-hidden="true" />
            {t('bots.collab.artifactCount', { count: fileCount })}
          </Chip>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {!live && hasResultBody ? (
            <Chip
              onClick={() => setResultOpen((open) => !open)}
              expanded={resultOpen}
              controls={resultId}
            >
              {resultOpen ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
              {resultLabel}
            </Chip>
          ) : null}
          {!live && canOpen ? (
            <Chip onClick={open}>
              <SquareArrowOutUpRight size={12} aria-hidden="true" />
              {t('bots.collab.watchWork')}
            </Chip>
          ) : null}
          {!frozen && view.canResume && actions.resume ? <Chip disabled={pending} onClick={() => void resume()}>{t('paseoTasks.resume')}</Chip> : null}
          {active ? (
            <Chip
              tone="danger"
              disabled={pending}
              onClick={() => void stop()}
            >
              <Square size={12} aria-hidden="true" />
              {t('bots.collab.stop')}
            </Chip>
          ) : null}
        </span>
      </div>
      {queuedNotice ? <p role="status" className="mt-1.5 text-11 text-[var(--text-secondary)]">{queuedNotice}</p> : null}
      {actionError ? (
        <p role="alert" className="mt-1.5 text-11 text-[var(--error-fg)]">
          {executionMessage(actionError, i18n.language)}
        </p>
      ) : null}
    </div>
  );
}
