#!/usr/bin/env node
// Real BoardView -> More -> ReleasePanel driven by trusted Chromium input.
// Static exports/copies use actual server core. GitHub is an explicit local adapter:
// no gh invocation, credentials, external repository or deployment is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const directory=dirname(fileURLToPath(import.meta.url)), root=dirname(directory);
const temporary=await mkdtemp(join(tmpdir(),'paseo-release-host-'));
const downloads=join(temporary,'downloads'); await mkdir(downloads);
const core=await build({stdin:{contents:`export {BoardStore} from './server/store';export {BoardCopies} from './server/board-copy';export {ReleaseRepository} from './server/static-release';`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.txt':'text'}});
const coreFile=join(temporary,'core.cjs'); await writeFile(coreFile,core.outputFiles[0].text);
const {BoardStore,BoardCopies,ReleaseRepository}=createRequire(import.meta.url)(coreFile);
const boardStore=new BoardStore(join(temporary,'boards')), repository=new ReleaseRepository(join(temporary,'releases'));
let sourceBoard, publishMode='accept', jobSequence=0, holdRefresh=false, failPreviewReleaseId;
const publicationTimers=new Set();
const later=(callback,ms)=>{const timer=setTimeout(()=>{publicationTimers.delete(timer);callback()},ms);publicationTimers.add(timer)};
const heldRefresh=[];
const calls=[], jobs=new Map(), prepareReceipts=new Map(), copiedBoards=[];
const copies=new BoardCopies(join(temporary,'copies'),{read:async id=>sourceBoard?.id===id?sourceBoard:boardStore.read(id),create:input=>boardStore.create(input)});
const rpc=async(name,input,board)=>{
  calls.push({name,input:structuredClone(input)});sourceBoard=board;
  if(name==='board.copy'){const copied=await copies.copy(input);copiedBoards.push(copied);return copied}
  if(name==='board.release.create')return (await repository.create({...input,board})).manifest;
  if(name==='board.release.list')return (await repository.list(input.boardId)).map(r=>r.manifest);
  if(name==='board.release.preview'){if(input.releaseId===failPreviewReleaseId){failPreviewReleaseId=undefined;throw new Error('Fixture selected preview unavailable')}return repository.preview(input.releaseId)}
  if(name==='board.release.download')return repository.download(input.releaseId);
  if(name==='board.pages.accounts')return [{login:'fixture-alice',host:'github.com',active:true},{login:'fixture-bob',host:'github.com',active:false}];
  if(name==='board.pages.repositories')return [{name:input.account+'/site',private:false,url:'https://github.com/'+input.account+'/site'},{name:input.account+'/private-site',private:true,url:'https://github.com/'+input.account+'/private-site'}];
  if(name==='board.pages.list')return [...jobs.values()].filter(j=>!input.releaseId||j.releaseId===input.releaseId);
  if(name==='board.pages.publish'){
    if(publishMode==='lost-before-job'){publishMode='accept';throw new Error('Fixture connection lost before any readable job')}
    const previous=prepareReceipts.get(input.eventId);if(previous)assert.deepEqual(previous,input,'Same event must retain exact release, target and creation policy');
    else prepareReceipts.set(input.eventId,structuredClone(input));
    const release=await repository.read(input.releaseId);assert.equal(release.manifest.artifactHash,input.artifactHash);
    let job=[...jobs.values()].find(j=>j.eventId===input.eventId);
    if(!job){job={...input,jobId:'fixture-job-'+(++jobSequence),status:'prepared',branch:'board-release/'+input.eventId,baseBranch:'main',baseSha:'a'.repeat(40),headSha:'b'.repeat(40)};jobs.set(job.jobId,job)}
    job.autoPublish=true;job.autoPublishUntil=new Date(Date.now()+30*60*1000).toISOString();job.publicationMode='legacy-subdirectory';job.sitePath='boards/'+input.releaseId.slice(8,24);
    if(publishMode==='lost-response'){publishMode='accept';job.status='unknown';job.autoPublishUntil=new Date(Date.now()-1).toISOString();job.error='Fixture response lost after automatic retry window expired';throw new Error('Fixture response lost; outcome unknown')}
    const recovering=publishMode==='recovering';publishMode='accept';
    job.status=recovering?'unknown':'pr-open';job.prNumber=jobSequence;job.prUrl='https://github.com/'+input.repository+'/pull/'+job.prNumber;delete job.error;
    // Explicit adapter: independent server progression, including while the UI
    // is closed. The separate manager tests cover real GitHub head validation.
    later(()=>{job.status='deploying';job.mergedSha='c'.repeat(40)},100);
    later(()=>{job.status='live';job.url='https://'+input.account+'.github.io/'+input.repository.split('/')[1]+'/'+job.sitePath+'/';job.verifiedAt=new Date().toISOString()},350);
    return structuredClone(job);
  }
  if(name==='board.pages.merge'||name==='board.pages.prepare')throw new Error('The one-click UI must never invoke separate preparation or merge');
  if(name==='board.pages.refresh'){if(holdRefresh)await new Promise(resolve=>heldRefresh.push(resolve));const job=jobs.get(input.jobId);assert.ok(job);return structuredClone(job)}
  throw new Error('Unhandled release RPC '+name);
};
const bundle=await build({entryPoints:[join(directory,'release-host-fixture.tsx')],bundle:true,format:'iife',platform:'browser',write:false,loader:{'.txt':'text'},define:{'process.env.NODE_ENV':'"test"'},plugins:[{name:'modal-baseline',setup(b){if(process.env.BOARD_MODAL_BASELINE)b.onLoad({filter:/client\/(board|home|toolbar-popover)\.tsx$/},async args=>({contents:await readFile(join(process.env.BOARD_MODAL_BASELINE,args.path.split('/').at(-1)),'utf8'),loader:'tsx',resolveDir:dirname(args.path)}))}},{name:'host-adapters',setup(b){b.onResolve({filter:/^(react-native|@getpaseo\/plugin(?:\/client(?:\/ui)?)?)$/},()=>({path:join(directory,'board-host-adapter.tsx')}))}}]});
const server=createServer(async(req,res)=>{
  if(req.url==='/rpc'){
    try{let body='';for await(const chunk of req)body+=chunk;const {name,input,board}=JSON.parse(body);const value=await rpc(name,input,board);res.setHeader('content-type','application/json');res.end(JSON.stringify({value}))}
    catch(error){res.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:error.message}))}return;
  }
  res.setHeader('content-type',req.url==='/bundle.js'?'text/javascript':'text/html');
  res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:'<!doctype html><meta charset="utf-8"><style>html,body,#app{margin:0;width:100%;height:100%;font:14px system-ui}#app{display:flex;flex-direction:column}button{font:inherit}</style><div id="app"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
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
  const replace=async(selector,text)=>{
    await click(selector);assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`),true);
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4,commands:['selectAll']});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA'});
    await command('Input.insertText',{text});
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`),text);
  };
  const open=async()=>{
    await until("hostFixture.mainReady()?.ready");
    await click('[data-testid="board-more-open"]');await click(button('导出与发布'));
    await until("document.querySelector('[data-testid=board-release-panel]')||document.querySelector('[data-fixture-modal-error]')");
    assert.equal(await evaluate("document.querySelector('[data-fixture-modal-error]')?.textContent"),undefined,'SDK-isolated modal must receive its explicit Board theme');
  };
  const reload=async()=>{
    const id=await evaluate('hostFixture.pageInstance');await command('Page.reload',{ignoreCache:true});await until(`window.hostFixture&&hostFixture.pageInstance!==${JSON.stringify(id)}`);await open();
  };
  const count=name=>calls.filter(c=>c.name===name).length;
  const verifyFailedPreviewSwitch=async(current,target)=>{
    const before=count('board.pages.publish');failPreviewReleaseId=target.releaseId;
    await click(button(target.title+' · '+target.artifactHash.slice(0,10)));
    await until("document.body.textContent.includes('Fixture selected preview unavailable')");
    assert.equal(await evaluate("!!document.querySelector('[data-testid=board-release-preview]')"),false,'A failed target cannot leave the previously visible release publishable');
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('一键发布'))})`),false);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('确认预览和数据，可发布此版本'))})`),false);
    await click(button(current.title+' · '+current.artifactHash.slice(0,10)));
    await until("document.querySelector('[data-testid=board-release-preview]')");
    assert.equal(count('board.pages.publish'),before);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('确认预览和数据，可发布此版本'))})`),true);
    check('A failed version preview clears the old preview and publication controls; reselecting a valid version restores its exact scope and requires fresh confirmation');
  };
  const screenshot=async name=>{if(process.env.BOARD_RELEASE_SCREENSHOT_DIR){const shot=await command('Page.captureScreenshot',{format:'png'});await writeFile(join(process.env.BOARD_RELEASE_SCREENSHOT_DIR,name+'.png'),Buffer.from(shot.data,'base64'))}};
  await command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await command('Page.navigate',{url:origin+'/?drafts=1'});await open();
  await replace('input[aria-label="发布名称"]','Publication copy fixture');await click(button('复制为发布 Board'));
  await until('hostFixture.backCalls===1');assert.equal(copiedBoards.length,1);assert.equal(copiedBoards[0].title,'Publication copy fixture');
  assert.deepEqual(copiedBoards[0].interactions,[]);assert.deepEqual(copiedBoards[0].decisions,[]);assert.deepEqual(copiedBoards[0].userState,{});
  assert.equal(calls.find(c=>c.name==='board.copy').input.canvasBase.revision,1);
  check('More opens the actual release panel; copying uses the current canvas base and the real copy core creates an independent Board without discussions or drafts');
  await reload();
  assert.equal(await evaluate(`document.querySelector('[data-testid=board-release-data]').value`),'{}');
  await replace('[data-testid="board-release-data"]','[1,2]');await click(button('生成固定版本并预览'));
  await until("document.body.textContent.includes('公开数据须为 JSON 对象')");assert.equal(count('board.release.create'),0);
  await replace('[data-testid="board-release-data"]','{}');await click(button('生成固定版本并预览'));
  await until("document.querySelector('[data-testid=board-release-preview]')");await until(`!document.querySelector(${JSON.stringify(button('下载 ZIP'))})?.disabled`);
  const first=calls.find(c=>c.name==='board.release.create');assert.deepEqual(first.input.publicData,{});
  const releases=await repository.list('host-fixture');assert.equal(releases.length,1);const frozen=releases[0];
  assert.ok(!frozen.files['index.html'].includes('Isolated test fixture'),'Private Board data is not implicitly included');
  const sandbox=await evaluate("document.querySelector('[data-testid=board-release-preview]').getAttribute('sandbox')");assert.equal(sandbox,'allow-scripts allow-forms');
  check('Public data starts empty; invalid JSON objects never invoke export, and the actual static snapshot previews in a sandbox without inheriting private Board data');
  await evaluate('hostFixture.updateCanvas();true');await until("document.body.textContent.includes('r2')");
  const fixed=await repository.read(frozen.manifest.releaseId);assert.deepEqual(fixed,frozen);
  await click(button('下载 ZIP'));
  await evaluate('new Promise(resolve=>setTimeout(resolve,150))');
  const zipNames=(await readdir(downloads)).filter(n=>n.endsWith('.zip'));assert.equal(zipNames.length,1);
  const bytes=await readFile(join(downloads,zipNames[0]));assert.equal(bytes.readUInt32LE(0),0x04034b50);
  const entries={};let offset=0;while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),nameLength=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28),name=bytes.subarray(offset+30,offset+30+nameLength).toString(),start=offset+30+nameLength+extra;entries[name]=bytes.subarray(start,start+size).toString();offset=start+size}
  assert.deepEqual(entries,frozen.files);assert.ok(!JSON.stringify(entries).includes('owner-fixture'));
  check('Editing the working Board leaves the selected snapshot unchanged, and a real browser ZIP download contains exactly its frozen public files');
  if(process.env.BOARD_RELEASE_PREVIEW_SWITCH_ONLY){
    await replace('input[aria-label="发布名称"]','Preview recovery fixture');await click(button('生成固定版本并预览'));
    await until("document.body.textContent.includes('Preview recovery fixture · 固定版本')");
    const recovery=(await repository.list('host-fixture')).find(item=>item.manifest.title==='Preview recovery fixture');assert.ok(recovery);
    await verifyFailedPreviewSwitch(recovery.manifest,frozen.manifest);
  }else{
  await click(button('读取 GitHub 账号'));await click(button('fixture-alice'));await click(button('fixture-alice/site'));
  assert.deepEqual(calls.find(c=>c.name==='board.pages.repositories').input,{account:'fixture-alice'});
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button('一键发布'))}).disabled`),true);
  await click(button('一键发布'));assert.equal(count('board.pages.publish'),0);
  await click(button('确认预览和数据，可发布此版本'));await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建')");
  const prepared=calls.find(c=>c.name==='board.pages.publish').input;assert.equal(prepared.artifactHash,frozen.manifest.artifactHash);assert.equal(prepared.repository,'fixture-alice/site');assert.equal(prepared.account,'fixture-alice');
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('合并此 PR 并发布'))})`),false);
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('打开已发布网页'))})`),false,'No link is offered before verification');
  await reload();
  await click(button(frozen.manifest.title+' · '+frozen.manifest.artifactHash.slice(0,10)));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('已核实上线')",9000);
  assert.equal(count('board.pages.publish'),1,'Full page loss does not create another publication');
  assert.equal(count('board.pages.merge'),0,'The server owns all merge progression');
  await click(button('打开已发布网页'));
  assert.equal(await evaluate('hostFixture.links.at(-1)'),'https://fixture-alice.github.io/site/boards/'+frozen.manifest.releaseId.slice(8,24)+'/');
  await screenshot('release-desktop-live');
  check('One explicit publish click starts the exact snapshot and repository; the server completes PR, merge and verified deployment across full page loss without another publish or merge click (GitHub adapter)');
  // A different target creates a new explicit request; response loss must persist it.
  await click(button('读取 GitHub 账号'));await click(button('fixture-bob'));await click(button('fixture-bob/site'));publishMode='lost-response';
  await click(button('确认预览和数据，可发布此版本'));
  await click(button('一键发布'));await until("document.body.textContent.includes('Fixture response lost')");
  const unknown=calls.filter(c=>c.name==='board.pages.publish').at(-1).input;
  await reload();
  await click(button(frozen.manifest.title+' · '+frozen.manifest.artifactHash.slice(0,10)));
  await until("document.querySelector('[data-testid=board-release-preview]')");
  assert.equal(count('board.pages.publish'),2,'Full reload must not automatically prepare/upload');
  await click(button('fixture-bob/site · 结果待核对'));
  await click(button('确认预览和数据，可发布此版本'));
  await click(button('一键继续发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建')");
  assert.equal(count('board.pages.publish'),3);assert.deepEqual(calls.filter(c=>c.name==='board.pages.publish').at(-1).input,unknown);
  assert.equal(jobs.size,2);
  check('An uncertain publish with an expired automatic window survives a complete page reload and retries only its original immutable request without creating a duplicate job');
  await click(button('读取 GitHub 账号'));await click(button('fixture-bob'));await click(button('fixture-bob/private-site · 私有仓库'));publishMode='lost-before-job';
  await click(button('一键发布'));await until("document.body.textContent.includes('Fixture connection lost before any readable job')");
  const unseen=calls.filter(c=>c.name==='board.pages.publish').at(-1).input;
  await reload();await click(button('恢复发布 · fixture-bob/private-site'));
  await until("document.querySelector('[data-testid=board-release-preview]')");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button('一键发布'))}).disabled`),true);
  assert.equal(count('board.pages.publish'),4);
  await click(button('确认预览和数据，可发布此版本'));await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建')");
  assert.deepEqual(calls.filter(c=>c.name==='board.pages.publish').at(-1).input,unseen);assert.equal(jobs.size,3);
  check('Even without a readable server job, full reload recovers the local publish request, requires preview confirmation again and reuses its exact event and target');
  await click(button('读取 GitHub 账号'));await click(button('fixture-alice'));await click(button('fixture-alice/private-site · 私有仓库'));
  await evaluate("window.restorePublicationStorage=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('@paseo:board-pages:'))throw new DOMException('Fixture full storage','QuotaExceededError');return window.restorePublicationStorage.call(this,key,value)};true");
  const beforeQuota=count('board.pages.publish');await click(button('一键发布'));
  await until("document.body.textContent.includes('Fixture full storage')");assert.equal(count('board.pages.publish'),beforeQuota);
  await evaluate('Storage.prototype.setItem=window.restorePublicationStorage;true');await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('fixture-alice/private-site')&&document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建')");
  assert.equal(count('board.pages.publish'),beforeQuota+1);
  check('Real browser storage failure blocks publication before any GitHub adapter call; restoring persistence allows one explicit retry');
  holdRefresh=true;const beforeHeld=await evaluate("hostFixture.publicationCalls.filter(c=>c.name==='board.pages.refresh').length");
  await until(`hostFixture.publicationCalls.filter(c=>c.name==='board.pages.refresh').length>${beforeHeld}`,9000);
  assert.equal(heldRefresh.length,1);
  await replace('[data-testid="board-release-data"]','{"publicLabel":"Second independently reviewed release"}');
  await replace('input[aria-label="发布名称"]','Second release fixture');await click(button('生成固定版本并预览'));
  await until("document.body.textContent.includes('Second release fixture · 固定版本')&&!document.querySelector('[data-testid=board-pages-job]')");
  holdRefresh=false;heldRefresh.splice(0).forEach(resolve=>resolve());
  await evaluate('new Promise(resolve=>setTimeout(resolve,100))');
  assert.equal(await evaluate("!!document.querySelector('[data-testid=board-pages-job]')"),false);
  const secondRelease=(await repository.list('host-fixture')).find(r=>r.manifest.title==='Second release fixture');assert.ok(secondRelease);
  assert.deepEqual(calls.filter(c=>c.name==='board.release.create').at(-1).input.publicData,{publicLabel:'Second independently reviewed release'});
  assert.ok((await repository.preview(secondRelease.manifest.releaseId)).html.includes('Second independently reviewed release'));
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('确认预览和数据，可发布此版本'))})`),true);
  check('Switching to a second fixed release clears its public confirmation, and a delayed automatic deployment response cannot reopen or replace the previous job');
  await verifyFailedPreviewSwitch(secondRelease.manifest,frozen.manifest);
  // An old preparation had no permission to merge. Read/list/refresh cannot
  // silently upgrade it; the new one-click action is the authorization boundary.
  const legacy={eventId:'legacy-prepare-only',releaseId:secondRelease.manifest.releaseId,artifactHash:secondRelease.manifest.artifactHash,account:'fixture-alice',repository:'fixture-alice/legacy',jobId:'legacy-job',status:'pr-open',branch:'legacy-branch',headSha:'b'.repeat(40),prNumber:71,prUrl:'https://github.com/fixture-alice/legacy/pull/71'};
  jobs.set(legacy.jobId,legacy);
  const beforeLegacy=count('board.pages.publish');
  await reload();await click(button(secondRelease.manifest.title+' · '+secondRelease.manifest.artifactHash.slice(0,10)));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('等待继续发布')");
  await click(button('核对部署状态'));
  assert.equal(count('board.pages.publish'),beforeLegacy);assert.equal(legacy.autoPublish,undefined);assert.equal(legacy.status,'pr-open');
  await click(button('确认预览和数据，可发布此版本'));await click(button('一键继续发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建，等待自动合并')");
  assert.deepEqual(calls.filter(c=>c.name==='board.pages.publish').at(-1).input,{eventId:legacy.eventId,releaseId:legacy.releaseId,artifactHash:legacy.artifactHash,account:legacy.account,repository:legacy.repository});
  check('Old preparation-only jobs remain unmerged across reload and read-only refresh; one explicit Continue click authorizes the same frozen request for automatic publication');
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('已核实上线')",9000);
  const beforeRecovery=count('board.pages.publish');publishMode='recovering';await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('结果待核对')");
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('一键继续发布'))})`),false,'An authorized uncertain job is still being handled in the background');
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('已核实上线')",9000);
  assert.equal(count('board.pages.publish'),beforeRecovery+1);assert.equal(calls.filter(c=>c.name==='board.pages.publish').at(-1).input.eventId,legacy.eventId);
  check('An authorized unknown result keeps tracking background recovery to a verified URL with no second click, and publishing an existing live snapshot reuses its original event');
  await command('Emulation.setDeviceMetricsOverride',{width:420,height:860,deviceScaleFactor:1,mobile:false});
  await click(button('下载 ZIP'));await screenshot('release-compact');
  assert.ok(await evaluate("(()=>{const p=document.querySelector('[role=dialog]').getBoundingClientRect();return p.width>0&&p.left>=0&&p.right<=innerWidth})()"));
  check('The publication panel and download action remain reachable at a compact desktop viewport');
  }
  console.log(`Release host integration: ${passed} checks passed (actual static/copy core; adapted GitHub and Paseo transport, no external publication).`);
} catch(error){console.error('Release host failed:',error);console.error('Browser exceptions:',JSON.stringify(logs).slice(-4000));console.error('RPC calls:',JSON.stringify(calls.map(c=>({name:c.name,input:c.input}))).slice(-7000));process.exitCode=1}
finally{
  for(const timer of publicationTimers)clearTimeout(timer);
  try{process.kill(-chrome.pid,'SIGKILL')}catch{}
  chrome.stdio[3].destroy();chrome.stdio[4].destroy();chrome.stderr.destroy();
  for(const entry of commands.values()){clearTimeout(entry.timer);entry.reject(new Error('browser closed'))}
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
