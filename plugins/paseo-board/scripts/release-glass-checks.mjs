import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// An exported/published liquid-glass release: offline, dark release theme, materialized patch,
// the preset inline, and "/" working before any click (top-level canvas autofocus) while the
// host's release preview never moves focus.
export async function createReleaseGlassFixture({ buildRelease, store, directory }) {
  const example = await readFile(join(directory, '../examples/liquid-glass.html'), 'utf8');
  let board = await store.create({ id: 'glass-publication', title: '液态玻璃发布', ownerAgentId: 'owner', html: example, data: { trend: [2, 4, 3] } });
  const patch = { id: 'glass-release-card', selector: '#kpi', operation: 'append', html: '<article id="patched-card" data-lg="card" class="lg-stat" data-lg-command="指标：补丁卡片"><p class="lg-stat-label">补丁卡片</p><p class="lg-stat-value"><b data-lg-count="42">42</b><span>个</span></p></article>' };
  board = await store.publish({ boardId: board.id, expectedRevision: board.revision, canvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, eventId: patch.id, patch });
  const release = buildRelease({ board, boardId: board.id, expectedCanvasBase: { revision: board.canvas.revision, documentVersion: board.canvas.documentVersion }, publicData: {}, network: 'offline', theme: 'dark' });
  return { release };
}

export async function runReleaseGlassChecks({ assert, command, evaluate, frame, open, check, glass }) {
  const index = glass.release.files['index.html'];
  assert.ok(index.includes('if(top!==self)return;'));
  assert.deepEqual(glass.release.manifest.dependencies, []);
  await open('/glass/', "window.LiquidGlass?.version==='1.0.0'&&document.querySelector('#patched-card')");
  const state = await frame("(()=>{const h=document.documentElement,c=getComputedStyle(document.querySelector('#patched-card'));return {theme:h.dataset.theme,scheme:getComputedStyle(h).colorScheme,bg:getComputedStyle(h).backgroundColor,builtin:LiquidGlass.builtin,cardBlur:c.backdropFilter,cardRadius:c.borderTopLeftRadius,style:document.querySelectorAll('#paseo-board-liquid-glass-style').length}})()");
  assert.deepEqual(state, { theme: 'dark', scheme: 'light', bg: 'rgb(235, 215, 204)', builtin: true, cardBlur: state.cardBlur, cardRadius: '24px', style: 1 });
  assert.notEqual(state.cardBlur, 'none');
  // The published page focused its canvas once loaded: "/" opens the palette with no click.
  await frame("new Promise(resolve=>{const loop=()=>document.hasFocus()?resolve(true):setTimeout(loop,20);loop()})");
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', windowsVirtualKeyCode: 191 });
  await frame("new Promise((resolve,reject)=>{const end=performance.now()+3000;const loop=()=>{if(document.querySelector('#palette').classList.contains('is-open'))return resolve(true);if(performance.now()>end)return reject(new Error('palette did not open'));setTimeout(loop,20)};loop()})");
  assert.ok(await frame("[...document.querySelectorAll('#palette .lg-pal-title')].some(t=>t.textContent.includes('补丁卡片'))"));
  if (process.env.BOARD_GLASS_SHOT_DIR) {
    await mkdir(process.env.BOARD_GLASS_SHOT_DIR, { recursive: true });
    const image = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(process.env.BOARD_GLASS_SHOT_DIR, 'release-glass.png'), Buffer.from(image.data, 'base64'));
  }
  check('a published liquid-glass release works offline in a dark release theme, includes patched content and opens the palette with "/" before any click');
  await open('/glass-preview', "window.LiquidGlass?.version==='1.0.0'");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await evaluate("document.activeElement===document.body||document.activeElement===null"), true);
  check('inside the host release preview the published canvas never takes focus');
}
