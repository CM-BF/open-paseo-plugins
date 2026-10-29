// Extracted from Cindy BotsHomeView: original BotSettings JSX, autosave and navigation guards.
import { showHostSettingsNotice } from '@/features/bots/paseoHostStatus';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/input';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, Check, ChevronRight, FolderOpen } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBotTranslation } from './botPronounContext';
import { Spinner } from '@/components/ui/spinner';
import type { ConversationSearchJump } from '../../../shared/conversationSearchJump';
import { canonicalBotSessionId, type BotCapabilities, type BotProfile } from './botStore';
import { useBotSettingsTarget } from './useBotSettingsTarget';
import { BotPortraitPicker } from './BotPortraitPicker';
import { botSettingsIcons } from './botSettingsIcons';
import { BotAvatar } from './BotAvatar';
import { BotBasicProfileFields } from './BotBasicProfileFields';
import { normalizeBotName } from '../../../shared/botCreation';
import { useCompanionCloud } from './companionCloudStore';
import { cloudCompanionAt } from './cloudCompanionPresentation';
import { BotHomeComputerSetting } from './BotHomeComputerSetting';
import { CindyMergeSetting } from './CindyMergeSetting';
import { BotLifecycleSettings } from './BotLifecycleSettings';
import { BotInvitationWelcome } from './BotInvitationWelcome';
import { BotModelChainEditor } from './BotModelChainEditor';
import { BotTaskModelEditor } from './BotTaskModelEditor';
import { BotCapabilitySettings } from './BotCapabilitySettings';
import { BotRoutines } from './BotRoutines';
import { BotAutonomySettings } from './BotAutonomySettings';
import { BotMemorySettings } from './BotMemorySettings';
import { CompanionVoiceSettings } from './voice/CompanionVoiceSettings';
import { BotChannelsPage } from './BotChannelsPage';
import { botSettingsChanges, normalizeBotSettingsPayload, reconcileBotSettingsDraft, type BotSettingsPayload } from './botSettingsAutosave';
import { useBotSettingsAutosave } from './useBotSettingsAutosave';
export function BotSettings({
  bot,
  onBack,
  onOpenSession,
  beforeCloseRef,
  initialPage = 'home',
}: {
  initialPage?: 'home' | 'memory' | 'capabilities' | 'model' | 'voice' | 'channels';
  bot: BotProfile;
  beforeCloseRef?: { current: (() => Promise<boolean>) | null };
  onBack: () => void;
  onOpenSession: (sessionId: string, searchJump?: ConversationSearchJump) => void;
}) {
  const { t } = useBotTranslation();
  const navigate = useNavigate();
  // The computer these pages read from and write to: this one, or the teammate's own computer.
  const target = useBotSettingsTarget();
  const isRemote = target.kind === 'remote';
  const cloud = useCompanionCloud();
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const profiles = target.useRoster();
  // Same identity rule as creation and the host: NFKC, trimmed, case-insensitive.
  const nameTaken = !!name.trim() && profiles.some((other) => other.id !== bot.id && other.status !== 'archived'
    && normalizeBotName(other.name) === normalizeBotName(name));
  const [portraitRetryFailed, setPortraitRetryFailed] = useState(false);
  const [identitySource, setIdentitySource] = useState(bot.identitySource ?? '');
  const [userContextSource, setUserContextSource] = useState(bot.userContextSource ?? '');
  const [avatar, setAvatar] = useState(bot.avatar);
  const [avatarColor, setAvatarColor] = useState(bot.avatarColor);
  const [selectedSkills, setSelectedSkills] = useState<string[]>(bot.skills);
  const [capabilities, setCapabilities] = useState<BotCapabilities>(bot.capabilities);
  // Live defaults are display state, not form edits: refreshing them must not
  // dirty autosave or overwrite a model override / pending text edits.
  const hiddenVendors = target.useHiddenVendors();
  const defaultModelChain = target.useDefaultModelChain();
  const displayedModelChain =
    capabilities.modelChainOverride === null
      ? defaultModelChain
      : capabilities.modelChain;
  const [page, setPage] = useState<
    | 'home'
    | 'profile'
    | 'personality'
    | 'model'
    | 'voice'
    | 'capabilities'
    | 'channels'
    | 'history'
    | 'advanced'
    | 'routines'
    | 'memory'
    | 'projects'
  >(initialPage);
  const voiceLeaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const routineLeaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const routineBackRef = useRef<(() => Promise<boolean>) | null>(null);
  const memoryLeaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const memoryBackRef = useRef<(() => Promise<boolean>) | null>(null);
  const pageTitle =
    page === 'projects' ? t('bots.projects.title') : page === 'voice'
      ? t('bots.voiceMode.settingsTitle')
      : page === 'channels'
        ? t('bots.channels.title')
        : page === 'memory'
          ? t('bots.memory.title')
          : page === 'model'
            ? t('bots.settingsTabs.model')
            : page === 'routines'
              ? t('routines.title')
              : page === 'history'
                ? t('bots.historySearch.title')
                : page === 'advanced'
                  ? t('bots.homeFolder.title')
                  : page === 'capabilities'
                    ? t('bots.capabilities.title')
                    : page === 'personality'
                      ? t('bots.profile.personality')
                      : t('bots.profile.title');
  const [folderError, setFolderError] = useState<string | null>(null);
  const avatarInFlight = useRef(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  // 只在切到另一个 Bot 时重灌表单。自动保存下 `bot` 每次落库(以及失败回滚)都会
  // 换一个新对象,若仍按对象身份重灌,用户在提交在途期间敲的字会被服务端快照盖掉,
  // 失败回滚时更会把刚改的内容整批还原 —— 那是比「忘记点保存」更严重的丢字。
  // 页面挂载期间本地 state 才是编辑权威;`bot.channels` / `bot.sessions` 等非表单
  // 字段仍直接读 prop,保持实时。
  const botIdentityRef = useRef(bot.id);
  const reconciledBotRef = useRef(bot);
  const savingProfileRef = useRef(false);
  const savedSettingsRef = useRef(
    normalizeBotSettingsPayload(
      {
        name,
        description,
        identitySource,
        userContextSource,
        avatar,
        avatarColor,
        capabilities,
        skills: selectedSkills,
      },
      bot.name,
    ),
  );
  const commitProfile = useCallback(
    async (payload: BotSettingsPayload) => {
      savingProfileRef.current = true;
      try {
        await target.profile.update(bot.id, botSettingsChanges(savedSettingsRef.current, payload, true));
        savedSettingsRef.current = payload;
      } finally {
        savingProfileRef.current = false;
      }
    },
    [bot.id, target],
  );

  const autosave = useBotSettingsAutosave({
    draft: {
      name,
      description,
      identitySource,
      userContextSource,
      avatar,
      avatarColor,
      capabilities,
      skills: selectedSkills,
    },
    // The last confirmed save, which a cleared field keeps (the prop can lag behind it).
    fallbackName: savedSettingsRef.current.name,
    // 归档 bot 的设置页是只读的(不渲染任何表单字段),自动保存不得为它引入写入。
    enabled: bot.status !== 'archived',
    baseline: savedSettingsRef,
    commit: commitProfile,
  });

  const canLeave = useCallback(async () => {
    if (avatarInFlight.current) return false;
    await autosave.flush();
    if (autosave.isDirty()) return false;
    if (!((await voiceLeaveRef.current?.()) ?? true)) return false;
    if (!((await memoryLeaveRef.current?.()) ?? true)) return false;
    return (await routineLeaveRef.current?.()) ?? true;
  }, [autosave.flush, autosave.isDirty]);
  useEffect(() => {
    if (!beforeCloseRef) return;
    beforeCloseRef.current = canLeave;
    return () => {
      beforeCloseRef.current = null;
    };
  }, [beforeCloseRef, canLeave]);
  // Opening a page unmounts the row that had focus; move it to the page's back
  // button, and back to the originating row on return.
  const pageBackButtonRef = useRef<HTMLButtonElement>(null);
  const settingsRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusRowRef = useRef<string | null>(null);
  const pageFocusPendingRef = useRef(false);
  const showPage = (next: typeof page) => {
    if (page === 'home' && next !== 'home') returnFocusRowRef.current = next;
    pageFocusPendingRef.current = true;
    setPage(next);
  };
  useEffect(() => {
    if (!pageFocusPendingRef.current) return;
    pageFocusPendingRef.current = false;
    if (page !== 'home') pageBackButtonRef.current?.focus();
    else if (returnFocusRowRef.current)
      settingsRowRefs.current.get(returnFocusRowRef.current)?.focus();
  }, [page]);
  const go = (next: typeof page) => {
    if (!autosave.isDirty() && !routineLeaveRef.current && !memoryLeaveRef.current && !voiceLeaveRef.current) {
      showPage(next);
      return;
    }
    void canLeave().then((allowed) => {
      if (allowed) showPage(next);
    });
  };
  useEffect(() => {
    // Store props include optimistic writes and rollback. Reconcile only after
    // our save settles, retaining edits typed while that request was in flight.
    if (savingProfileRef.current || reconciledBotRef.current === bot) return;
    const incoming = normalizeBotSettingsPayload(
      {
        ...bot,
        identitySource: bot.identitySource ?? '',
        userContextSource: bot.userContextSource ?? '',
      },
      bot.name,
    );
    const next =
      botIdentityRef.current === bot.id
        ? reconcileBotSettingsDraft(
            savedSettingsRef.current,
            {
              name,
              description,
              identitySource,
              userContextSource,
              avatar,
              avatarColor,
              capabilities,
              skills: selectedSkills,
            },
            incoming,
          )
        : incoming;
    botIdentityRef.current = bot.id;
    reconciledBotRef.current = bot;
    savedSettingsRef.current = incoming;
    setName(next.name);
    setDescription(next.description);
    setIdentitySource(next.identitySource);
    setUserContextSource(next.userContextSource);
    setAvatar(next.avatar);
    setAvatarColor(next.avatarColor);
    setSelectedSkills(next.skills);
    setCapabilities(next.capabilities);
  }, [bot, autosave.status]);

  const updateCapability = <K extends keyof BotCapabilities>(key: K, value: BotCapabilities[K]) => {
    setCapabilities((current) => ({
      ...current,
      [key]: value,
      ...(key === 'fastMode' && current.modelOverride
        ? { modelOverride: { ...current.modelOverride, fastMode: value === 'ultrafast' ? 'ultrafast' : value === true } }
        : {}),
    }));
    autosave.onEdit('instant');
  };
  const handleBack = () => {
    void canLeave().then((allowed) => {
      if (allowed) onBack();
    });
  };
  // A cleared name is never saved (the previous one stays), so show that one
  // everywhere and restore it to the field once editing ends.
  const displayName = name.trim() || savedSettingsRef.current.name;
  const handleNameBlur = () => {
    if (name !== displayName) setName(displayName);
    void autosave.flush();
  };
  const handleDescriptionBlur = () => {
    const trimmed = description.trim();
    if (trimmed !== description) setDescription(trimmed);
    void autosave.flush();
  };

  if (bot.status === 'archived') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto flex max-w-xl flex-col gap-5">
          <header className="flex items-center gap-3">
            <BotAvatar bot={bot} size="lg" />
            <div>
              <p className="text-12 font-medium uppercase tracking-[0.16em] text-[var(--text-tertiary)]">
                {t('bots.lifecycle.stoppedTitle')}
              </p>
              <h1 className="mt-1 text-24 font-medium text-[var(--text-primary)]">{bot.name}</h1>
              {bot.description ? (
                <p className="mt-1 text-12 text-[var(--text-secondary)]">{bot.description}</p>
              ) : null}
            </div>
          </header>
          <BotLifecycleSettings bot={bot} onOpenSession={onOpenSession} />
        </div>
      </div>
    );
  }

  const handleChooseAvatar = async (portrait: string) => {
    if (avatarInFlight.current) return;
    avatarInFlight.current = true;
    setAvatarBusy(true);
    setAvatarError(false);
    try {
      await autosave.flush();
      if (autosave.isDirty()) return;
      // The picker chooses and crops on this computer; the teammate's own computer saves the image.
      const next = await target.profile.chooseAvatar(bot.id, portrait.split(',')[1]);
      if (!next) return;
      setAvatar(next.avatar);
      setAvatarColor(next.avatarColor);
    } catch {
      setAvatarError(true);
    } finally {
      avatarInFlight.current = false;
      setAvatarBusy(false);
    }
  };

  const avatarPicker = (
    <BotPortraitPicker
      disabled={avatarBusy}
      onChange={portrait => void handleChooseAvatar(portrait)}
      trigger={
        <button
          type="button"
          disabled={avatarBusy}
          aria-label={t('bots.profile.changeAvatar')}
          className="relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50"
        >
          <BotAvatar bot={{ name: displayName, avatar, avatarColor, deviceId: target.deviceId }} size="xl" />
          <span className="absolute bottom-0 right-0 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)]">
            <Camera size={12} aria-hidden="true" />
          </span>
        </button>
      }
    />
  );

  const invitationPending = bot.invitation && bot.invitation.stage !== 'ready'
    && !(bot.invitation.stage === 'avatar' && bot.canonicalSessionId);

  const settingsRows = ([
    ['profile', botSettingsIcons.profile, t('bots.profile.title')],
    ['personality', botSettingsIcons.personality, t('bots.profile.personality')],
    ['memory', botSettingsIcons.memory, t('bots.memory.title')],
    ['projects', botSettingsIcons.projects, t('bots.projects.title')],
    ['model', botSettingsIcons.model, t('bots.settingsTabs.model')],
    ['voice', botSettingsIcons.voice, t('bots.voiceMode.settingsTitle')],
    ['capabilities', botSettingsIcons.capabilities, t('bots.capabilities.title')],
    ['channels', botSettingsIcons.channels, t('bots.channels.title')],
    ['routines', botSettingsIcons.routines, t('routines.title')],
    ['history', botSettingsIcons.history, t('bots.historySearch.title')],
    // The Home folder is a path on the teammate's own computer.
    ['advanced', botSettingsIcons.advanced, t('bots.homeFolder.title')],
  ] as const).filter(([id]) => target.pages.has(id));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-8">
      <div className="mx-auto w-full max-w-xl">
        {invitationPending && (page === 'home' || page === 'model') ? (
          <BotInvitationWelcome bot={bot}
            onConfigureModel={page === 'model' ? undefined : () => go('model')}
            onRetry={async () => {
              // A retry must use the confirmed selection, never race an autosave.
              if (!await canLeave()) throw new Error('Bot settings have not been saved');
              await target.profile.retryInvitation(bot.id);
            }} />
        ) : null}
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-3">
          {page !== 'home' ? (
            <div className="flex min-w-0 items-center gap-2">
              <button
                ref={pageBackButtonRef}
                type="button"
                onClick={() =>
                  void (async () => {
                    if (page === 'memory' && (await memoryBackRef.current?.())) return;
                    if (page === 'routines' && (await routineBackRef.current?.())) return;
                    go('home');
                  })()
                }
                aria-label={t('bots.settingsBack')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <ArrowLeft size={18} />
              </button>
              <h2 className="text-14 font-medium text-[var(--text-primary)]">{pageTitle}</h2>
            </div>
          ) : (
            <span />
          )}
          {nameTaken ? (
            // The host rejects the rename; say why instead of a generic save failure and a futile retry.
            <p className="text-11 text-[var(--text-danger)]" role="alert">
              {t('bots.guided.duplicateName')}
            </p>
          ) : autosave.status === 'saving' ? (
            <span
              role="status"
              className="inline-flex items-center gap-1 text-11 text-[var(--text-tertiary)]"
            >
              <Spinner size={12} /> {t('bots.autosave.saving')}
            </span>
          ) : autosave.status === 'saved' ? (
            <span
              role="status"
              className="inline-flex animate-fade-in items-center gap-1 text-11 text-[var(--text-tertiary)]"
            >
              <Check size={12} /> {t('bots.autosave.saved')}
            </span>
          ) : autosave.status === 'error' ? (
            <p className="flex items-center gap-2 text-11 text-[var(--text-danger)]" role="alert">
              {t('bots.profileSaveFailed')}
              <button
                type="button"
                onClick={() => void autosave.retry()}
                className="font-medium text-[var(--text-primary)]"
              >
                {t('bots.autosave.retry')}
              </button>
            </p>
          ) : null}
        </div>
        {page === 'home' ? (
          <>
            <div className="flex flex-col items-center pb-6 pt-2 text-center">
              {avatarPicker}
              <h1 className="mt-2 max-w-full break-words text-18 font-medium text-[var(--text-primary)]">
                {displayName}
              </h1>
              {avatarError ? (
                <p className="mt-2 text-12 text-[var(--text-danger)]" role="alert">
                  {t('bots.profile.avatarFailed')}
                </p>
              ) : null}
            </div>
            <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
              {settingsRows.map(([next, Icon, title]) => (
                <button
                  key={next}
                  ref={(node) => {
                    if (node) settingsRowRefs.current.set(next, node);
                    else settingsRowRefs.current.delete(next);
                  }}
                  type="button"
                  onClick={() => void go(next)}
                  className="flex min-h-12 w-full items-center gap-3 border-b border-[var(--border-default)] px-4 py-3 text-left text-14 text-[var(--text-primary)] outline-none last:border-b-0 hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                >
                  <Icon size={18} className="shrink-0 text-[var(--text-secondary)]" />
                  <span className="min-w-0 flex-1">{title}</span>
                  <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                </button>
              ))}
            </div>
            {!isRemote ? (
              <>
                <BotHomeComputerSetting bot={bot} />
                <CindyMergeSetting bot={bot} />
              </>
            ) : cloudCompanionAt(cloud, target.deviceId!, bot.id) ? (
              // The main computer can be changed from any computer (it is asked to hand the companion over).
              <>
                <BotHomeComputerSetting bot={{ id: bot.id, name: bot.name }} />
                <CindyMergeSetting bot={{ id: bot.id, name: bot.name }} />
              </>
            ) : (
              <p className="mt-4 truncate text-12 text-[var(--text-tertiary)]">{target.deviceName}</p>
            )}
            <div className="mt-6">
              <BotLifecycleSettings
                bot={bot}
                onOpenSession={onOpenSession}
                mode="actions"
                beforeAction={canLeave}
                onDeleted={() => navigate('/bots', { replace: true })}
              />
            </div>
          </>
        ) : null}
        <div hidden={page !== 'profile'} className="pt-3">
          <BotBasicProfileFields
            centeredAvatar
            readOnly={!!invitationPending}
            value={{ name, description, avatar, avatarColor }}
            avatarControl={avatarPicker}
            composition={autosave.composition}
            onNameBlur={handleNameBlur}
            onDescriptionBlur={handleDescriptionBlur}
            onChange={(next, kind) => {
              setName(next.name);
              setDescription(next.description);
              setAvatar(next.avatar);
              setAvatarColor(next.avatarColor);
              autosave.onEdit(kind);
            }}
          />
          {bot.invitation?.avatarSkipped ? (
            <p className="text-12 text-[var(--text-tertiary)]">
              {t('bots.invitation.avatarSkipped')}
              <button
                type="button"
                onClick={() => {
                  setPortraitRetryFailed(false);
                  void target.profile.retryInvitation(bot.id).catch(() => setPortraitRetryFailed(true));
                }}
                disabled={bot.invitation.stage === 'avatar'}
                className="ml-2 text-[var(--text-primary)] underline underline-offset-2 disabled:opacity-50"
              >
                {t('commonUi.retry')}
              </button>
              {portraitRetryFailed ? (
                <span role="alert">{t('bots.invitation.retryFailed')}</span>
              ) : null}
            </p>
          ) : null}
          {avatarError ? (
            <p className="text-center text-11 text-[var(--text-danger)]" role="alert">
              {t('bots.profile.avatarFailed')}
            </p>
          ) : null}
        </div>
        <div hidden={page !== 'personality'} className="pt-3">
          <Textarea
            aria-label={t('bots.profile.personality')}
            readOnly={!!invitationPending}
            value={identitySource}
            onChange={(next) => {
              setIdentitySource(next);
              autosave.onEdit('text');
            }}
            onBlur={() => void autosave.flush()}
            {...autosave.composition}
            rows={6}
            className="min-h-40 resize-none p-3 leading-6 [field-sizing:content]"
          />
        </div>
        <section
          hidden={page !== 'model'}
          className="pt-3"
          aria-label={t('bots.settingsTabs.model')}
        >
          <div data-testid="bot-model-controls" className="min-w-0">
            <div data-testid="bot-primary-model-controls">
              <BotModelChainEditor
                label={t('bots.model.primary')}
                hiddenVendors={hiddenVendors}
                deviceId={target.deviceId}
                onRestoreDefault={() => {
                  const modelChain = defaultModelChain;
                  const primary = modelChain[0];
                  setCapabilities((current) => ({
                    ...current,
                    ...(primary ?? { model: '', providerId: null, effort: '', fastMode: false }),
                    modelOverride: null,
                    modelChain,
                    modelChainOverride: null,
                  }));
                  autosave.onEdit('instant');
                }}
                value={displayedModelChain}
                onChange={(modelChain) => {
                  const primary = modelChain[0];
                  if (!primary) return;
                  setCapabilities((current) => ({
                    ...current,
                    ...primary,
                    modelChain,
                    modelChainOverride: modelChain,
                    modelOverride: {
                      model: primary.model,
                      providerId: primary.providerId,
                      effort: primary.effort,
                      fastMode: primary.fastMode,
                    },
                  }));
                  autosave.onEdit('instant');
                }}
              />
            </div>
            <BotTaskModelEditor value={capabilities.taskModelOverride ?? null}
              inheritedRoute={displayedModelChain[0]} hiddenVendors={hiddenVendors} deviceId={target.deviceId}
              onChange={taskModelOverride => {
                setCapabilities(current => ({ ...current, taskModelOverride }));
                autosave.onEdit('instant');
              }} />
          </div>
        </section>
        {page === 'capabilities' && (
          <div>
            <BotCapabilitySettings
              // These open the settings of the computer this window runs on, not the teammate's.
              onConfigure={isRemote ? undefined : (kind, id) => {
                void canLeave().then(ok => {
                  if (!ok) return;
                  const toolSettings: Record<string, string> = {
                    browser: 'computer-use', computer: 'computer-use', android: 'computer-use',
                    contacts: 'personalization&section=personalization.contacts',
                    ssh: 'remote-control&section=remoteControl.ssh',
                    slack: 'im-bot&section=imBot.cindy.slack', feishu_bot: 'im-bot', wechat: 'im-bot',
                  };
                  showHostSettingsNotice();
                });
              }}
              expanded={page === 'capabilities'}
              bot={bot}
              capabilities={capabilities}
              skills={selectedSkills}
              onChange={(kind, values) => {
                if (kind === 'skill') setSelectedSkills(values);
                setCapabilities((current) => ({
                  ...current,
                  ...(kind === 'skill'
                    ? { skillMode: 'allowlist' as const }
                    : kind === 'mcp'
                      ? { mcpMode: 'allowlist' as const, mcpServers: values }
                      : { toolsetMode: 'allowlist' as const, toolsets: values }),
                }));
                autosave.onEdit('instant');
              }}
            />
            <div className="mt-5 flex items-start gap-3 border-t border-[var(--border-default)] pt-4">
              <div className="min-w-0 flex-1">
                <p className="text-13 font-medium text-[var(--text-primary)]">{t('bots.capabilities.inputHandoff.title')}</p>
                <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{t('bots.capabilities.inputHandoff.description')}</p>
              </div>
              <Switch
                aria-label={t('bots.capabilities.inputHandoff.title')}
                className="mt-0.5 shrink-0"
                checked={capabilities.inputHandoff !== false}
                onCheckedChange={(value) => updateCapability('inputHandoff', value === true)}
              />
            </div>
          </div>
        )}
        {page === 'channels' ? <BotChannelsPage bot={bot} /> : null}
        {page === 'history' ? (
          <BotLifecycleSettings
            bot={bot}
            mode="history"
            onOpenSession={(...args) => {
              void canLeave().then((ok) => {
                if (ok) onOpenSession(...args);
              });
            }}
          />
        ) : null}
        {page === 'advanced' ? (
          <div className="mt-4 flex flex-col gap-5 px-3">
            <div className="flex items-center gap-3">
              <FolderOpen size={16} className="shrink-0 text-[var(--text-tertiary)]" />
              <div className="min-w-0 flex-1">
                <Button
                  variant="secondary"
                  size="lg"
                  compact
                  type="button"
                  disabled={!bot.homeDir}
                  onClick={() => {
                    if (!bot.homeDir) return;
                    setFolderError(null);
                    void window.electronAPI.openPath(bot.homeDir).then((result) => {
                      if (shouldShowOpenPathError(result))
                        setFolderError(result.error ?? t('bots.homeFolder.openFailed'));
                    });
                  }}
                >
                  {t('bots.homeFolder.open')}
                </Button>
                {folderError ? (
                  <p className="mt-2 text-11 text-[var(--text-danger)]" role="alert">
                    {folderError}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {page === 'voice' ? (
          <CompanionVoiceSettings botId={bot.id} sessionId={canonicalBotSessionId(bot) ?? undefined}
            beforeLeaveRef={voiceLeaveRef}
            // Providers are connected in the settings of the computer the teammate runs on.
            onOpenProviders={isRemote ? undefined : () => {
              void canLeave().then((allowed) => {
                if (allowed) showHostSettingsNotice();
              });
            }} />
        ) : null}
        {page === 'memory' ? (
          <BotMemorySettings
            botId={bot.id}
            botName={name}
            memoryEnabled={capabilities.memory}
            onMemoryEnabledChange={(enabled) => updateCapability('memory', enabled)}
            aboutMe={{
              value: userContextSource,
              readOnly: !!invitationPending,
              onChange: (next) => {
                setUserContextSource(next);
                autosave.onEdit('text');
              },
              onBlur: () => void autosave.flush(),
              composition: autosave.composition,
            }}
            backRef={memoryBackRef}
            leaveRef={memoryLeaveRef}
          />
        ) : null}
        {page === 'routines' ? (
          <BotRoutines
            embedded
            botId={bot.id}
            inheritedRoute={displayedModelChain[0]}
            beforeLeaveRef={routineLeaveRef}
            backRef={routineBackRef}
            header={
              <BotAutonomySettings
                botId={bot.id}
                botName={displayName}
                allowSchedulerFollow={capabilities.allowSchedulerFollow === true}
                onAllowSchedulerFollowChange={(value) => updateCapability('allowSchedulerFollow', value)}
              />
            }
          />
        ) : null}
      </div>
      <button type="button" onClick={handleBack} className="sr-only">
        {t('bots.backToChat')}
      </button>
    </div>
  );
}
