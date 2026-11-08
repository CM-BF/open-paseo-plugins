/** Text-only API transport for published pages. The host supplies no private credentials. */
export const PUBLIC_API_CLIENT = String.raw`function(send, initial) {
  const pending=new Map();let sequence=0;
  window.addEventListener('message',event=>{
    const m=event.data;
    if(event.source!==parent||!m||m.channel!=='paseo-board-release-v1'||m.releaseId!==initial.releaseId||m.sessionId!==initial.sessionId||m.type!=='api-result')return;
    const item=pending.get(m.id);if(!item)return;pending.delete(m.id);clearTimeout(item.timer);
    if(m.error)item.reject(new Error(m.error));
    else {const r=m.response;item.resolve(Object.freeze({status:r.status,ok:r.status>=200&&r.status<300,headers:Object.freeze(r.headers),text:async()=>r.body,json:async()=>JSON.parse(r.body)}))}
  });
  return (url,options={})=>new Promise((resolve,reject)=>{
    if(pending.size>=16)return reject(new Error('Too many pending API requests'));
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('API outcome unknown; inspect before an explicit idempotent retry'))},17000);
    pending.set(id,{resolve,reject,timer});
    try{send({type:'api-request',id,url,options})}catch(error){clearTimeout(timer);pending.delete(id);reject(error)}
  });
}`;

/** Runs in the published outer page, retaining its real CORS origin. */
export const PUBLIC_API_HOST = String.raw`function(origins, reply) {
  const allowed=new Set(origins||[]);let active=0,lastId=0;
  return async m=>{
    if(!Number.isSafeInteger(m.id)||m.id<=lastId)return;
    lastId=m.id;
    let controller,timer,counted=false;
    try{
      if(active>=16)throw new Error('Too many pending API requests');
      if(location.origin==='null')throw new Error('API requests require a hosted HTTP(S) page; the isolated preview cannot contact a backend');
      if(typeof m.url!=='string'||m.url.length>8000)throw new Error('Expected an absolute API URL');
      const url=new URL(m.url);
      if(!allowed.has(url.origin)||url.username||url.password||url.hash)throw new Error('API origin is not approved for this release');
      const o=m.options;
      if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!['method','headers','body'].includes(k)))throw new Error('Supported API options: method, headers, body');
      const method=o.method===undefined?'GET':o.method;
      if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method))throw new Error('Unsupported API method');
      if(o.body!==undefined&&(typeof o.body!=='string'||new TextEncoder().encode(o.body).length>262144||['GET','HEAD'].includes(method)))throw new Error('API body must be text, at most 256 KiB, and is not allowed on GET/HEAD');
      const headers=o.headers||{};
      if(typeof headers!=='object'||Array.isArray(headers)||Object.keys(headers).length>32)throw new Error('Invalid API headers');
      for(const [key,value]of Object.entries(headers))if(!/^[a-zA-Z0-9-]{1,80}$/.test(key)||/^(?:cookie|host|origin|referer|connection|content-length|proxy-|sec-)/i.test(key)||typeof value!=='string'||value.length>8192||/[\r\n]/.test(value))throw new Error('Invalid API header');
      active++;counted=true;controller=new AbortController();timer=setTimeout(()=>controller.abort(),15000);
      const response=await fetch(url.href,{method,headers,body:o.body,mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});
      const chunks=[];let bytes=0;
      if(response.body){const reader=response.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();throw new Error('API response exceeds 1 MiB')}chunks.push(value)}}
      const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength}
      reply({type:'api-result',id:m.id,response:{status:response.status,headers:Object.fromEntries(response.headers.entries()),body:new TextDecoder().decode(buffer)}});
    }catch(error){reply({type:'api-result',id:m.id,error:error instanceof Error?error.message:'API request failed; outcome may be unknown'})}
    finally{clearTimeout(timer);if(counted)active--;}
  };
}`;
