import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { i18n } from './adapters/i18n';
import { invoke, onInit, post, type Init } from './bridge';
import { setBootstrap, type BootstrapData } from './state';
import type { BotModelRoute } from '../shared/vendor/botModelChain';
import { BotSettingsDrawer } from '../vendor/renderer/features/bots/BotSettingsDrawer';
import { ConfirmDialogProvider } from '../vendor/renderer/components/ui/confirm-dialog-provider';
import { Tooltip } from '../vendor/renderer/components/ui/tooltip';
import { ToastContainer } from '../vendor/renderer/components/ui/toast';
import { Spinner } from '../vendor/renderer/components/ui/spinner';
import '../vendor/renderer/themes/colors';
import { themeService } from '../vendor/renderer/themes/theme-service';
import { cindyDark } from '../vendor/renderer/themes/builtin/cindy-dark';
import { cindyLight } from '../vendor/renderer/themes/builtin/cindy-light';
import { toast } from '../vendor/renderer/lib/toast';
import { loadOriginalFonts } from './font-loader';
import { GroupChat } from './group-chat';
import { BotGroupCreateDialog } from '../vendor/renderer/features/bots/BotGroupCreateDialog';
import { BotRosterView } from '../vendor/renderer/features/bots/BotRosterView';
import { BotMarketDialog } from '../vendor/renderer/features/bots/BotMarketDialog';
import { presetApi, openPresetCompanion } from './adapters/presets';
import { setDataOwnerGeneration } from '../vendor/renderer/contexts/dataOwnerGeneration';

function SettingsRoute() {
  const location=useLocation();
  useEffect(()=>{
    if(location.pathname.startsWith('/agent/')) {
      post('navigate-agent',{agentId:decodeURIComponent(location.pathname.slice(7))}); post('close');
    } else if(!new URLSearchParams(location.search).has('settings')) {
      post('close');
    }
  },[location.pathname,location.search]);
  return <BotSettingsDrawer/>;
}
function PresetsRoute({ packageId }: { packageId?: string }) {
  const alive = useRef(true);
  const close = () => { alive.current = false; post('close'); };
  useEffect(() => {
    alive.current = true;
    window.addEventListener('cindy-request-close', close);
    return () => { alive.current = false; window.removeEventListener('cindy-request-close', close); };
  }, []);
  return <BotMarketDialog api={presetApi} initialPackageId={packageId} onClose={close} onOpenBot={botId => openPresetCompanion(botId, () => alive.current)}/>;
}
function CreateGroupRoute() {
  return <BotGroupCreateDialog onOpenChange={open => { if (!open) post('close'); }} onCreated={groupId => { post('groups-changed'); post('navigate-group', { groupId }); }}/>;
}
function CreateTeammateRoute() {
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  return <BotRosterView onClose={() => { alive.current = false; post('close'); }} onCreated={bot => openPresetCompanion(bot.id, () => alive.current)}/>;
}
function initialRoute(init: Init) {
  if (init.view === 'presets') return <PresetsRoute packageId={init.packageId}/>;
  if (init.view === 'teammate-create') return <CreateTeammateRoute/>;
  if (init.view === 'group-create') return <CreateGroupRoute/>;
  if (init.view === 'group' && init.groupId) return <GroupChat key={init.groupId} groupId={init.groupId}/>;
  return <SettingsRoute/>;
}
function App() {
  const [status,setStatus]=useState<'waiting'|'loading'|'ready'|'error'>('waiting');
  const [error,setError]=useState('');
  const [router,setRouter]=useState<ReturnType<typeof createMemoryRouter>|null>(null);
  const cancelLoading=useRef<()=>void>(()=>{});
  const closeLoading=()=>{cancelLoading.current();post('close');};
  useEffect(()=>{
    let generation=0;
    let active:AbortController|null=null;
    const cleanup=onInit((init:Init)=>{
      active?.abort();
      const controller=new AbortController();active=controller;
      const own=++generation;
      cancelLoading.current=()=>{generation++;controller.abort();};
      setDataOwnerGeneration(init.host.id);
      themeService.applyTheme(init.theme==='light'?cindyLight:cindyDark);
      document.documentElement.dataset.platform='darwin';
      void i18n.changeLanguage(init.locale);
      setStatus('loading');
      void Promise.all([
        invoke<BootstrapData>('paseo.bootstrap',{botId:init.botId}),
        invoke<{modelChain:BotModelRoute[]}>('models.default',{botId:init.botId}),
        loadOriginalFonts(invoke,controller.signal),
      ]).then(([data,defaults])=>{
        if(own!==generation||controller.signal.aborted)return;
        setBootstrap({...data,defaultModelChain:defaults.modelChain});
        setRouter(createMemoryRouter([{path:'*',element:initialRoute(init)}],{initialEntries:[`/bots/${encodeURIComponent(data.bot.id)}?settings=1`]}));
        setStatus('ready');
      }).catch(reason=>{controller.abort();if(own===generation){setError(reason instanceof Error?reason.message:String(reason));setStatus('error');}});
    });
    post('ready');
    const pagehide=()=>{generation++;active?.abort();};window.addEventListener('pagehide',pagehide);
    return()=>{generation++;active?.abort();cleanup();window.removeEventListener('pagehide',pagehide);};
  },[]);
  useLayoutEffect(()=>{
    if(status==='ready')return;
    const close=()=>closeLoading();
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();}};
    window.addEventListener('cindy-request-close',close);window.addEventListener('keydown',key);
    return()=>{window.removeEventListener('cindy-request-close',close);window.removeEventListener('keydown',key);};
  },[status]);
  return <ConfirmDialogProvider><Tooltip.Provider>{status==='ready'&&router?<RouterProvider router={router}/>:<div className="flex h-full min-h-0 flex-col bg-[var(--surface)] text-[var(--text-primary)]"><header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5"><h1 className="text-15 font-medium">{i18n.t('bots.settings')}</h1><button className="h-9 w-9 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)]" aria-label={i18n.t('bots.close')} onClick={closeLoading}>×</button></header><div className="flex flex-1 items-center justify-center p-5">{status==='error'?<p role="alert" className="text-13 text-[var(--text-danger)]">{error}</p>:<Spinner size={20}/>}</div></div>}<ToastContainer/></Tooltip.Provider></ConfirmDialogProvider>;
}
class Boundary extends React.Component<React.PropsWithChildren, {error:string}> {
  state={error:''};
  static getDerivedStateFromError(error:Error){return{error:error.message};}
  componentDidCatch(error:Error){post('error',{message:error.message});}
  render(){return this.state.error?<div role="alert" className="p-5 text-13 text-[var(--text-danger)]">{this.state.error}<button className="ml-3 underline" onClick={()=>post('close')}>{i18n.t('bots.close')}</button></div>:this.props.children;}
}
window.addEventListener('unhandledrejection',event=>{toast.error(event.reason instanceof Error?event.reason.message:String(event.reason));});
createRoot(document.getElementById('root')!).render(<Boundary><App/></Boundary>);
