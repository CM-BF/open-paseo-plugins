import layoutState from "./assets/component-layout-state.txt";
import { PUBLIC_API_CLIENT, PUBLIC_API_HOST } from "./public-api";

/** Non-live releases keep this version and exact bytes; see the SHA pin in static-release.test.ts. */
export const STATIC_VIEWER_VERSION = 2;
export const STATIC_VIEWER_LIVE_VERSION = 3;

const FROZEN_DATA_API = String.raw`const context=Object.freeze({boardId:initial.releaseId,releaseId:initial.releaseId,documentVersion:1,boardRevision:1,canvasRevision:1,published:true});
  const watch=(path,fn,options)=>{
    if(typeof path!=='string'||path.length>2000||(path!==''&&!path.startsWith('/'))||/~(?![01])/.test(path))throw new TypeError('Expected a JSON Pointer');
    const parts=path===''?[]:path.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
    if(parts.length>64||parts.some(p=>['__proto__','prototype','constructor'].includes(p)))throw new TypeError('Invalid data path');
    if(typeof fn!=='function'||options!==undefined&&(!options||!['sync','frame',undefined].includes(options.schedule)))throw new TypeError('Invalid watch');
    let value=initial.data,exists=true;
    for(const p of parts){if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,p)||Array.isArray(value)&&!/^(0|[1-9][0-9]*)$/.test(p)){exists=false;value=undefined;break}value=value[p]}
    try{fn(clone(value),Object.freeze({path,exists,boardRevision:1,canvasRevision:1}))}catch(error){console.error(error)}
    return()=>{};
  };`;

/** Overlays public values on the frozen data in place, so a large release is not re-cloned per update. */
const LIVE_DATA_API = String.raw`const context=Object.freeze({boardId:initial.releaseId,releaseId:initial.releaseId,documentVersion:1,boardRevision:1,canvasRevision:1,published:true});
  const dangerous=['__proto__','prototype','constructor'],owns=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
  const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
  const parsePointer=path=>path===''?[]:path.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
  const livePaths=initial.live.paths.map(path=>({path,parts:parsePointer(path)})).filter(({parts})=>!parts.some(p=>dangerous.includes(p)));
  const readPath=(data,parts)=>{let value=data;for(const p of parts){if(!value||typeof value!=='object'||!owns(value,p)||Array.isArray(value)&&!/^(0|[1-9][0-9]*)$/.test(p))return{exists:false,value:undefined};value=value[p]}return{exists:true,value}};
  const equalJson=(a,b)=>{if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>owns(b,key)&&equalJson(a[key],b[key]))};
  let current=clone(initial.data),lastSeq=0,liveState=initial.live.state,liveAsOf=initial.live.asOf;
  const dataListeners=new Set(),dataWatches=new Map();
  const parentOf=(parts,create)=>{let node=current;for(const p of parts.slice(0,-1)){if(!isObject(node))return null;if(!owns(node,p)){if(!create)return null;node[p]={}}node=node[p]}return isObject(node)?node:null};
  const overlay=doc=>{
    const changed=[];
    for(const {path,parts} of livePaths){
      const before=readPath(current,parts),present=owns(doc.values,path),key=parts[parts.length-1];
      if(present?before.exists&&equalJson(before.value,doc.values[path]):!before.exists)continue;
      const parent=parentOf(parts,present);if(!parent)continue;
      if(present)parent[key]=doc.values[path];else delete parent[key];
      changed.push(path);
    }
    lastSeq=doc.seq;return changed;
  };
  const restore=()=>{const previous=current;current=clone(initial.data);lastSeq=0;return livePaths.filter(({parts})=>{const a=readPath(previous,parts),b=readPath(current,parts);return a.exists!==b.exists||!equalJson(a.value,b.value)}).map(({path})=>path)};
  if(initial.live.doc)overlay(initial.live.doc);
  const watchMeta=entry=>Object.freeze({path:entry.path,exists:entry.current.exists,boardRevision:1,canvasRevision:1+lastSeq});
  const deliverWatch=(entry,listener,immediate)=>{
    if(!listener.active)return;
    if(listener.schedule==='frame'&&!immediate){if(listener.frame===null)listener.frame=requestAnimationFrame(()=>{listener.frame=null;deliverWatch(entry,listener,true)});return}
    try{listener.fn(entry.current.exists?clone(entry.current.value):undefined,watchMeta(entry))}catch(error){console.error(error)}
  };
  // Every cache updates before any authored callback runs, as on the working Board.
  const emitWatches=changed=>{
    const deliveries=[];
    for(const entry of Array.from(dataWatches.values())){
      if(!changed.some(path=>path===entry.path||path.startsWith(entry.path+'/')||entry.path.startsWith(path+'/')))continue;
      const next=readPath(current,entry.parts);
      if(next.exists===entry.current.exists&&equalJson(next.value,entry.current.value))continue;
      entry.current=next;deliveries.push({entry,listeners:Array.from(entry.listeners)});
    }
    for(const {entry,listeners} of deliveries)for(const listener of listeners)if(entry.listeners.has(listener))deliverWatch(entry,listener);
  };
  const emitData=changed=>{
    if(!changed.length)return;
    emitWatches(changed);
    for(const fn of Array.from(dataListeners)){try{fn(clone(current))}catch(error){console.error(error)}}
    window.dispatchEvent(new CustomEvent('board:data',{detail:clone(current)}));
  };
  const watch=(path,fn,options)=>{
    if(typeof path!=='string'||path.length>2000||(path!==''&&!path.startsWith('/'))||/~(?![01])/.test(path))throw new TypeError('Expected a JSON Pointer');
    const parts=parsePointer(path);
    if(parts.length>64||parts.some(p=>dangerous.includes(p)))throw new TypeError('Invalid data path');
    if(typeof fn!=='function'||options!==undefined&&(!options||!['sync','frame',undefined].includes(options.schedule)))throw new TypeError('Invalid watch');
    let entry=dataWatches.get(path);
    if(!entry){entry={path,parts,current:readPath(current,parts),listeners:new Set()};dataWatches.set(path,entry)}
    const listener={fn,schedule:options?.schedule,frame:null,active:true};entry.listeners.add(listener);
    try{fn(entry.current.exists?clone(entry.current.value):undefined,watchMeta(entry))}catch(error){console.error(error)}
    return()=>{listener.active=false;if(listener.frame!==null)cancelAnimationFrame(listener.frame);entry.listeners.delete(listener);if(!entry.listeners.size&&dataWatches.get(path)===entry)dataWatches.delete(path)};
  };`;

// Parent messages only: authored scripts in this frame cannot forge event.source.
const LIVE_RUNTIME_LISTENER = String.raw`
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==parent||!m||m.channel!=='paseo-board-release-v1'||m.releaseId!==initial.releaseId||m.sessionId!==initial.sessionId||m.type!=='live')return;
    liveState=m.state;liveAsOf=m.asOf;
    if(m.doc)emitData(overlay(m.doc));else if(m.cleared)emitData(restore());
  });
  send({type:'live-ready'});`;

const LIVE_SHELL_BODY = String.raw`
  const live=config.live,box=document.querySelector('[data-live]'),localKey='paseo-board-live:'+live.channelId,allowed=new Set(live.paths),maxDocument=131072;
  const depOf=version=>version.slice(0,version.indexOf('.'));
  const validDoc=doc=>Boolean(doc)&&typeof doc==='object'&&typeof doc.v==='string'&&/^[^.\s]{1,64}\.[1-9][0-9]{0,15}$/.test(doc.v)&&Number.isSafeInteger(doc.seq)&&doc.v.slice(doc.v.indexOf('.')+1)===String(doc.seq)&&typeof doc.at==='string'&&Boolean(doc.values)&&typeof doc.values==='object'&&!Array.isArray(doc.values);
  // Only paths frozen in this release can reach authored code.
  const restrict=doc=>({v:doc.v,seq:doc.seq,at:doc.at,values:Object.fromEntries(Object.entries(doc.values).filter(([path])=>allowed.has(path)))});
  let doc=null,booted=false,frameReady=false,sent=null,sentKey='',clearPending=false,status='live',failures=0,period=5,timer=0,bootTimer=0,networkTimer=0,lastOk=performance.now(),inFlight=false,notBefore=0;
  try{const raw=localStorage.getItem(localKey);if(raw&&raw.length<=maxDocument){const parsed=JSON.parse(raw);if(validDoc(parsed))doc=restrict(parsed)}}catch{}
  const when=at=>{const time=Date.parse(at);return Number.isNaN(time)?'未知时间':new Date(time).toLocaleString()};
  const bannerText=()=>{
    const shown=doc?'显示的是 '+when(doc.at)+' 的数据':'显示的是发布时的内容';
    if(status==='publisher-silent')return '发布者暂时没有推送更新，数据截至 '+(doc?when(doc.at):'发布时')+'，可能不是最新。';
    if(status==='network')return '连接不上数据源，'+shown+'，正在重试。';
    if(status==='unavailable')return '实时数据暂不可用，'+shown+'。';
    if(status==='revoked')return '发布者已停止公开这些数据，显示的是发布时的内容。';
    if(status==='preview')return '预览不连接实时数据，显示发布时的内容。';
    return '';
  };
  const postLive=()=>{
    if(!frameReady)return;
    const asOf=doc?doc.at:null,key=status+'|'+asOf,message={type:'live',state:status,asOf,channel:'paseo-board-release-v1',releaseId:config.releaseId,sessionId};
    if(doc&&doc!==sent){message.doc=doc;sent=doc}else if(clearPending)message.cleared=true;else if(key===sentKey)return;
    clearPending=false;sentKey=key;frame.contentWindow.postMessage(message,'*');
  };
  const setStatus=next=>{status=next;const text=bannerText();box.textContent=text;box.hidden=!text;postLive()};
  const startFrame=()=>{frame.srcdoc=config.prefix+'<script>('+config.runtime+')('+json(initial)+');<\/script>'+config.html+config.suffix};
  const boot=()=>{if(booted)return;booted=true;clearTimeout(bootTimer);sent=doc;sentKey=status+'|'+(doc?doc.at:null);initial.live={paths:live.paths,state:status,asOf:doc?doc.at:null,doc};startFrame()};
  const readBody=async response=>{
    if(!response.body)return'';
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxDocument){await reader.cancel();throw new Error('Live document too large')}chunks.push(value)}
    const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength}
    return new TextDecoder().decode(buffer);
  };
  const jitter=seconds=>seconds*1000*(0.8+Math.random()*0.4);
  const clamp=(value,low,high)=>Math.min(high,Math.max(low,value));
  const disarmNetwork=()=>{clearTimeout(networkTimer);networkTimer=0};
  const armNetwork=()=>{
    if(networkTimer||status==='revoked')return;
    const wait=Math.max(30000,3*period*1000)-(performance.now()-lastOk);
    networkTimer=setTimeout(()=>{networkTimer=0;if(failures>0&&!document.hidden)setStatus('network')},Math.max(0,wait));
  };
  const reachable=()=>{failures=0;lastOk=performance.now();disarmNetwork()};
  const failed=()=>{failures++;armNetwork();return [5,10,20,40,60][Math.min(failures,5)-1]*1000};
  const backendSaid=async response=>{
    const code=response.status;
    if(code===200||code===204){
      const text=code===200?await readBody(response):'';
      if(code===200){
        const body=JSON.parse(text);if(!validDoc(body))throw new Error('Invalid live document');
        if(!doc||depOf(body.v)!==depOf(doc.v)||body.seq>doc.seq){doc=restrict(body);clearPending=false;try{localStorage.setItem(localKey,text)}catch{}}
      }
      const header=response.headers.get('board-live')||'',freshness=/(?:^|[,\s])f=([01g])(?:[,\s]|$)/.exec(header)?.[1],seconds=Number(/(?:^|[,\s])p=(\d{1,6})(?:[,\s]|$)/.exec(header)?.[1]);
      reachable();period=clamp(seconds||5,2,300);setStatus(freshness==='g'||freshness==='1'?'live':'publisher-silent');
      return jitter(period);
    }
    if(code===404){reachable();setStatus('unavailable');return 30000}
    if(code===410){
      reachable();
      if(status!=='revoked'){doc=null;sent=null;clearPending=true;try{localStorage.removeItem(localKey)}catch{}}
      notBefore=performance.now()+300000;setStatus('revoked');return 300000;
    }
    if(code===429||code===503){
      const backoff=failed(),seconds=/^\d{1,9}$/.test(response.headers.get('retry-after')||'')?Number(response.headers.get('retry-after')):0;
      if(!seconds)return backoff;
      const delay=clamp(seconds,2,300)*1000;notBefore=performance.now()+delay;return delay;
    }
    return failed();
  };
  const poll=async()=>{
    if(inFlight||document.hidden)return;
    inFlight=true;clearTimeout(timer);
    const controller=new AbortController(),abort=setTimeout(()=>controller.abort(),8000);let delay;
    try{
      const response=await fetch(live.origin+'/_board/live/'+live.channelId+(doc?'?v='+encodeURIComponent(doc.v):''),{mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
      delay=await backendSaid(response);
    }catch{delay=failed()}
    clearTimeout(abort);inFlight=false;boot();
    if(!document.hidden)timer=setTimeout(poll,delay);
  };`;

// One poll races this boot; on timeout the page starts from the local copy or frozen data.
const LIVE_BOOT = String.raw`if(location.origin==='null'){setStatus('preview');boot()}
  else{
    document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);return}if(failures===0)lastOk=performance.now();const wait=notBefore-performance.now();if(wait>0){clearTimeout(timer);timer=setTimeout(poll,wait)}else void poll()});
    if(document.hidden)boot();else{bootTimer=setTimeout(boot,1000);void poll()}
  }`;

const FROZEN_BOOT = String.raw`frame.srcdoc=config.prefix+'<script>('+config.runtime+')('+json(initial)+');<\/script>'+config.html+config.suffix;`;

export const staticViewerRuntime = (live = false): string => String.raw`function(initial) {
  'use strict';
  const clone=value=>structuredClone(value), listeners=new Set();
  let state=clone(initial.state||{});
  const send=message=>parent.postMessage({...message,channel:'paseo-board-release-v1',releaseId:initial.releaseId,sessionId:initial.sessionId},'*');
  const request=(${PUBLIC_API_CLIENT})(send,initial);
  const subscribe=(set,fn)=>{if(typeof fn!=='function')throw new TypeError('Listener must be a function');set.add(fn);return()=>set.delete(fn)};
  const emptySubscription=fn=>{if(typeof fn!=='function')throw new TypeError('Listener must be a function');return()=>{}};
  ${live ? LIVE_DATA_API : FROZEN_DATA_API}
  const ask=()=>{send({type:'unavailable'});return Promise.resolve({status:'cancelled',outcome:'This published version does not connect to an agent.'})};
  const managedViewNamespace="__paseoContainerViews";
  const writeState=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('State must be a JSON object');
    const raw=JSON.stringify(value);if(raw.length>524288)throw new RangeError('State exceeds 512 KiB');
    state=JSON.parse(raw);send({type:'state',state});
    for(const fn of listeners){try{fn(clone(state))}catch(error){console.error(error)}}return clone(state);
  };
  const saveState=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('State must be a JSON object');
    const next={...value};
    if(Object.prototype.hasOwnProperty.call(state,managedViewNamespace))next[managedViewNamespace]=state[managedViewNamespace];
    else delete next[managedViewNamespace];
    return writeState(next);
  };
  Object.defineProperty(window,'board',{configurable:false,writable:false,value:Object.freeze({
    ${live ? "getData:()=>clone(current),onData:fn=>subscribe(dataListeners,fn)" : "getData:()=>clone(initial.data),onData:emptySubscription"},watch,getState:()=>clone(state),restoreState:()=>clone(state),
    saveState,onState:fn=>subscribe(listeners,fn),ask,request,onReveal:emptySubscription,getContext:()=>(${live ? "{...context,canvasRevision:1+lastSeq,live:{state:liveState,asOf:liveAsOf}}" : "{...context}"})
  })});
  window.openai=Object.freeze({sendFollowUpMessage:ask});
  (${layoutState})({getState:()=>clone(state),saveState:writeState,onState:fn=>subscribe(listeners,fn)},1);
  document.addEventListener('submit',event=>event.preventDefault(),true);
  document.addEventListener('click',event=>{const link=event.target?.closest?.('a[href]');if(!link)return;const href=link.getAttribute('href');if(href?.startsWith('#'))return;event.preventDefault();if(!event.isTrusted)return;try{const url=new URL(href,initial.siteUrl);if(['https:','http:'].includes(url.protocol))send({type:'link',url:url.href})}catch{}},true);${live ? LIVE_RUNTIME_LISTENER : ""}
}`;
export const STATIC_VIEWER_RUNTIME = staticViewerRuntime();

/** Parent owns visitor storage; authored scripts remain in an opaque-origin iframe. */
export const staticViewerShell = (live = false): string => String.raw`function(config) {
  'use strict';
  const frame=document.querySelector('iframe'),notice=document.querySelector('[role=status]');
  const announce=text=>{notice.textContent=text;notice.hidden=!text};
  const key='paseo-board-release:'+config.releaseId+':'+location.pathname;
  let state={};
  try{const raw=localStorage.getItem(key);if(raw&&raw.length<=524288){const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))state=parsed}}catch{announce('浏览器无法保存本地浏览状态；页面仍可使用。')}
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);const sessionId=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  const initial={releaseId:config.releaseId,sessionId,data:config.data,state,siteUrl:location.href};
  const api=(${PUBLIC_API_HOST})(config.apiOrigins,message=>frame.contentWindow.postMessage({...message,channel:'paseo-board-release-v1',releaseId:config.releaseId,sessionId},'*'));
  const json=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');${live ? LIVE_SHELL_BODY : ""}
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==frame.contentWindow||!m||m.channel!=='paseo-board-release-v1'||m.releaseId!==config.releaseId||m.sessionId!==sessionId)return;
    if(m.type==='api-request'){void api(m)}
    else if(m.type==='state'){try{if(!m.state||typeof m.state!=='object'||Array.isArray(m.state))return;const raw=JSON.stringify(m.state);if(raw.length>524288)return;localStorage.setItem(key,raw)}catch{announce('浏览器未能保存本地浏览状态；当前页面仍保留输入。')}}
    else if(m.type==='unavailable')announce('此发布版本保留页面交互，不连接 agent。');
    else if(m.type==='link'&&navigator.userActivation?.isActive&&typeof m.url==='string'&&m.url.length<8000){try{const url=new URL(m.url);if(['https:','http:'].includes(url.protocol))window.open(url.href,'_blank','noopener,noreferrer')}catch{}}${live ? "\n    else if(m.type==='live-ready'){frameReady=true;postLive()}" : ""}
  });
  ${live ? LIVE_BOOT : FROZEN_BOOT}
}`;
export const STATIC_VIEWER_SHELL = staticViewerShell();
