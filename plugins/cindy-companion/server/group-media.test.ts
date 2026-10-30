import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CompanionStore } from './store';
import { GroupMedia, pinGroupMedia, releaseGroupMedia } from './group-media';
import { GROUP_MEDIA_CHUNK_BYTES } from '../shared/group-media';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'cindy-media-')); roots.push(root); const store = new CompanionStore(root); await store.load();
  await store.transaction(s => { s.groups = { a: { id:'a',name:'A',description:'',botIds:['cindy'],replyMode:'mentioned',revision:1,createdAt:1,updatedAt:1,messages:[],rounds:[],lanes:{},receipts:{},continueKeys:{} }, b: { id:'b',name:'B',description:'',botIds:['cindy'],replyMode:'mentioned',revision:1,createdAt:1,updatedAt:1,messages:[],rounds:[],lanes:{},receipts:{},continueKeys:{} } }; });
  return { root, store, media: new GroupMedia(store) };
}
async function upload(t: Awaited<ReturnType<typeof setup>>, bytes: Buffer, key='one', mimeType='application/octet-stream') {
  const result = await t.media.begin('a', {operationId:key,name:'file.bin',mimeType,size:bytes.length,sha256:sha(bytes)});
  for (let offset=0;offset<bytes.length;offset+=GROUP_MEDIA_CHUNK_BYTES) await t.media.write('a',{uploadId:result.uploadId,offset,data:bytes.subarray(offset,offset+GROUP_MEDIA_CHUNK_BYTES).toString('base64')});
  return t.media.complete('a',{uploadId:result.uploadId});
}
it('persists multi-chunk bytes and same-offset receipts across a real store reopen', async () => {
  const t = await setup(), bytes=Buffer.alloc(GROUP_MEDIA_CHUNK_BYTES+27, 101);bytes.fill(202,GROUP_MEDIA_CHUNK_BYTES);
  const input={operationId:'x',name:'../../hello?.bin',mimeType:'application/octet-stream',size:bytes.length,sha256:sha(bytes)};
  const a=await t.media.begin('a',input);expect((await t.media.begin('a',input)).uploadId).toBe(a.uploadId);
  await t.media.write('a',{uploadId:a.uploadId,offset:0,data:bytes.subarray(0,GROUP_MEDIA_CHUNK_BYTES).toString('base64')});await t.media.close();
  const media=new GroupMedia(new CompanionStore(t.root));
  expect((await media.status('a',{uploadId:a.uploadId})).nextOffset).toBe(GROUP_MEDIA_CHUNK_BYTES);
  await media.write('a',{uploadId:a.uploadId,offset:0,data:bytes.subarray(0,GROUP_MEDIA_CHUNK_BYTES).toString('base64')});
  await media.write('a',{uploadId:a.uploadId,offset:GROUP_MEDIA_CHUNK_BYTES,data:bytes.subarray(GROUP_MEDIA_CHUNK_BYTES).toString('base64')});
  expect((await media.complete('a',{uploadId:a.uploadId})).attachment?.name).toBe('hello_.bin');
  const chunks=[];for(let offset=0;offset<bytes.length;offset+=GROUP_MEDIA_CHUNK_BYTES){const chunk=await media.read('a',{mediaId:a.uploadId,offset});expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThan(600000);chunks.push(Buffer.from(chunk.data,'base64'));}
  expect(Buffer.concat(chunks)).toEqual(bytes);await media.close();
});
it('preserves message and outbox references when only the upload or sibling outbox is cancelled', async () => {
  const t=await setup(), a=await upload(t,Buffer.from('safe bytes'));
  await t.store.transaction(s=>{const attachments=pinGroupMedia(s,'a',[{mediaId:a.uploadId}],'message:m');pinGroupMedia(s,'a',[{mediaId:a.uploadId}],'outbox:one');pinGroupMedia(s,'a',[{mediaId:a.uploadId}],'outbox:two');s.groups!.a!.messages.push({id:'m',sequence:1,authorKind:'user',authorName:'You',kind:'message',content:'',createdAt:1,attachments});});
  expect(await t.media.cancel('a',{uploadId:a.uploadId,operationId:'cancel'})).toEqual({cancelled:true,retained:true});
  await t.store.transaction(s=>releaseGroupMedia(s,'a','outbox:one'));
  expect((await t.media.read('a',{mediaId:a.uploadId,messageId:'m',offset:0})).data).toBe(Buffer.from('safe bytes').toString('base64'));
  await expect(t.media.read('b',{mediaId:a.uploadId,messageId:'m',offset:0})).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(t.media.read('a',{mediaId:a.uploadId,messageId:'wrong',offset:0})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect((await new CompanionStore(t.root).snapshot()).groupMedia![a.uploadId]!.refs).toEqual(['message:m','outbox:two']);
});
it('rejects identity mismatches, invalid chunks, missing bytes, mismatched hashes and forged image MIME', async () => {
  const t=await setup(), bytes=Buffer.from('not an image'), input={operationId:'one',name:'a.png',mimeType:'image/png',size:bytes.length,sha256:sha(bytes)};
  const a=await t.media.begin('a',input);
  await expect(t.media.begin('a',{...input,name:'b.png'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(t.media.write('a',{uploadId:a.uploadId,offset:-1,data:'AA=='})).rejects.toMatchObject({code:'INVALID_PARAMS'});
  await expect(t.media.write('a',{uploadId:a.uploadId,offset:1,data:'AA=='})).rejects.toMatchObject({code:'INVALID_PARAMS'});
  await expect(t.media.complete('a',{uploadId:a.uploadId})).rejects.toMatchObject({code:'MEDIA_INCOMPLETE'});
  await t.media.write('a',{uploadId:a.uploadId,offset:0,data:bytes.toString('base64')});
  await expect(t.media.write('a',{uploadId:a.uploadId,offset:0,data:Buffer.alloc(bytes.length).toString('base64')})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  await expect(t.media.complete('a',{uploadId:a.uploadId})).rejects.toMatchObject({code:'MEDIA_TYPE_MISMATCH'});
  await writeFile(join(t.root,'group-media',`${a.uploadId}.bin`),Buffer.alloc(bytes.length));
  await expect(t.media.complete('a',{uploadId:a.uploadId})).rejects.toMatchObject({code:'MEDIA_HASH_MISMATCH'});
});
it('tombstones before cleanup, fences cancelled uploads across reopen, and rejects symlinks', async () => {
  const t=await setup(), bytes=Buffer.from('data'), a=await t.media.begin('a',{operationId:'one',name:'x',mimeType:'text/plain',size:bytes.length,sha256:sha(bytes)});
  await t.media.write('a',{uploadId:a.uploadId,offset:0,data:bytes.toString('base64')});
  await t.media.cancel('a',{uploadId:a.uploadId,operationId:'cancel'});
  const reopened=new GroupMedia(new CompanionStore(t.root));expect((await reopened.status('a',{uploadId:a.uploadId})).status).toBe('cancelled');
  await expect(reopened.write('a',{uploadId:a.uploadId,offset:0,data:bytes.toString('base64')})).rejects.toMatchObject({code:'MEDIA_CANCELLED'});
  const b=await t.media.begin('a',{operationId:'two',name:'x',mimeType:'text/plain',size:bytes.length,sha256:sha(bytes)});
  const foreign=join(t.root,'foreign');await writeFile(foreign,'original');await symlink(foreign,join(t.root,'group-media',`${b.uploadId}.bin`));
  await expect(t.media.write('a',{uploadId:b.uploadId,offset:0,data:bytes.toString('base64')})).rejects.toMatchObject({code:'UNSAFE_PATH'});expect(await readFile(foreign,'utf8')).toBe('original');
});
it('drains an admitted write on immediate close and rejects subsequent requests', async () => {
  const t=await setup(), bytes=Buffer.from('drain'), a=await t.media.begin('a',{operationId:'one',name:'x',mimeType:'text/plain',size:bytes.length,sha256:sha(bytes)});
  const write=t.media.write('a',{uploadId:a.uploadId,offset:0,data:bytes.toString('base64')});await t.media.close();await write;
  expect((await new CompanionStore(t.root).snapshot()).groupMedia![a.uploadId]!.offset).toBe(bytes.length);
  expect(()=>t.media.status('a',{uploadId:a.uploadId})).toThrow(/closing/);
});
it('rejects empty media like the upstream and persists cancel identity across reopen',async()=>{
  const t=await setup();await expect(upload(t,Buffer.alloc(0),'empty')).rejects.toMatchObject({code:'MEDIA_EMPTY'});
  const a=await upload(t,Buffer.from('a')),b=await upload(t,Buffer.from('b'),'two');
  await t.media.cancel('a',{uploadId:a.uploadId,operationId:'cancel-empty'});await t.media.close();
  const media=new GroupMedia(new CompanionStore(t.root));
  expect(await media.cancel('a',{uploadId:a.uploadId,operationId:'cancel-empty'})).toEqual({cancelled:true,retained:false});
  await expect(media.cancel('a',{uploadId:b.uploadId,operationId:'cancel-empty'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect((await media.read('a',{mediaId:b.uploadId,offset:0})).data).toBe('Yg==');await media.close();
});
it('rechecks the exact message reference after reading bytes and resumes tombstoned cleanup',async()=>{
  const t=await setup(),a=await upload(t,Buffer.from('revoked'));
  await t.store.transaction(s=>{s.groups!.a!.messages.push({id:'m',sequence:1,authorKind:'user',authorName:'You',kind:'message',content:'',createdAt:1,attachments:pinGroupMedia(s,'a',[{mediaId:a.uploadId}],'message:m')});});
  const original=t.store.snapshot.bind(t.store);let calls=0;
  t.store.snapshot=async()=>{if(++calls===2)await t.store.transaction(s=>{s.groups!.a!.messages[0]!.deleted=true;});return original();};
  await expect(t.media.read('a',{mediaId:a.uploadId,messageId:'m',offset:0})).rejects.toMatchObject({code:'NOT_FOUND'});t.store.snapshot=original;
  await t.store.transaction(s=>{const item=s.groupMedia![a.uploadId]!;item.retained=false;item.refs=[];item.phase='cancelled';});await t.media.close();
  const reopened=new GroupMedia(new CompanionStore(t.root));await reopened.collect('a');
  expect((await new CompanionStore(t.root).snapshot()).groupMedia![a.uploadId]!.cleaned).toBe(true);await expect(readFile(join(t.root,'group-media',`${a.uploadId}.bin`))).rejects.toMatchObject({code:'ENOENT'});await reopened.close();
});
