import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useAuth } from '@/contexts/AuthContext';
import { showHostSettingsNotice } from '@/features/bots/paseoHostStatus';
import { Button } from '@/components/ui/button';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { normalizeBotName } from '../../../shared/botCreation';
import { BOT_PORTRAIT_COUNT, BotPortraitPicker, galleryPortrait } from './BotPortraitPicker';
import { addBotProfileAndWait, BotModelSelectionRequiredError, getEffectiveBotModelChain, subscribeBotGlobalModel, useBotProfiles, type BotProfile } from './botStore';
import { useProviders } from '@/hooks/useProviders';
import { BotModelChainEditor } from './BotModelChainEditor';
import type { BotModelRoute } from '../../../shared/botModelChain';

// Only the provider-setup detour retains a draft; ordinary close/unmount discards it.
let providerSetupDraft: {
  owner: DataOwnerGeneration;
  dataOwnerId: string | null;
  name: string;
  portrait?: string;
  initialPortrait: number;
  modelOverride: BotModelRoute[] | null;
} | null = null;

interface BotRosterViewProps {
  onCreated?: (bot: BotProfile) => void | Promise<void>;
  onClose?: () => void;
  restoreFocus?: () => void;
  inline?: boolean;
}

/** A name creates a usable profile; identity and working habits develop in its own chat. */
export function BotRosterView({ onCreated, onClose, restoreFocus, inline = false }: BotRosterViewProps = {}) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  useProviders();
  useSyncExternalStore(subscribeBotGlobalModel, () => JSON.stringify(getEffectiveBotModelChain()));
  const [restoredDraft] = useState(() => providerSetupDraft
    && providerSetupDraft.dataOwnerId === dataOwnerId
    && isDataOwnerGenerationCurrent(providerSetupDraft.owner) ? providerSetupDraft : null);
  useEffect(() => { providerSetupDraft = null; }, []);
  const [modelOverride, setModelOverride] = useState<BotModelRoute[] | null>(restoredDraft?.modelOverride ?? null);
  const importing = false;
  const [name, setName] = useState(restoredDraft?.name ?? '');
  const [portrait, setPortrait] = useState<string | undefined>(restoredDraft?.portrait);
  const [initialPortrait] = useState(() => restoredDraft?.initialPortrait ?? Math.floor(Math.random() * BOT_PORTRAIT_COUNT));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const preparingPortrait = useRef(false);
  const [portraitPreparing, setPortraitPreparing] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void galleryPortrait(initialPortrait).then(value => {
      if (!cancelled) setPortrait(current => current ?? value);
    }).catch(() => { if (!cancelled) setError(t('bots.profile.avatarSelectionFailed')); });
    return () => { cancelled = true; alive.current = false; };
  }, [initialPortrait]);
  const duplicate = bots.some(bot => bot.status !== 'archived' && normalizeBotName(bot.name) === normalizeBotName(name));
  const close = () => { if (submitting.current || preparingPortrait.current) return; alive.current = false; if (onClose) onClose(); else navigate('/bots'); };
  useEffect(() => {
    window.addEventListener('cindy-request-close', close);
    return () => window.removeEventListener('cindy-request-close', close);
  });
  const create = async () => {
    if (!name.trim() || duplicate || submitting.current || preparingPortrait.current || !portrait) return;
    submitting.current = true;
    setCreating(true);
    setError(null);
    const owner = getDataOwnerGeneration();
    try {
      const bot = await addBotProfileAndWait({ name: name.trim(), description: '',
        ...(modelOverride ? { capabilities: { ...modelOverride[0], modelChain: modelOverride, modelChainOverride: modelOverride } } : {}),
        avatarImageBase64: portrait.split(',')[1], prepareInvitation: true });
      if (!alive.current || !isDataOwnerGenerationCurrent(owner)) return;
      if (onCreated) await onCreated(bot);
      else { navigate(`/bots/${bot.id}`); onClose?.(); }
    } catch (cause) {
      if (alive.current && isDataOwnerGenerationCurrent(owner)) setError(t(cause instanceof BotModelSelectionRequiredError
        ? 'bots.guided.modelRequired' : 'bots.createWizard.createFailed'));
    } finally {
      submitting.current = false;
      if (alive.current && isDataOwnerGenerationCurrent(owner)) setCreating(false);
    }
  };
  const title = t(importing ? 'bots.import.title' : 'bots.guided.title');
  const content = (
    <>
      <div className="mb-8 flex shrink-0 items-center justify-between gap-4">
        {inline ? (
          <h1 className="text-20 font-medium">{title}</h1>
        ) : (
          <Dialog.Title className="text-20 font-medium">{title}</Dialog.Title>
        )}
        {!inline && (
          <Button
            variant="secondary"
            size="lg"
            tone="quiet"
            type="button"
            onClick={close}
            disabled={creating}
          >
            {t('commonUi.confirmDialog.cancel')}
          </Button>
        )}
    </div>
    {<form onSubmit={event => { event.preventDefault(); void create(); }}>
      <div className="flex items-center gap-5">
        <BotPortraitPicker value={portrait} disabled={creating} onChange={setPortrait} onPreparingChange={pending => { preparingPortrait.current = pending; setPortraitPreparing(pending); }} />
        <label className="min-w-0 flex-1 text-13 text-[var(--text-secondary)]">
          {t('bots.creationName')}
          <input autoFocus value={name} maxLength={200} disabled={creating} onChange={event => setName(event.target.value)}
            className="mt-2 h-11 w-full rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)] px-3 text-16 text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" />
        </label>
      </div>
        <div className="mt-5">
          <BotModelChainEditor
            label={t('bots.settingsTabs.model')}
            value={(modelOverride ?? getEffectiveBotModelChain()).slice(0, 1)}
            disabled={creating}
            allowFallbacks={false}
            onChange={(routes) => { setModelOverride(routes.slice(0, 1)); setError(null); }}
            onNavigateToProviders={() => {
              providerSetupDraft = { owner: getDataOwnerGeneration(), dataOwnerId, name, portrait, initialPortrait, modelOverride };
              showHostSettingsNotice();
            }}
          />
          <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
            {t(modelOverride ? 'bots.guided.modelForThisBot' : 'bots.guided.modelFollowsDefault')}
          </p>
        </div>
        {(error || duplicate) && (
          <p role="alert" className="mt-4 text-13 text-[var(--text-danger)]">{duplicate ? t('bots.guided.duplicateName') : error}</p>
        )}
        <div className="mt-8 flex justify-between gap-3">
          <Button variant="secondary" size="lg" type="button" disabled title={t('paseoIntegration.importUnavailable')}>{t('bots.import.entry')}</Button>
          <Button
            variant="cta"
            size="lg"
            loading={creating}
            type="submit"
            disabled={creating || portraitPreparing || !name.trim() || duplicate || !portrait}
          >
            {t('bots.guided.generate')}
            <ArrowRight size={16} />
          </Button>
      </div>
    </form>}
    </>
  );
  if (inline)
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] px-6 text-[var(--text-primary)]"><div className={importing ? "flex max-h-[90vh] w-full max-w-lg flex-col" : "w-full max-w-lg"}>{content}</div></main>
    );
  return (
    <Dialog.Root open onOpenChange={open => { if (!open && !creating) close(); }}>
      <Dialog.Portal>
        {/* Keep portaled controls inside the overlay’s React tree so its scroll lock allows them. */}
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-50">
          <Dialog.Content aria-describedby={undefined} onPointerDownOutside={(event) => event.preventDefault()} onCloseAutoFocus={event => { if (restoreFocus) { event.preventDefault(); restoreFocus(); } }}
            className={`modal-panel fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-32px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 ${importing ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'} p-6 text-[var(--text-primary)] outline-none sm:p-8`}>
            {content}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
