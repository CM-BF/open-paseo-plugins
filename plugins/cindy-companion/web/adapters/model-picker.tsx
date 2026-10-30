// Host-catalog seam. BotModelChainEditor, task override, slider and speed toggle are Cindy's.
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Search, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as Popover from '@radix-ui/react-popover';
import { Input } from '../../vendor/renderer/components/ui/input';
import { Select } from '../../vendor/renderer/components/ui/select';
import { EffortSlider } from '../../vendor/renderer/components/ui/effort-slider';
import { FastModeToggle } from '../../vendor/renderer/components/new-chat/FastModeToggle';
import { useSnapshot } from '../state';
import { invoke } from '../bridge';
import { providerRows } from './catalog';
import { speedChoices, type ModelFeatures } from './model-options';

export function ModelRouteSelector(props: any) {
  const { t, i18n } = useTranslation();
  const zh=i18n.language==='zh-CN';
  const [open,setOpen]=useState(false);
  const [query,setQuery]=useState('');
  const [featureResult,setFeatureResult]=useState<ModelFeatures|null>(null);
  const [featureError,setFeatureError]=useState('');
  const state=useSnapshot();
  const providers=useMemo(()=>providerRows(state?.models),[state?.models]);
  const current=providers.find(p=>p.vendor===props.vendorKey);
  const model=current?.models.find(item=>item.id===props.modelId);
  const label=model?.name || props.modelId || (zh?'选择模型':'Select model');
  const options=model?.thinkingOptions??[];
  const recommended=model?.defaultThinkingOptionId??options.find(option=>option.isDefault)?.id;
  const effort=props.effort||recommended||null;
  const effortLabel=options.find(option=>option.id===effort)?.label??effort;
  const featureSupported=state?.caps.ops.includes('models.features');
  useEffect(()=>{
    if(!open||!model||!state?.bot.id||!featureSupported)return;
    let alive=true;setFeatureResult(null);setFeatureError('');
    void invoke<ModelFeatures>('models.features',{botId:state.bot.id,harness:props.vendorKey==='cc'?'claude':props.vendorKey,model:props.modelId,effort:props.effort||undefined,providerId:props.currentProviderId??undefined}).then(result=>{
      if(!alive)return;
      if(result.error) setFeatureError(typeof result.error==='string'?result.error:JSON.stringify(result.error));
      else setFeatureResult(result);
    }).catch(error=>{if(alive)setFeatureError(error instanceof Error?error.message:String(error));});
    return()=>{alive=false;};
  },[open,state?.bot.id,props.vendorKey,props.modelId,props.effort,props.currentProviderId,featureSupported]);
  const speeds=speedChoices(featureResult?.features);
  const hasFast=speeds.some(speed=>speed.value===true);
  const hasUltra=speeds.some(speed=>speed.value==='ultrafast');
  const allowed=props.unifiedAgents?.map((kind:string)=>kind==='claude-code'?'cc':kind);
  const entries=providers.filter(p=>!allowed||allowed.includes(p.vendor)).flatMap(provider=>provider.models.filter(model=>model.isSelectable!==false).map(model=>({provider,model}))).filter(({provider,model})=>`${provider.name} ${model.name??''} ${model.id}`.toLowerCase().includes(query.toLowerCase()));
  return <Popover.Root open={open&&!props.disabled} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" disabled={props.disabled} aria-label={`${props.ariaContext??''} ${label}${effortLabel?` · ${effortLabel}`:''}`} aria-expanded={open} aria-haspopup="listbox" className="flex min-w-0 max-w-full shrink items-baseline gap-1 rounded-full border border-transparent bg-transparent px-2.5 py-1 text-left leading-5 transition-colors min-h-[30px] hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg)] disabled:opacity-50">
      <span className="shrink-0 text-13 font-normal text-[var(--model-trigger-meta)]">{current?.name??props.vendorKey} ·</span>
      <span className="min-w-0 whitespace-normal text-13 text-[var(--text-primary)] [overflow-wrap:anywhere]">{label}</span>
      {effortLabel?<span className="shrink-0 text-13 font-normal text-[var(--model-trigger-meta)]">· {effortLabel}</span>:null}
      {props.fastMode?<Zap size={12} className="shrink-0 self-center text-[var(--model-trigger-meta)]"/>:null}
      <ChevronDown size={12} className="shrink-0 self-center text-[var(--text-tertiary)]"/>
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content side="bottom" align="start" sideOffset={6} className="z-[80] w-[min(360px,calc(100vw-40px))] overflow-hidden rounded-xl border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)] p-2 text-[var(--text-primary)]">
      <div className="mb-2 flex items-center gap-2 px-1"><Search size={14}/><Input value={query} onChange={setQuery} ariaLabel={zh?'搜索模型':'Search models'} placeholder={zh?'搜索模型':'Search models'}/></div>
      <div role="listbox" className="max-h-64 overflow-y-auto">{entries.map(({provider,model})=><button key={`${provider.id}:${model.id}`} type="button" role="option" aria-selected={provider.vendor===props.vendorKey&&model.id===props.modelId} disabled={provider.status!=='ready'} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-13 hover:bg-[var(--model-item-hover)] disabled:opacity-50" onClick={()=>{
        props.onUnifiedSelect?.({engine:provider.vendor,providerId:null,modelId:model.id,effort:model.defaultThinkingOptionId??model.thinkingOptions?.find(option=>option.isDefault)?.id??'',fast:false});
        if(!props.onUnifiedSelect)props.onModelChange?.(model.id);
        setOpen(false);
      }}><span className="min-w-0 flex-1"><span className="block truncate">{model.name??model.id}</span><span className="block text-11 text-[var(--text-tertiary)]">{provider.name}</span></span>{provider.vendor===props.vendorKey&&model.id===props.modelId?<Check size={14}/>:null}</button>)}
      {entries.length===0?<p role="status" className="p-3 text-12 text-[var(--text-secondary)]">{zh?'此主机没有可用的模型目录。':'No model catalog is available on this host.'}</p>:null}</div>
      {model&&props.configurationEnabled?<div className="mt-2 border-t border-[var(--model-dropdown-border)] px-2 pb-1 pt-3">
        <p className="mb-1 text-12 text-[var(--text-secondary)]">{label}{effortLabel?` · ${effortLabel}`:''}</p>
        <div className="flex items-center gap-2">
          {options.length>1&&effort?<EffortSlider stops={options.map(option=>option.id) as any} value={effort} recommended={recommended as any} labelOf={value=>options.find(option=>option.id===value)?.label??value} onChange={props.onEffortChange} disabled={props.disabled}/>:null}
          {options.length>1&&!effort?<Select label={t('newChat.modelSelector.effortLabel')} value="" options={options.map(option=>({value:option.id,label:option.label}))} onValueChange={props.onEffortChange}/>:null}
          {hasFast&&!hasUltra?<FastModeToggle enabled={!!props.fastMode} onToggle={()=>props.onFastModeChange?.(!props.fastMode)} accentVar="var(--fast-accent)"/>:null}
          {hasUltra?<Select label={t('newChat.modelSelector.speed.label')} value={speeds.find(speed=>speed.value===props.fastMode)?.id??''} options={speeds.map(speed=>({value:speed.id,label:speed.label}))} onValueChange={id=>{const speed=speeds.find(speed=>speed.id===id);if(speed)props.onFastModeChange?.(speed.value);}}/>:null}
        </div>
        {featureError?<p role="alert" className="mt-2 text-12 text-[var(--text-danger)]">{featureError}</p>:null}
        {!featureSupported&&props.fastMode?<p role="status" className="mt-2 text-12 text-[var(--text-secondary)]">{zh?'此主机尚未提供当前模型的速度选项。':'This host has not provided speed options for this model.'}</p>:null}
      </div>:null}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
export const ModelRouteSelectorContent=ModelRouteSelector;
