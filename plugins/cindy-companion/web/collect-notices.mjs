import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const plugin=path.dirname(here);
const moduleRoots=[path.join(here,'node_modules'),path.join(plugin,'node_modules')];
const meta=JSON.parse(fs.readFileSync(path.join(here,'.build/meta.json'),'utf8'));
const packages=new Map();const assets=[];
for(const input of Object.keys(meta.inputs)) {
 // build-web fixes absWorkingDir to plugin; preserve the actual installation,
 // including a future ../node_modules input, rather than rewriting its root.
 const file=path.resolve(plugin,input);
 if(/\.(woff2?|ttf|png|jpe?g|svg)$/.test(file))assets.push({source:path.relative(here,file),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
 const index=input.indexOf('node_modules/');if(index<0)continue;
 if(!fs.existsSync(file))throw new Error(`Missing bundled input: ${input}`);
 const moduleRoot=moduleRoots.find(root=>file.startsWith(root+path.sep));
 if(!moduleRoot)throw new Error(`Unrecognized bundled npm root: ${input}`);
 let dir=path.dirname(file);
 while(dir.startsWith(moduleRoot+path.sep)) {
  const metadata=path.join(dir,'package.json');
  if(fs.existsSync(metadata)){const pkg=JSON.parse(fs.readFileSync(metadata,'utf8'));if(pkg.name){packages.set(`${pkg.name}@${pkg.version}`,{...pkg,dir});break;}}
  dir=path.dirname(dir);
 }
}
const inventoryRoot=path.join(here,'licenses/npm');
// Official server-only font assets are distributed too, although not in browser metafile.
const fontSource=JSON.parse(fs.readFileSync(path.join(here,'assets/fonts/SOURCE.json'),'utf8'));
for(const [filename,sha256] of Object.entries(fontSource.files))assets.push({source:`assets/fonts/${filename}`,sha256});
const expectedDirectories=new Set([...packages.values()].map(pkg=>`${pkg.name.replaceAll('/','__')}@${pkg.version}`));
fs.mkdirSync(inventoryRoot,{recursive:true});
for(const name of fs.readdirSync(inventoryRoot))if(!expectedDirectories.has(name))fs.rmSync(path.join(inventoryRoot,name),{recursive:true,force:true});
const lines=['# Bundled npm attribution inventory','','Generated from `.build/meta.json`; package metadata and bundled license files retain their original wording.','', '| Package | Declared package license | Retained files |','| --- | --- | --- |'];
for(const pkg of [...packages.values()].sort((a,b)=>a.name.localeCompare(b.name))) {
 const names=fs.readdirSync(pkg.dir).filter(name=>/^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
 const dest=path.join(here,'licenses/npm',`${pkg.name.replaceAll('/','__')}@${pkg.version}`);fs.mkdirSync(dest,{recursive:true});
 for(const name of names)fs.copyFileSync(path.join(pkg.dir,name),path.join(dest,name));
 const license=typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license??null);
 lines.push(`| ${pkg.name}@${pkg.version} | ${license} | ${names.map(name=>`[${name}](${path.relative(path.join(here,'licenses'),path.join(dest,name))})`).join(', ')||'No root license file shipped in package'} |`);
}
lines.push('', 'HarmonyOS Sans SC: original unmodified Huawei TTF files, delivered from server-only assets through verified chunks without conversion or subsetting. Copyright 2021-2025 Huawei Device Co., Ltd. All Rights Reserved. The [complete agreement](HarmonyOS-Sans-LICENSE_Fonts) accompanies them; [font source hashes](../assets/fonts/SOURCE.json) distinguish the official ZIP from the separately sourced OpenHarmony agreement.', '', 'react-remove-scroll-bar 2.3.8 declares MIT but its npm tarball and release gitHead omit LICENSE. The [retained author MIT notice](react-remove-scroll-bar-LICENSE) was added later in upstream commit [7301c160fda44cb8cf2b9fdfde61efad35736196](https://github.com/theKashey/react-remove-scroll-bar/commit/7301c160fda44cb8cf2b9fdfde61efad35736196), not extracted from release 2.3.8. See [source details](SUPPLEMENTAL-SOURCES.md).', '');
fs.writeFileSync(path.join(here,'licenses/THIRD-PARTY.md'),lines.join('\n'));
fs.writeFileSync(path.join(here,'asset-files.json'),JSON.stringify(assets.sort((a,b)=>a.source.localeCompare(b.source)),null,2)+'\n');
console.log(`Recorded ${packages.size} bundled npm packages and ${assets.length} embedded font/image files.`);
