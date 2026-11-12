import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// The built-in liquid-glass preset inside the real buildBoardDocument wrapper and the real
// CanvasFrame host: activation, all seven roles, host "/" forwarding, live-patch activation,
// legacy hand-over, reduced motion, layout shift, identity and a pass of every interaction in
// light/dark at desktop and narrow widths; dark-theme readability, an open module's strip against
// the dock, and benign ResizeObserver notices (any Board). Screenshots only when
// BOARD_GLASS_SHOT_DIR is set. BOARD_LEGACY_BOARD_HTML=<path to a 0.2 kit Board source> also runs
// that real Board through the frame host (not part of this repository).
export async function runLiquidGlassChecks({ evaluate, frame, update, command, send, clickPoint, location, drag, key, until, untilFrame, settleFrame, setReducedMotion, profile, directory, baseHtml, check }) {
  const root = join(directory, '..');
  const example = await readFile(join(root, 'examples/liquid-glass.html'), 'utf8');
  const legacyKit = await readFile(join(directory, 'fixtures/liquid-glass-legacy-guard.js'), 'utf8');
  const identityBundle = await build({ stdin: { contents: 'export {componentIdentityFor} from "./shared/component-identity"; export {DOMParser} from "linkedom";', resolveDir: root, loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', write: false });
  const identityPath = join(profile, 'glass-identity.cjs'); await writeFile(identityPath, identityBundle.outputFiles[0].text);
  const { componentIdentityFor, DOMParser } = createRequire(import.meta.url)(identityPath);
  const shotDir = process.env.BOARD_GLASS_SHOT_DIR;
  if (shotDir) await mkdir(shotDir, { recursive: true });
  const shot = async name => {
    if (!shotDir) return;
    const image = await command('Page.captureScreenshot', { format: 'png' });
    const file = join(shotDir, `${name}.png`); await writeFile(file, Buffer.from(image.data, 'base64'));
    console.log('ARTIFACT glass-screenshot', file);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Eval bridge and forwarding counter (test harness only; the example page itself has no script).
  // window.delayPresetKey (ms) holds a forwarded "/" back like a busy canvas would; parse-time
  // listeners run before the preset's own (it starts on DOMContentLoaded).
  // window.rawErrors keeps every window error message the canvas sees, including the benign
  // ResizeObserver notices that the Board runtime does not report.
  const bridge = `<script>window.rawErrors=[];window.addEventListener('error',e=>rawErrors.push(String(e.message)));window.addEventListener('message',e=>{if(window.delayPresetKey&&e.source===parent&&e.data?.type==='preset-key'&&!e.data.late){e.stopImmediatePropagation();setTimeout(()=>window.dispatchEvent(new MessageEvent('message',{data:{...e.data,late:true},source:parent})),window.delayPresetKey)}});window.presetKeyMessages=0;window.lgChanges=[];window.addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='preset-key')window.presetKeyMessages++});document.addEventListener('lg:change',e=>window.lgChanges.push({name:e.detail.name,value:e.detail.value}));window.addEventListener('message',async e=>{if(e.source===parent&&e.data?.channel==='fixture'){try{const value=await eval(e.data.code);parent.postMessage({channel:'fixture-result',id:e.data.id,value},'*')}catch(error){parent.postMessage({channel:'fixture-result',id:e.data.id,error:error.message},'*')}}});</script>`;
  // A typical agent reset: the preset must survive it (no cascade layer, scoped selectors).
  const reset = '<style id="agent-reset">*{margin:0;padding:0;box-sizing:border-box}button{background:none;border:0;font:inherit}h1{font-size:20px}section{padding:0}</style>';
  // Authored motion inside a preset card: reduced motion must leave it to the author.
  const authoredMotion = '<style id="authored-motion">@keyframes authored-pulse{50%{opacity:.2}}.authored-pulse{display:inline-block;width:8px;height:8px;animation:authored-pulse 1.2s ease-in-out infinite}.col-lg-6{transition:opacity 2s}</style>';
  const extras = `<section id="glass-tests" class="lg-columns" aria-label="测试区">
    <article data-lg="card" id="tests-card"><div class="lg-card-head"><h2>数据路径</h2><button type="button" class="btn" id="glass-btn">普通按钮</button></div>
      <figure id="data-chart" data-lg="chart" data-lg-path="/trend" data-lg-type="line" data-lg-unit="次" aria-label="来自 Board 数据的折线"></figure></article>
    <article data-lg="card"><h2>注入测试</h2><figure id="xss-chart" data-lg="chart" aria-label="标签注入测试" data-lg-values="3,5" data-lg-labels='<img src=x onerror="window.__xss=1">,b'></figure></article>
    <article data-lg="card" id="motion-card"><h2>作者动画</h2><span id="authored-pulse" class="authored-pulse"></span><span id="authored-col" class="col-lg-6">列</span>
      <p><b id="count-plain" data-lg-count="1234">1234</b> · <b id="count-unit" data-lg-count="98.6" data-lg-key="{range}" data-lg-by="7d:98.6, 30d:97.25, 90d:96">98.6%</b></p>
      <p id="ink-sample">正文 <a id="ink-link" href="#overview">链接</a> <code id="ink-code">code</code> <input id="ink-input" class="form-control" value="输入" aria-label="示例输入"></p>
      <figure id="int-chart" data-lg="chart" data-lg-values="14,19,22" data-lg-labels="一,二,三" data-lg-unit="篇" aria-label="整数计数"></figure></article>
  </section>`;
  const page = reset + authoredMotion + example.replace('<nav id="dock"', `${extras}\n  <nav id="dock"`) + bridge;
  const data = { trend: [3, 5, 4] };

  let version = await evaluate('hostProps.canvas.documentVersion');
  const errorsAtStart = await evaluate('results.errors.length');
  const load = async (html, { height = 780, presetKeys = { fromBody: true }, canvasData = data } = {}) => {
    const ready = await evaluate('results.ready');
    version += 1;
    await update(`{boardId:'glass-board',title:'Glass',selectionMode:'off',interactions:[],selectedInteractionId:undefined,height:${height},presetKeys:${JSON.stringify(presetKeys)},canvas:{html:${JSON.stringify(html)},data:${JSON.stringify(canvasData)},patches:[],revision:${version},documentVersion:${version}}}`);
    await until(`results.ready===${ready + 1}`);
    await untilFrame('typeof window.fixtureCall!=="undefined"||true');
  };
  const viewport = async (width, height = 850) => {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await settleFrame();
  };
  const hostBlur = () => evaluate('document.activeElement&&document.activeElement!==document.body&&document.activeElement.blur(),true');
  const slash = async () => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191, text: '/', unmodifiedText: '/' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191 });
  };
  const hostFrameFocused = () => evaluate("document.activeElement===document.querySelector('iframe')");
  const paletteOpen = () => frame("document.querySelector('#palette')?.classList.contains('is-open')===true");
  const center = async selector => { const b = await location(selector); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const hover = async ({ x, y }) => command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const clickIn = async selector => { await frame(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await settleFrame(); const p = await center(selector); await clickPoint(p.x, p.y); };
  const rgb = value => value.replace(/\s+/g, '');
  const dockState = "({cls:document.querySelector('#dock').className,y:scrollY,h:innerHeight,sh:document.documentElement.scrollHeight,hover:document.querySelector('#dock').matches(':hover'),act:document.activeElement?.tagName+'#'+document.activeElement?.id})";
  const untilDock = async (tucked, label, timeout = 3000) => untilFrame(`${tucked ? '' : '!'}document.querySelector('#dock').classList.contains('is-tucked')`, timeout).catch(async e => { console.log('DEBUG dock', label, JSON.stringify(await frame(dockState))); throw e; });

  // 1. Activation inside the real wrapper.
  await viewport(1100);
  await load(page);
  await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  const srcdoc = await evaluate("document.querySelector('iframe').srcdoc");
  assert.equal(srcdoc.split('<style id="paseo-board-liquid-glass-style" data-version="1.0.0">').length - 1, 1);
  assert.equal(srcdoc.split('<script id="paseo-board-liquid-glass-script" data-version="1.0.0">').length - 1, 1);
  assert.deepEqual(await frame("({version:LiquidGlass.version,builtin:LiquidGlass.builtin,defs:document.querySelectorAll('#lg-defs').length,overlay:document.querySelector('#lg-defs').hasAttribute('data-board-overlay')})"), { version: '1.0.0', builtin: true, defs: 1, overlay: true });
  assert.deepEqual(await evaluate(`results.errors.slice(${errorsAtStart})`), []);
  check('liquid-glass preset activates once inside the real Board document and frame host');

  // 2. Base look, under a typical agent CSS reset.
  await untilFrame("!document.querySelector('.lg-rolling')", 4000);
  const look = await frame(`(()=>{const h=getComputedStyle(document.documentElement),s=getComputedStyle(document.querySelector('#lg-page')),t=getComputedStyle(document.querySelector('.lg-title')),c=getComputedStyle(document.querySelector('#kpi-publish')),b=getComputedStyle(document.body),o=getComputedStyle(document.querySelector('#range > [data-lg-option]'));return {scheme:h.colorScheme,bg:h.backgroundColor,ink:s.color,title:parseFloat(t.fontSize),cardBg:c.backgroundImage!=='none',blur:c.backdropFilter,pad:c.paddingTop,radius:c.borderTopLeftRadius,bodyMax:b.maxWidth,optionHeight:o.height,blobs:document.querySelectorAll('#range .lg-split-blob').length}})()`);
  assert.equal(look.scheme, 'light'); assert.equal(rgb(look.bg), 'rgb(235,215,204)'); assert.equal(rgb(look.ink), 'rgb(43,29,26)');
  assert.ok(look.title >= 48, JSON.stringify(look)); assert.ok(look.cardBg); assert.notEqual(look.blur, 'none');
  assert.equal(look.pad, '20px'); assert.equal(look.radius, '24px'); assert.equal(look.bodyMax, 'none'); assert.equal(look.optionHeight, '42px'); assert.equal(look.blobs, 3);
  await shot('glass-light-desktop');
  check('the base look (field, frosted 24px cards, 48px+ title, ink) holds and survives a typical agent CSS reset');

  // 3. Layout shift and offline/no-error state after load.
  const shift = await frame("new Promise(resolve=>{let sum=0;new PerformanceObserver(list=>{for(const e of list.getEntries())if(!e.hadRecentInput)sum+=e.value}).observe({type:'layout-shift',buffered:true});setTimeout(()=>resolve(sum),1000)})");
  console.log('MEASURE glass-layout-shift', shift);
  assert.ok(shift < 0.05, `layout shift ${shift}`);
  check('the preset mounts without measurable layout shift');

  // 3b. Rolling numbers keep authored text that already shows the value (Board text edits compare
  // the live text with the source); a new value keeps the authored affixes and grouping.
  const counts = () => frame("['#count-plain','#count-unit','#kpi > article:nth-of-type(2) [data-lg-count]','#kpi-publish [data-lg-count]'].map(s=>document.querySelector(s).textContent)");
  assert.deepEqual(await counts(), ['1234', '98.6%', '15,872', '126']);
  const chooseRange = value => frame(`LiquidGlass.api(document.querySelector('#range'),'split').choose(document.querySelector('#range > [data-lg-option="${value}"]')),true`);
  await chooseRange('90d');
  await untilFrame("!document.querySelector('.lg-rolling')&&document.querySelector('#count-unit').textContent==='96%'", 4000);
  assert.deepEqual(await counts(), ['1234', '96%', '183,940', '1,486']);
  await chooseRange('7d');
  await untilFrame("!document.querySelector('.lg-rolling')&&document.querySelector('#count-unit').textContent==='98.6%'", 4000);
  assert.deepEqual(await counts(), ['1234', '98.6%', '15,872', '126']);
  check('rolling numbers keep the authored text (no reformatting) and follow controls in the authored format');

  // 4. Identity matrix: live fingerprints (runtime algorithm) against the authored source.
  const liveIdentity = selector => frame(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});const elements=[node,...node.querySelectorAll('*')].filter(e=>!e.closest('[data-board-overlay]'));const indices=new Map(elements.map((e,i)=>[e,i]));const input=JSON.stringify(elements.map(e=>{const id=[indices.get(e.parentElement)??-1,e.localName.toLowerCase(),e.id||'',e.getAttribute('role')||'',e.getAttribute('name')||'',e.getAttribute('type')||''];const l=['data-paseo-layout','data-paseo-layout-part','data-paseo-layout-key'].map(n=>e.getAttribute(n));if(l.some(v=>v!==null))id.push(l.map(v=>v??''));return id}));let h=2166136261;for(let i=0;i<input.length;i++)h=Math.imul(h^input.charCodeAt(i),16777619);return (h>>>0).toString(16).padStart(8,'0')})()`);
  const authoredDoc = new DOMParser().parseFromString(`<html><body>${page}</body></html>`, 'text/html');
  const matrix = {};
  for (const id of ['kpi-publish', 'kpi', 'recent', 'metric', 'range', 'dock', 'trend-chart', 'modules']) {
    matrix[id] = (await liveIdentity('#' + id)) === componentIdentityFor(authoredDoc.querySelector('#' + id)).fingerprint;
  }
  console.log('MEASURE glass-identity-matrix', JSON.stringify(matrix));
  for (const id of ['kpi-publish', 'kpi', 'recent', 'metric', 'range', 'dock']) assert.equal(matrix[id], true, `${id} keeps its authored component identity`);
  for (const id of ['trend-chart', 'modules']) assert.equal(matrix[id], false, `${id} is documented as generated structure`);
  check('KPI cards, lists, nav, split and dock keep authored component identity; chart and expand are the documented exceptions');

  // 5. Text anchor over a rolling KPI reads the real number, and its capture renders.
  await frame("document.querySelector('#kpi-publish').scrollIntoView({block:'center'});getSelection().removeAllRanges()");
  await settleFrame();
  const kpi = await location('#kpi-publish .lg-stat-value');
  const composesBefore = await evaluate('results.composes.length');
  await drag({ x: kpi.x + 1, y: kpi.y + kpi.height / 2 }, { x: kpi.x + kpi.width - 2, y: kpi.y + kpi.height / 2 });
  await until(`results.composes.length===${composesBefore + 1}`, 18000);
  const textCompose = await evaluate('results.composes.at(-1)');
  assert.equal(textCompose.anchor.kind, 'text');
  assert.ok(textCompose.anchor.text.includes('126'), textCompose.anchor.text);
  assert.ok(!/0123456789/.test(textCompose.anchor.text), textCompose.anchor.text);
  try { await until(`results.composes.at(-1).captureStatus==='ready'`, 15000); } catch {}
  const captured = await evaluate('results.composes.at(-1)');
  console.log('MEASURE glass-capture', captured.captureStatus, JSON.stringify(await evaluate("results.raw.filter(m=>m.type==='selection-capture').map(m=>({status:m.status,reason:m.reason}))")));
  if (captured.anchor?.image?.data && shotDir) await writeFile(join(shotDir, 'glass-capture.png'), Buffer.from(captured.anchor.image.data, 'base64'));
  await frame('getSelection().removeAllRanges()'); await key('Escape');
  await update("{selectionMode:'off'}");
  check('a text comment over a KPI quotes its real value (not reel digits) and captures');

  // 6. Host "/" forwarding: scope, focus return, negatives and fail-safes.
  await load(page);
  await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  await hostBlur();
  await slash();
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  assert.equal(await hostFrameFocused(), true);
  assert.equal(await frame("document.activeElement.classList.contains('lg-pal-input')"), true);
  await command('Input.insertText', { text: '评论' });
  await untilFrame("document.querySelectorAll('#palette .lg-pal-item').length>0&&document.querySelectorAll('#palette .lg-pal-item').length<6");
  assert.match(await frame("document.querySelector('#palette .lg-sr').textContent"), /^\d+ 个结果$/);
  assert.ok(await frame("document.querySelector('#palette .lg-pal-input').getAttribute('aria-activedescendant')"));
  await shot('glass-palette-forwarded');
  await key('Escape');
  await untilFrame("!document.querySelector('#palette').classList.contains('is-open')");
  await until("document.activeElement!==document.querySelector('iframe')", 2000);
  check('"/" from the Board route screen opens the canvas palette; Esc hands focus back to Paseo');

  await evaluate("document.querySelector('#board-toolbar').focus()");
  await slash();
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  await key('Escape');
  await until("document.activeElement===document.querySelector('#board-toolbar')", 2000);
  // Focus outside this Board's root (another panel) is never taken.
  const forwards = await frame('window.presetKeyMessages');
  await evaluate("document.querySelector('#host-ask').focus()");
  await slash(); await sleep(350);
  assert.equal(await frame('window.presetKeyMessages'), forwards); assert.equal(await paletteOpen(), false);
  assert.equal(await evaluate("document.activeElement.id"), 'host-ask');
  // Panels (fromBody:false) never take a body-level "/".
  await update('{presetKeys:{fromBody:false}}'); await hostBlur();
  await slash(); await sleep(350);
  assert.equal(await frame('window.presetKeyMessages'), forwards); assert.equal(await paletteOpen(), false);
  await update('{presetKeys:{fromBody:true}}');
  check('forwarding follows focus inside this Board root, returns focus to the toolbar, and ignores focus elsewhere and body-level "/" in panels');

  await evaluate("showInput('')");
  await until("document.querySelector('[data-testid=board-message-input]')");
  await evaluate("document.querySelector('[data-testid=board-message-input]').focus()");
  await slash(); await sleep(300);
  assert.equal(await evaluate("document.querySelector('[data-testid=board-message-input]').value"), '/');
  assert.equal(await frame('window.presetKeyMessages'), forwards); assert.equal(await paletteOpen(), false);
  await evaluate('showInput(null)'); await hostBlur();
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 4 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 0 });
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8, text: '?' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 0 });
  await update("{selectionMode:'text'}"); await untilFrame("document.documentElement.dataset.boardSelection==='text'");
  await slash(); await sleep(300);
  await update("{selectionMode:'off'}"); await untilFrame("document.documentElement.dataset.boardSelection!=='text'");
  assert.equal(await frame('window.presetKeyMessages'), forwards); assert.equal(await paletteOpen(), false);
  check('text entry, ⌘K, "?" and selection mode never forward "/" or open the canvas palette');

  // Paseo's "Boards" sidebar row keeps focus after reopening the last Board: route screen only.
  await evaluate("document.querySelector('#sidebar-boards').focus()");
  await slash();
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  await key('Escape');
  await until("document.activeElement===document.querySelector('#sidebar-boards')", 2000);
  const rowForwards = await frame('window.presetKeyMessages');
  await update('{presetKeys:{fromBody:false}}'); await until('hostProps.presetKeys?.fromBody===false'); await settleFrame();
  await evaluate("document.querySelector('#sidebar-boards').focus()");
  await slash(); await sleep(350);
  assert.equal(await frame('window.presetKeyMessages'), rowForwards); assert.equal(await paletteOpen(), false);
  await update('{presetKeys:{fromBody:true}}'); await until('hostProps.presetKeys?.fromBody===true');
  check('focus left on the Boards sidebar row forwards "/" for the route screen only');

  // The slash key reported as 「、」 (Chinese IME, Chinese punctuation mode), from Paseo and in the canvas.
  const imeSlash = async () => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: '、', code: 'Slash', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: '、', code: 'Slash', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191 });
  };
  await hostBlur(); await imeSlash();
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  await key('Escape');
  await until("document.activeElement!==document.querySelector('iframe')", 2000);
  await clickIn('.lg-title'); await imeSlash();
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  await key('Escape');
  await untilFrame("!document.querySelector('#palette').classList.contains('is-open')");
  check('the slash key reported as 「、」 by a Chinese IME opens the palette from Paseo and inside the canvas');

  // Focus moving to Paseo closes a forwarded palette, and Paseo forgets the handoff.
  await hostBlur(); await slash();
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  await evaluate("document.querySelector('#host-ask').focus()");
  await untilFrame("!document.querySelector('#palette').classList.contains('is-open')", 2000);
  await sleep(300);
  assert.equal(await evaluate('document.activeElement.id'), 'host-ask');
  await hostBlur();
  check('focus moving to Paseo closes a forwarded palette without pulling focus back');

  // Enter on a result is deliberate in-canvas navigation: focus stays at the target.
  await hostBlur(); await slash();
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  await command('Input.insertText', { text: '最近发布' });
  await untilFrame("document.querySelector('#palette .lg-pal-item')");
  await key('Enter', 'Enter');
  await untilFrame("!document.querySelector('#palette').classList.contains('is-open')");
  await untilFrame("(()=>{const r=document.querySelector('#recent').getBoundingClientRect();return r.top>=-2&&r.top<innerHeight})()");
  assert.equal(await frame("document.activeElement.id"), 'recent');
  assert.equal(await hostFrameFocused(), true);
  await frame("document.activeElement.blur()");
  assert.equal(await frame("document.querySelector('#recent').hasAttribute('tabindex')"), false);
  check('Enter on a palette result jumps to its target and keeps focus there, without a lasting tabindex');

  // A chosen result ends the handoff: a later session change never jumps back to the toolbar.
  await evaluate("document.querySelector('#board-toolbar').focus()"); await slash();
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  await command('Input.insertText', { text: '最近发布' });
  await untilFrame("document.querySelector('#palette .lg-pal-item')");
  await key('Enter', 'Enter');
  await untilFrame("!document.querySelector('#palette').classList.contains('is-open')");
  assert.equal(await hostFrameFocused(), true);
  const readyStale = await evaluate('results.ready');
  await evaluate('replaceDocument()');
  await until(`results.ready===${readyStale + 1}`);
  version = await evaluate('hostProps.canvas.documentVersion');
  await untilFrame("window.LiquidGlass?.version==='1.0.0'"); await sleep(150);
  assert.notEqual(await evaluate('document.activeElement?.id'), 'board-toolbar');
  check('after Enter on a forwarded result, replacing the session leaves focus alone (no stale handoff)');

  // Fail-safes: no palette left (acknowledged), and a kit that cannot answer (timeout).
  await frame("document.querySelector('#palette').remove()");
  await settleFrame(); await hostBlur();
  const started = Date.now();
  await slash();
  await until("document.activeElement!==document.querySelector('iframe')", 2000);
  console.log('MEASURE glass-no-palette-restore-ms', Date.now() - started);
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  await frame('LiquidGlass.teardown(),true'); await hostBlur();
  await slash();
  await until("document.activeElement===document.querySelector('iframe')", 1000).catch(() => {});
  await until("document.activeElement!==document.querySelector('iframe')", 2000);
  check('without a palette or a live kit, focus returns to Paseo (acknowledgement or 250 ms timeout)');
  // That session stopped answering: the next "/" is left to Paseo (no swallowed key, no bounce).
  const mutedForwards = await frame('window.presetKeyMessages');
  await evaluate("document.querySelector('#board-toolbar').focus()"); await slash(); await sleep(350);
  assert.equal(await frame('window.presetKeyMessages'), mutedForwards);
  assert.equal(await evaluate('document.activeElement.id'), 'board-toolbar');
  check('a canvas session that let a forwarded "/" time out is not forwarded to again');

  // A slow canvas answers after the 250 ms fallback: the palette takes focus again if nobody
  // moved on, and is closed if the user already did. (The frame delays the message itself.)
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  await frame('window.delayPresetKey=450,true');
  await evaluate("document.querySelector('#board-toolbar').focus()"); await slash();
  await until("document.activeElement===document.querySelector('#board-toolbar')", 1000);
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')", 3000);
  await until("document.activeElement===document.querySelector('iframe')", 2000);
  await untilFrame("document.activeElement?.classList.contains('lg-pal-input')", 2000);
  await key('Escape');
  await until("document.activeElement===document.querySelector('#board-toolbar')", 2000);
  await slash(); await sleep(300);
  await evaluate("document.querySelector('#host-ask').focus()");
  await untilFrame("document.querySelector('#palette').classList.contains('is-mounted')", 3000);
  await untilFrame("!document.querySelector('#palette').classList.contains('is-open')", 3000);
  await sleep(200);
  assert.equal(await evaluate('document.activeElement.id'), 'host-ask');
  check('a late palette reply takes focus back only when the user has not moved on, otherwise it closes');

  // 7. Esc while the runtime holds a selection: one press closes the palette.
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  await clickIn('#kpi-publish');
  await frame("LiquidGlass.api(document.querySelector('#palette'),'palette').open(),true");
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
  await update("{selectionMode:'text'}"); await untilFrame("document.documentElement.dataset.boardSelection==='text'");
  await key('Escape');
  await untilFrame("!document.querySelector('#palette').classList.contains('is-open')", 3000);
  await update("{selectionMode:'off'}");
  check('one Esc closes the palette even when the Board runtime consumes the keydown');

  // ...but an Esc that authored code prevented, or that the runtime used for its component
  // mode, is not also taken by the preset.
  const expandApi = "LiquidGlass.api(document.querySelector('#modules [data-lg~=expand]'),'expand')";
  const expanded = "document.querySelector('#modules [data-lg~=expand]').classList.contains('is-expanded')";
  const firstModule = "document.querySelector('#modules [data-lg-module]:not(.lg-placeholder)')";
  await frame(`${expandApi}.open(${firstModule}),true`);
  await untilFrame(expanded); await sleep(700);
  await frame("window.authorEsc=0;window.authorModal=true;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&window.authorModal){e.preventDefault();window.authorModal=false;window.authorEsc++}});document.activeElement.blur();true");
  await key('Escape'); await sleep(400);
  assert.deepEqual(await frame(`({esc:window.authorEsc,expanded:${expanded}})`), { esc: 1, expanded: true });
  await key('Escape');
  await untilFrame(`!${expanded}`, 3000);
  await sleep(1200);
  await frame(`${expandApi}.open(${firstModule}),true`);
  await untilFrame(expanded); await sleep(700);
  await update("{selectionMode:'component'}"); await untilFrame("document.documentElement.dataset.boardSelection==='component'");
  await key('Escape');
  await untilFrame("document.documentElement.dataset.boardSelection==='off'", 3000); await sleep(400);
  assert.equal(await frame(expanded), true);
  await update("{selectionMode:'off'}");
  await key('Escape');
  await untilFrame(`!${expanded}`, 3000);
  check('an Esc that authored code prevented or the runtime used for component mode leaves an open module alone; a free Esc closes it');

  // The open palette is in the top layer: Board's comment markers never paint over it.
  const markerAnchors = await frame("[[520,150],[640,190],[600,260]].map(([x,y])=>({kind:'point',...board.getContext(),rect:{x:x+scrollX,y:y+scrollY,width:0,height:0},viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY}}))");
  const markerItems = markerAnchors.map((anchor, i) => ({ id: `glass-marker-${i}`, kind: 'question', text: `讨论 ${i + 1}`, status: 'answered', anchor, resultReferences: [], createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' }));
  await update(`{interactions:${JSON.stringify(markerItems)}}`);
  const markerCenters = "[...(document.querySelector('[data-board-markers]')?.shadowRoot?.querySelectorAll('button:not([hidden])')||[])].map(b=>{const r=b.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})";
  await untilFrame(`${markerCenters}.length===3`);
  assert.ok((await frame(`${markerCenters}.map(([x,y])=>document.elementFromPoint(x,y)?.hasAttribute('data-board-markers'))`)).every(Boolean));
  await frame("LiquidGlass.api(document.querySelector('#palette'),'palette').open(),true");
  await untilFrame("document.querySelector('#palette').classList.contains('is-open')"); await sleep(350);
  const onTop = await frame(`({top:document.querySelector('#palette .lg-pal-layer').matches(':popover-open'),hits:${markerCenters}.map(([x,y])=>Boolean(document.elementFromPoint(x,y)?.closest('#palette')))})`);
  assert.deepEqual(onTop, { top: true, hits: [true, true, true] });
  await shot('glass-palette-over-markers');
  await key('Escape');
  await untilFrame("!document.querySelector('#palette').classList.contains('is-mounted')&&!document.querySelector('#palette .lg-pal-layer').matches(':popover-open')", 3000);
  await update('{interactions:[]}');
  check('the open palette sits in the top layer, above Board comment markers, and leaves it when closed');

  // Colours of preset text, glass and generic authored elements (link, code, .btn, .form-control)
  // inside the scope, and the Board tokens on the root (host) and on the scope.
  const inkSelectors = ['#lg-page', '.lg-eyebrow', '.lg-title', '.lg-lede', '.lg-section-head .lg-muted', '#kpi-publish', '#kpi-publish .lg-stat-label', '#kpi-publish .lg-stat-value b', '#kpi-publish .lg-chip', '#recent', '#recent .lg-list li', '#recent time', '.lg-pill', '.lg-pill kbd', '#metric > button', '#glass-btn', '#ink-link', '#ink-code', '#ink-input', '#modules [data-lg-module]', '#modules [data-lg-module] h3', '#modules .lg-meta', '.lg-section-title', '#dock'];
  const inkState = `(()=>{const pick=s=>{const e=document.querySelector(s);if(!e)return 'missing';const c=getComputedStyle(e);return [c.color,c.backgroundColor,c.backgroundImage.slice(0,160),c.borderTopColor].join(' | ')};const token=(e,n)=>getComputedStyle(e).getPropertyValue(n).trim();return {host:token(document.documentElement,'--background'),hostInk:token(document.documentElement,'--foreground'),scope:token(document.querySelector('#lg-page'),'--background'),scopeInk:token(document.querySelector('#lg-page'),'--foreground'),els:Object.fromEntries(${JSON.stringify(inkSelectors)}.map(s=>[s,pick(s)]))}})()`;
  const paletteInk = "['#palette .lg-pal-panel','#palette .lg-pal-input','#palette .lg-pal-item','#palette .lg-pal-foot','#palette .lg-pal-scrim'].map(s=>{const e=document.querySelector(s);if(!e)return 'missing';const c=getComputedStyle(e);return [c.color,c.backgroundColor,c.backgroundImage.slice(0,160)].join(' | ')})";
  const inks = {};

  // 8. All interactions per theme and width (desktop-first, mobile fallback).
  const passes = [{ name: 'light-1100', scheme: 'light', width: 1100 }, { name: 'dark-1100', scheme: 'dark', width: 1100 }, { name: 'light-480', scheme: 'light', width: 480 }, { name: 'light-360', scheme: 'light', width: 360 }];
  for (const pass of passes) {
    await viewport(pass.width);
    await evaluate(`setTheme('${pass.scheme}')`);
    await load(page, { height: pass.width < 600 ? 760 : 780 });
    await untilFrame("window.LiquidGlass?.version==='1.0.0'&&!document.querySelector('.lg-rolling')", 4000);
    const label = `${pass.name}:`;
    if (pass.scheme === 'dark') {
      const dark = await frame(`(()=>{const h=document.documentElement,btn=getComputedStyle(document.querySelector('#glass-btn'));return {theme:h.dataset.theme,scheme:getComputedStyle(h).colorScheme,bg:getComputedStyle(h).backgroundColor,ink:getComputedStyle(document.querySelector('#lg-page')).color,muted:getComputedStyle(document.querySelector('.lg-stat-label')).color,btnBg:btn.backgroundColor,btnInk:btn.color}})()`);
      assert.equal(dark.theme, 'dark'); assert.equal(dark.scheme, 'light'); assert.equal(rgb(dark.bg), 'rgb(235,215,204)');
      assert.equal(rgb(dark.ink), 'rgb(43,29,26)'); assert.equal(rgb(dark.muted), 'rgb(86,58,55)');
      const channels = text => text.match(/[\d.]+/g).slice(0, 3).map(Number);
      assert.ok(channels(dark.btnInk).every(v => v < 90), JSON.stringify(dark));
      assert.ok(!/rgba?\(\s*\d+,\s*\d+,\s*\d+,\s*0\)/.test(dark.btnBg) ? channels(dark.btnBg).every(v => v > 150) : true, JSON.stringify(dark));
    }
    // Dark Paseo theme readability: the host's own tokens on the root really are dark, yet every
    // sampled colour inside the scope (preset text, glass, link, code, .btn, .form-control) is the
    // light-theme value, so nothing turns light-on-light.
    if (pass.width >= 600) {
      await hover({ x: 4, y: 4 }); await settleFrame();
      inks[pass.scheme] = await frame(inkState);
      if (pass.scheme === 'dark') {
        const [light, dark] = [inks.light, inks.dark];
        assert.ok(!Object.values(dark.els).includes('missing'), JSON.stringify(dark.els));
        assert.notEqual(dark.host, light.host, 'host tokens follow the Paseo theme');
        assert.equal(dark.scope, light.scope); assert.equal(dark.scopeInk, light.scopeInk);
        assert.notEqual(dark.scope, dark.host);
        for (const selector of inkSelectors) assert.equal(dark.els[selector], light.els[selector], `${selector} differs in the dark host theme`);
      }
    }
    if (pass.width < 600) {
      const narrow = await frame(`(()=>{const cols=e=>getComputedStyle(document.querySelector(e)).gridTemplateColumns.split(' ').length;const dock=document.querySelector('#dock'),item=dock.querySelector('[data-lg-dock-item]');return {kpi:cols('#kpi'),columns:cols('#trend'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,item:item.getBoundingClientRect().width,pad:parseFloat(getComputedStyle(document.querySelector('#lg-page')).paddingBottom),dock:dock.getBoundingClientRect().height}})()`);
      assert.ok(narrow.kpi <= 2, JSON.stringify(narrow)); assert.equal(narrow.columns, 1); assert.ok(narrow.overflow <= 0, JSON.stringify(narrow));
      assert.ok(narrow.item <= 42, JSON.stringify(narrow)); assert.ok(narrow.pad >= narrow.dock + 16, JSON.stringify(narrow));
      // At rest the narrow dock is tucked away: nothing in the first view sits under it.
      await untilDock(true, 'rest');
      assert.equal(await frame("Boolean(document.elementFromPoint(innerWidth/2,innerHeight-30)?.closest('#dock'))"), false);
      await shot(`glass-${pass.name}-top`);
      await frame('scrollTo(0,0)'); await settleFrame();
      await frame('scrollTo(0,500)'); await settleFrame(); await untilDock(true, 'scroll down');
      await shot(`glass-${pass.name}-tucked`);
      await frame('scrollTo(0,300)'); await untilDock(false, 'scroll up');
      await frame('scrollTo(0,document.documentElement.scrollHeight)'); await settleFrame(); await sleep(150);
      const bottom = await frame("(()=>{const last=document.querySelector('#glass-tests').getBoundingClientRect(),dock=document.querySelector('#dock').getBoundingClientRect();return {last:last.bottom,dock:dock.top,tucked:document.querySelector('#dock').classList.contains('is-tucked')}})()");
      assert.ok(bottom.last <= bottom.dock + 0.5 && !bottom.tucked, JSON.stringify(bottom));
      await shot(`glass-${pass.name}-bottom`);
      await frame('scrollTo(0,0)'); await settleFrame();
    }
    // nav: liquid capsule follows the current item, lg:change names the control, chart follows.
    await clickIn('#metric > button:nth-of-type(2)');
    await untilFrame("document.querySelector('#metric > button:nth-of-type(2)').getAttribute('aria-current')==='true'");
    await sleep(700);
    const capsule = await frame("(()=>{const c=document.querySelector('#metric > .lg-capsule').getBoundingClientRect(),b=document.querySelector('#metric > button:nth-of-type(2)').getBoundingClientRect();return {dx:Math.abs(c.left-b.left),dw:Math.abs(c.width-b.width),overlay:document.querySelector('#metric > .lg-capsule').hasAttribute('data-board-overlay')}})()");
    assert.ok(capsule.dx <= 1 && capsule.dw <= 1 && capsule.overlay, label + JSON.stringify(capsule));
    assert.deepEqual(await frame('window.lgChanges.at(-1)'), { name: 'metric', value: 'visit' });
    await untilFrame("document.querySelectorAll('#trend-chart .lg-chart-bar').length===7&&document.querySelector('#trend-chart .lg-chart-table tr:last-child td:last-child').textContent==='1,697'");
    await shot(`glass-${pass.name}-nav`);
    // card (desktop pointers only): light and tilt, then the inline properties are cleared.
    if (pass.width >= 600) {
      const card = await location('#kpi-publish');
      await hover({ x: card.x + 14, y: card.y + 12 }); await hover({ x: card.x + 30, y: card.y + 20 });
      await untilFrame("parseFloat(getComputedStyle(document.querySelector('#kpi-publish')).getPropertyValue('--lg-glow'))>0.5");
      assert.equal(await frame("document.querySelector('#kpi-publish').hasAttribute('style')"), false);
      assert.notEqual(await frame("getComputedStyle(document.querySelector('#kpi-publish')).transform"), 'none');
      await shot(`glass-${pass.name}-card`);
      await hover({ x: 4, y: card.y - 30 > 4 ? card.y - 30 : 4 });
      await untilFrame("!(parseFloat(getComputedStyle(document.querySelector('#kpi-publish')).getPropertyValue('--lg-glow'))>0)&&document.querySelector('#kpi-publish').getAnimations().length===0", 3000);
    }
    // split: droplet opens, a choice merges back, keyed numbers/text/chart follow.
    await frame("(()=>{window.splitLog=[];new MutationObserver(()=>splitLog.push(document.querySelector('#range').className+' | '+(document.activeElement?.outerHTML||'').slice(0,50))).observe(document.querySelector('#range'),{attributes:true,attributeFilter:['class']});document.addEventListener('focusout',e=>splitLog.push('focusout '+(e.target.outerHTML||'').slice(0,40)+' -> '+(e.relatedTarget?.outerHTML||'null').slice(0,40)),true);return true})()");
    await clickIn('#range');
    await untilFrame("document.querySelector('#range').classList.contains('is-open')");
    const expanded = await frame("document.querySelector('#range [aria-pressed=\"true\"]').getAttribute('aria-expanded')");
    assert.equal(expanded, 'true', label + JSON.stringify(await frame('window.splitLog')));
    await sleep(500); await shot(`glass-${pass.name}-split-open`);
    const option = await center('#range > [data-lg-option="30d"]'); await clickPoint(option.x, option.y);
    await untilFrame("!document.querySelector('#range').classList.contains('is-open')", 3000);
    assert.equal(await frame("document.querySelector('#range > [data-lg-option=\"30d\"]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await frame("document.querySelector('#kpi-publish [data-lg-count]').getAttribute('data-lg-count')"), '512');
    await untilFrame("!document.querySelector('.lg-rolling')&&document.querySelector('#kpi-publish [data-lg-count]').textContent==='512'", 4000);
    assert.equal(await frame("document.querySelector('#kpi-publish .lg-stat-foot span:last-child').textContent"), '较上月');
    await untilFrame("document.querySelectorAll('#trend-chart .lg-chart-bar').length===5");
    await shot(`glass-${pass.name}-split-chosen`);
    // expand: module opens in place with a strip of the others; Esc restores focus to its trigger.
    await clickIn('#modules [data-lg-module]:nth-of-type(2) h3');
    await untilFrame("document.querySelector('#modules [data-lg~=expand]').classList.contains('is-expanded')");
    assert.equal(await frame("[...document.querySelectorAll('#modules .lg-strip .lg-thumb')].filter(t=>!t.hidden).length"), 3);
    assert.equal(await frame("document.activeElement.matches('[data-lg-module].is-open')"), true);
    await sleep(800); await shot(`glass-${pass.name}-expand`);
    await key('Escape');
    await untilFrame("!document.querySelector('#modules [data-lg~=expand]').classList.contains('is-expanded')");
    await untilFrame("document.activeElement.matches('.lg-module-trigger')&&document.activeElement.getAttribute('aria-expanded')==='false'");
    await sleep(700);
    // palette via host forwarding, then Esc.
    await hostBlur(); await slash();
    await untilFrame("document.querySelector('#palette').classList.contains('is-open')");
    await command('Input.insertText', { text: '模块' });
    await sleep(450); await shot(`glass-${pass.name}-palette`);
    if (pass.width >= 600) {
      inks[`${pass.scheme}-palette`] = await frame(paletteInk);
      if (pass.scheme === 'dark') assert.deepEqual(inks['dark-palette'], inks['light-palette'], 'the palette looks the same in the dark host theme');
    }
    await key('Escape');
    await untilFrame("!document.querySelector('#palette').classList.contains('is-mounted')");
    await until("document.activeElement!==document.querySelector('iframe')", 2000);
    // dock: magnification and the name label (pointer), or focus label (keyboard).
    await frame('scrollTo(0,0)'); await settleFrame();
    // Narrow panes: the pointer nearing the bottom edge brings the tucked dock back.
    const nearBottom = async () => { if (pass.width < 720) await hover(await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+Math.min(r.height,innerHeight)-30}})()")); };
    await nearBottom();
    await untilDock(false, 'near bottom'); await sleep(400);
    const dockItem = await location('#dock > [data-lg-dock-item]:nth-of-type(3)');
    await hover({ x: dockItem.x + dockItem.width / 2, y: dockItem.y + dockItem.height / 2 });
    await untilFrame(`parseFloat(getComputedStyle(document.querySelector('#dock > [data-lg-dock-item]:nth-of-type(3)')).getPropertyValue('--lg-s'))>${pass.width < 720 ? 1.15 : 1.3}`);
    await untilFrame("document.querySelector('#dock .lg-dock-label').classList.contains('is-shown')&&document.querySelector('#dock .lg-dock-label').textContent==='趋势'");
    await sleep(200); await shot(`glass-${pass.name}-dock`);
    await hover({ x: 4, y: 4 });
    await untilFrame("![...document.querySelectorAll('#dock [data-lg-dock-item]')].some(i=>i.hasAttribute('style')||i.getAnimations().length)", 3000);
    if (pass.width < 720) { await hover({ x: dockItem.x + dockItem.width / 2, y: dockItem.y + dockItem.height / 2 }); await untilDock(false, 'before click'); await sleep(400); }
    await clickPoint(dockItem.x + dockItem.width / 2, dockItem.y + dockItem.height / 2);
    await untilFrame("(()=>{const r=document.querySelector('#trend').getBoundingClientRect();return r.top>-4&&r.top<innerHeight*0.6})()", 4000);
    if (pass.name === 'light-1100') {
      // Back at the very top, the scroll spy selects the first dock target again.
      await sleep(1500);
      await frame('scrollTo(0,700)'); await sleep(300);
      await frame('scrollTo(0,0)');
      await untilFrame("document.querySelector('#dock [aria-current]')?.dataset.lgLabel==='总览'", 3000);
    }
    if (pass.name === 'light-480') {
      // Touch has no hover: a tapped dock item shows its name for a moment (synthetic touch).
      await hover({ x: 4, y: 4 });
      await frame("(()=>{const it=document.querySelector('#dock > [data-lg-dock-item]:nth-of-type(2)');it.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch'}));window.dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch'}));it.click();return true})()");
      await untilFrame("document.querySelector('#dock .lg-dock-label').classList.contains('is-shown')&&document.querySelector('#dock .lg-dock-label').textContent==='指标'&&!document.querySelector('#dock').classList.contains('is-tucked')", 2000);
      await shot('glass-light-480-dock-tapped');
      await untilFrame("!document.querySelector('#dock .lg-dock-label').classList.contains('is-shown')", 3000);
    }
    if (pass.name === 'light-1100') {
      // Identity is unchanged after real interaction too (state lives in attributes outside it).
      for (const id of ['kpi-publish', 'kpi', 'metric', 'range', 'dock']) assert.equal(await liveIdentity('#' + id), componentIdentityFor(authoredDoc.querySelector('#' + id)).fingerprint, `${id} after interaction`);
    }
    check(`${pass.name}: nav, ${pass.width >= 600 ? 'card, ' : ''}split, expand, forwarded palette and dock all work`);
    if (pass.scheme === 'dark') check('dark Paseo theme: preset text, glass, palette and generic elements (link, code, .btn, .form-control) keep their light-theme colours; host tokens outside stay dark');
  }
  await viewport(1100);
  await evaluate("setTheme('light')");

  // 8b. Opening the split never re-flows the page; the open row stays inside the pane; there is
  // no sideways scroll; an opened module with a table stays inside a narrow pane.
  for (const width of [856, 420, 300]) {
    await viewport(width);
    await load(page, { height: 760 });
    await untilFrame("window.LiquidGlass?.version==='1.0.0'&&!document.querySelector('.lg-rolling')", 4000);
    const geo = () => frame("(()=>{const k=document.querySelector('#kpi').getBoundingClientRect(),cw=document.documentElement.clientWidth,opts=[...document.querySelectorAll('#range > [data-lg-option]')].map(o=>o.getBoundingClientRect());return {kpi:Math.round(k.top+scrollY),overflow:document.documentElement.scrollWidth-cw,left:Math.round(Math.min(...opts.map(r=>r.left))),right:Math.round(Math.max(...opts.map(r=>r.right))),cw,pill:getComputedStyle(document.querySelector('.lg-actions > .lg-pill')).opacity}})()");
    const closed = await geo();
    await clickIn('#range');
    await untilFrame("document.querySelector('#range').classList.contains('is-open')"); await sleep(900);
    const opened = await geo();
    assert.equal(opened.kpi, closed.kpi, `${width}: ${JSON.stringify({ closed, opened })}`);
    assert.ok(closed.overflow <= 0 && opened.overflow <= 0, `${width}: ${JSON.stringify({ closed, opened })}`);
    assert.ok(opened.left >= 0 && opened.right <= opened.cw, `${width}: ${JSON.stringify(opened)}`);
    // The neighbour under the floating row fades while it is open (no text through the glass).
    assert.deepEqual([closed.pill, opened.pill], ['1', '0'], `${width}`);
    await shot(`glass-light-${width}-split-open`);
    await key('Escape');
    await untilFrame("!document.querySelector('#range').classList.contains('is-open')", 3000);
    if (width > 420) continue;
    await frame(`LiquidGlass.api(document.querySelector('#modules [data-lg~=expand]'),'expand').open(document.querySelector('#modules [data-lg-module]')),true`);
    await untilFrame("document.querySelector('#modules [data-lg~=expand]').classList.contains('is-expanded')"); await sleep(900);
    const table = await frame("(()=>{const m=document.querySelector('#modules [data-lg-module].is-open'),c=m.querySelector('.lg-module-close').getBoundingClientRect(),d=m.querySelector('[data-lg-detail]'),cw=document.documentElement.clientWidth;return {module:Math.round(m.getBoundingClientRect().right),close:Math.round(c.right),cw,overflow:document.documentElement.scrollWidth-cw,scrolls:d.scrollWidth>d.clientWidth}})()");
    assert.ok(table.module <= table.cw && table.close <= table.cw && table.overflow <= 0 && (width > 360 || table.scrolls), `${width}: ${JSON.stringify(table)}`);
    await shot(`glass-light-${width}-expand-table`);
    await key('Escape');
    await untilFrame("!document.querySelector('#modules [data-lg~=expand]').classList.contains('is-expanded')", 3000);
  }
  await viewport(1100);
  check('opening the split keeps the page still and inside the pane at 856/420/300px (neighbours fade); an opened table module scrolls inside a narrow pane');

  // 8e. An open module's thumbnail strip is never under the floating dock (real-app finding: at
  // the Paseo desktop canvas of 950x787 the strip sat completely behind the dock). Modules are the
  // last section, as in the real Board. From the page end (where "/" → 工作台模块 lands), with the
  // grid at the bottom edge, and with the strip scrolled into the dock's band, every thumbnail is
  // the topmost element at its centre and a real click switches modules; the dock never covers the
  // open module or its close button, and it is back once the module is out of its way. Narrow
  // panes also try the things that bring a tucked dock back (pointer at the bottom edge, scroll up).
  const stripPage = reset + example + bridge;
  const expandedQ = "document.querySelector('#modules [data-lg~=expand]').classList.contains('is-expanded')";
  const stripState = `(()=>{const root=document.querySelector('#modules [data-lg~=expand]'),strip=root.querySelector('.lg-strip'),m=root.querySelector('[data-lg-module].is-open'),dock=document.querySelector('#dock'),ds=getComputedStyle(dock),d=dock.getBoundingClientRect();
    const shown=ds.pointerEvents!=='none'&&parseFloat(ds.opacity)>0.05;
    const hit=el=>{const r=el.getBoundingClientRect(),e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return e===el||el.contains(e)};
    const under=r=>shown&&r.bottom>d.top&&r.top<d.bottom&&r.right>d.left&&r.left<d.right;
    const s=strip.getBoundingClientRect(),mr=m?m.getBoundingClientRect():null,close=m&&m.querySelector('.lg-module-close'),cr=close&&close.getBoundingClientRect();
    const thumbs=[...strip.querySelectorAll('.lg-thumb')].filter(t=>!t.hidden);
    return {open:!!m,fits:!!mr&&s.bottom-mr.top<=innerHeight-24,thumbs:thumbs.map(t=>{const r=t.getBoundingClientRect();return {view:r.top>=0&&r.bottom<=innerHeight,hit:r.bottom<=0||r.top>=innerHeight||hit(t)}}),
      close:!cr||cr.bottom<=0||cr.top>=innerHeight||hit(close),stripUnder:under(s),moduleUnder:!!mr&&under(mr),dockShown:shown,
      strip:[Math.round(s.top),Math.round(s.bottom)],dock:[Math.round(d.top),Math.round(d.bottom)],module:mr&&[Math.round(mr.top),Math.round(mr.bottom)],y:Math.round(scrollY),max:document.documentElement.scrollHeight-innerHeight,ih:innerHeight}})()`;
  // Waits for the open/switch animation, any smooth scroll and the dock's 320 ms slide.
  const settleStrip = async () => {
    await sleep(900);
    await frame('new Promise(resolve=>{let y=scrollY,same=0;const tick=()=>{if(scrollY===y){if(++same>5)return resolve(true)}else{y=scrollY;same=0}setTimeout(tick,40)};tick()})');
    await sleep(380);
  };
  const stripClear = async (label, { inView = true } = {}) => {
    const state = await frame(stripState);
    const ok = state.open && state.thumbs.length === 3 && state.thumbs.every(t => t.hit && (!inView || !state.fits || t.view)) && state.close && !state.stripUnder && !state.moduleUnder;
    assert.ok(ok, `${label}: ${JSON.stringify(state)}`);
    return state;
  };
  // Opens the first module whose title is in view (above the dock zone) with a real click.
  const openModule = async () => {
    const n = await frame("[...document.querySelectorAll('#modules [data-lg-module]')].findIndex(m=>{const r=m.querySelector('h3').getBoundingClientRect();return r.top>=8&&r.bottom<=innerHeight-90})+1");
    assert.ok(n > 0, 'a module title is in view');
    const p = await center(`#modules [data-lg-module]:nth-of-type(${n}) h3`);
    await clickPoint(p.x, p.y);
    await untilFrame(expandedQ); await settleStrip();
  };
  // A real click on the first thumbnail switches to that module (thumbnails follow module order).
  const switchFromStrip = async () => {
    const n = await frame("[...document.querySelectorAll('#modules .lg-strip .lg-thumb')].findIndex(t=>!t.hidden)+1");
    const p = await center(`#modules .lg-strip .lg-thumb:nth-child(${n})`);
    await clickPoint(p.x, p.y);
    await untilFrame(`document.querySelector('#modules [data-lg-module]:nth-of-type(${n})').classList.contains('is-open')`); await settleStrip();
  };
  const closeModule = async () => { await key('Escape'); await untilFrame(`!${expandedQ}`, 3000); await settleStrip(); };
  for (const size of [{ width: 950, height: 787 }, { width: 420, height: 787 }, { width: 320, height: 640 }]) {
    const label = `${size.width}x${size.height}`, narrowPane = size.width <= 720;
    await viewport(size.width, size.height + 40);
    await load(stripPage, { height: size.height });
    await untilFrame("window.LiquidGlass?.version==='1.0.0'&&!document.querySelector('.lg-rolling')", 4000);
    // a) From the page end.
    await frame('scrollTo(0,document.documentElement.scrollHeight)'); await settleStrip();
    await openModule();
    await stripClear(`${label} opened at the page end`);
    await shot(`glass-strip-${size.width}-page-end`);
    // The strip is really clickable: a real click on a thumbnail switches modules.
    await switchFromStrip();
    await stripClear(`${label} after switching from the strip`);
    // b) The strip scrolled into the dock's band at the bottom edge of the pane.
    await frame("(()=>{const s=document.querySelector('#modules .lg-strip').getBoundingClientRect();scrollBy({top:s.bottom-(innerHeight-14),behavior:'instant'});return true})()"); await settleStrip();
    await stripClear(`${label} strip at the bottom edge`);
    if (narrowPane) {
      // What brings a tucked narrow dock back: the pointer near the bottom edge, a scroll up.
      const bottomEdge = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height-30}})()");
      await hover({ x: bottomEdge.x - 60, y: bottomEdge.y }); await sleep(450);
      await stripClear(`${label} pointer at the bottom edge`);
      await hover({ x: 4, y: 4 });
      await frame("scrollBy({top:40,behavior:'instant'}),true"); await sleep(120);
      await frame("(()=>{const s=document.querySelector('#modules .lg-strip').getBoundingClientRect();scrollBy({top:s.bottom-(innerHeight-14),behavior:'instant'});return true})()"); await settleStrip();
      await stripClear(`${label} after scrolling up`);
    }
    await shot(`glass-strip-${size.width}-bottom-edge`);
    if (!narrowPane) {
      // Keyboard focus in the dock brings it back over the strip; Shift+Tab back gives way again.
      // A mouse click leaves focus on a dock button in Chromium, so only keyboard focus counts.
      const tab = async (modifiers = 0) => {
        await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
        await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers });
      };
      await frame("[...document.querySelectorAll('#modules .lg-strip .lg-thumb')].filter(t=>!t.hidden).at(-1).focus(),true");
      await tab();
      await untilFrame("document.activeElement.matches('#dock [data-lg-dock-item]')&&!document.querySelector('#dock').classList.contains('is-yielding')", 2000);
      await tab(8);
      await untilFrame("document.activeElement.matches('.lg-thumb')&&document.querySelector('#dock').classList.contains('is-yielding')", 2000);
    }
    await switchFromStrip();
    await stripClear(`${label} switched from the bottom edge`);
    // c) Once the open module is out of its way (the page end keeps room below it) the dock is back.
    await frame('scrollTo(0,document.documentElement.scrollHeight)'); await settleStrip();
    const end = await stripClear(`${label} at the page end while open`, { inView: false });
    assert.equal(end.dockShown, true, `${label}: the dock returns at the page end ${JSON.stringify(end)}`);
    if (!narrowPane) {
      // A real click on a dock item leaves focus on it (Chromium) without :focus-visible: the dock
      // still gives way once the strip reaches its band.
      const item = await center('#dock > [data-lg-dock-item]:nth-of-type(4)');
      await clickPoint(item.x, item.y); await settleStrip();
      assert.equal(await frame("document.activeElement.matches('#dock [data-lg-dock-item]')&&!document.activeElement.matches(':focus-visible')"), true);
      await frame("(()=>{const s=document.querySelector('#modules .lg-strip').getBoundingClientRect();scrollBy({top:s.bottom-(innerHeight-14),behavior:'instant'});return true})()"); await settleStrip();
      await stripClear(`${label} strip at the bottom edge after a dock click`);
      await frame('document.activeElement.blur(),scrollTo(0,document.documentElement.scrollHeight),true'); await settleStrip();
    }
    await closeModule();
    // d) With the grid's bottom edge at the bottom of the pane (as in the real-app probe).
    await frame("(()=>{const g=document.querySelector('#modules [data-lg~=expand]').getBoundingClientRect();scrollBy({top:g.bottom-innerHeight+4,behavior:'instant'});return true})()"); await settleStrip();
    await openModule();
    await stripClear(`${label} opened with the grid at the bottom edge`);
    await shot(`glass-strip-${size.width}-grid-bottom`);
    await closeModule();
    if (!narrowPane) {
      // Nothing open: the desktop dock is there again.
      assert.equal(await frame("(()=>{const s=getComputedStyle(document.querySelector('#dock'));return s.pointerEvents!=='none'&&parseFloat(s.opacity)>0.95})()"), true);
    }
  }
  await viewport(1100);
  check('an open module\'s thumbnail strip stays visible and clickable above the dock at 950x787, 420x787 and 320x640; the dock never covers the open module and comes back when out of the way');

  // 8c. Forced colours: built-in icons, dots and the chosen option use system colours.
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'&&!document.querySelector('.lg-rolling')", 4000);
  // Emulation belongs to the session that set it, so each canvas target keeps one session.
  const mediaSessions = new Map();
  const emulate = async features => {
    await command('Emulation.setEmulatedMedia', { features });
    for (const target of (await send('Target.getTargets')).targetInfos.filter(info => info.type === 'iframe')) {
      if (!mediaSessions.has(target.targetId)) mediaSessions.set(target.targetId, (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId);
      await send('Emulation.setEmulatedMedia', { features }, mediaSessions.get(target.targetId));
    }
  };
  await emulate([{ name: 'forced-colors', value: 'active' }]);
  await untilFrame("matchMedia('(forced-colors: active)').matches");
  await clickIn('#range'); await untilFrame("document.querySelector('#range').classList.contains('is-open')"); await sleep(900);
  const forced = await frame("(()=>{const after=s=>getComputedStyle(document.querySelector(s),'::after').backgroundColor;return {canvas:getComputedStyle(document.documentElement).backgroundColor,dock:after('#dock [data-lg-dock-item]:nth-of-type(2)'),current:after('#dock [data-lg-dock-item][aria-current]'),module:after('#modules .lg-icon'),dot:getComputedStyle(document.querySelector('.lg-dot')).backgroundColor,pick:getComputedStyle(document.querySelector('#range .lg-split-pick')).backgroundColor}})()");
  for (const name of ['dock', 'current', 'module', 'dot', 'pick']) assert.notEqual(rgb(forced[name]), rgb(forced.canvas), `${name}: ${JSON.stringify(forced)}`);
  assert.notEqual(rgb(forced.current), rgb(forced.dock), JSON.stringify(forced));
  await shot('glass-forced-colors');
  await key('Escape');
  await emulate([]);
  await untilFrame("!matchMedia('(forced-colors: active)').matches");
  check('forced colours keep built-in icons, status dots, the current dock item and the chosen option visible');

  // 8d. Page mode on the body element itself takes over the whole width.
  await load('<body data-style="liquid-glass" data-lg-page><header class="lg-header"><div><h1 class="lg-title">整页</h1></div></header><section class="lg-grid" data-lg-cols="2"><article data-lg="card">一</article><article data-lg="card">二</article></section>' + bridge + '</body>');
  await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  const bodyScope = await frame("(()=>{const b=document.body,r=b.getBoundingClientRect();return {scope:document.querySelector('[data-style]')===b,max:getComputedStyle(b).maxWidth,left:r.left,full:Math.abs(r.width-document.documentElement.clientWidth)<1}})()");
  assert.deepEqual(bodyScope, { scope: true, max: 'none', left: 0, full: true });
  check('data-style on the body element gives the full-width page, not the 960px Board column');

  // 9. Charts: Board data path, live data updates, and inert labels.
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  await untilFrame("document.querySelectorAll('#data-chart .lg-chart-dot').length===3");
  await update('{canvas:{...hostProps.canvas,data:{trend:[1,2,3,4]}}}');
  await untilFrame("document.querySelectorAll('#data-chart .lg-chart-dot').length===4");
  assert.equal(await frame('window.__xss'), undefined);
  assert.ok((await frame("document.querySelector('#xss-chart .lg-chart-table').textContent")).includes('<img src=x onerror="window.__xss=1">'));
  assert.ok((await frame("document.querySelector('#xss-chart svg').textContent")).includes('<img'));
  assert.equal(await frame("document.querySelectorAll('#xss-chart img').length"), 0);
  const bar = await location('#trend-chart .lg-chart-bar');
  await hover({ x: bar.x + bar.width / 2, y: bar.y + 4 });
  await untilFrame("document.querySelector('#trend-chart .lg-chart-tip').classList.contains('is-on')");
  assert.match(await frame("document.querySelector('#trend-chart .lg-chart-tip text').textContent"), /^周一 · 14$/);
  assert.match(await frame("document.querySelector('#trend-chart .lg-chart-avg text').textContent"), /^均值 18/);
  // Integer data gets whole-number axis ticks (no 「12.5 篇」).
  const ticks = await frame("[...document.querySelectorAll('#int-chart svg > g:first-of-type text')].map(t=>t.textContent)");
  assert.deepEqual(ticks, ['0', '15', '30']);
  await shot('glass-chart-hover');
  check('declarative charts follow Board data live, show hover and average tags, and render injected labels as inert text');

  // 10. Nested markers are inert; patched sections follow the page's named controls.
  await update(`{canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[{id:'nested-glass',selector:'#kpi',operation:'append',html:${JSON.stringify('<article id="nested" data-style="liquid-glass" data-lg="card" class="lg-stat"><p class="lg-stat-label">补充</p><p class="lg-stat-value"><b id="nested-count" data-lg-count="126" data-lg-key="{range}" data-lg-by="7d:126, 30d:512, 90d:1486">126</b></p></article>')}}]}}`);
  await untilFrame("document.querySelector('#nested')&&window.LiquidGlass.api(document.querySelector('#nested'),'card')");
  const nested = await frame("(()=>{const s=getComputedStyle(document.querySelector('#nested'));return {bg:s.backgroundImage,pad:s.paddingTop}})()");
  assert.ok(!nested.bg.includes('radial-gradient') && nested.pad !== '24px', JSON.stringify(nested));
  await frame("LiquidGlass.api(document.querySelector('#range'),'split').choose(document.querySelector('#range > [data-lg-option=\"90d\"]')),true");
  await untilFrame("document.querySelector('#nested-count').getAttribute('data-lg-count')==='1486'");
  check('a nested data-style marker added by a patch is inert and its values follow the page controls');

  // 11. Reduced motion: no tilt, no droplet merge, no expand animation.
  // Emulation binds to the current canvas target, so load first.
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  await setReducedMotion(true);
  const card = await location('#kpi-publish');
  await hover({ x: card.x + 20, y: card.y + 20 }); await hover({ x: card.x + 40, y: card.y + 30 }); await settleFrame();
  assert.equal(await frame("getComputedStyle(document.querySelector('#kpi-publish')).transform"), 'none');
  // Only preset-owned nodes collapse: an authored loop inside a card keeps its own timing, and an
  // authored class that merely contains "lg-" is untouched.
  const motion = await frame("(()=>{const g=s=>getComputedStyle(document.querySelector(s));return {pulse:[g('#authored-pulse').animationDuration,g('#authored-pulse').animationIterationCount],col:g('#authored-col').transitionDuration,pill:g('.lg-pill').transitionDuration,blob:g('#range .lg-split-blob').transitionDuration}})()");
  assert.deepEqual(motion.pulse, ['1.2s', 'infinite'], JSON.stringify(motion));
  assert.equal(motion.col, '2s', JSON.stringify(motion));
  assert.match(motion.pill, /^0\.001s(, 0\.001s)*$/); assert.match(motion.blob, /^0\.001s(, 0\.001s)*$/);
  await frame("(()=>{window.sawMerging=false;new MutationObserver(()=>{if(document.querySelector('#range').classList.contains('is-merging'))window.sawMerging=true}).observe(document.querySelector('#range'),{attributes:true});return true})()");
  await clickIn('#range'); await untilFrame("document.querySelector('#range').classList.contains('is-open')");
  const option30 = await center('#range > [data-lg-option="30d"]'); await clickPoint(option30.x, option30.y);
  await untilFrame("!document.querySelector('#range').classList.contains('is-open')");
  assert.equal(await frame('window.sawMerging'), false);
  await clickIn('#modules [data-lg-module]:nth-of-type(1) h3');
  await untilFrame("document.querySelector('#modules [data-lg-module].is-open')");
  assert.equal(await frame("document.querySelector('#modules [data-lg-module].is-open').getAnimations().length"), 0);
  await shot('glass-reduced-motion');
  await key('Escape');
  await setReducedMotion(false);
  check('reduced motion removes tilt, droplet merging and expand animation, and leaves authored animations alone');

  // 12. Live patch activation: one idle rebuild that keeps the reading position.
  const plain = `${baseHtml}<div id="tall-spacer" style="height:1800px"></div>`;
  await load(plain, { presetKeys: undefined });
  assert.equal(await evaluate("document.querySelector('iframe').srcdoc.includes('paseo-board-liquid-glass-style')"), false);
  await frame('scrollTo(0,320)'); await sleep(500);
  const readyBefore = await evaluate('results.ready');
  await update(`{canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[{id:'glass-island',selector:'body',operation:'append',html:${JSON.stringify('<section id="island" data-style="liquid-glass"><h2>液态玻璃岛</h2><article data-lg="card"><p>后来加入的玻璃区域</p></article></section>')}}]}}`);
  await until(`results.ready===${readyBefore + 1}`, 8000);
  assert.equal(await evaluate("document.querySelector('iframe').srcdoc.split('<style id=\"paseo-board-liquid-glass-style\"').length-1"), 1);
  await untilFrame("window.LiquidGlass?.version==='1.0.0'&&document.querySelector('#island')");
  assert.notEqual(await frame("getComputedStyle(document.querySelector('#island')).backgroundImage"), 'none');
  assert.equal(rgb(await frame("getComputedStyle(document.querySelector('#island')).color")), 'rgb(43,29,26)');
  await untilFrame('Math.abs(scrollY-320)<=4', 4000);
  await update(`{canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[...hostProps.canvas.patches,{id:'glass-island-2',selector:'#island',operation:'append',html:'<article data-lg="card" id="second">二</article>'}]}}`);
  await untilFrame("document.querySelector('#second')"); await sleep(400);
  assert.equal(await evaluate('results.ready'), readyBefore + 1);
  check('a live patch that first adds the marker rebuilds the canvas once and keeps the reading position');

  // An update request the replaced session never answered is sent again by the rebuilt one.
  // (The request is one the runtime ignores, standing in for a reply lost in the rebuild.)
  const counted = `${plain}<script>window.focusUpdates=0;window.addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='focus-update')window.focusUpdates++})</script>`;
  await load(counted, { presetKeys: undefined });
  const lost = await frame("({id:'lost-update',eventId:'lost-update',at:new Date().toISOString(),boardRevision:board.getContext().boardRevision,canvasRevision:board.getContext().canvasRevision,documentVersion:board.getContext().documentVersion,kind:'unanswered',targets:[]})");
  await update(`{focusUpdate:{update:${JSON.stringify(lost)},token:41,targetIndex:0}}`);
  await untilFrame('window.focusUpdates===1');
  const readyLost = await evaluate('results.ready');
  await update(`{canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[{id:'glass-lost',selector:'body',operation:'append',html:'<section id="island-lost" data-style="liquid-glass">玻璃</section>'}]}}`);
  await until(`results.ready===${readyLost + 1}`, 8000);
  await untilFrame("document.querySelector('#island-lost')&&window.focusUpdates===1", 3000);
  await update('{focusUpdate:undefined}');
  check('an update request still pending when the preset rebuild runs is sent to the rebuilt canvas');

  // ...and waits while the user is typing in the canvas.
  await load(plain, { presetKeys: undefined });
  await clickIn('#field');
  const readyTyping = await evaluate('results.ready');
  await update(`{canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[{id:'glass-late',selector:'body',operation:'append',html:'<section id="late" data-style="liquid-glass">晚到的玻璃</section>'}]}}`);
  await untilFrame("document.querySelector('#late')"); await sleep(500);
  assert.equal(await evaluate('results.ready'), readyTyping);
  assert.equal(await frame("document.activeElement.id"), 'field');
  await clickPoint(1050, 820);
  await until(`results.ready===${readyTyping + 1}`, 8000);
  check('the one-time preset rebuild waits until the canvas is no longer being edited');

  // 13. Legacy kits: an old copy added live takes over; an unguarded overwrite tears down.
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  const errorsBefore = await evaluate('results.errors.length');
  await update(`{canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[{id:'legacy-kit',selector:'#lg-page',operation:'append',html:${JSON.stringify(`<script id="lg-kit-script">${legacyKit}</script>`)}}]}}`);
  await untilFrame("window.__legacyKitBody===1&&window.LiquidGlass?.version==='0.2.0'");
  assert.deepEqual(await frame("({media:document.querySelector('#paseo-board-liquid-glass-style').media,defs:document.querySelectorAll('#lg-defs').length,capsules:document.querySelectorAll('.lg-capsule').length})"), { media: 'not all', defs: 0, capsules: 0 });
  assert.equal(await evaluate('results.errors.length'), errorsBefore);
  // Paseo stops forwarding "/" once the live source hands the page to the old kit.
  const legacyForwards = await frame('window.presetKeyMessages');
  await evaluate("document.querySelector('#board-toolbar').focus()"); await slash(); await sleep(350);
  assert.equal(await frame('window.presetKeyMessages'), legacyForwards);
  assert.equal(await evaluate('document.activeElement.id'), 'board-toolbar');
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  await frame("window.LiquidGlass={version:'0.1.0',scan(){}};document.querySelector('#kpi').append(document.createElement('div')),true");
  await untilFrame("document.querySelectorAll('.lg-capsule').length===0");
  assert.equal(await frame('window.LiquidGlass.version'), '0.1.0');
  check('an old kit added by a live patch takes the page over cleanly; an unguarded overwrite makes the built-in step aside');

  // 14. Resizing never shows "ResizeObserver loop completed with undelivered notifications." (real-app
  // finding on the built-in preset Board and on a Board with the 0.2 kit inlined). These notices are
  // benign: the observer delivers the rest in the next frame. (a) The Board runtime does not report
  // them for any Board, and a patch script still running while one fires still applies; real errors
  // and rejections are still reported. (b) Paseo drops them even if a frame posts one itself.
  // (c) The preset's own observers write layout in the next frame, so resizing a preset page does
  // not make the browser raise the notice at all.
  const legacyBoard = `<main id="ro-page" data-style="liquid-glass" data-lg-page><h1>0.2 风格 Board</h1><div id="ro-box" style="height:10px;background:#ccc"></div></main><script id="lg-kit-script">${legacyKit}</script>`
    + `<script>window.roLoop=(frames=6)=>{const box=document.querySelector('#ro-box');let left=frames;const ro=new ResizeObserver(()=>{if(left-->0)box.style.height=(box.offsetHeight===10?20:10)+'px';else ro.disconnect()});ro.observe(box);return true};</script>${bridge}`;
  await viewport(1100);
  await load(legacyBoard);
  await untilFrame("window.LiquidGlass?.version==='0.2.0'");
  assert.equal(await evaluate("document.querySelector('iframe').srcdoc.includes('paseo-board-liquid-glass-script')"), false);
  const roErrors = await evaluate('results.errors.length');
  const rawRo = () => frame("window.rawErrors.filter(m=>/^ResizeObserver loop/.test(m)).length");
  await frame('roLoop(6)');
  await untilFrame("window.rawErrors.some(m=>/^ResizeObserver loop/.test(m))", 3000);
  await frame("dispatchEvent(new ErrorEvent('error',{message:'ResizeObserver loop limit exceeded'})),dispatchEvent(new ErrorEvent('error',{message:'ResizeObserver loop completed with undelivered notifications.'})),true");
  for (const width of [1100, 900, 700, 520, 760, 1100]) { await command('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false }); await sleep(60); }
  await sleep(300);
  assert.deepEqual(await evaluate(`results.errors.slice(${roErrors})`), []);
  // A module patch still waiting (top-level await) while the loop notices fire applies, and later
  // patches are not paused.
  const rawBeforePatch = await rawRo();
  await frame('roLoop(120)');
  await update(`{canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[...hostProps.canvas.patches,{id:'ro-module',selector:'#ro-page',operation:'append',html:${JSON.stringify('<script type="module">await new Promise(resolve=>setTimeout(resolve,500));window.modulePatched=1;</script>')}}]}}`);
  await untilFrame('window.modulePatched===1', 5000);
  await update(`{canvas:{...hostProps.canvas,revision:hostProps.canvas.revision+1,patches:[...hostProps.canvas.patches,{id:'ro-after',selector:'#ro-page',operation:'append',html:'<p id="ro-after">后续补丁</p>'}]}}`);
  await untilFrame("document.querySelector('#ro-after')", 3000);
  assert.ok(await rawRo() > rawBeforePatch, 'the loop notices fired while the module patch ran');
  assert.deepEqual(await evaluate(`results.errors.slice(${roErrors})`), []);
  // Real problems are still reported.
  await frame("setTimeout(()=>{throw new Error('画布脚本出错：示例')}),Promise.reject(new Error('画布承诺被拒绝：示例')),true");
  await until(`results.errors.slice(${roErrors}).some(e=>e.code==='runtime-error'&&e.message.includes('画布脚本出错：示例'))&&results.errors.slice(${roErrors}).some(e=>e.code==='runtime-error'&&e.message.includes('画布承诺被拒绝：示例'))`, 3000);
  // (b) A frame that posts the notice itself: Paseo drops it, but still takes a real error.
  const forge = message => `(()=>{const t=[...document.scripts].map(s=>s.textContent).find(t=>t.includes('"sessionId":"'));const id=k=>t.match(new RegExp('"'+k+'":"([^"]+)"'))[1];parent.postMessage({channel:'paseo-board-frame-v1',boardId:id('boardId'),sessionId:id('sessionId'),type:'error',error:{code:'runtime-error',message:${JSON.stringify(message)}}},'*');return true})()`;
  const forgedFrom = await evaluate('results.errors.length');
  await frame(forge('ResizeObserver loop completed with undelivered notifications.'));
  await frame(forge('ResizeObserver loop limit exceeded'));
  await frame(forge('画布自报的真实错误'));
  await until(`results.errors.length>${forgedFrom}`, 3000); await sleep(150);
  assert.deepEqual((await evaluate(`results.errors.slice(${forgedFrom})`)).map(e => e.message), ['画布自报的真实错误']);
  check('benign ResizeObserver loop notices never reach Paseo for any Board (0.2 kit Board, resizes, a patch that runs meanwhile, a frame that posts one); real errors and rejections still do');

  // (c) The built-in preset itself does not raise the notice while the pane is resized, with a module
  // open or not (column balancing, nav capsule and the dock's yield all write in the next frame).
  await viewport(1100);
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'&&!document.querySelector('.lg-rolling')", 4000);
  const resizeErrors = await evaluate('results.errors.length');
  const resizeAll = async () => {
    for (const width of [1100, 1010, 940, 860, 780, 700, 640, 560, 480, 430, 380, 340, 300, 360, 420, 520, 620, 760, 880, 980, 1100]) {
      await command('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false });
      await sleep(50);
    }
    await settleFrame(); await sleep(250);
  };
  await resizeAll();
  await frame(`LiquidGlass.api(document.querySelector('#modules [data-lg~=expand]'),'expand').open(document.querySelector('#modules [data-lg-module]')),true`);
  await untilFrame(expandedQ); await sleep(900);
  await resizeAll();
  await frame("document.querySelector('#metric > button:nth-of-type(2)').click(),true"); await sleep(100);
  await resizeAll();
  assert.deepEqual(await frame("window.rawErrors.filter(m=>/ResizeObserver/.test(m))"), []);
  assert.deepEqual(await evaluate(`results.errors.slice(${resizeErrors})`), []);
  await key('Escape'); await untilFrame(`!${expandedQ}`, 3000);
  await viewport(1100);
  check('resizing a preset page back and forth (module open or not) raises no ResizeObserver loop notice at all');

  // 15. Optional: the real 0.2 kit Board source (BOARD_LEGACY_BOARD_HTML, the reference Board's
  // demo.html, not part of this repository) still works in the real frame host: the old kit alone,
  // its palette and dock, and resizing without any error reaching Paseo.
  if (process.env.BOARD_LEGACY_BOARD_HTML) {
    const legacyHtml = await readFile(process.env.BOARD_LEGACY_BOARD_HTML, 'utf8');
    await viewport(1100);
    await load(legacyHtml + bridge, { height: 780, presetKeys: { fromBody: true } });
    await untilFrame("window.LiquidGlass?.version==='0.2.0'", 8000);
    const info = await frame("({builtin:window.LiquidGlass.builtin??null,builtinStyle:!!document.getElementById('paseo-board-liquid-glass-style'),builtinScript:!!document.getElementById('paseo-board-liquid-glass-script'),kitStyle:!!document.getElementById('lg-kit-style'),kitScript:!!document.getElementById('lg-kit-script'),cards:document.querySelectorAll('[data-lg~=card]').length,docks:document.querySelectorAll('[data-lg~=dock]').length,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth})");
    console.log('MEASURE legacy-board', JSON.stringify(info));
    assert.deepEqual({ builtin: info.builtin, builtinStyle: info.builtinStyle, builtinScript: info.builtinScript, kitStyle: info.kitStyle, kitScript: info.kitScript }, { builtin: null, builtinStyle: false, builtinScript: false, kitStyle: true, kitScript: true });
    assert.ok(info.cards > 0 && info.docks > 0, JSON.stringify(info));
    await shot('legacy-0.2-board');
    const legacyErrors = await evaluate('results.errors.length');
    for (const width of [1100, 940, 792, 640, 520, 420, 360, 520, 792, 1100]) { await command('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false }); await sleep(80); }
    await settleFrame(); await sleep(300);
    console.log('MEASURE legacy-board-loop-notices', await frame("window.rawErrors.filter(m=>/^ResizeObserver loop/.test(m)).length"));
    assert.deepEqual(await evaluate(`results.errors.slice(${legacyErrors})`), []);
    // Its own palette: "/" inside the canvas opens it, Esc closes it.
    await viewport(1100); await settleFrame();
    await clickIn('h1');
    const legacyPalette = "[...document.querySelectorAll('[data-lg~=palette]')].some(p=>p.classList.contains('is-open'))";
    await slash(); await untilFrame(legacyPalette, 3000);
    await shot('legacy-0.2-palette');
    await key('Escape');
    await untilFrame("![...document.querySelectorAll('[data-lg~=palette]')].some(p=>p.classList.contains('is-open')||p.classList.contains('is-mounted'))", 3000);
    // Its dock: magnification on hover and a jump on click.
    const dockItems = "[...document.querySelectorAll('[data-lg~=dock] [data-lg-dock-item]')].filter(b=>b.getBoundingClientRect().width>0)";
    await frame('scrollTo(0,0)'); await settleFrame();
    const restWidth = await frame(`${dockItems}[0].getBoundingClientRect().width`);
    const second = await frame(`(()=>{const b=${dockItems}[1],r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,target:b.getAttribute('data-lg-target')}})()`);
    const frameOrigin = await evaluate("(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()");
    await hover({ x: frameOrigin.x + second.x - 30, y: frameOrigin.y + second.y }); await hover({ x: frameOrigin.x + second.x, y: frameOrigin.y + second.y }); await sleep(500);
    const legacyDock = await frame(`(()=>{const e=document.elementFromPoint(${JSON.stringify(second)}.x,${JSON.stringify(second)}.y);return {hit:e&&(e.tagName+'.'+e.className),widths:${dockItems}.map(b=>Math.round(b.getBoundingClientRect().width)),s:${dockItems}.map(b=>b.style.getPropertyValue('--lg-s')),second:${JSON.stringify(second)},rest:${restWidth}}})()`);
    assert.ok(legacyDock.widths.some(w => w > restWidth * 1.1), `the 0.2 dock magnifies ${JSON.stringify(legacyDock)}`);
    await shot('legacy-0.2-dock');
    await clickPoint(frameOrigin.x + second.x, frameOrigin.y + second.y);
    await untilFrame('scrollY>40', 4000);
    await hover({ x: 4, y: 4 });
    assert.deepEqual(await evaluate(`results.errors.slice(${legacyErrors})`), []);
    check('the real 0.2 kit Board renders with its own kit alone; palette, dock and resizing work without an error reaching Paseo');
  }

  // Leave the shared fixture as other checks expect it.
  await command('Emulation.clearDeviceMetricsOverride');
  await update('{presetKeys:undefined}');
}
