import layoutState from "./assets/component-layout-state.txt";

/** Standalone publication runtime. It has no Paseo RPC, editing or discussion code. */
export const STATIC_VIEWER_VERSION = 1;
export const STATIC_VIEWER_RUNTIME = String.raw`function(initial) {
  'use strict';
  const clone=value=>structuredClone(value), listeners=new Set();
  let state=clone(initial.state||{});
  const send=message=>parent.postMessage({...message,channel:'paseo-board-release-v1',releaseId:initial.releaseId,sessionId:initial.sessionId},'*');
  const subscribe=(set,fn)=>{if(typeof fn!=='function')throw new TypeError('Listener must be a function');set.add(fn);return()=>set.delete(fn)};
  const emptySubscription=fn=>{if(typeof fn!=='function')throw new TypeError('Listener must be a function');return()=>{}};
  const context=Object.freeze({boardId:initial.releaseId,releaseId:initial.releaseId,documentVersion:1,boardRevision:1,canvasRevision:1,published:true});
  const watch=(path,fn,options)=>{
    if(typeof path!=='string'||path.length>2000||(path!==''&&!path.startsWith('/'))||/~(?![01])/.test(path))throw new TypeError('Expected a JSON Pointer');
    const parts=path===''?[]:path.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~'));
    if(parts.length>64||parts.some(p=>['__proto__','prototype','constructor'].includes(p)))throw new TypeError('Invalid data path');
    if(typeof fn!=='function'||options!==undefined&&(!options||!['sync','frame',undefined].includes(options.schedule)))throw new TypeError('Invalid watch');
    let value=initial.data,exists=true;
    for(const p of parts){if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,p)||Array.isArray(value)&&!/^(0|[1-9][0-9]*)$/.test(p)){exists=false;value=undefined;break}value=value[p]}
    try{fn(clone(value),Object.freeze({path,exists,boardRevision:1,canvasRevision:1}))}catch(error){console.error(error)}
    return()=>{};
  };
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
    getData:()=>clone(initial.data),onData:emptySubscription,watch,getState:()=>clone(state),restoreState:()=>clone(state),
    saveState,onState:fn=>subscribe(listeners,fn),ask,onReveal:emptySubscription,getContext:()=>({...context})
  })});
  window.openai=Object.freeze({sendFollowUpMessage:ask});
  (${layoutState})({getState:()=>clone(state),saveState:writeState,onState:fn=>subscribe(listeners,fn)},1);
  document.addEventListener('submit',event=>event.preventDefault(),true);
  document.addEventListener('click',event=>{const link=event.target?.closest?.('a[href]');if(!link)return;const href=link.getAttribute('href');if(href?.startsWith('#'))return;event.preventDefault();if(!event.isTrusted)return;try{const url=new URL(href,initial.siteUrl);if(['https:','http:'].includes(url.protocol))send({type:'link',url:url.href})}catch{}},true);
}`;

/** Parent owns visitor storage; authored scripts remain in an opaque-origin iframe. */
export const STATIC_VIEWER_SHELL = String.raw`function(config) {
  'use strict';
  const frame=document.querySelector('iframe'),notice=document.querySelector('[role=status]');
  const announce=text=>{notice.textContent=text;notice.hidden=!text};
  const key='paseo-board-release:'+config.releaseId+':'+location.pathname;
  let state={};
  try{const raw=localStorage.getItem(key);if(raw&&raw.length<=524288){const parsed=JSON.parse(raw);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))state=parsed}}catch{announce('浏览器无法保存本地浏览状态；页面仍可使用。')}
  const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);const sessionId=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  const initial={releaseId:config.releaseId,sessionId,data:config.data,state,siteUrl:location.href};
  const json=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==frame.contentWindow||!m||m.channel!=='paseo-board-release-v1'||m.releaseId!==config.releaseId||m.sessionId!==sessionId)return;
    if(m.type==='state'){try{if(!m.state||typeof m.state!=='object'||Array.isArray(m.state))return;const raw=JSON.stringify(m.state);if(raw.length>524288)return;localStorage.setItem(key,raw)}catch{announce('浏览器未能保存本地浏览状态；当前页面仍保留输入。')}}
    else if(m.type==='unavailable')announce('此发布版本保留页面交互，不连接 agent。');
    else if(m.type==='link'&&navigator.userActivation?.isActive&&typeof m.url==='string'&&m.url.length<8000){try{const url=new URL(m.url);if(['https:','http:'].includes(url.protocol))window.open(url.href,'_blank','noopener,noreferrer')}catch{}}
  });
  frame.srcdoc=config.prefix+'<script>('+config.runtime+')('+json(initial)+');<\/script>'+config.html+config.suffix;
}`;
