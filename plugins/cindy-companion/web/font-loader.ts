import { FONT_CHUNK_BYTES, FONT_MANIFEST, type FontWeightName } from '../shared/font-manifest';

export type FontRequest = (op: string, args: Record<string, unknown>) => Promise<unknown>;
function checkActive(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Settings closed before fonts finished loading', 'AbortError');
}

/** One request at a time per font; no FontFace is created until its full hash matches. */
export async function fetchOriginalFont(font: FontWeightName, request: FontRequest, signal: AbortSignal): Promise<ArrayBuffer> {
  const expected=FONT_MANIFEST[font];
  const bytes=new Uint8Array(expected.size);
  for(let offset=0;offset<expected.size;) {
    checkActive(signal);
    const value=await request('assets.fontChunk',{font,offset});
    checkActive(signal);
    const chunk=value as {font?:unknown;offset?:unknown;totalBytes?:unknown;sha256?:unknown;data?:unknown;nextOffset?:unknown}|null;
    const length=Math.min(FONT_CHUNK_BYTES,expected.size-offset);
    const nextOffset=offset+length===expected.size?null:offset+length;
    if(!chunk||chunk.font!==font||chunk.offset!==offset||chunk.totalBytes!==expected.size||chunk.sha256!==expected.sha256||chunk.nextOffset!==nextOffset||typeof chunk.data!=='string'||chunk.data.length!==4*Math.ceil(length/3)||!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)) {
      throw new Error(`Invalid ${font} font chunk from the host`);
    }
    const decoded=atob(chunk.data);
    if(decoded.length!==length)throw new Error(`Invalid ${font} font chunk length`);
    for(let index=0;index<length;index++)bytes[offset+index]=decoded.charCodeAt(index);
    offset+=length;
  }
  checkActive(signal);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  checkActive(signal);
  const sha256=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  if(sha256!==expected.sha256)throw new Error(`The ${font} font does not match the official original`);
  return bytes.buffer;
}

export async function loadOriginalFonts(request: FontRequest, signal: AbortSignal): Promise<void> {
  const controller=new AbortController();
  const abort=()=>controller.abort();
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  try {
    const fonts=[['Regular','400'],['Medium','500'],['Semibold','600']] as const;
    const loaded=await Promise.all(fonts.map(async ([font,weight])=>{
      const bytes=await fetchOriginalFont(font,request,controller.signal);
      checkActive(controller.signal);
      const face=new FontFace('HarmonyOS Sans SC',bytes,{weight,style:'normal',display:'swap'});
      await face.load();
      checkActive(controller.signal);
      return face;
    }));
    checkActive(controller.signal);
    for(const face of loaded)document.fonts.add(face);
  } catch(error) { controller.abort(); throw error; }
  finally { signal.removeEventListener('abort',abort); }
}
