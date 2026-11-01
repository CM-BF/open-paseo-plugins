#!/usr/bin/env node
// Actual ToolbarPopover native fallback with an SDK-style isolated Modal root.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const directory=dirname(fileURLToPath(import.meta.url)), temporary=await mkdtemp(join(tmpdir(),'board-modal-'));
const bundle=await build({entryPoints:[join(directory,'modal-host-fixture.tsx')],bundle:true,platform:'browser',format:'iife',write:false,loader:{'.txt':'text'},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'host-adapters',setup(b){b.onResolve({filter:/^(react-native|@getpaseo\/plugin(?:\/client(?:\/ui)?)?)$/},()=>({path:join(directory,'board-host-adapter.tsx')}))}}]});
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:'<!doctype html><div id="app"></div><script src="/bundle.js"></script>')});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const chrome = spawn(process.env.BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${join(temporary, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-mock-keychain', '--window-size=1100,850', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let seq = 0;
let buffer = '';
const commands = new Map();
const logs = [];
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.id && commands.has(message.id)) {
      const entry = commands.get(message.id); commands.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') logs.push(message.params.exceptionDetails);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { commands.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  commands.set(id, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
let passed = 0;
const check = (name) => { passed++; console.log(`PASS ${name}`); };
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
  const evaluate = async (expression) => {
    const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const until = async (expression, timeout = 10000) => {
    await evaluate(`new Promise((resolve,reject)=>{const deadline=performance.now()+${timeout};const loop=()=>{try{if(${expression}){resolve(true);return}}catch{}if(performance.now()>deadline){reject(new Error('condition timeout: '+${JSON.stringify(expression)}));return}setTimeout(loop,20)};loop()})`);
  };
  const button=label=>'button[aria-label='+JSON.stringify(label)+']';
  const click=async selector=>{
    await until(`document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'});true`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const point=await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return{x,y,hit:n===h||n.contains(h),disabled:n.disabled,actual:h?.outerHTML?.slice(0,120)}})()`);
    assert.ok(point.hit,JSON.stringify({selector,...point}));
    await command('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
    await command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
  };
  await command('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/?native-toolbar=1'});
  await click(button('Open native toolbar'));
  await until("document.querySelector('[data-testid=native-modal-theme]')||document.querySelector('[data-fixture-modal-error]')");
  assert.equal(await evaluate("document.querySelector('[data-fixture-modal-error]')?.textContent"),undefined);
  assert.equal(await evaluate("document.querySelector('[data-fixture-modal-root]').dataset.fixtureModalRoot"),'isolated');
  assert.equal(await evaluate("document.querySelector('[data-testid=native-modal-theme]').dataset.probe"),'unbridged','Arbitrary outer plugin contexts must not leak into the modal root');
  assert.ok(await evaluate("document.querySelector('[data-testid=native-modal-theme]').dataset.color"));
  assert.equal(await evaluate("!!document.querySelector('[data-testid=unused-web-popover]')"),false,'The actual native fallback branch is required');
  const before=await evaluate("(()=>{window.modalInput=document.querySelector('[data-testid=native-modal-input]');window.modalRoot=document.querySelector('[data-fixture-modal-root]');modalInput.focus();modalInput.select();return getComputedStyle(document.querySelector('[data-testid=native-modal-theme]')).color})()");
  await command('Input.insertText',{text:'Draft survives an open-modal theme change'});
  await evaluate('hostFixture.switchTheme();true');
  await until("document.querySelector('[data-testid=native-modal-theme]')?.dataset.color===hostFixture.expectedDark");
  const themed=await evaluate("(()=>{const node=document.querySelector('[data-testid=native-modal-theme]');return {color:getComputedStyle(node).color,rootSame:modalRoot===document.querySelector('[data-fixture-modal-root]'),rootCount:document.querySelectorAll('[data-fixture-modal-root]').length,inputSame:modalInput===document.querySelector('[data-testid=native-modal-input]'),text:modalInput.value,probe:node.dataset.probe,focused:document.activeElement===modalInput}})()");
  assert.notEqual(themed.color,before);assert.equal(themed.rootSame,true);assert.equal(themed.rootCount,1);assert.equal(themed.inputSame,true);assert.equal(themed.text,'Draft survives an open-modal theme change');assert.equal(themed.probe,'unbridged');assert.equal(themed.focused,true);
  console.log('MEASURE isolated-modal-theme',JSON.stringify({before,...themed}));
  check('Changing the outer host theme while the isolated modal stays open updates its computed color without replacing the modal root, input, draft or focus');
  await click(button('关闭窗口'));await until("!document.querySelector('[data-fixture-modal]')");
  assert.deepEqual(await evaluate('window.fixtureModalErrors||[]'),[]);
  check('Native ToolbarPopover fallback bridges its explicit Board theme across a genuinely isolated modal root while unrelated outer contexts remain absent');
  console.log('Isolated native modal: '+passed+' checks passed (browser adapter, not native UI).');
}catch(error){console.error(error);console.error(JSON.stringify(logs));process.exitCode=1}
finally{try{process.kill(-chrome.pid,'SIGKILL')}catch{}chrome.stdio[3].destroy();chrome.stdio[4].destroy();chrome.stderr.destroy();for(const entry of commands.values()){clearTimeout(entry.timer);entry.reject(new Error('browser closed'))}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
