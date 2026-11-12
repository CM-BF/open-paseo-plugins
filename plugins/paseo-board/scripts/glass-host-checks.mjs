import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The real BoardView: a live patch introduces a liquid-glass island (one idle rebuild), "/" from
// this Board's toolbar opens its palette and Esc returns focus to that toolbar button, while the
// title field and an open composer keep their own keys.
export async function runGlassHostChecks({ assert, command, evaluate, until, untilFrame, key, hostClick, openAt, noPopover, check }) {
  const iframe = "document.querySelector('iframe[data-board-id=\"host-fixture\"]')";
  const slash = async () => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', code: 'Slash', windowsVirtualKeyCode: 191, text: '/' });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', code: 'Slash', windowsVirtualKeyCode: 191 });
  };
  const paletteOpen = "document.querySelector('#glass-palette')?.classList.contains('is-open')===true";
  const ready = await evaluate('hostFixture.ready');
  await evaluate(`hostFixture.appendHtml('glass-island', ${JSON.stringify('<section id="glass-island" data-style="liquid-glass"><article id="glass-host-card" data-lg="card" data-lg-command="玻璃卡片"><h2>液态玻璃</h2><p>宿主里的玻璃区域</p></article><div id="glass-palette" data-lg="palette"></div></section>')})`);
  await until(`hostFixture.ready>${ready}`, 15000);
  await untilFrame("window.LiquidGlass?.version==='1.0.0'&&document.querySelector('#glass-palette')&&getComputedStyle(document.querySelector('#glass-island')).backgroundImage!=='none'");
  assert.equal(await evaluate(`${iframe}.closest('[data-testid="board-screen"]')!==null`), true);
  check('a live patch that adds a glass island to the real BoardView activates the preset once');

  const tools = 'button[aria-label="选择工具"]';
  await evaluate(`document.querySelector(${JSON.stringify(tools)}).focus()`);
  await slash();
  await untilFrame(paletteOpen);
  assert.equal(await evaluate(`document.activeElement===${iframe}`), true);
  if (process.env.BOARD_GLASS_SHOT_DIR) {
    await mkdir(process.env.BOARD_GLASS_SHOT_DIR, { recursive: true });
    const image = await command('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(process.env.BOARD_GLASS_SHOT_DIR, 'host-glass-palette.png'), Buffer.from(image.data, 'base64'));
  }
  await key('Escape');
  await untilFrame(`!(${paletteOpen})`);
  await until(`document.activeElement===document.querySelector(${JSON.stringify(tools)})`, 2000);
  check('"/" from the Board toolbar opens the canvas palette and Esc returns focus to that toolbar button');

  await hostClick('button[aria-label="修改 Board 名称"]');
  await until("document.activeElement===document.querySelector('[data-testid=\"board-title-input\"]')");
  await slash(); await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok((await evaluate("document.querySelector('[data-testid=\"board-title-input\"]').value")).includes('/'));
  assert.equal(await evaluate(`document.activeElement===${iframe}`), false);
  await untilFrame(`!(${paletteOpen})`);
  await key('Escape');
  await until("!document.querySelector('[data-testid=\"board-title-input\"]')");

  await openAt(60, 60);
  await evaluate(`document.querySelector(${JSON.stringify(tools)}).focus()`);
  await slash(); await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await evaluate(`document.activeElement===${iframe}`), false);
  await untilFrame(`!(${paletteOpen})`);
  await evaluate("document.querySelector('[data-testid=\"board-message-input\"]').focus()");
  await key('Escape'); await noPopover();
  check('the title field and an open composer keep "/" for themselves');
}
