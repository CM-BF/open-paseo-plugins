import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A real independent HTTP origin, with file-backed application data and exact CORS.
// This receiver never contacts a daemon, company host or production service.
export async function createReleaseApiFixture({ buildRelease, options, origin, temporary, rejectedUrl }) {
  const dataFile = join(temporary, 'visitor-records.json');
  await writeFile(dataFile, '[]');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: request.method, path: request.url, headers: { ...request.headers }, body });
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type, x-request-id');
    response.setHeader('Access-Control-Expose-Headers', 'x-app-revision');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.url === '/items') {
      const records = JSON.parse(await readFile(dataFile, 'utf8'));
      if (request.method === 'POST') {
        const record = JSON.parse(body);
        records.push(record); await writeFile(dataFile, JSON.stringify(records));
        response.setHeader('X-App-Revision', String(records.length));
        response.writeHead(201).end(JSON.stringify({ saved: record, total: records.length }));
      } else { response.setHeader('X-App-Revision', String(records.length)); response.end(JSON.stringify({ records })); }
      return;
    }
    if (request.url === '/echo') { response.end(JSON.stringify({ bytes: Buffer.byteLength(body) })); return; }
    if (request.url === '/error-status') { response.setHeader('X-App-Revision', 'unchanged'); response.writeHead(409).end(JSON.stringify({ error: 'fixture-conflict' })); return; }
    if (request.url === '/redirect') { response.writeHead(302, { Location: rejectedUrl }).end(); return; }
    if (request.url === '/oversize-response') { response.end('x'.repeat(1048577)); return; }
    response.writeHead(404).end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiOrigin = `http://127.0.0.1:${server.address().port}`;
  const html = `<style>body{font:16px system-ui;margin:24px}button,input{font:inherit}#records{white-space:pre-wrap}</style>
<h1>Published application</h1><label>New record <input id="record" value=""></label><button id="save" type="button">Save to backend</button><output id="saved"></output><pre id="records"></pre>
<script>
window.apiOrigin=${JSON.stringify(apiOrigin)};window.ready=false;window.apiDone=false;
async function load(){try{const response=await board.request(apiOrigin+'/items');window.apiLoad=await response.json();document.querySelector('#records').textContent=JSON.stringify(apiLoad.records)}catch(error){window.apiError=error.message}finally{window.ready=true}}
document.querySelector('#save').onclick=async()=>{window.apiDone=false;try{const response=await board.request(apiOrigin+'/items',{method:'POST',headers:{'Content-Type':'application/json','X-Request-Id':'visitor-entry-1'},body:JSON.stringify({id:'visitor-entry-1',text:document.querySelector('#record').value})});window.apiSaved={status:response.status,ok:response.ok,headers:response.headers,value:await response.json()};document.querySelector('#saved').textContent='Saved '+apiSaved.value.total;await load()}catch(error){window.apiError=error.message}finally{window.apiDone=true}};
load();
</script>`;
  const source = { ...options.board, userState: { secret: 'PRIVATE_API_VISITOR_STATE' }, canvas: { ...options.board.canvas, html, patches: [], data: { privateExportToken: 'PRIVATE_INBOX_EXPORT_TOKEN' } } };
  const release = buildRelease({ ...options, board: source, publicData: { appName: 'Backend integration fixture' }, apiOrigins: [apiOrigin] });
  return { release, apiOrigin, requests, dataFile, close: () => new Promise(resolve => server.close(resolve)) };
}

export async function runReleaseApiChecks({ assert, command, evaluate, frame, open, click, api, rejectedUrl, rejectedRequests, check }) {
  const waitFrame = expression => frame(`new Promise((resolve,reject)=>{const deadline=performance.now()+5000;const loop=()=>{if(${expression})return resolve(true);if(performance.now()>deadline)return reject(new Error('Published API fixture timed out: '+${JSON.stringify(expression)}));setTimeout(loop,20)};loop()})`);
  const rejected = expression => frame(`(${expression}).then(()=>({rejected:false}),error=>({rejected:true,message:error.message}))`);
  const noNewNetwork = async (expression, expectedPattern) => {
    const count = api.requests.length, denied = rejectedRequests.length;
    const result = await rejected(expression);
    assert.equal(result.rejected, true, JSON.stringify(result));
    if (expectedPattern) assert.match(result.message, expectedPattern);
    assert.equal(api.requests.length, count, 'A refused request must not reach the API receiver');
    assert.equal(rejectedRequests.length, denied, 'A refused request must not reach an unapproved origin');
  };
  const publicFiles = JSON.stringify(api.release.files);
  for (const secret of ['PRIVATE_INBOX_EXPORT_TOKEN', 'PRIVATE_API_VISITOR_STATE', 'PRIVATE_SOURCE_BOARD', 'PRIVATE_AGENT_ID', 'PRIVATE_CANVAS_DATA']) assert.equal(publicFiles.includes(secret), false, secret);
  assert.deepEqual(api.release.manifest.apiOrigins, [api.apiOrigin]);
  await command('Network.setCookie', { name: 'privateBackendSession', value: 'PRIVATE_BACKEND_COOKIE', url: api.apiOrigin + '/', sameSite: 'Lax' });
  const cookies = await command('Network.getCookies', { urls: [api.apiOrigin + '/'] });
  assert.ok(cookies.cookies.some(cookie => cookie.name === 'privateBackendSession'), 'The browser must actually hold a backend cookie before omission is tested');
  await open('/api/');
  assert.equal(await frame('window.apiError'), undefined);
  assert.deepEqual(await frame('window.apiLoad'), { records: [] });
  await frame("document.querySelector('#record').value='Persistent visitor record'");
  await click('#save'); await waitFrame('window.apiDone');
  assert.deepEqual(await frame("({status:apiSaved.status,ok:apiSaved.ok,contentType:apiSaved.headers['content-type'],revision:apiSaved.headers['x-app-revision'],value:apiSaved.value})"), { status: 201, ok: true, contentType: 'application/json', revision: '1', value: { saved: { id: 'visitor-entry-1', text: 'Persistent visitor record' }, total: 1 } });
  assert.ok(api.requests.some(request => request.method === 'OPTIONS'), 'JSON POST must exercise a real CORS preflight');
  const savedRequests = api.requests.filter(request => request.method === 'POST' && request.path === '/items');
  assert.equal(savedRequests.length, 1);
  const publishedOrigin = await evaluate('location.origin');
  for (const request of api.requests) {
    assert.equal(request.headers.origin, publishedOrigin, 'CORS requests must use the published outer page origin, never null');
    assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.referer, undefined);
  }
  assert.equal(JSON.stringify(api.requests).includes('PRIVATE_BACKEND_COOKIE'), false);
  assert.equal(JSON.stringify(api.requests).includes('PRIVATE_INBOX_EXPORT_TOKEN'), false);
  check('a trusted published form reaches a separate CORS backend with its real page origin and Response-like data, without browser cookies or private tokens');

  // Revisit the URL through a new document, not a reload of the inner authored frame.
  await open('/api/');
  assert.deepEqual(await frame('window.apiLoad.records'), [{ id: 'visitor-entry-1', text: 'Persistent visitor record' }]);
  assert.deepEqual(JSON.parse(await readFile(api.dataFile, 'utf8')), [{ id: 'visitor-entry-1', text: 'Persistent visitor record' }]);
  assert.equal(api.requests.filter(request => request.method === 'POST' && request.path === '/items').length, 1, 'Cold startup must read saved records without reposting');
  const errorResponse = await frame(`board.request(apiOrigin+'/error-status').then(async response=>({status:response.status,ok:response.ok,header:response.headers['x-app-revision'],text:await response.text(),json:await response.json()}))`);
  assert.deepEqual(errorResponse, { status: 409, ok: false, header: 'unchanged', text: '{"error":"fixture-conflict"}', json: { error: 'fixture-conflict' } });
  check('a fresh published document reads file-persisted application data without another POST, and non-2xx responses retain status, headers, text and JSON');

  await noNewNetwork(`board.request(${JSON.stringify(rejectedUrl)})`, /not approved/i);
  await noNewNetwork(`board.request(apiOrigin+'/forbidden-cookie',{headers:{Cookie:'PRIVATE_INBOX_EXPORT_TOKEN'}})`, /header/i);
  await noNewNetwork(`board.request(apiOrigin+'/forbidden-credentials',{credentials:'include'})`, /options/i);
  await noNewNetwork(`board.request(apiOrigin+'/oversize-body',{method:'POST',body:'é'.repeat(131073)})`, /256 KiB/i);
  await noNewNetwork(`fetch(apiOrigin+'/direct-authored-fetch')`);
  check('unapproved origins, credential overrides, forbidden headers, oversized UTF-8 bodies and direct authored fetches fail before any backend request');

  const beforeRedirect = rejectedRequests.length;
  const redirect = await rejected(`board.request(apiOrigin+'/redirect')`);
  assert.equal(redirect.rejected, true); assert.equal(rejectedRequests.length, beforeRedirect);
  assert.equal(api.requests.filter(request => request.path === '/redirect').length, 1);
  const oversize = await rejected(`board.request(apiOrigin+'/oversize-response')`);
  assert.equal(oversize.rejected, true); assert.match(oversize.message, /1 MiB/i);
  const boundary = await frame(`board.request(apiOrigin+'/echo',{method:'POST',body:'x'.repeat(262144)}).then(response=>response.json())`);
  assert.deepEqual(boundary, { bytes: 262144 });
  check('redirects are not followed, responses over 1 MiB are rejected, and the 256 KiB request boundary is usable');

  const beforePreview = api.requests.length, deniedBeforePreview = rejectedRequests.length;
  await open('/api-preview');
  assert.match(await frame('window.apiError'), /hosted HTTP\(S\)|isolated preview/i);
  await noNewNetwork(`board.request(apiOrigin+'/items',{method:'POST',body:'preview must never send'})`, /hosted HTTP\(S\)|isolated preview/i);
  assert.equal(api.requests.length, beforePreview); assert.equal(rejectedRequests.length, deniedBeforePreview);
  assert.equal(JSON.stringify(api.requests).includes('PRIVATE_INBOX_EXPORT_TOKEN'), false);
  check('the actual opaque ReleasePreview refuses API-enabled authored startup and writes with zero backend traffic');
}
