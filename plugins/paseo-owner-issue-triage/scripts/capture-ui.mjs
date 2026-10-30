// Capture the real app.paseo.sh tab at an exact viewport. Chrome's headless window can clamp
// widths to 500px; a CDP viewport override and capture in the SAME session preserves 420px.
// Start Chrome as documented in the repository scripts/cdp.mjs, then:
// CDP_PORT=9347 node scripts/capture-ui.mjs 420 860 /absolute/screenshot.png [text-to-scroll-to]
import { writeFileSync } from "node:fs";
const [width, height, file, scrollText] = process.argv.slice(2);
if (!file || !Number(width) || !Number(height)) throw new Error("Expected width height screenshot.png [text]");
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT || "9333"}/json/list`)).json();
const page = pages.find((entry) => entry.type === "page" && entry.url.startsWith("https://app.paseo.sh/"));
if (!page) throw new Error("No real Paseo Web UI tab found");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const request = pending.get(message.id);
  if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
};
const send = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
try {
  await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
  await send("Runtime.evaluate", { expression: `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`, awaitPromise: true });
  if (scrollText) await send("Runtime.evaluate", { expression: `(() => { const text=${JSON.stringify(scrollText)}; const found=[...document.querySelectorAll('div,span')].find(e=>e.childElementCount===0&&e.textContent.trim()===text); if(!found) throw new Error('Scroll target unavailable'); found.scrollIntoView({block:'start'}); })()` });
  await send("Runtime.evaluate", { expression: `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`, awaitPromise: true });
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(`Captured real Web UI ${width}x${height}: ${file}`);
} finally { socket.close(); }
