import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// The built-in liquid-glass preset inside the real buildBoardDocument wrapper and the real
// CanvasFrame host: activation, all seven roles, host "/" forwarding, live-patch activation,
// legacy hand-over, reduced motion, layout shift, identity and a pass of every interaction in
// light/dark at desktop and narrow widths. Screenshots only when BOARD_GLASS_SHOT_DIR is set.
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
  const bridge = `<script>window.presetKeyMessages=0;window.lgChanges=[];window.addEventListener('message',e=>{if(e.source===parent&&e.data?.type==='preset-key')window.presetKeyMessages++});document.addEventListener('lg:change',e=>window.lgChanges.push({name:e.detail.name,value:e.detail.value}));window.addEventListener('message',async e=>{if(e.source===parent&&e.data?.channel==='fixture'){try{const value=await eval(e.data.code);parent.postMessage({channel:'fixture-result',id:e.data.id,value},'*')}catch(error){parent.postMessage({channel:'fixture-result',id:e.data.id,error:error.message},'*')}}});</script>`;
  // A typical agent reset: the preset must survive it (no cascade layer, scoped selectors).
  const reset = '<style id="agent-reset">*{margin:0;padding:0;box-sizing:border-box}button{background:none;border:0;font:inherit}h1{font-size:20px}section{padding:0}</style>';
  const extras = `<section id="glass-tests" class="lg-columns" aria-label="测试区">
    <article data-lg="card" id="tests-card"><div class="lg-card-head"><h2>数据路径</h2><button type="button" class="btn" id="glass-btn">普通按钮</button></div>
      <figure id="data-chart" data-lg="chart" data-lg-path="/trend" data-lg-type="line" data-lg-unit="次" aria-label="来自 Board 数据的折线"></figure></article>
    <article data-lg="card"><h2>注入测试</h2><figure id="xss-chart" data-lg="chart" aria-label="标签注入测试" data-lg-values="3,5" data-lg-labels='<img src=x onerror="window.__xss=1">,b'></figure></article>
  </section>`;
  const page = reset + example.replace('<nav id="dock"', `${extras}\n  <nav id="dock"`) + bridge;
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
    if (pass.width < 600) {
      const narrow = await frame(`(()=>{const cols=e=>getComputedStyle(document.querySelector(e)).gridTemplateColumns.split(' ').length;const dock=document.querySelector('#dock'),item=dock.querySelector('[data-lg-dock-item]');return {kpi:cols('#kpi'),columns:cols('#trend'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,item:item.getBoundingClientRect().width,pad:parseFloat(getComputedStyle(document.querySelector('#lg-page')).paddingBottom),dock:dock.getBoundingClientRect().height}})()`);
      assert.ok(narrow.kpi <= 2, JSON.stringify(narrow)); assert.equal(narrow.columns, 1); assert.ok(narrow.overflow <= 0, JSON.stringify(narrow));
      assert.ok(narrow.item <= 42, JSON.stringify(narrow)); assert.ok(narrow.pad >= narrow.dock + 16, JSON.stringify(narrow));
      await shot(`glass-${pass.name}-top`);
      await frame('scrollTo(0,0)'); await settleFrame();
      await frame('scrollTo(0,500)'); await untilFrame("document.querySelector('#dock').classList.contains('is-tucked')", 3000);
      await shot(`glass-${pass.name}-tucked`);
      await frame('scrollTo(0,300)'); await untilFrame("!document.querySelector('#dock').classList.contains('is-tucked')", 3000);
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
    await key('Escape');
    await untilFrame("!document.querySelector('#palette').classList.contains('is-mounted')");
    await until("document.activeElement!==document.querySelector('iframe')", 2000);
    // dock: magnification and the name label (pointer), or focus label (keyboard).
    await frame('scrollTo(0,0)'); await settleFrame();
    await untilFrame("!document.querySelector('#dock').classList.contains('is-tucked')"); await sleep(400);
    const dockItem = await location('#dock > [data-lg-dock-item]:nth-of-type(3)');
    await hover({ x: dockItem.x + dockItem.width / 2, y: dockItem.y + dockItem.height / 2 });
    await untilFrame(`parseFloat(getComputedStyle(document.querySelector('#dock > [data-lg-dock-item]:nth-of-type(3)')).getPropertyValue('--lg-s'))>${pass.width < 720 ? 1.15 : 1.3}`);
    await untilFrame("document.querySelector('#dock .lg-dock-label').classList.contains('is-shown')&&document.querySelector('#dock .lg-dock-label').textContent==='趋势'");
    await sleep(200); await shot(`glass-${pass.name}-dock`);
    await hover({ x: 4, y: 4 });
    await untilFrame("![...document.querySelectorAll('#dock [data-lg-dock-item]')].some(i=>i.hasAttribute('style')||i.getAnimations().length)", 3000);
    await clickPoint(dockItem.x + dockItem.width / 2, dockItem.y + dockItem.height / 2);
    await untilFrame("(()=>{const r=document.querySelector('#trend').getBoundingClientRect();return r.top>-4&&r.top<innerHeight*0.6})()", 4000);
    if (pass.name === 'light-1100') {
      // Identity is unchanged after real interaction too (state lives in attributes outside it).
      for (const id of ['kpi-publish', 'kpi', 'metric', 'range', 'dock']) assert.equal(await liveIdentity('#' + id), componentIdentityFor(authoredDoc.querySelector('#' + id)).fingerprint, `${id} after interaction`);
    }
    check(`${pass.name}: nav, ${pass.width >= 600 ? 'card, ' : ''}split, expand, forwarded palette and dock all work`);
  }
  await viewport(1100);
  await evaluate("setTheme('light')");

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
  check('reduced motion removes tilt, droplet merging and expand animation');

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
  await load(page); await untilFrame("window.LiquidGlass?.version==='1.0.0'");
  await frame("window.LiquidGlass={version:'0.1.0',scan(){}};document.querySelector('#kpi').append(document.createElement('div')),true");
  await untilFrame("document.querySelectorAll('.lg-capsule').length===0");
  assert.equal(await frame('window.LiquidGlass.version'), '0.1.0');
  check('an old kit added by a live patch takes the page over cleanly; an unguarded overwrite makes the built-in step aside');

  // Leave the shared fixture as other checks expect it.
  await command('Emulation.clearDeviceMetricsOverride');
  await update('{presetKeys:undefined}');
}
