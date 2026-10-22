// Minimal Chrome DevTools Protocol driver for Web UI verification screenshots (see AGENTS.md).
// Start Chrome first:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 \
//     --user-data-dir=/tmp/paseo-verify-chrome --disable-features=LocalNetworkAccessChecks about:blank
// Usage: node scripts/cdp.mjs <command> [args...]
//   goto <url> [waitMs] | text [chars] | eval <js> | click-text <label or text> | type <aria-label> <text>
//   key <Key> | window <w> <h> | shot <file.png> [full]
// `window` resizes the headless window and persists; `size` (device emulation) only lasts one invocation.
const PORT = process.env.CDP_PORT || '9333';
const [, , command, ...rest] = process.argv;

async function target() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  let page = list.find((t) => t.type === 'page');
  if (!page) page = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  return page;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); }),
      close: () => ws.close(),
    });
    ws.onerror = reject;
  });
}

const page = await target();
const cdp = await connect(page.webSocketDebuggerUrl);
const evaluate = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description));
  return r.result.value;
};
try {
  if (command === 'goto') {
    await cdp.send('Page.navigate', { url: rest[0] });
    await new Promise((r) => setTimeout(r, Number(rest[1] || 4000)));
    console.log(await evaluate('location.href'));
  } else if (command === 'eval') {
    console.log(JSON.stringify(await evaluate(rest.join(' ')), null, 1));
  } else if (command === 'window') {
    const [w, h] = rest.map(Number);
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.id });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: w, height: h } });
    await new Promise((r) => setTimeout(r, 1500));
    console.log(await evaluate('innerWidth + "x" + innerHeight'));
  } else if (command === 'size') {
    const [w, h] = rest.map(Number);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
    console.log('ok');
  } else if (command === 'shot') {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: rest[1] === 'full' });
    const fs = await import('node:fs');
    fs.writeFileSync(rest[0], Buffer.from(r.data, 'base64'));
    console.log('saved', rest[0]);
  } else if (command === 'click-text') {
    const text = rest.join(' ');
    console.log(await evaluate(`(() => {
      const want = ${JSON.stringify(text)};
      const nodes = [...document.querySelectorAll('[role=button],button,a,[tabindex]')];
      const hit = nodes.find((n) => (n.getAttribute('aria-label') || '').trim() === want) || nodes.find((n) => n.innerText && n.innerText.trim() === want) || nodes.find((n) => (n.getAttribute('aria-label') || n.innerText || '').includes(want));
      if (!hit) return 'not found: ' + want;
      hit.scrollIntoView({ block: 'center' });
      const rect = hit.getBoundingClientRect();
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
      return 'clicked ' + (hit.getAttribute('aria-label') || hit.innerText).slice(0, 80);
    })()`));
  } else if (command === 'type') {
    const [label, ...words] = rest;
    console.log(await evaluate(`(() => { const el = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']'); if (!el) return 'no field'; el.focus(); el.select && el.select(); return 'focused'; })()`));
    await cdp.send('Input.insertText', { text: words.join(' ') });
  } else if (command === 'key') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: rest[0], code: rest[0], windowsVirtualKeyCode: rest[0] === 'Enter' ? 13 : 0 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: rest[0], code: rest[0] });
  } else if (command === 'text') {
    console.log(await evaluate('document.body.innerText.slice(0, ' + (rest[0] || 4000) + ')'));
  }
} finally {
  cdp.close();
}
