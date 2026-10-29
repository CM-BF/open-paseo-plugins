import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { build } from 'esbuild';

globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const host=globalThis.__FONT_APP_TEST__={events:[],fonts:[],adopted:[],init:null,root:null};
const listeners=new Map();
globalThis.window={addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},removeEventListener(type,fn){listeners.get(type)?.delete(fn);}};
globalThis.document={documentElement:{dataset:{}},getElementById(){return {};}};
const mocks={
 'react-dom/client':`export const createRoot=()=>({render:element=>globalThis.__FONT_APP_TEST__.root=element});`,
 'react-router-dom':`import {createElement} from 'react';export const createMemoryRouter=routes=>({routes});export const RouterProvider=({router})=>createElement('router',null,router.routes[0].element);export const useLocation=()=>({pathname:'/bots/cindy',search:'?settings=1'});`,
 './bridge':`export const onInit=fn=>{globalThis.__FONT_APP_TEST__.init=fn;return()=>{};};export const post=(type,fields)=>globalThis.__FONT_APP_TEST__.events.push({type,...fields});export const invoke=async op=>op==='paseo.bootstrap'?{bot:{id:'cindy'}}:{modelChain:[]};`,
 './font-loader':`export const loadOriginalFonts=(_request,signal)=>new Promise(resolve=>globalThis.__FONT_APP_TEST__.fonts.push({resolve,signal}));`,
 './state':`export const setBootstrap=value=>globalThis.__FONT_APP_TEST__.adopted.push(value);`,
 './adapters/i18n':`export const i18n={t:key=>key,changeLanguage:async()=>{}};`,
};
const result=await build({entryPoints:[new URL('../app.tsx',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'mock-app-boundary',setup(builder){
 builder.onResolve({filter:/.*/},args=>{
  if(args.kind==='entry-point'||args.path==='react'||args.path==='react/jsx-runtime')return;
  return {path:args.path,namespace:'app-mock'};
 });
 builder.onLoad({filter:/.*/,namespace:'app-mock'},({path})=>({contents:mocks[path]??(
  path.endsWith('/BotSettingsDrawer')?`import {createElement} from 'react';export const BotSettingsDrawer=()=>createElement('original-drawer');`:
  path.endsWith('/confirm-dialog-provider')?`export const ConfirmDialogProvider=({children})=>children;`:
  path.endsWith('/tooltip')?`export const Tooltip={Provider:({children})=>children};`:
  path.endsWith('/toast')?`export const ToastContainer=()=>null;export const toast={error:()=>{}};`:
  path.endsWith('/spinner')?`export const Spinner=()=>null;`:
  path.endsWith('/theme-service')?`export const themeService={applyTheme:()=>{}};`:
  path.endsWith('/default-dark')?`export const defaultDark={};`:
  path.endsWith('/default-light')?`export const defaultLight={};`:
  `export {};`)}));
}}]});
const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const init={botId:'cindy',host:{id:'local',label:'Local'},theme:'dark',locale:'en'};

test('real App stays in loading until fonts resolve, and Close cancels without mounting the original drawer afterward',async()=>{
 let renderer;await act(async()=>{renderer=create(host.root);});
 await act(async()=>{host.init(init);});
 assert.equal(renderer.root.findAllByType('original-drawer').length,0);assert.equal(host.fonts.length,1);
 const close=renderer.root.findByType('button');act(()=>close.props.onClick());
 assert.equal(host.fonts[0].signal.aborted,true);assert.equal(host.events.at(-1).type,'close');
 await act(async()=>host.fonts[0].resolve());
 assert.equal(renderer.root.findAllByType('original-drawer').length,0);assert.equal(host.adopted.length,0);
 act(()=>renderer.unmount());
});

test('real App mounts the original drawer only after the complete font load and removes its loading Escape handler',async()=>{
 host.fonts=[];host.adopted=[];let renderer;
 await act(async()=>{renderer=create(host.root);});
 await act(async()=>host.init(init));assert.equal(renderer.root.findAllByType('original-drawer').length,0);
 await act(async()=>host.fonts[0].resolve());
 assert.equal(renderer.root.findAllByType('original-drawer').length,1);assert.equal(host.adopted.length,1);
 assert.equal(listeners.get('keydown')?.size??0,0);
 act(()=>renderer.unmount());
});
