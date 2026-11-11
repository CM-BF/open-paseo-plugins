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
import { createLiveHostBackend, runLiveHostChecks } from './live-host-checks.mjs';
const directory=dirname(fileURLToPath(import.meta.url)), root=dirname(directory);
const temporary=await mkdtemp(join(tmpdir(),'paseo-release-host-'));
const downloads=join(temporary,'downloads'); await mkdir(downloads);
const core=await build({stdin:{contents:`export {BoardStore} from './server/store';export {BoardCopies} from './server/board-copy';export {ReleaseRepository} from './server/static-release';export {canonicalJson} from './server/store-format';export {registerPublicationRpc} from './server/publication-rpc';export {LiveDataPublisher} from './server/live-data';export {projectLive} from './server/live-projection';`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.txt':'text'}});
const coreFile=join(temporary,'core.cjs'); await writeFile(coreFile,core.outputFiles[0].text);
const {BoardStore,BoardCopies,ReleaseRepository,canonicalJson,registerPublicationRpc,LiveDataPublisher,projectLive}=createRequire(import.meta.url)(coreFile);
const boardStore=new BoardStore(join(temporary,'boards')), repository=new ReleaseRepository(join(temporary,'releases'));
let sourceBoard, publishMode='accept', jobSequence=0, holdRefresh=false, failPreviewReleaseId;
const publicationTimers=new Set();
const later=(callback,ms)=>{const timer=setTimeout(()=>{publicationTimers.delete(timer);callback()},ms);publicationTimers.add(timer)};
const heldRefresh=[];
const calls=[], jobs=new Map(), prepareReceipts=new Map(), copiedBoards=[];
const enterpriseHost='github.enterprise.example';
let configuredAccounts=[{login:'fixture-alice',host:'github.com',active:true},{login:'fixture-bob',host:'github.com',active:false},{login:'fixture-alice',host:enterpriseHost,active:true}];
// Share status/update run the actual server handlers over this adapter's job journal.
const shareHandlers=new Map();
registerPublicationRpc({handle:(contract,handler)=>shareHandlers.set(contract.name,handler)},{ready:async()=>{},requireBoard:async id=>{assert.equal(sourceBoard?.id,id);return sourceBoard},releases:repository,
  pages:{list:async()=>structuredClone([...jobs.values()]),read:async id=>structuredClone(jobs.get(id))},
  live:{releaseChannel:board=>liveHost.publisher.releaseChannel(board.id,board.createdAt)}});
const pagesRoot=input=>(input.githubHost===enterpriseHost?'https://pages.enterprise.example/'+input.account+'/':'https://'+input.account+'.github.io/')+input.repository.split('/')[1]+'/';
const copies=new BoardCopies(join(temporary,'copies'),{read:async id=>sourceBoard?.id===id?sourceBoard:boardStore.read(id),create:input=>boardStore.create(input)});
const rpc=async(name,input,board)=>{
  const recorded=structuredClone(input);if(name==='board.live.set'&&recorded.token){delete recorded.token;recorded.tokenSent=true}
  calls.push({name,input:recorded});sourceBoard=board;
  if(name.startsWith('board.live.'))return liveHost.rpc(name,input);
  if(name==='board.release.create'&&input.liveData)return shareHandlers.get(name)(input);
  if(name==='board.copy'){const copied=await copies.copy(input);copiedBoards.push(copied);return copied}
  if(name==='board.release.create')return (await repository.create({...input,board})).manifest;
  if(name==='board.release.list')return (await repository.list(input.boardId)).map(r=>r.manifest);
  if(name==='board.release.preview'){if(input.releaseId===failPreviewReleaseId){failPreviewReleaseId=undefined;throw new Error('Fixture selected preview unavailable')}return repository.preview(input.releaseId)}
  if(name==='board.release.download')return repository.download(input.releaseId);
  if(name==='board.release.share-status'||name==='board.release.share-update')return shareHandlers.get(name)(input);
  if(name==='board.pages.accounts')return configuredAccounts.filter(account=>!input.githubHost||account.host===input.githubHost);
  if(name==='board.pages.repositories')return [{name:input.account+'/site',private:false,url:'https://'+(input.githubHost??'github.com')+'/'+input.account+'/site'},{name:input.account+'/private-site',private:true,url:'https://'+(input.githubHost??'github.com')+'/'+input.account+'/private-site'}];
  if(name==='board.pages.list')return [...jobs.values()].filter(j=>!input.releaseId||j.releaseId===input.releaseId);
  if(name==='board.pages.publish'){
    if(publishMode==='lost-before-job'){publishMode='accept';throw new Error('Fixture connection lost before any readable job')}
    const previous=prepareReceipts.get(input.eventId);if(previous)assert.deepEqual(previous,input,'Same event must retain exact release, target and creation policy');
    else prepareReceipts.set(input.eventId,structuredClone(input));
    const release=await repository.read(input.releaseId);assert.equal(release.manifest.artifactHash,input.artifactHash);
    let job=[...jobs.values()].find(j=>j.eventId===input.eventId);
    if(!job){job={...input,jobId:'fixture-job-'+(++jobSequence),status:'prepared',branch:'board-release/'+input.eventId,baseBranch:'main',baseSha:'a'.repeat(40),headSha:'b'.repeat(40),createdAt:new Date().toISOString()};jobs.set(job.jobId,job)}
    job.autoPublish=true;job.autoPublishUntil=new Date(Date.now()+30*60*1000).toISOString();job.publicationMode='legacy-subdirectory';
    // Series layout: stable boards/<key> plus the version archive; key-less requests keep boards/<releaseHex>.
    if(input.shareKey){job.sharePath='boards/'+input.shareKey;job.sitePath=job.sharePath+'/v/'+input.releaseId.slice(8)}else job.sitePath='boards/'+input.releaseId.slice(8);
    if(publishMode==='lost-response'){publishMode='accept';job.status='unknown';job.autoPublishUntil=new Date(Date.now()-1).toISOString();job.error='Fixture response lost after automatic retry window expired';throw new Error('Fixture response lost; outcome unknown')}
    const recovering=publishMode==='recovering';publishMode='accept';
    job.status=recovering?'unknown':'pr-open';job.prNumber=jobSequence;job.prUrl='https://'+(input.githubHost??'github.com')+'/'+input.repository+'/pull/'+job.prNumber;delete job.error;
    // Explicit adapter: independent server progression, including while the UI
    // is closed. The separate manager tests cover real GitHub head validation.
    later(()=>{job.status='deploying';job.mergedSha='c'.repeat(40)},100);
    later(()=>{
      const url=pagesRoot(input)+job.sitePath+'/',share=job.sharePath&&pagesRoot(input)+job.sharePath+'/';
      if(input.githubHost===enterpriseHost){job.status='deploying';job.deployedUrl=url;if(share)job.shareDeployedUrl=share;job.error='部署已完成，但站点需要公司登录，页面内容待核验。'}
      else{job.status='live';job.url=url;job.verifiedAt=new Date().toISOString();if(share){job.shareDeployedUrl=share;job.shareUrl=share}}
    },350);
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
const liveHost=await createLiveHostBackend({temporary,pageOrigin:origin,currentBoard:()=>sourceBoard,setBoard:board=>{sourceBoard=board},LiveDataPublisher,projectLive});
const chrome = spawn(process.env.BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${join(temporary, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--use-mock-keychain', '--window-size=1100,850', 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let seq = 0;
let buffer = '';
const commands = new Map();
const logs = [];
const downloadEvents = [], downloadListeners = new Set();
chrome.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString();
  let end;
  while ((end = buffer.indexOf('\0')) !== -1) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.id && commands.has(message.id)) {
      const entry = commands.get(message.id); commands.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    } else if (message.method === 'Browser.downloadWillBegin' || message.method === 'Browser.downloadProgress') {
      downloadEvents.push({ method: message.method, ...message.params });
      for (const listener of [...downloadListeners]) listener();
    } else if (message.method === 'Runtime.exceptionThrown') logs.push(message.params.exceptionDetails);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { commands.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  commands.set(id, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
// A click or completed RPC is not a completed browser download. Match the
// native GUID begun after this click and wait for its terminal browser receipt.
const completedDownload = (since, fileName, timeout = 15000) => new Promise((resolve, reject) => {
  let timer;
  const finish = (error, value) => { clearTimeout(timer); downloadListeners.delete(check); error ? reject(error) : resolve(value); };
  const check = () => {
    const begins = downloadEvents.slice(since).filter(event => event.method === 'Browser.downloadWillBegin' && event.suggestedFilename === fileName);
    if (begins.length > 1) { finish(new Error('One download click began multiple matching downloads')); return; }
    if (!begins.length) return;
    const begin = begins[0], terminal = downloadEvents.slice(since).find(event => event.method === 'Browser.downloadProgress' && event.guid === begin.guid && ['completed', 'canceled'].includes(event.state));
    if (!terminal) return;
    if (terminal.state !== 'completed') { finish(new Error('Browser download canceled: ' + JSON.stringify({ begin, terminal }))); return; }
    const filePath = terminal.filePath ?? join(downloads, fileName);
    if (dirname(filePath) !== downloads) { finish(new Error('Completed download escaped the owned directory')); return; }
    finish(undefined, { ...terminal, filePath, suggestedFilename: begin.suggestedFilename });
  };
  timer = setTimeout(() => finish(new Error('Browser download did not complete: ' + JSON.stringify(downloadEvents.slice(since)))), timeout);
  downloadListeners.add(check); check();
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
  await command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
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
  const first=calls.find(c=>c.name==='board.release.create');assert.deepEqual(first.input.publicData,{});assert.deepEqual(first.input.apiOrigins,[]);
  const releases=await repository.list('host-fixture');assert.equal(releases.length,1);const frozen=releases[0];
  assert.ok(!frozen.files['index.html'].includes('Isolated test fixture'),'Private Board data is not implicitly included');
  const sandbox=await evaluate("document.querySelector('[data-testid=board-release-preview]').getAttribute('sandbox')");assert.equal(sandbox,'allow-scripts allow-forms');
  check('Public data starts empty; invalid JSON objects never invoke export, and the actual static snapshot previews in a sandbox without inheriting private Board data');
  await evaluate('hostFixture.updateCanvas();true');await until("document.body.textContent.includes('r2')");
  const fixed=await repository.read(frozen.manifest.releaseId);assert.deepEqual(fixed,frozen);
  const downloadStart = downloadEvents.length;
  await click(button('下载 ZIP'));
  const downloaded = await completedDownload(downloadStart, frozen.manifest.releaseId + '.zip');
  const zipNames=(await readdir(downloads)).filter(n=>n.endsWith('.zip'));assert.equal(zipNames.length,1);
  const bytes=await readFile(downloaded.filePath);assert.equal(bytes.length,downloaded.receivedBytes);assert.equal(bytes.length,downloaded.totalBytes);assert.equal(bytes.readUInt32LE(0),0x04034b50);
  const entries={};let offset=0;while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),nameLength=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28),name=bytes.subarray(offset+30,offset+30+nameLength).toString(),start=offset+30+nameLength+extra;entries[name]=bytes.subarray(start,start+size).toString();offset=start+size}
  assert.deepEqual(entries,frozen.files);assert.ok(!JSON.stringify(entries).includes('owner-fixture'));
  check('Editing the working Board leaves the selected snapshot unchanged, and a real browser ZIP download contains exactly its frozen public files');
  if(process.env.BOARD_RELEASE_PREVIEW_SWITCH_ONLY){
    await replace('input[aria-label="发布名称"]','Preview recovery fixture');await click(button('生成固定版本并预览'));
    await until("document.body.textContent.includes('Preview recovery fixture · 固定版本')");
    const recovery=(await repository.list('host-fixture')).find(item=>item.manifest.title==='Preview recovery fixture');assert.ok(recovery);
    await verifyFailedPreviewSwitch(recovery.manifest,frozen.manifest);
  }else{
  await click(button('读取 GitHub 账号'));
  await until(`document.querySelector(${JSON.stringify(button('fixture-alice · github.com'))})&&document.querySelector(${JSON.stringify(button('fixture-alice · '+enterpriseHost))})&&!document.querySelector(${JSON.stringify(button('读取 GitHub 账号'))}).disabled`);
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(button('fixture-alice · github.com'))})&&document.querySelector(${JSON.stringify(button('fixture-alice · '+enterpriseHost))}))`),true);
  await click(button('fixture-alice · github.com'));await click(button('fixture-alice/site'));
  assert.deepEqual(calls.find(c=>c.name==='board.pages.repositories').input,{account:'fixture-alice',githubHost:'github.com'});
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button('一键发布'))}).disabled`),true);
  await click(button('一键发布'));assert.equal(count('board.pages.publish'),0);
  await click(button('确认预览和数据，可发布此版本'));await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建')");
  const prepared=calls.find(c=>c.name==='board.pages.publish').input;assert.equal(prepared.artifactHash,frozen.manifest.artifactHash);assert.equal(prepared.repository,'fixture-alice/site');assert.equal(prepared.account,'fixture-alice');assert.equal(prepared.githubHost,'github.com');
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('合并此 PR 并发布'))})`),false);
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('打开已发布网页'))})`),false,'No link is offered before verification');
  await reload();
  await click(button(frozen.manifest.title+' · '+frozen.manifest.artifactHash.slice(0,10)));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('已核实上线')",9000);
  assert.equal(count('board.pages.publish'),1,'Full page loss does not create another publication');
  assert.equal(count('board.pages.merge'),0,'The server owns all merge progression');
  assert.match(prepared.shareKey,/^s[a-f0-9]{20}$/,'A first publication starts a share series');
  await click(button('打开已发布网页'));
  assert.equal(await evaluate('hostFixture.links.at(-1)'),'https://fixture-alice.github.io/site/boards/'+prepared.shareKey+'/');
  await click(button('打开此版本'));
  assert.equal(await evaluate('hostFixture.links.at(-1)'),'https://fixture-alice.github.io/site/boards/'+prepared.shareKey+'/v/'+frozen.manifest.releaseId.slice(8)+'/');
  await screenshot('release-desktop-live');
  check('One explicit publish click starts the exact snapshot and repository; the server completes PR, merge and verified deployment across full page loss without another publish or merge click (GitHub adapter)');
  // A different target creates a new explicit request; response loss must persist it.
  await click(button('读取 GitHub 账号'));await click(button('fixture-bob · github.com'));await click(button('fixture-bob/site'));publishMode='lost-response';
  await click(button('确认预览和数据，可发布此版本'));
  await click(button('一键发布'));await until("document.body.textContent.includes('Fixture response lost')");
  const unknown=calls.filter(c=>c.name==='board.pages.publish').at(-1).input;
  await reload();
  await click(button(frozen.manifest.title+' · '+frozen.manifest.artifactHash.slice(0,10)));
  await until("document.querySelector('[data-testid=board-release-preview]')");
  assert.equal(count('board.pages.publish'),2,'Full reload must not automatically prepare/upload');
  await click(button('github.com · fixture-bob/site · 结果待核对'));
  await click(button('确认预览和数据，可发布此版本'));
  await click(button('一键继续发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建')");
  assert.equal(count('board.pages.publish'),3);assert.deepEqual(calls.filter(c=>c.name==='board.pages.publish').at(-1).input,unknown);
  assert.equal(jobs.size,2);
  check('An uncertain publish with an expired automatic window survives a complete page reload and retries only its original immutable request without creating a duplicate job');
  await click(button('读取 GitHub 账号'));await click(button('fixture-bob · github.com'));await click(button('fixture-bob/private-site · 私有仓库'));publishMode='lost-before-job';
  await click(button('一键发布'));await until("document.body.textContent.includes('Fixture connection lost before any readable job')");
  const unseen=calls.filter(c=>c.name==='board.pages.publish').at(-1).input;
  await reload();await click(button('恢复发布 · github.com · fixture-bob/private-site'));
  await until("document.querySelector('[data-testid=board-release-preview]')");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button('一键发布'))}).disabled`),true);
  assert.equal(count('board.pages.publish'),4);
  await click(button('确认预览和数据，可发布此版本'));await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建')");
  assert.deepEqual(calls.filter(c=>c.name==='board.pages.publish').at(-1).input,unseen);assert.equal(jobs.size,3);
  check('Even without a readable server job, full reload recovers the local publish request, requires preview confirmation again and reuses its exact event and target');
  await click(button('读取 GitHub 账号'));await click(button('fixture-alice · github.com'));await click(button('fixture-alice/private-site · 私有仓库'));
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
  // The same login/repository on an Enterprise host is a new publication target.
  // An Enterprise-only login remains usable without any public GitHub account.
  configuredAccounts=configuredAccounts.filter(account=>account.host===enterpriseHost);
  await click(button(frozen.manifest.title+' · '+frozen.manifest.artifactHash.slice(0,10)));
  await until(`document.body.textContent.includes(${JSON.stringify(frozen.manifest.title+' · 固定版本')})&&!document.querySelector(${JSON.stringify(button('读取 GitHub 账号'))}).disabled`);
  await click(button('读取 GitHub 账号'));
  await until(`document.querySelector(${JSON.stringify(button('fixture-alice · '+enterpriseHost))})&&!document.querySelector(${JSON.stringify(button('fixture-alice · github.com'))})&&!document.querySelector(${JSON.stringify(button('读取 GitHub 账号'))}).disabled`);
  assert.deepEqual(calls.filter(call=>call.name==='board.pages.accounts').at(-1).input,{});
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('fixture-alice · github.com'))})`),false);
  await click(button('fixture-alice · '+enterpriseHost));await click(button('fixture-alice/site'));
  assert.deepEqual(calls.filter(call=>call.name==='board.pages.repositories').at(-1).input,{account:'fixture-alice',githubHost:enterpriseHost});
  await click(button('确认预览和数据，可发布此版本'));publishMode='lost-before-job';
  await click(button('一键发布'));await until("document.body.textContent.includes('Fixture connection lost before any readable job')");
  const enterpriseRequest=calls.filter(call=>call.name==='board.pages.publish').at(-1).input;
  assert.equal(enterpriseRequest.githubHost,enterpriseHost);assert.equal(enterpriseRequest.account,prepared.account);assert.equal(enterpriseRequest.repository,prepared.repository);assert.notEqual(enterpriseRequest.eventId,prepared.eventId);
  const beforeEnterpriseReload=count('board.pages.publish');
  await reload();await click(button('恢复发布 · '+enterpriseHost+' · fixture-alice/site'));
  await until(`document.querySelector('[data-testid=board-release-preview]')&&document.body.textContent.includes(${JSON.stringify('发布账号：fixture-alice · '+enterpriseHost)})&&!document.querySelector(${JSON.stringify(button('读取 GitHub 账号'))}).disabled`);
  assert.equal(count('board.pages.publish'),beforeEnterpriseReload);
  assert.ok(await evaluate(`document.body.textContent.includes(${JSON.stringify('发布账号：fixture-alice · '+enterpriseHost)})`));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button('一键发布'))}).disabled`),true);
  await click(button('确认预览和数据，可发布此版本'));await click(button('一键发布'));
  await until("document.querySelector('[data-testid=board-pages-job]')?.textContent.includes('PR 已创建')");
  assert.deepEqual(calls.filter(call=>call.name==='board.pages.publish').at(-1).input,enterpriseRequest);
  assert.equal([...jobs.values()].filter(item=>item.releaseId===prepared.releaseId&&item.repository===prepared.repository).length,2);
  check('Enterprise-only discovery works without a public login; identical account/repository names on different GitHub hosts get distinct requests, and reload recovers only the exact Enterprise target');
  await replace('input[aria-label="GitHub 主机（可选）"]',enterpriseHost);
  await until(`document.querySelector(${JSON.stringify(button('一键发布'))}).disabled&&!document.body.textContent.includes(${JSON.stringify('发布账号：fixture-alice · '+enterpriseHost)})`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button('一键发布'))}).disabled`),true);
  await click(button('读取 GitHub 账号'));
  await until(`document.querySelector(${JSON.stringify(button('fixture-alice · '+enterpriseHost))})&&!document.querySelector(${JSON.stringify(button('fixture-alice · '+enterpriseHost))}).disabled&&!document.querySelector(${JSON.stringify(button('读取 GitHub 账号'))}).disabled`);
  await click(button('fixture-alice · '+enterpriseHost));
  await until(`document.querySelector(${JSON.stringify(button('fixture-alice/site'))})&&!document.querySelector(${JSON.stringify(button('读取 GitHub 账号'))}).disabled`);
  assert.deepEqual(calls.filter(call=>call.name==='board.pages.accounts').at(-1).input,{githubHost:enterpriseHost});
  assert.deepEqual(calls.filter(call=>call.name==='board.pages.repositories').at(-1).input,{account:'fixture-alice',githubHost:enterpriseHost});
  assert.equal(await evaluate('document.querySelector(\'input[aria-label="GitHub 仓库 owner/repo"]\').value'),'');
  assert.equal(count('board.pages.publish'),beforeEnterpriseReload+1);
  check('The optional GitHub hostname scopes discovery and repository reads, clears the old target and never publishes by itself');
  await until(`document.querySelector(${JSON.stringify(button('打开网页（内容待核验）'))})`,9000);
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(button('打开已发布网页'))})`),false);
  assert.equal(await evaluate("document.querySelector('[data-testid=board-pages-job]').textContent.includes('已核实上线')"),false);
  const beforePrivateOpen=count('board.pages.publish');await click(button('打开网页（内容待核验）'));
  assert.match(enterpriseRequest.shareKey,/^s[a-f0-9]{20}$/);assert.notEqual(enterpriseRequest.shareKey,prepared.shareKey,'Another host is another share link');
  await until(`hostFixture.links.at(-1)===${JSON.stringify('https://pages.enterprise.example/fixture-alice/site/boards/'+enterpriseRequest.shareKey+'/')}`);
  assert.equal(await evaluate('hostFixture.links.at(-1)'),'https://pages.enterprise.example/fixture-alice/site/boards/'+enterpriseRequest.shareKey+'/');
  assert.equal(count('board.pages.publish'),beforePrivateOpen);
  check('An Enterprise site with a successful build but login-protected contents exposes an explicitly unverified link without claiming live verification or starting another publication');
  await command('Emulation.setDeviceMetricsOverride',{width:420,height:860,deviceScaleFactor:1,mobile:false});
  const compactDownloadStart=downloadEvents.length;
  await click(button('下载 ZIP'));await completedDownload(compactDownloadStart,frozen.manifest.releaseId+'.zip');await screenshot('release-compact');
  assert.ok(await evaluate("(()=>{const p=document.querySelector('[role=dialog]').getBoundingClientRect();return p.width>0&&p.left>=0&&p.right<=innerWidth})()"));
  check('The publication panel and download action remain reachable at a compact desktop viewport');
  }
  // API destinations are explicit per-release inputs, not implicit live Board data.
  const apiInput='textarea[aria-label="后端 API 来源"]', beforeApi=count('board.release.create');
  await replace(apiInput,'https://api.example.internal/private-path');
  await click(button('生成固定版本并预览'));
  await until("document.body.textContent.includes('API 地址应为 HTTPS 来源')");
  assert.equal(count('board.release.create'),beforeApi,'Invalid API URLs must be rejected before the create RPC');
  const apiOrigins=['https://api.example.internal','http://127.0.0.1:58123'];
  await replace(apiInput,'  '+apiOrigins[0]+'  \n\n '+apiOrigins[1]+'\n');
  await replace('input[aria-label="发布名称"]','Backend API publication');
  await click(button('生成固定版本并预览'));
  await until("document.body.textContent.includes('Backend API publication · 固定版本')&&document.querySelector('[data-testid=board-release-preview]')");
  assert.deepEqual(calls.filter(c=>c.name==='board.release.create').at(-1).input.apiOrigins,apiOrigins);
  const apiRelease=(await repository.list('host-fixture')).find(r=>r.manifest.title==='Backend API publication');assert.ok(apiRelease);
  assert.deepEqual(apiRelease.manifest.apiOrigins,apiOrigins);
  const fixedApiText='已固定的后端来源：'+apiOrigins.join('、');
  assert.ok(await evaluate(`document.body.textContent.includes(${JSON.stringify(fixedApiText)})`));
  await replace(apiInput,'https://not-yet-exported.example.internal');
  assert.equal(count('board.release.create'),beforeApi+1,'Editing API input must not silently create or modify a release');
  assert.ok(await evaluate(`document.body.textContent.includes(${JSON.stringify(fixedApiText)})`));
  assert.deepEqual((await repository.read(apiRelease.manifest.releaseId)).manifest.apiOrigins,apiOrigins);
  await screenshot('release-api-origins');
  await reload();await click(button(apiRelease.manifest.title+' · '+apiRelease.manifest.artifactHash.slice(0,10)));
  await until(`document.body.textContent.includes(${JSON.stringify(fixedApiText)})&&document.querySelector('[data-testid=board-release-preview]')`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(apiInput)}).value`),'','A fresh editor must not silently inherit API authority from a selected release');
  assert.equal(count('board.release.create'),beforeApi+1);
  check('The API origin field rejects paths before RPC, freezes trimmed explicit origins into the real artifact and displays that immutable authority across input edits and reload');

  // Retain a valid old manifest shape: the API field did not exist in old releases.
  // Public manifest serialization is updated, while the hashed content inventory
  // and exact viewer files remain unchanged; read/list/preview use the real core.
  const legacyRelease=structuredClone(frozen);delete legacyRelease.manifest.apiOrigins;
  legacyRelease.files['release.json']=canonicalJson(legacyRelease.manifest)+'\n';
  await writeFile(join(repository.root,legacyRelease.manifest.releaseId+'.json'),JSON.stringify(legacyRelease));
  assert.equal((await repository.read(legacyRelease.manifest.releaseId)).manifest.apiOrigins,undefined);
  await reload();await click(button(legacyRelease.manifest.title+' · '+legacyRelease.manifest.artifactHash.slice(0,10)));
  await until(`document.body.textContent.includes(${JSON.stringify(legacyRelease.manifest.title+' · 固定版本')})&&document.querySelector('[data-testid=board-release-preview]')`);
  assert.equal(await evaluate("document.body.textContent.includes('已固定的后端来源：')"),false);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(apiInput)}).value`),'');
  assert.equal(count('board.release.create'),beforeApi+1);
  check('A stored manifest without apiOrigins still lists and previews through the real repository without granting backend access or creating a replacement release');
  if(!process.env.BOARD_RELEASE_PREVIEW_SWITCH_ONLY){
    // Share links follow their Board. A fresh Board keeps this share list deterministic.
    configuredAccounts=[{login:'fixture-alice',host:'github.com',active:true},{login:'fixture-bob',host:'github.com',active:false}];
    await command('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});
    const loadPage=async load=>{const id=await evaluate('hostFixture.pageInstance');await load();await until(`window.hostFixture&&hostFixture.pageInstance!==${JSON.stringify(id)}&&hostFixture.mainReady()?.ready`)};
    const statusReads="hostFixture.publicationCalls.filter(c=>c.name==='board.release.share-status').length";
    const badge='[data-testid="board-share-badge"]', confirm='[data-testid="board-share-confirm"]';
    const jobText=text=>`document.querySelector('[data-testid=board-pages-job]')?.textContent.includes(${JSON.stringify(text)})`;
    const opened=url=>until(`hostFixture.links.at(-1)===${JSON.stringify(url)}`);
    await loadPage(()=>command('Page.navigate',{url:origin+'/?drafts=1&board=share-fixture'}));
    await until(`${statusReads}>0`);
    await click('[data-testid="board-more-open"]');
    assert.equal(await evaluate(`!!document.querySelector('[data-testid="board-share-update"]')||!!document.querySelector(${JSON.stringify(badge)})`),false,'Nothing shared yet: no dot and no update action');
    await click(button('导出与发布'));await until("document.querySelector('[data-testid=board-release-panel]')");
    assert.equal(await evaluate("!!document.querySelector('[data-testid=board-share-status]')"),false);
    await replace('input[aria-label="发布名称"]','Shared page fixture');await replace('[data-testid="board-release-data"]','{"shared":1}');
    await click(button('深色'));await click(button('允许 CDN 库'));await click(button('生成固定版本并预览'));
    await until("document.body.textContent.includes('Shared page fixture · 固定版本')&&document.querySelector('[data-testid=board-release-preview]')");
    const v1=(await repository.list('share-fixture'))[0].manifest;
    await click(button('读取 GitHub 账号'));await click(button('fixture-alice · github.com'));await click(button('fixture-alice/site'));
    await click(button('确认预览和数据，可发布此版本'));await click(button('一键发布'));
    await until(jobText('已核实上线'),12000);
    const firstShare=calls.filter(c=>c.name==='board.pages.publish').at(-1).input;
    assert.match(firstShare.shareKey,/^s[a-f0-9]{20}$/);assert.equal(firstShare.releaseId,v1.releaseId);assert.ok(calls.filter(c=>c.name==='board.pages.publish').slice(0,-1).every(c=>c.input.shareKey!==firstShare.shareKey),'Another Board on the same repository gets its own share link');
    const shareLink='https://fixture-alice.github.io/site/boards/'+firstShare.shareKey+'/';
    await click(button('打开已发布网页'));await opened(shareLink);
    await click(button('打开此版本'));await opened(shareLink+'v/'+v1.releaseId.slice(8)+'/');
    check('A first one-click publication mints a share key: the opened link is the stable share link and the exact version stays separately openable');
    // A pre-feature publication of this Board: per-release directory and no stored settings.
    const shareBoard=await evaluate('hostFixture.board()');
    const r0=await repository.create({boardId:shareBoard.id,expectedCanvasBase:{revision:shareBoard.canvas.revision,documentVersion:shareBoard.canvas.documentVersion},title:'Old shared page',network:'cdn',publicData:{old:true},board:shareBoard});
    await rm(join(repository.root,r0.manifest.releaseId+'.settings.json'));
    const r0hex=r0.manifest.releaseId.slice(8), legacyLink='https://fixture-alice.github.io/legacy-share/boards/'+r0hex+'/';
    jobs.set('legacy-share-job',{eventId:'legacy-share',releaseId:r0.manifest.releaseId,artifactHash:r0.manifest.artifactHash,account:'fixture-alice',repository:'fixture-alice/legacy-share',jobId:'legacy-share-job',status:'live',branch:'legacy-share',mergedSha:'d'.repeat(40),publicationMode:'legacy-subdirectory',sitePath:'boards/'+r0hex,sourcePath:'/',url:legacyLink,verifiedAt:new Date().toISOString(),createdAt:'2026-01-01T00:00:00.000Z'});
    const beforeClose=await evaluate(statusReads);
    await click(button('关闭窗口'));await until(`!document.querySelector('[data-testid=board-release-panel]')&&${statusReads}>${beforeClose}`);
    await click('[data-testid="board-more-open"]');
    await until(`document.querySelector('[data-testid="board-share-update"]')&&document.querySelector(${JSON.stringify(button('导出与发布'))}).textContent.includes('分享页已是最新')`);
    await click('[data-testid="board-more-open"]');
    await evaluate('hostFixture.updateCanvas();true');await until('hostFixture.cacheBoard()?.canvas.revision===hostFixture.board().canvas.revision');
    await evaluate('new Promise(resolve=>setTimeout(resolve,200))');
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(badge)})`),false,'A data-only write is not an unpublished change');
    const readsBeforeEdit=await evaluate(statusReads);
    await evaluate("hostFixture.patchCanvas('Edited after sharing');true");
    await until(`document.querySelector(${JSON.stringify(badge)})`);
    assert.equal(await evaluate(statusReads),readsBeforeEdit,'The dot compares the live canvas locally; an edit does not refetch share status');
    await click('[data-testid="board-more-open"]');
    await until(`document.querySelector(${JSON.stringify(button('导出与发布'))}).textContent.includes('2 个分享页有改动还没发布')`);
    const publishesBeforeUpdate=count('board.pages.publish');
    await click('[data-testid="board-share-update"]');
    await until(`document.querySelector(${JSON.stringify(confirm)})&&document.querySelector('[data-testid=board-release-preview]')`,15000);
    const updateCall=calls.filter(c=>c.name==='board.release.share-update').at(-1).input;
    assert.equal(updateCall.boardId,'share-fixture');assert.deepEqual(updateCall.expectedSource,{documentVersion:1,patchCount:1});
    assert.equal(count('board.pages.publish'),publishesBeforeUpdate,'Opening an update builds and previews only');
    const v2=(await repository.list('share-fixture')).find(r=>r.provenance.patchCount===1&&r.manifest.title==='Shared page fixture');assert.ok(v2);
    assert.notEqual(v2.manifest.releaseId,v1.releaseId);
    assert.deepEqual((await repository.meta(v2.manifest.releaseId)).settings,(await repository.meta(v1.releaseId)).settings,'The update inherits title, theme, network, API origins and public data');
    const confirmText=await evaluate(`document.querySelector(${JSON.stringify(confirm)}).parentElement.textContent`);
    assert.ok(confirmText.includes(shareLink)&&confirmText.includes('访客本地保存的状态会从新版本重新开始'),confirmText);
    assert.ok(await evaluate("document.querySelector('[data-testid=board-share-status]').textContent.includes('有改动还没发布')"));
    check('After an authored edit (not a data-only write) the More dot appears without refetching; 更新分享页 builds with the inherited settings and previews it without publishing');
    const beforeReload=count('board.pages.publish');
    await loadPage(()=>command('Page.reload',{ignoreCache:true}));
    await until(`document.querySelector(${JSON.stringify(badge)})`);
    assert.equal(count('board.pages.publish'),beforeReload,'Reload never publishes');
    await click('[data-testid="board-more-open"]');await click('[data-testid="board-share-update"]');
    await until(`document.querySelector(${JSON.stringify(confirm)})&&document.querySelector('[data-testid=board-release-preview]')`,15000);
    assert.equal(count('board.pages.publish'),beforeReload);
    await click(confirm);
    await until(jobText('已核实上线'),12000);
    const updated=calls.filter(c=>c.name==='board.pages.publish').at(-1).input;
    assert.equal(count('board.pages.publish'),beforeReload+1);
    assert.deepEqual({...updated,eventId:undefined},{releaseId:v2.manifest.releaseId,artifactHash:v2.manifest.artifactHash,githubHost:'github.com',account:'fixture-alice',repository:'fixture-alice/site',shareKey:firstShare.shareKey,eventId:undefined});
    assert.notEqual(updated.eventId,firstShare.eventId);
    await click(button('打开已发布网页'));await opened(shareLink);
    await click(button('打开此版本'));await opened(shareLink+'v/'+v2.manifest.releaseId.slice(8)+'/');
    check('One 确认并更新分享页 click publishes the reviewed build with the same share key, so the same link updates; a full reload before it published nothing');
    await click(button('Shared page fixture · '+v1.artifactHash.slice(0,10)));
    await until(jobText('已核实上线'));
    await click(button('打开此版本'));await opened(shareLink+'v/'+v1.releaseId.slice(8)+'/');
    check('The previous version stays listed and openable at its own archive link after the update');
    await until(`[...document.querySelectorAll('[data-testid=board-share-status] button')].some(b=>b.getAttribute('aria-label')==='沿用上次分享页的设置')`);
    await click(button('沿用上次分享页的设置'));
    await until(`document.querySelector('input[aria-label="发布名称"]').value==='Old shared page'`);
    const recoveredText=await evaluate("document.querySelector('[data-testid=board-share-status]').textContent");
    assert.ok(recoveredText.includes('允许 CDN 库')&&recoveredText.includes('不连接后端')&&recoveredText.includes('主题和公开数据没有保存'),recoveredText);
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="后端 API 来源"]').value`),'');
    await replace('[data-testid="board-release-data"]','{"old":true}');await click(button('生成固定版本并预览'));
    await until(`document.querySelector(${JSON.stringify(confirm)})&&document.body.textContent.includes('Old shared page · 固定版本')&&document.querySelector('[data-testid=board-release-preview]')`);
    assert.ok((await evaluate(`document.querySelector(${JSON.stringify(confirm)}).parentElement.textContent`)).includes(legacyLink));
    const beforeAdopt=count('board.pages.publish');
    await click(confirm);await until(jobText('已核实上线'),12000);
    const adopted=calls.filter(c=>c.name==='board.pages.publish').at(-1).input;
    assert.equal(count('board.pages.publish'),beforeAdopt+1);assert.equal(adopted.shareKey,r0hex);assert.equal(adopted.repository,'fixture-alice/legacy-share');
    assert.ok((await repository.meta(adopted.releaseId)).settings.network==='cdn');
    await click(button('打开已发布网页'));await opened(legacyLink);
    check('A pre-feature share without stored settings is adopted: recovered settings are listed, theme and data are chosen again, and one confirmation updates the link already sent');
    await click(button('关闭窗口'));await until(`!document.querySelector('[data-testid=board-release-panel]')&&!document.querySelector(${JSON.stringify(badge)})`,9000);
    await click('[data-testid="board-more-open"]');
    await until(`document.querySelector(${JSON.stringify(button('导出与发布'))}).textContent.includes('分享页已是最新')`);
    await click('[data-testid="board-more-open"]');
    check('Once every share link carries the current authored source, the dot clears');
    // Stale local requests: a typed server refusal drops the record; any other can be discarded.
    await open();
    await click(button('Shared page fixture · '+v1.artifactHash.slice(0,10)));await until(jobText('已核实上线'));
    await click(button('读取 GitHub 账号'));await click(button('fixture-bob · github.com'));await click(button('fixture-bob/site'));
    await click(button('确认预览和数据，可发布此版本'));publishMode='lost-before-job';
    await click(button('一键发布'));await until("document.body.textContent.includes('Fixture connection lost before any readable job')");
    const refused=calls.filter(c=>c.name==='board.pages.publish').at(-1).input;
    assert.match(refused.shareKey,/^s[a-f0-9]{20}$/);
    jobs.set('refused-job',{...refused,jobId:'refused-job',status:'failed',branch:'refused',createdAt:new Date().toISOString(),error:'分享页上已有更新的版本，此请求不会覆盖。',refusal:{code:'newer-on-share',message:'分享页上已有更新的版本，此请求不会覆盖。'}});
    await click(button('fixture-bob/private-site · 私有仓库'));publishMode='lost-before-job';
    await click(button('一键发布'));
    await until(`Object.keys(localStorage).filter(k=>k.startsWith('@paseo:board-pages:')&&k.includes('share-fixture')).length===2`);
    const beforeStale=count('board.pages.publish');
    await reload();
    await until(`!document.querySelector(${JSON.stringify(button('恢复发布 · github.com · fixture-bob/site'))})&&document.querySelector(${JSON.stringify(button('恢复发布 · github.com · fixture-bob/private-site'))})`);
    await click(button('放弃 · github.com · fixture-bob/private-site'));
    await until(`!document.querySelector(${JSON.stringify(button('恢复发布 · github.com · fixture-bob/private-site'))})&&Object.keys(localStorage).filter(k=>k.startsWith('@paseo:board-pages:')&&k.includes('share-fixture')).length===0`);
    await reload();
    assert.equal(await evaluate("document.body.textContent.includes('待核对的发布请求')"),false);
    assert.equal(count('board.pages.publish'),beforeStale,'Cleaning up stale requests never publishes');
    check('A request the server refused for good leaves the local retry list on reopen, and any other stale request can be discarded without publishing');
  }
  if(!process.env.BOARD_RELEASE_PREVIEW_SWITCH_ONLY){
    const loadPage=async load=>{const id=await evaluate('hostFixture.pageInstance');await load();await until(`window.hostFixture&&hostFixture.pageInstance!==${JSON.stringify(id)}&&hostFixture.mainReady()?.ready`)};
    await runLiveHostChecks({assert,command,evaluate,until,click,replace,button,check,pageOrigin:origin,live:liveHost,calls,repository,jobs,loadPage});
  }
  console.log(`Release host integration: ${passed} checks passed (actual static/copy core; adapted GitHub and Paseo transport, no external publication).`);
} catch(error){console.error('Release host failed:',error);console.error('Browser exceptions:',JSON.stringify(logs).slice(-4000));console.error('Download events:',JSON.stringify(downloadEvents));console.error('RPC calls:',JSON.stringify(calls.map(c=>({name:c.name,input:c.input}))).slice(-7000));process.exitCode=1}
finally{
  for(const timer of publicationTimers)clearTimeout(timer);
  try{process.kill(-chrome.pid,'SIGKILL')}catch{}
  chrome.stdio[3].destroy();chrome.stdio[4].destroy();chrome.stderr.destroy();
  for(const entry of commands.values()){clearTimeout(entry.timer);entry.reject(new Error('browser closed'))}
  await liveHost.close().catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
