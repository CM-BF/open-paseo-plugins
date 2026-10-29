import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { build } from 'esbuild';
const bundle=await build({entryPoints:[new URL('../font-loader.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const {fetchOriginalFont,loadOriginalFonts}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const source=JSON.parse(await fs.readFile(new URL('../assets/fonts/SOURCE.json',import.meta.url),'utf8'));
const originals=Object.fromEntries(await Promise.all(['Regular','Medium','Semibold'].map(async font=>[font,await fs.readFile(new URL(`../assets/fonts/HarmonyOS_SansSC_${font}.ttf`,import.meta.url))])));
const size=393216;
function chunk(font,offset){const bytes=originals[font];const end=Math.min(offset+size,bytes.length);return {font,offset,totalBytes:bytes.length,sha256:source.files[`HarmonyOS_SansSC_${font}.ttf`],data:bytes.subarray(offset,end).toString('base64'),nextOffset:end===bytes.length?null:end};}

test('font chunks reassemble the exact official original and stay sequential within each font',async()=>{
 const calls=[];let inFlight=0;
 const actual=await fetchOriginalFont('Regular',async(op,args)=>{assert.equal(op,'assets.fontChunk');assert.deepEqual(Object.keys(args).sort(),['font','offset']);assert.equal(++inFlight,1);await Promise.resolve();calls.push(args.offset);inFlight--;return chunk(args.font,args.offset);},new AbortController().signal);
 assert.equal(crypto.createHash('sha256').update(Buffer.from(actual)).digest('hex'),source.files['HarmonyOS_SansSC_Regular.ttf']);
 assert.deepEqual(calls,Array.from({length:Math.ceil(originals.Regular.length/size)},(_,index)=>index*size));
});

test('wrong metadata, ordering and changed font bytes are rejected',async()=>{
 for(const patch of [{offset:1},{totalBytes:1},{nextOffset:2},{sha256:'bad'},{data:''}]){
  await assert.rejects(fetchOriginalFont('Regular',async()=>({...chunk('Regular',0),...patch}),new AbortController().signal),/Invalid Regular font chunk/);
 }
 await assert.rejects(fetchOriginalFont('Regular',async(_op,args)=>{
  const result=chunk(args.font,args.offset);if(args.offset===0){const bytes=Buffer.from(result.data,'base64');bytes[0]^=1;result.data=bytes.toString('base64');}return result;
 },new AbortController().signal),/does not match the official original/);
});

test('closing while a chunk is in flight prevents all following chunks and font use',async()=>{
 const controller=new AbortController();let calls=0,resolve;
 const pending=fetchOriginalFont('Regular',()=>{calls++;return new Promise(done=>{resolve=done;});},controller.signal);
 controller.abort();resolve(chunk('Regular',0));
 await assert.rejects(pending,{name:'AbortError'});assert.equal(calls,1);
 await assert.rejects(fetchOriginalFont('Regular',async()=>{assert.fail('sent after close');},controller.signal),{name:'AbortError'});
});

test('FontFace only receives verified original bytes; closing during font loading never adds them to the document',async()=>{
 const originalFace=globalThis.FontFace,originalDocument=globalThis.document;
 const hashes=[],added=[],loads=[];
 globalThis.FontFace=class {constructor(family,bytes,descriptors){assert.equal(family,'HarmonyOS Sans SC');hashes.push(crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'));this.descriptors=descriptors;}load(){return new Promise(done=>loads.push(()=>done(this)));}};
 globalThis.document={fonts:{add:face=>added.push(face)}};
 const controller=new AbortController();
 try {
  const pending=loadOriginalFonts(async(_op,args)=>chunk(args.font,args.offset),controller.signal);
  while(loads.length<3)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(new Set(hashes),new Set(Object.values(source.files)));
  assert.equal(added.length,0);controller.abort();for(const done of loads)done();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(added.length,0);
 }finally {globalThis.FontFace=originalFace;globalThis.document=originalDocument;}
});
