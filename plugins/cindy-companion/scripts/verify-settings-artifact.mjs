import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const plugin=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const web=path.join(plugin,'web');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const raw=await fs.readFile(path.join(web,'.build/settings.html'));
const bootstrap=await fs.readFile(path.join(web,'.build/bootstrap.html'));
const generated=await fs.readFile(path.join(plugin,'client/generated/settings-html.ts'));
const exported=JSON.parse(generated.toString().split('export const SETTINGS_HTML = ')[1].trim().replace(/;$/,''));
assert.equal(exported,bootstrap.toString(),'Host export differs from the tested bootstrap');
const payload=JSON.parse(/const payload=("[A-Za-z0-9+/=]+");/.exec(exported)[1]);
// Use the same native browser API, not gunzip, to verify the shipped payload.
const restored=Buffer.from(await new Response(new Blob([Buffer.from(payload,'base64')]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
assert.equal(hash(restored),hash(raw),'Native decompression changed the original document');
assert.ok(bootstrap.length<20*1024*1024,'Transport document exceeds 20 MiB');
const manifest=JSON.parse(await fs.readFile(path.join(web,'assets/fonts/SOURCE.json'),'utf8'));
const html=restored.toString();
const assetSource=await fs.readFile(path.join(plugin,'server/generated/font-assets.ts'),'utf8');
const serverFonts=Object.fromEntries([...assetSource.matchAll(/(Regular|Medium|Semibold): Object\.freeze\((\{[^\n]+\})\)/g)].map(match=>[match[1],JSON.parse(match[2])]));
const fontChunks={};
for(const [filename,expected] of Object.entries(manifest.files)) {
  const original=await fs.readFile(path.join(web,'assets/fonts',filename));
  assert.equal(hash(original),expected,`${filename} differs from the official original`);
  assert.ok(!html.includes(original.subarray(0,384).toString('base64')),`${filename} leaked into client HTML`);
  const font=/HarmonyOS_SansSC_(.+)\.ttf/.exec(filename)[1];
  const packed=serverFonts[font];
  assert.equal(packed.size,original.length);assert.equal(packed.sha256,expected);
  const chunks=[];
  for(let offset=0;offset<packed.size;offset+=393216) {
    const end=Math.min(offset+393216,packed.size);
    const data=packed.data.slice(offset/3*4,Math.ceil(end/3)*4);
    assert.ok(data.length<=524288);chunks.push(Buffer.from(data,'base64'));
  }
  assert.equal(hash(Buffer.concat(chunks)),expected,`${filename} chunk reconstruction differs`);
  fontChunks[font]={bytes:packed.size,sha256:expected,chunks:chunks.length,maxRawChunkBytes:393216};
}
const license=await fs.readFile(path.join(web,'licenses/HarmonyOS-Sans-LICENSE_Fonts'));
assert.equal(hash(license),manifest.licenseSha256,'Font agreement changed');
const result={raw:{bytes:raw.length,sha256:hash(raw)},bootstrap:{bytes:bootstrap.length,sha256:hash(bootstrap)},generated:{bytes:generated.length,sha256:hash(generated)},originalFontsVerified:Object.keys(manifest.files),fontChunks,nativeDecompressionVerified:true};
await fs.writeFile(path.join(web,'.build/verified-artifacts.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
