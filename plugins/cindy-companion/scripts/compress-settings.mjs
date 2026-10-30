import { gzipSync } from 'node:zlib';

/** Transport compression only: the browser restores the exact UTF-8 document. */
export function compressSettingsHtml(html) {
  const payload = gzipSync(Buffer.from(html, 'utf8'), { level: 9 }).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cindy Settings</title></head><body style="margin:0;background:#181818;color:#f1f1f1;font:14px system-ui"><button id="close-loading" type="button" style="margin:16px 24px;padding:8px 12px">Close</button><p id="loading" style="padding:0 24px">Loading settings…</p><script>
const payload=${JSON.stringify(payload)};
let loadingActive=true;
const close=()=>{if(loadingActive)window.parent.postMessage({channel:'cindy-companion',type:'close'},'*');};
const onKey=event=>{if(event.key==='Escape'&&loadingActive){event.preventDefault();close();}};
window.addEventListener('keydown',onKey);
document.getElementById('close-loading').onclick=close;
(async()=>{
 try {
  if(typeof DecompressionStream!=='function')throw new Error('This browser cannot open the compressed settings. Update your browser to continue.');
  const bytes=Uint8Array.from(atob(payload),c=>c.charCodeAt(0));
  const html=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  loadingActive=false;window.removeEventListener('keydown',onKey);
  document.open();document.write(html);document.close();
 } catch(error) {
  loadingActive=true;
  let message=document.getElementById('loading');
  if(!message){
   const body=document.body||document.documentElement.appendChild(document.createElement('body'));
   const button=document.createElement('button');button.type='button';button.textContent='Close';button.onclick=close;
   message=document.createElement('p');message.id='loading';body.replaceChildren(button,message);
  }
  message.textContent='Could not load Cindy settings. '+(error instanceof Error?error.message:String(error));
  window.removeEventListener('keydown',onKey);window.addEventListener('keydown',onKey);
 }
})();
</script></body></html>`;
}
