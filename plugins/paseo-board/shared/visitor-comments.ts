/**
 * Visitor text-selection comments for published pages (DESIGN.md §4.3, §4.4, §11.11).
 *
 * Spliced into the static viewer only for releases with `comments: {apiBase, appKey}`; every other
 * release stays byte-identical. Each block is one IIFE that declares nothing in the enclosing scope.
 *
 * - COMMENTS_RUNTIME runs inside the sandboxed canvas iframe (uses `initial` and `send`). It only sees
 *   the authored DOM: it validates selections, builds anchors and draws the visitor's own markers in a
 *   closed shadow root. It never receives the visitor secret, comment text or reply text.
 * - COMMENTS_SHELL runs in the trusted outer page (uses `config`, `frame` and `sessionId`). It owns the
 *   floating button, composer, badge, thread panel, the anonymous visitor secret and every request to
 *   the comment backend.
 *
 * The code is plain JavaScript inside String.raw: no template literals and no closing script tags.
 */

/** Synchronous SHA-256 of a UTF-8 string, as lowercase hex (no secure context required). */
export const SHA256_JS = String.raw`(text=>{
    const bytes=new TextEncoder().encode(text),K=[],H=[];
    for(let n=2,count=0;count<64;n++){let prime=true;for(let d=2;d*d<=n;d++)if(n%d===0){prime=false;break}if(!prime)continue;if(count<8)H[count]=Math.pow(n,1/2)*4294967296|0;K[count++]=Math.pow(n,1/3)*4294967296|0}
    const length=bytes.length,words=new Uint32Array(((length+72)>>6)<<4),w=new Uint32Array(64);
    for(let i=0;i<length;i++)words[i>>2]|=bytes[i]<<(24-(i%4)*8);
    words[length>>2]|=0x80<<(24-(length%4)*8);words[words.length-1]=length*8;words[words.length-2]=Math.floor(length/536870912);
    for(let i=0;i<words.length;i+=16){
      let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for(let j=0;j<64;j++){
        if(j<16)w[j]=words[i+j];else{const x=w[j-15],y=w[j-2];w[j]=((x>>>7|x<<25)^(x>>>18|x<<14)^(x>>>3))+w[j-7]+((y>>>17|y<<15)^(y>>>19|y<<13)^(y>>>10))+w[j-16]}
        const t1=(h+((e>>>6|e<<26)^(e>>>11|e<<21)^(e>>>25|e<<7))+((e&f)^(~e&g))+K[j]+w[j])|0,t2=(((a>>>2|a<<30)^(a>>>13|a<<19)^(a>>>22|a<<10))+((a&b)^(a&c)^(b&c)))|0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      H[0]=H[0]+a|0;H[1]=H[1]+b|0;H[2]=H[2]+c|0;H[3]=H[3]+d|0;H[4]=H[4]+e|0;H[5]=H[5]+f|0;H[6]=H[6]+g|0;H[7]=H[7]+h|0;
    }
    return H.map(x=>(x>>>0).toString(16).padStart(8,'0')).join('');
  })`;

/** Anchor bounds shared by the iframe producer and the shell's validation (DESIGN §4.1). */
const ANCHOR_CHECK = String.raw`const cleanAnchor=a=>{
    if(!a||typeof a!=='object'||Array.isArray(a))return null;
    const out={},str=(key,min,max)=>{const v=a[key];if(v===undefined)return true;if(typeof v!=='string'||v.length<min||v.length>max)return false;out[key]=v;return true};
    if(!str('label',0,200)||!str('selector',0,500)||!str('quote',1,1000)||!str('prefix',0,64)||!str('suffix',0,64))return null;
    const int=v=>Number.isSafeInteger(v)&&v>=0&&v<=10000000;
    if(a.start!==undefined||a.end!==undefined){if(!int(a.start)||!int(a.end)||a.start>=a.end||out.quote===undefined||a.end-a.start!==out.quote.length)return null;out.start=a.start;out.end=a.end}
    return out;
  };`;

export const COMMENTS_RUNTIME = String.raw`
  ;(()=>{
  const root=document.documentElement,CHANNEL='paseo-board-release-v1';
  const EDITORS='input,textarea,select,option,button,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=menu],[role=menuitem],[role=slider],[role=listbox],[role=combobox],[data-board-comments=off]';
  const TEXT_CONTROLS='input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox]';
  const NATIVE='a[href],button,summary,label,canvas,svg,[draggable=true],[role=button],[role=tab],[role=option],[role=combobox]';
  const STATUS={sent:'已发送，等待作者查看',received:'作者已收到',replied:'已回复'};
  let host=null,shadow=null,layer=null,outline=null,outlineTimer=0,threads=[],marks=new Map(),orphanKey='';
  let touch=false,snapshot=null,keyAt=-1e9,idle=0,posted=false,quiet='',frameRequest=0,mutationTimer=0,lastAnchor=0,mouseDown=false;
  const off=()=>root.getAttribute('data-board-comments')==='off'||Boolean(document.body&&document.body.getAttribute('data-board-comments')==='off');
  const elementOf=node=>node?(node.nodeType===1?node:node.parentElement):null;
  const excluded=node=>{const el=elementOf(node);if(!el)return true;if(host&&(el===host||host.contains(el)))return true;return Boolean(el.closest(EDITORS))};
  const signature=selection=>selection&&selection.rangeCount?[selection.anchorOffset,selection.focusOffset,selection.toString().length].join(':')+String(selection.anchorNode&&selection.anchorNode.nodeName):'';
  const validRange=()=>{
    if(off())return null;
    const selection=getSelection();
    if(!selection||selection.isCollapsed||selection.rangeCount!==1||!selection.toString().trim())return null;
    if(excluded(selection.anchorNode)||excluded(selection.focusNode))return null;
    const active=document.activeElement;if(active&&active!==document.body&&active!==root&&active.closest&&active.closest(TEXT_CONTROLS))return null;
    const range=selection.getRangeAt(0);return range.toString().trim()?range:null;
  };
  const rectsOf=range=>Array.from(range.getClientRects()).filter(rect=>rect.width>0||rect.height>0);
  const within=(range,x,y)=>rectsOf(range).some(r=>x>=r.left-1&&x<=r.right+1&&y>=r.top-1&&y<=r.bottom+1);
  const escapeId=value=>window.CSS&&CSS.escape?CSS.escape(value):value.replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c);
  /** The closest uniquely identified ancestor, else a structural path from body (depth at most 12). */
  const targetOf=range=>{
    const body=document.body;let el=elementOf(range.commonAncestorContainer);
    for(let e=el;e&&e!==body&&e!==root;e=e.parentElement){
      if(!e.id)continue;const selector='#'+escapeId(e.id);
      try{if(selector.length<=500&&document.querySelector(selector)===e)return{el:e,selector}}catch{}
    }
    if(!body||!el||!body.contains(el))return{el:body||root,selector:'body'};
    const chain=[];for(let e=el;e&&e!==body;e=e.parentElement)chain.unshift(e);
    const parts=chain.slice(0,12).map(e=>{let n=1;for(let s=e.previousElementSibling;s;s=s.previousElementSibling)if(s.localName===e.localName)n++;return e.localName+':nth-of-type('+n+')'});
    while(parts.length){const selector='body > '+parts.join(' > ');try{if(selector.length<=500&&document.querySelector(selector)===chain[parts.length-1])return{el:chain[parts.length-1],selector}}catch{}parts.pop()}
    return{el:body,selector:'body'};
  };
  const labelOf=el=>{
    const component=el.closest('[data-board-component]'),value=component&&component.getAttribute('data-board-component').replace(/\s+/g,' ').trim();
    if(value)return value.slice(0,80);
    const section=el.closest('section,article,figure,li,table,form'),heading=section&&section.querySelector('h1,h2,h3,h4,h5,h6');
    const text=heading&&heading.textContent.replace(/\s+/g,' ').trim();return text?text.slice(0,80):undefined;
  };
  const offsetIn=(el,node,offset)=>{const before=document.createRange();before.selectNodeContents(el);before.setEnd(node,offset);return before.toString().length};
  const anchorOf=range=>{
    const {el,selector}=targetOf(range),text=el.textContent||'';
    let quote=range.toString().slice(0,1000);if(/[\uD800-\uDBFF]$/.test(quote))quote=quote.slice(0,-1);
    let start=-1;try{start=offsetIn(el,range.startContainer,range.startOffset)}catch{}
    if(start<0||text.slice(start,start+quote.length)!==quote)start=text.indexOf(quote);
    const anchor={},label=labelOf(el);if(label)anchor.label=label;
    anchor.selector=selector;anchor.quote=quote;
    if(start>=0&&start+quote.length<=10000000){
      let prefix=text.slice(Math.max(0,start-64),start),suffix=text.slice(start+quote.length,start+quote.length+64);
      if(/^[\uDC00-\uDFFF]/.test(prefix))prefix=prefix.slice(1);if(/[\uD800-\uDBFF]$/.test(suffix))suffix=suffix.slice(0,-1);
      if(prefix)anchor.prefix=prefix;if(suffix)anchor.suffix=suffix;anchor.start=start;anchor.end=start+quote.length;
    }
    // Leave room for the releaseId the parent adds; the backend allows 2,000 serialized characters.
    while(JSON.stringify(anchor).length>1900){
      if(anchor.label)delete anchor.label;
      else if(anchor.prefix||anchor.suffix){delete anchor.prefix;delete anchor.suffix}
      else{anchor.quote=anchor.quote.slice(0,Math.max(1,Math.floor(anchor.quote.length*0.8)));if(/[\uD800-\uDBFF]$/.test(anchor.quote)&&anchor.quote.length>1)anchor.quote=anchor.quote.slice(0,-1);if(anchor.start!==undefined)anchor.end=anchor.start+anchor.quote.length}
    }
    return anchor;
  };
  const box=rect=>({x:rect.left,y:rect.top,width:rect.width,height:rect.height});
  const post=(trigger,range,point)=>{
    try{
      const rects=rectsOf(range),whole=range.getBoundingClientRect(),last=rects[rects.length-1]||whole;
      send({type:'comment-target',trigger,anchor:anchorOf(range),rect:box(last),bounds:box(whole),touch,...(point?{point}:{})});posted=true;
    }catch(error){console.warn('Comment target unavailable',error)}
  };
  const clear=()=>{clearTimeout(idle);if(posted){posted=false;send({type:'comment-target-clear'})}};
  const settle=delay=>{clearTimeout(idle);idle=setTimeout(()=>{if(mouseDown)return;const range=validRange();if(!range){clear();return}if(quiet&&quiet===signature(getSelection()))return;quiet='';post('select',range)},delay)};
  document.addEventListener('selectionchange',()=>{if(!validRange()){quiet='';clear();return}if(posted){posted=false;send({type:'comment-target-clear'})}settle(400)});
  const onPointerDown=event=>{
    if(event.pointerType)touch=event.pointerType==='touch'||event.pointerType==='pen';
    if(event.button===0&&!touch)mouseDown=true;
    if(event.button!==2||event.pointerType&&event.pointerType!=='mouse')return;
    const range=validRange();snapshot={at:performance.now(),inside:Boolean(range)&&within(range,event.clientX,event.clientY)};
  };
  if(window.PointerEvent)window.addEventListener('pointerdown',onPointerDown,true);else window.addEventListener('mousedown',onPointerDown,true);
  window.addEventListener('blur',()=>{mouseDown=false});
  window.addEventListener(window.PointerEvent?'pointerup':'mouseup',event=>{if(event.button===0&&mouseDown){mouseDown=false;if(validRange())settle(120)}},true);
  window.addEventListener('contextmenu',event=>{
    const fresh=snapshot&&performance.now()-snapshot.at<=1000;
    // The keyboard menu key was already turned into a comment target; keep the browser menu closed.
    if(!fresh&&performance.now()-keyAt<1000&&event.isTrusted&&!event.defaultPrevented){event.preventDefault();return}
    if(event.defaultPrevented||!event.isTrusted||event.shiftKey)return;
    if(event.pointerType==='touch'||event.pointerType==='pen'||event.sourceCapabilities&&event.sourceCapabilities.firesTouchEvents)return;
    const snap=snapshot;snapshot=null;
    if(!snap||!fresh||!snap.inside)return;
    const target=elementOf(event.target);if(target&&target.closest(NATIVE))return;
    const range=validRange();if(!range)return;
    event.preventDefault();clearTimeout(idle);post('menu',range,{x:event.clientX,y:event.clientY});
  });
  window.addEventListener('keydown',event=>{
    if(!event.isTrusted)return;
    if(event.key==='Escape'){if(posted){clear();quiet=signature(getSelection())}return}
    if(event.defaultPrevented||!(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey))return;
    const range=validRange();if(!range)return;
    event.preventDefault();keyAt=performance.now();clearTimeout(idle);post('key',range);
  });
  document.addEventListener('scroll',()=>{if(posted){posted=false;send({type:'comment-target-clear'});settle(400)}schedule()},true);
  window.addEventListener('resize',()=>schedule());
  // Markers: the visitor's own threads, drawn in a closed shadow root that authored code cannot read.
  const ensureHost=()=>{
    if(host&&host.isConnected)return;
    host=document.createElement('paseo-board-comment-markers');
    for(const [k,v] of [['position','fixed'],['inset','0'],['pointer-events','none'],['z-index','2147483646'],['display','block'],['margin','0'],['padding','0'],['border','0'],['background','none'],['transform','none'],['opacity','1'],['visibility','visible']])host.style.setProperty(k,v,'important');
    shadow=host.attachShadow({mode:'closed'});
    const style=document.createElement('style');
    style.textContent=':host{all:initial}button{all:initial;position:absolute;left:0;top:0;box-sizing:border-box;min-width:20px;height:20px;padding:0 5px;border-radius:10px 10px 10px 3px;border:1.5px solid #fff;background:#2f6feb;color:#fff;font:600 11px/17px system-ui,-apple-system,sans-serif;text-align:center;cursor:pointer;pointer-events:auto;box-shadow:0 1px 4px rgba(0,0,0,.35)}button[data-unread]{box-shadow:0 0 0 3px #f59e0b,0 1px 4px rgba(0,0,0,.35)}button:focus-visible{outline:2px solid #1d1d1f;outline-offset:2px}button[hidden]{display:none}div{position:absolute;left:0;top:0;border:2px solid #f59e0b;border-radius:4px;pointer-events:none}div[hidden]{display:none}';
    layer=document.createElement('section');outline=document.createElement('div');outline.hidden=true;
    shadow.append(style,layer,outline);root.appendChild(host);
  };
  const rangeAt=(el,start,end)=>{
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),range=document.createRange();let position=0,started=false;
    for(let node=walker.nextNode();node;node=walker.nextNode()){
      const length=node.data.length;
      if(!started&&start<=position+length){range.setStart(node,start-position);started=true}
      if(started&&end<=position+length){range.setEnd(node,end-position);return range}
      position+=length;
    }
    return null;
  };
  const search=(el,a,exact)=>{
    if(!el)return null;const text=el.textContent||'',quote=a.quote;
    if(exact&&a.start!==undefined&&text.slice(a.start,a.end)===quote)return rangeAt(el,a.start,a.end);
    let first=-1,found=-1,guard=0;
    for(let i=text.indexOf(quote);i!==-1&&guard<2000;i=text.indexOf(quote,i+1),guard++){
      if(first<0)first=i;
      if((!a.prefix||text.slice(Math.max(0,i-a.prefix.length),i)===a.prefix)&&(!a.suffix||text.slice(i+quote.length,i+quote.length+a.suffix.length)===a.suffix)){found=i;break}
    }
    const at=found>=0?found:first;return at<0?null:rangeAt(el,at,at+quote.length);
  };
  const locate=a=>{
    if(!a||!a.quote||!document.body)return null;
    let el=null;try{el=a.selector?document.querySelector(a.selector):null}catch{}
    if(el&&host&&(el===host||host.contains(el)))el=null;
    return search(el||document.body,a,Boolean(el))||(el&&el!==document.body?search(document.body,a,false):null);
  };
  const clippers=range=>{const list=[];for(let e=elementOf(range.startContainer);e&&e!==document.body&&e!==root;e=e.parentElement){const s=getComputedStyle(e);if(s.overflowX!=='visible'||s.overflowY!=='visible')list.push(e)}return list};
  const reanchor=()=>{
    lastAnchor=performance.now();const missing=[];
    for(const thread of threads){const mark=marks.get(thread.id);if(!mark)continue;mark.range=locate(thread.anchor);mark.clip=mark.range?clippers(mark.range):[];if(!mark.range)missing.push(thread.id)}
    const key=missing.join('\n');if(key!==orphanKey){orphanKey=key;send({type:'comment-orphans',ids:missing})}
    schedule();
  };
  const place=()=>{
    frameRequest=0;const width=innerWidth,height=innerHeight;
    for(const mark of marks.values()){
      const range=mark.range,rects=range?rectsOf(range):[],last=rects[rects.length-1];
      let visible=Boolean(last)&&last.bottom>0&&last.top<height&&last.right>0&&last.left<width;
      if(visible)for(const el of mark.clip){const r=el.getBoundingClientRect();if(last.bottom<r.top||last.top>r.bottom||last.right<r.left||last.left>r.right){visible=false;break}}
      mark.button.hidden=!visible;
      if(visible){const x=Math.min(Math.max(0,last.right+1),width-22),y=Math.min(Math.max(0,last.top-9),height-22);mark.button.style.transform='translate('+Math.round(x)+'px,'+Math.round(y)+'px)'}
    }
  };
  const schedule=()=>{if(!frameRequest&&marks.size)frameRequest=requestAnimationFrame(place)};
  const render=list=>{
    threads=list;
    if(!threads.length&&!host)return;
    ensureHost();const keep=new Set();
    for(const thread of threads){
      keep.add(thread.id);let mark=marks.get(thread.id);
      if(!mark){const button=document.createElement('button');button.type='button';button.hidden=true;button.addEventListener('click',event=>{if(event.isTrusted)send({type:'comment-open',id:thread.id})});layer.appendChild(button);mark={button,range:null,clip:[]};marks.set(thread.id,mark)}
      mark.button.textContent=String(thread.n);mark.button.setAttribute('aria-label','我的评论 '+thread.n+'：'+(STATUS[thread.status]||STATUS.sent));
      if(thread.unread)mark.button.setAttribute('data-unread','');else mark.button.removeAttribute('data-unread');
    }
    for(const [id,mark] of marks)if(!keep.has(id)){mark.button.remove();marks.delete(id)}
    reanchor();
  };
  const reveal=id=>{
    const mark=marks.get(id);if(!mark||!mark.range)return;
    const el=elementOf(mark.range.startContainer);if(el)el.scrollIntoView({block:'center',inline:'nearest'});
    requestAnimationFrame(()=>{const r=mark.range.getBoundingClientRect();if(!outline)return;outline.hidden=false;outline.style.transform='translate('+Math.round(r.left-3)+'px,'+Math.round(r.top-3)+'px)';outline.style.width=Math.round(r.width+6)+'px';outline.style.height=Math.round(r.height+6)+'px';clearTimeout(outlineTimer);outlineTimer=setTimeout(()=>{outline.hidden=true},2000);schedule()});
  };
  const watcher=new MutationObserver(records=>{
    if(!marks.size||records.every(record=>record.target===host))return;
    if(mutationTimer)return;
    mutationTimer=setTimeout(()=>{mutationTimer=0;reanchor()},Math.max(0,500-(performance.now()-lastAnchor)));
  });
  const valid=t=>t&&typeof t.id==='string'&&t.id.length<=200&&Number.isSafeInteger(t.n)&&t.n>0&&Object.prototype.hasOwnProperty.call(STATUS,t.status)&&t.anchor&&typeof t.anchor==='object'&&typeof t.anchor.quote==='string'&&t.anchor.quote.length>0&&t.anchor.quote.length<=1000;
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==parent||!m||m.channel!==CHANNEL||m.releaseId!==initial.releaseId||m.sessionId!==initial.sessionId)return;
    if(m.type==='comment-threads'&&Array.isArray(m.threads))render(m.threads.slice(0,30).filter(valid));
    else if(m.type==='comment-reveal'&&typeof m.id==='string')reveal(m.id);
  });
  const ready=()=>{watcher.observe(root,{childList:true,subtree:true,characterData:true});send({type:'comment-runtime-ready',off:off()})};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
  })();`;

export const COMMENTS_SHELL = String.raw`
  ;(()=>{
  const settings=config.comments,apiBase=settings.apiBase,appKey=settings.appKey,CHANNEL='paseo-board-release-v1';
  const preview=location.origin==='null',pageUrl=location.origin+location.pathname,pageKey=location.origin+location.pathname.replace(/\/index\.html$/,'/');
  const sha256=${SHA256_JS};
  ${ANCHOR_CHECK}
  const visitorKey='paseo-board-visitor:v2:'+appKey,cachePrefix='paseo-board-comments:v2:'+appKey+':',cacheKey=cachePrefix+pageKey,hintKey='paseo-board-comments-hint:v1',pageHash=sha256(pageKey).slice(0,16);
  const TEXT={
    sending:'发送中…',sent:'已发送',unconfirmed:'没有确认送达，评论已保留。',network:'浏览器或网络阻止了连接到评论服务（可能需要允许访问本地网络，或只能在公司网络内评论）。',
    busy:'评论服务繁忙，稍后自动重试。',poll:'暂时连接不上评论服务，稍后自动重试。',unavailable:'评论服务暂时不可用（地址指向了其他服务，或后端版本过旧）。',
    preview:'预览不连接评论后端，发布后才能发送。',storage:'浏览器不允许本地存储：关闭页面后将看不到自己的评论和回复。',
    note:'评论只发给页面作者，可能由作者的 AI 助手处理；回复只在这个浏览器里对你可见。',keys:'⌘/Ctrl + Enter 发送 · Esc 收起（保留草稿）',shift:'Shift + 右键：浏览器菜单',
    empty:'你还没有在这个页面留下评论。',orphan:'原文已修改，页面上找不到这段文字',forget:'清除后，这个浏览器将看不到你之前在这个评论服务留下的评论和回复。确定清除？',
  };
  const STATUS={sent:'已发送，等待作者查看',received:'作者已收到',replied:'已回复'};
  const store=kind=>{try{const s=window[kind];s.getItem(hintKey);return s}catch{return null}};
  const local=preview?null:store('localStorage'),session=preview?null:store('sessionStorage');
  let storageNotice=!preview&&(!local||!session);
  const readJson=(s,key,max)=>{try{const raw=s&&s.getItem(key);if(!raw||raw.length>max)return null;const value=JSON.parse(raw);return value&&typeof value==='object'&&!Array.isArray(value)?value:null}catch{return null}};
  const counts=(value,keyPattern,limit)=>{const out={};if(value&&typeof value==='object'&&!Array.isArray(value))for(const [k,v] of Object.entries(value).slice(-limit))if(keyPattern.test(k)&&Number.isSafeInteger(v)&&v>=0)out[k]=v;return out};
  const stored=readJson(local,visitorKey,65536)||{};
  const visitor={secret:/^[a-f0-9]{64}$/.test(stored.secret)?stored.secret:'',name:typeof stored.name==='string'?stored.name.slice(0,80):'',seen:counts(stored.seen,/^.{1,200}$/s,200),pages:counts(stored.pages,/^[a-f0-9]{16}$/,100)};
  const bump=(map,key,value,limit)=>{delete map[key];if(value!==undefined)map[key]=value;const keys=Object.keys(map);for(const k of keys.slice(0,Math.max(0,keys.length-limit)))delete map[k]};
  const saveVisitor=()=>{if(!visitor.secret)return;try{if(local)local.setItem(visitorKey,JSON.stringify(visitor))}catch{}};
  const cleanReply=r=>r&&typeof r==='object'&&typeof r.id==='string'&&r.id.length<=200&&typeof r.text==='string'&&r.text.length<=8000&&(r.authorKind==='owner'||r.authorKind==='agent')?{id:r.id,text:r.text,authorKind:r.authorKind,createdAt:typeof r.createdAt==='string'?r.createdAt.slice(0,40):''}:null;
  const cleanThread=t=>{
    if(!t||typeof t!=='object'||typeof t.id!=='string'||!t.id||t.id.length>200||typeof t.text!=='string'||t.text.length>8000)return null;
    const checked=t.anchor===undefined||t.anchor===null?null:cleanAnchor(t.anchor),anchor=checked&&checked.quote!==undefined?checked:null;
    return{id:t.id,text:t.text,authorName:typeof t.authorName==='string'?t.authorName.slice(0,160):undefined,createdAt:typeof t.createdAt==='string'?t.createdAt.slice(0,40):'',anchor,
      status:STATUS[t.status]?t.status:'sent',replies:Array.isArray(t.replies)?t.replies.slice(0,20).map(cleanReply).filter(Boolean):[]};
  };
  const cleanPending=p=>p&&typeof p==='object'&&/^[A-Za-z0-9._:-]{8,128}$/.test(p.key)&&p.payload&&typeof p.payload.text==='string'&&cleanAnchor(p.payload.anchor)?{key:p.key,payload:p.payload,at:typeof p.at==='string'?p.at:'',draft:typeof p.draft==='string'?p.draft:''}:null;
  const cached=readJson(session,cacheKey,262144)||{};
  let threads=Array.isArray(cached.threads)?cached.threads.slice(0,30).map(cleanThread).filter(Boolean):[];
  let pending=Array.isArray(cached.pending)?cached.pending.slice(0,5).map(cleanPending).filter(Boolean):[];
  let drafts=cached.drafts&&typeof cached.drafts==='object'&&!Array.isArray(cached.drafts)?Object.fromEntries(Object.entries(cached.drafts).filter(([k,v])=>k.length<=400&&typeof v==='string'&&v.length<=2000).slice(-5)):{};
  const saveCache=()=>{if(!session)return;try{let raw=JSON.stringify({pending,threads,drafts});if(raw.length>262144)raw=JSON.stringify({pending,threads:[],drafts});session.setItem(cacheKey,raw)}catch{}};
  let orphans=new Set(),frameReady=false,frameOff=false,health=null,healthCheck=null,timer=0,lastPoll=-1e9,failures=0,notBefore=0,inFlight=false,pollProblem='',loaded=false;
  let target=null,composer=null,panelOpen=false,toastTimer=0;
  const hex=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');
  const uuid=()=>{try{if(crypto.randomUUID)return crypto.randomUUID()}catch{}const h=hex(16);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-'+(8|parseInt(h[16],16)&3).toString(16)+h.slice(17,20)+'-'+h.slice(20,32)};
  // UI: a plain fixed layer in the outer page, styled by one inline stylesheet; all visitor and reply text uses textContent.
  const css='.pbc,.pbc *{box-sizing:border-box;margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;letter-spacing:0;color:inherit}'+
    '.pbc{position:fixed;z-index:2147483000;color:#1d1d1f;-webkit-text-size-adjust:100%}.pbc[hidden],.pbc [hidden]{display:none!important}'+
    '.pbc button{cursor:pointer;-webkit-tap-highlight-color:transparent}.pbc button:focus-visible,.pbc input:focus-visible,.pbc textarea:focus-visible{outline:2px solid #2f6feb;outline-offset:2px}'+
    '.pbc-float{left:0;top:0;transform-origin:0 0;padding:6px 14px;border:0;border-radius:999px;background:#1d1d1f;color:#fff;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.25)}'+
    '.pbc-card{background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.2)}'+
    '.pbc-composer{left:0;top:0;width:min(380px,calc(100vw - 16px));padding:12px;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 16px);overflow:auto}'+
    '.pbc-composer.pbc-sheet{left:0;right:0;top:auto;width:auto;border-radius:14px 14px 0 0;padding-bottom:max(12px,env(safe-area-inset-bottom))}'+
    '.pbc-quote{padding:6px 10px;border-left:3px solid #2f6feb;background:#f1f4fa;border-radius:4px;color:#3a3a3c;max-height:4.4em;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}'+
    '.pbc input,.pbc textarea{display:block;width:100%;padding:8px 10px;border:1px solid #c7c7cc;border-radius:8px;background:#fff;color:#1d1d1f;font-size:16px}'+
    '.pbc textarea{min-height:92px;max-height:40vh;resize:vertical}.pbc-small{font-size:12px;color:#6e6e73}'+
    '.pbc-status{font-size:13px;color:#b42318;white-space:pre-wrap}.pbc-status[data-tone=info]{color:#3a3a3c}.pbc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'+
    '.pbc-btn{padding:6px 14px;border-radius:8px;border:1px solid #c7c7cc;background:#fff;font-weight:500}.pbc-btn:disabled,.pbc-btn[aria-disabled=true]{opacity:.45;cursor:default}'+
    '.pbc-primary{background:#2f6feb;border-color:#2f6feb;color:#fff}.pbc-link{padding:2px 0;border:0;background:none;color:#2f6feb;font-size:13px}'+
    '.pbc-badge{left:12px;bottom:12px;padding:7px 14px;border-radius:999px;border:1px solid rgba(0,0,0,.14);background:#fff;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.16)}'+
    '.pbc-dot{display:inline-block;width:8px;height:8px;margin-left:6px;border-radius:4px;background:#f59e0b;vertical-align:middle}'+
    '.pbc-panel{left:12px;bottom:58px;width:min(420px,calc(100vw - 24px));max-height:min(72vh,660px);display:flex;flex-direction:column;overflow:hidden}'+
    '.pbc-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 8px;font-weight:600}.pbc-list{overflow:auto;padding:0 14px 8px;flex:1}'+
    '.pbc-thread{padding:10px 0;border-top:1px solid #ececf0;display:flex;flex-direction:column;gap:6px}.pbc-thread[data-focus]{background:#fff8e6}'+
    '.pbc-text{white-space:pre-wrap;overflow-wrap:anywhere}.pbc-reply{margin-left:8px;padding-left:10px;border-left:2px solid #c9d5f0;display:flex;flex-direction:column;gap:2px}'+
    '.pbc-tag{display:inline-block;margin-left:6px;padding:0 6px;border-radius:6px;background:#fff1d6;color:#8a5300;font-size:12px}.pbc-foot{padding:8px 14px 12px;border-top:1px solid #ececf0;display:flex;flex-direction:column;gap:6px}'+
    '.pbc-toast{left:12px;bottom:58px;padding:6px 12px;border-radius:8px;background:#1d1d1f;color:#fff}.pbc-hint{left:12px;bottom:12px;padding:6px 8px 6px 12px;border-radius:999px;display:flex;gap:8px;align-items:center;background:#fff;border:1px solid rgba(0,0,0,.14);box-shadow:0 4px 16px rgba(0,0,0,.14)}'+
    '.pbc-hint[data-raised]{bottom:58px}'+
    '@media (prefers-color-scheme:dark){.pbc{color:#f2f2f7}.pbc-card,.pbc-badge,.pbc-hint,.pbc input,.pbc textarea,.pbc-btn{background:#1f1f22;color:#f2f2f7;border-color:#3a3a3f}.pbc-primary{background:#3b7bf0;border-color:#3b7bf0;color:#fff}.pbc-quote{background:#26292f;color:#d8d8dc}.pbc-small{color:#a1a1a6}.pbc-thread,.pbc-foot{border-color:#333338}.pbc-thread[data-focus]{background:#2f2a1e}.pbc-status{color:#ff8a80}.pbc-status[data-tone=info]{color:#d8d8dc}.pbc-float,.pbc-toast{background:#f2f2f7;color:#1d1d1f}.pbc-link{color:#6ea0ff}}'+
    '@media (max-width:599px){.pbc-panel{left:0;right:0;bottom:0;width:auto;max-height:80vh;border-radius:14px 14px 0 0}}';
  const el=(tag,props,children)=>{const node=document.createElement(tag);for(const [k,v] of Object.entries(props||{})){if(k==='text')node.textContent=v;else if(k==='class')node.className=v;else if(k==='on')for(const [type,fn] of Object.entries(v))node.addEventListener(type,fn);else if(v!==undefined&&v!==false)node.setAttribute(k,v===true?'':v)}for(const child of children||[])if(child)node.append(child);return node};
  const style=el('style',{text:css});document.head.appendChild(style);
  const layer=el('div',{'data-pbc-root':''});document.body.appendChild(layer);
  const floatButton=el('button',{type:'button',class:'pbc pbc-float','data-pbc':'float','aria-label':'评论选中的文字',text:'评论',hidden:true});
  const badge=el('button',{type:'button',class:'pbc pbc-badge','data-pbc':'badge','aria-haspopup':'dialog',hidden:true});
  const toast=el('div',{class:'pbc pbc-toast','data-pbc':'toast',role:'status','aria-live':'polite',hidden:true});
  const hint=el('div',{class:'pbc pbc-hint','data-pbc':'hint',hidden:true});
  layer.append(floatButton,badge,toast,hint);
  const viewport=()=>window.visualViewport||{offsetLeft:0,offsetTop:0,width:innerWidth,height:innerHeight,scale:1};
  const clamp=(value,low,high)=>Math.min(Math.max(value,low),Math.max(low,high));
  const outer=rect=>{const f=frame.getBoundingClientRect();return{left:f.left+rect.x,top:f.top+rect.y,right:f.left+rect.x+rect.width,bottom:f.top+rect.y+rect.height}};
  const trusted=event=>Boolean(event&&event.isTrusted);
  const active=()=>Boolean(navigator.userActivation&&navigator.userActivation.isActive);
  const post=message=>{if(frameReady)frame.contentWindow.postMessage({...message,channel:CHANNEL,releaseId:config.releaseId,sessionId},'*')};
  const focusFrame=()=>{try{frame.focus()}catch{}};
  const ordered=()=>threads.slice().sort((a,b)=>a.createdAt<b.createdAt?-1:a.createdAt>b.createdAt?1:0);
  const unreadOf=t=>Math.max(0,t.replies.length-(visitor.seen[t.id]||0));
  const numberOf=t=>ordered().indexOf(t)+1;
  const postThreads=()=>post({type:'comment-threads',threads:ordered().map((t,i)=>{const a=t.anchor;if(!a)return null;const anchor={};for(const k of ['selector','quote','prefix','suffix','start','end'])if(a[k]!==undefined)anchor[k]=a[k];return{id:t.id,n:i+1,status:t.status,unread:unreadOf(t)>0,anchor}}).filter(Boolean)});
  const knownCount=()=>loaded||threads.length?threads.length:(visitor.secret&&visitor.pages[pageHash])||0;
  const updateBadge=()=>{
    const n=knownCount()+pending.length,m=threads.reduce((sum,t)=>sum+unreadOf(t),0);
    badge.hidden=preview||n===0&&!panelOpen;
    badge.textContent=m?'我的评论 '+n+' · '+m+' 条新回复':'我的评论 '+n;if(m)badge.append(el('span',{class:'pbc-dot','aria-hidden':'true'}));
    badge.setAttribute('aria-expanded',panelOpen?'true':'false');
    if(!hint.hidden){if(badge.hidden)hint.removeAttribute('data-raised');else hint.setAttribute('data-raised','')}
  };
  const dismissHint=()=>{hint.hidden=true;try{if(local)local.setItem(hintKey,'1')}catch{}};
  hint.append(el('span',{text:'选中文字即可评论'}),el('button',{type:'button',class:'pbc-link',text:'知道了',on:{click:event=>{if(trusted(event))dismissHint()}}}));
  const showToast=text=>{toast.textContent=text;toast.hidden=false;toast.style.bottom=badge.hidden?'12px':'58px';clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true},2500)};
  // Network: same fetch options as board.request; responses are read up to 2 MiB.
  const readBody=async response=>{
    if(!response.body)return'';const reader=response.body.getReader(),chunks=[];let bytes=0;
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2097152){await reader.cancel();throw new Error('Response too large')}chunks.push(value)}
    const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength}
    return new TextDecoder().decode(buffer);
  };
  const request=async(path,init)=>{
    const controller=new AbortController(),abort=setTimeout(()=>controller.abort(),10000);
    try{const response=await fetch(apiBase+path,{...init,mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});const text=await readBody(response);let body=null;try{body=text?JSON.parse(text):null}catch{}return{status:response.status,headers:response.headers,body}}
    finally{clearTimeout(abort)}
  };
  const retryAfter=headers=>{const raw=headers.get('retry-after')||'';return /^\d{1,9}$/.test(raw)?Number(raw):0};
  /** Before the first POST or list of a page load: the address must still serve this app's thread runtime. */
  const checkHealth=()=>{
    if(health!==null)return Promise.resolve(health);
    if(!healthCheck)healthCheck=(async()=>{
      try{const r=await request('/_board/health',{});if(r.status===200||r.status===404){health=r.status===200&&Boolean(r.body)&&r.body.appKey===appKey&&r.body.comments===2;return health}throw new Error('HTTP '+r.status)}
      finally{healthCheck=null}
    })();
    return healthCheck;
  };
  const failureText=error=>error instanceof TypeError?TEXT.network:TEXT.poll;
  const shouldPoll=()=>!preview&&Boolean(visitor.secret)&&health!==false&&((visitor.pages[pageHash]||0)>0||pending.length>0||threads.length>0);
  const schedule=delay=>{
    clearTimeout(timer);timer=0;if(!shouldPoll()||document.hidden)return;
    const now=performance.now();timer=setTimeout(poll,Math.max(delay,notBefore-now,lastPoll+10000-now,0));
  };
  const jitter=ms=>ms*(0.8+Math.random()*0.4);
  const backoff=()=>[30,60,120,300][Math.min(failures,4)-1]*1000;
  const setProblem=text=>{if(pollProblem!==text){pollProblem=text;if(panelOpen)renderPanel()}};
  const sameThread=(item,t)=>t.text===item.payload.text&&Boolean(t.anchor)&&t.anchor.quote===item.payload.anchor.quote;
  const applyMine=body=>{
    if(!body||!Array.isArray(body.threads))throw new Error('Invalid response');
    threads=body.threads.slice(0,30).map(cleanThread).filter(Boolean);loaded=true;
    const before=pending.length;pending=pending.filter(item=>!threads.some(t=>sameThread(item,t)));
    bump(visitor.pages,pageHash,threads.length||undefined,100);for(const t of threads)if(visitor.seen[t.id]!==undefined)bump(visitor.seen,t.id,Math.min(visitor.seen[t.id],t.replies.length),200);
    saveVisitor();saveCache();updateBadge();postThreads();if(panelOpen)renderPanel();
    if(before!==pending.length&&composer&&composer.item&&!pending.includes(composer.item))closeComposer(false);
  };
  const poll=async()=>{
    timer=0;if(inFlight||document.hidden||!shouldPoll())return;
    const now=performance.now();if(now-lastPoll<10000||now<notBefore){schedule(0);return}
    inFlight=true;lastPoll=now;let delay=jitter(15000);
    try{
      if(!(await checkHealth())){setProblem(TEXT.unavailable);updateComposer();return}
      const r=await request('/_board/comments/mine?page='+encodeURIComponent(pageUrl),{headers:{'X-Board-Visitor':visitor.secret}});
      if(r.status===200){applyMine(r.body);failures=0;setProblem('')}
      else{failures++;const wait=retryAfter(r.headers);setProblem(r.status===429?TEXT.busy:TEXT.poll);delay=(r.status===429||r.status===503)&&wait?Math.min(wait,600)*1000:backoff();notBefore=performance.now()+delay}
    }catch(error){failures++;setProblem(failureText(error));delay=backoff();notBefore=performance.now()+delay}
    finally{inFlight=false}
    schedule(delay);
  };
  const pollSoon=()=>{if(!timer&&!inFlight)schedule(0);else if(timer&&performance.now()-lastPoll>=10000&&performance.now()>=notBefore)schedule(0)};
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);timer=0}else pollSoon()});
  window.addEventListener('focus',()=>pollSoon());
  // Sending: the payload is frozen in the pending list before the request; a retry reuses its key and payload.
  const deliver=async item=>{
    try{
      if(!(await checkHealth()))return{error:TEXT.unavailable,keep:false,disable:true};
      const r=await request('/_board/comments',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':item.key,'X-Board-Visitor':visitor.secret},body:JSON.stringify(item.payload)});
      const c=r.body&&r.body.comment;
      if((r.status===201||r.status===200)&&c&&typeof c.externalId==='string'&&c.text===item.payload.text){
        pending=pending.filter(p=>p!==item);
        if(!threads.some(t=>t.id===c.externalId)){const thread=cleanThread({id:c.externalId,text:c.text,authorName:c.authorName,createdAt:c.createdAt,anchor:c.anchor||item.payload.anchor,status:'sent',replies:[]});if(thread)threads=[thread,...threads].slice(0,30)}
        bump(visitor.pages,pageHash,threads.length,100);saveVisitor();saveCache();updateBadge();postThreads();if(panelOpen)renderPanel();
        failures=0;schedule(jitter(15000));return{ok:true};
      }
      const message=r.body&&typeof r.body.error==='string'?r.body.error.slice(0,300):'HTTP '+r.status;
      if(r.status===429)return{error:'发送太频繁，请 '+(retryAfter(r.headers)||60)+' 秒后再试。',keep:true};
      if(r.status===400)return{error:'评论内容不符合要求：'+message,keep:false};
      if(r.status>=500&&r.status!==507)return{error:TEXT.unconfirmed,keep:true,retry:true};
      return{error:'评论没有发送：'+message,keep:false};
    }catch(error){return{error:(error instanceof TypeError?TEXT.network+'\n':'')+TEXT.unconfirmed,keep:true,retry:true}}
  };
  // Composer: a dialog next to the selection, or a bottom sheet above the on-screen keyboard on narrow screens.
  const draftKey=a=>(a.selector||'')+'|'+(a.start===undefined?'':a.start)+'|'+a.quote.slice(0,200);
  const saveDraft=(key,text)=>{delete drafts[key];if(text.trim())drafts[key]=text.slice(0,2000);const keys=Object.keys(drafts);for(const k of keys.slice(0,Math.max(0,keys.length-5)))delete drafts[k];saveCache()};
  const focusables=root=>Array.from(root.querySelectorAll('button,input,textarea')).filter(n=>!n.disabled&&!n.hidden&&n.offsetParent!==null);
  const trap=(root,event)=>{if(event.key!=='Tab')return;const list=focusables(root);if(!list.length)return;const first=list[0],last=list[list.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}};
  const placeComposer=()=>{
    if(!composer)return;const node=composer.node,v=viewport();
    if(innerWidth<600){node.classList.add('pbc-sheet');node.style.transform='';node.style.bottom=Math.max(0,innerHeight-(v.offsetTop+v.height))+'px';return}
    node.classList.remove('pbc-sheet');node.style.bottom='';
    const r=outer(composer.target.bounds||composer.target.rect),w=node.offsetWidth||380,h=node.offsetHeight||280;
    let x=r.left,y=r.bottom+10;if(y+h>v.offsetTop+v.height-8&&r.top-h-10>=v.offsetTop+8)y=r.top-h-10;
    x=clamp(x,v.offsetLeft+8,v.offsetLeft+v.width-w-8);y=clamp(y,v.offsetTop+8,v.offsetTop+v.height-h-8);
    node.style.transform='translate('+Math.round(x)+'px,'+Math.round(y)+'px)';
  };
  const placeFloat=()=>{
    if(!target||floatButton.hidden)return;const v=viewport(),s=1/(v.scale||1),r=outer(target.rect),b=outer(target.bounds||target.rect);
    const w=(floatButton.offsetWidth||60)*s,h=(floatButton.offsetHeight||32)*s;
    let x=target.touch?(b.left+b.right)/2-w/2:r.right-w/2,y=target.touch?b.bottom+14*s:r.top-h-8*s;
    if(!target.touch&&y<v.offsetTop+4*s)y=r.bottom+8*s;
    x=clamp(x,v.offsetLeft+4*s,v.offsetLeft+v.width-w-4*s);y=clamp(y,v.offsetTop+4*s,v.offsetTop+v.height-h-4*s);
    floatButton.style.transform='translate('+Math.round(x)+'px,'+Math.round(y)+'px) scale('+s+')';
  };
  const relayout=()=>{placeFloat();placeComposer()};
  if(window.visualViewport){visualViewport.addEventListener('resize',relayout);visualViewport.addEventListener('scroll',relayout)}
  window.addEventListener('resize',relayout);
  const showFloat=t=>{if(composer)return;target=t;floatButton.hidden=false;placeFloat()};
  const hideFloat=()=>{floatButton.hidden=true;target=null};
  floatButton.addEventListener('click',event=>{if(trusted(event)&&target)openComposer(target,'select')});
  const updateComposer=()=>{
    if(!composer)return;const c=composer,blocked=preview||health===false;
    // Busy buttons stay focusable (aria-disabled), so focus never falls back to the page body mid-send.
    c.send.disabled=blocked;c.send.setAttribute('aria-disabled',blocked||c.busy?'true':'false');c.send.textContent=c.busy?TEXT.sending:c.retry?'重试':'发送';
    c.cancel.setAttribute('aria-disabled',c.busy?'true':'false');c.textarea.readOnly=Boolean(c.item);c.name.readOnly=Boolean(c.item);
    const notice=preview?TEXT.preview:health===false?TEXT.unavailable:'';
    c.notice.textContent=notice||(storageNotice?TEXT.storage:'');c.notice.hidden=!c.notice.textContent;
    c.status.hidden=!c.status.textContent;
  };
  const closeComposer=(keepDraft,returnFocus)=>{
    if(!composer)return;const c=composer;composer=null;
    if(keepDraft&&!c.item)saveDraft(c.key,c.textarea.value);
    c.node.remove();if(returnFocus!==false)focusFrame();
  };
  const submit=async event=>{
    if(!trusted(event)||!composer||composer.busy||preview||health===false)return;
    const c=composer;let item=c.item;
    if(!item){
      const text=c.textarea.value.trim();
      if(!text){c.status.textContent='请先写下评论。';updateComposer();c.textarea.focus();return}
      if(text.length>2000){c.status.textContent='评论最多 2000 字。';updateComposer();return}
      if(pending.length>=5){c.status.textContent='有 5 条评论还没确认送达，请先在「我的评论」里重试或放弃。';updateComposer();return}
      const name=c.name.value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,80);
      if(!visitor.secret)visitor.secret=hex(32);visitor.name=name;saveVisitor();
      const anchor={...c.anchor,releaseId:config.releaseId};
      item={key:'pc-'+uuid(),payload:{text,...(name?{authorName:name}:{}),pageUrl,anchor},at:new Date().toISOString(),draft:c.key};
      pending=[...pending,item];c.item=item;delete drafts[c.key];saveCache();updateBadge();
    }
    c.busy=true;c.status.textContent='';c.status.setAttribute('data-tone','info');updateComposer();
    const result=await deliver(item);
    if(composer!==c)return;
    c.busy=false;c.status.removeAttribute('data-tone');
    if(result.ok){closeComposer(false);showToast(TEXT.sent);dismissHint();return}
    if(!result.keep){pending=pending.filter(p=>p!==item);c.item=null;saveCache();updateBadge()}
    c.retry=Boolean(result.retry&&c.item);c.status.textContent=result.error;updateComposer();
  };
  const openComposer=(t,trigger)=>{
    if(composer)closeComposer(true,false);
    if(panelOpen)closePanel(false);
    hideFloat();const anchor=cleanAnchor(t.anchor);if(!anchor||anchor.quote===undefined)return;
    const key=draftKey(anchor);
    const quote=anchor.quote.replace(/\s+/g,' ').trim(),shown=quote.length>120?quote.slice(0,120)+'…':quote;
    const textarea=el('textarea',{'aria-label':'评论','placeholder':'写下你的评论…',maxlength:'2000'});textarea.value=drafts[key]||'';
    const name=el('input',{type:'text','aria-label':'称呼（可选）',placeholder:'称呼（可选）',maxlength:'80',autocomplete:'nickname'});name.value=visitor.name;
    const send=el('button',{type:'button',class:'pbc-btn pbc-primary','data-pbc':'send',text:'发送'}),cancel=el('button',{type:'button',class:'pbc-btn','data-pbc':'cancel',text:'取消'});
    const status=el('div',{class:'pbc-status',role:'status','aria-live':'polite',hidden:true}),notice=el('div',{class:'pbc-status','data-tone':'info',hidden:true});
    const ask=el('div',{class:'pbc-row','data-pbc':'discard',hidden:true},[el('span',{text:'放弃这条评论？'}),el('button',{type:'button',class:'pbc-btn',text:'放弃',on:{click:event=>{if(!trusted(event)||!composer)return;delete drafts[composer.key];saveCache();closeComposer(false)}}}),el('button',{type:'button',class:'pbc-btn',text:'继续编辑',on:{click:event=>{if(!trusted(event)||!composer)return;ask.hidden=true;composer.textarea.focus()}}})]);
    const node=el('div',{class:'pbc pbc-card pbc-composer','data-pbc':'composer',role:'dialog','aria-modal':'true','aria-label':'评论选中的文字'},[
      el('div',{class:'pbc-quote',text:'“'+shown+'”'}),name,textarea,el('div',{class:'pbc-small',text:TEXT.note}),notice,status,ask,
      el('div',{class:'pbc-row'},[send,cancel]),el('div',{class:'pbc-small',text:TEXT.keys}),trigger==='menu'?el('div',{class:'pbc-small',text:TEXT.shift}):null]);
    composer={node,textarea,name,send,cancel,status,notice,ask,anchor,key,target:t,item:null,busy:false,retry:false};
    const linked=pending.find(p=>p.draft===key);
    if(linked){composer.item=linked;textarea.value=linked.payload.text;name.value=linked.payload.authorName||'';composer.retry=true;status.textContent=TEXT.unconfirmed}
    send.addEventListener('click',submit);
    cancel.addEventListener('click',event=>{if(!trusted(event)||!composer||composer.busy)return;if(!composer.item&&composer.textarea.value.trim()){ask.hidden=false;ask.querySelector('button').focus();return}if(!composer.item)delete drafts[key];saveCache();closeComposer(false)});
    textarea.addEventListener('input',()=>{if(composer&&!composer.item)saveDraft(key,textarea.value)});
    node.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();if(!ask.hidden){ask.hidden=true;textarea.focus();return}if(composer&&!composer.busy)closeComposer(true);return}
      if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void submit(event);return}
      trap(node,event);
    });
    layer.appendChild(node);updateComposer();placeComposer();
    if(storageNotice)storageNotice=false;
    textarea.focus({preventScroll:true});requestAnimationFrame(()=>placeComposer());
  };
  // Thread panel: the visitor's own threads on this page, newest first.
  const panel=el('div',{class:'pbc pbc-card pbc-panel','data-pbc':'panel',role:'dialog','aria-label':'我的评论',hidden:true});
  layer.appendChild(panel);
  let focusThread=null,forgetAsk=false;
  const when=value=>{const time=Date.parse(value);return Number.isNaN(time)?'':new Date(time).toLocaleString()};
  const clip=(text,max)=>{const t=text.replace(/\s+/g,' ').trim();return t.length>max?t.slice(0,max)+'…':t};
  const reveal=id=>{closePanel(false);post({type:'comment-reveal',id})};
  const recomment=t=>{closePanel(false);openComposer({anchor:t.anchor,rect:{x:innerWidth/2-150,y:innerHeight/3,width:1,height:1}},'panel')};
  const retryPending=async(item,line,button)=>{
    if(button.getAttribute('aria-disabled')==='true')return;button.setAttribute('aria-disabled','true');line.textContent=TEXT.sending;
    const result=await deliver(item);
    if(result.ok){showToast(TEXT.sent);renderPanel();return}
    if(!result.keep){pending=pending.filter(p=>p!==item);if(item.draft)saveDraft(item.draft,item.payload.text);saveCache();updateBadge()}
    line.textContent=result.error;button.setAttribute('aria-disabled','false');if(!result.keep)renderPanel();
  };
  const renderPanel=()=>{
    panel.textContent='';
    const close=el('button',{type:'button',class:'pbc-link','data-pbc':'close',text:'关闭',on:{click:event=>{if(trusted(event))closePanel(true)}}});
    panel.append(el('div',{class:'pbc-head'},[el('span',{text:'我的评论'}),close]));
    const list=el('div',{class:'pbc-list'});panel.append(list);
    if(pollProblem)list.append(el('div',{class:'pbc-status','data-pbc':'problem',text:pollProblem}));
    for(const item of pending){
      const line=el('div',{class:'pbc-small',text:'没有确认送达'}),retry=el('button',{type:'button',class:'pbc-btn',text:'重试'}),drop=el('button',{type:'button',class:'pbc-btn',text:'放弃'});
      retry.addEventListener('click',event=>{if(trusted(event))void retryPending(item,line,retry)});
      drop.addEventListener('click',event=>{if(!trusted(event))return;pending=pending.filter(p=>p!==item);if(item.draft)saveDraft(item.draft,item.payload.text);saveCache();updateBadge();renderPanel()});
      list.append(el('div',{class:'pbc-thread','data-pbc':'pending'},[el('div',{class:'pbc-quote',text:'“'+clip(item.payload.anchor.quote,120)+'”'}),el('div',{class:'pbc-text',text:item.payload.text}),line,el('div',{class:'pbc-row'},[retry,drop])]));
    }
    const newest=threads.slice().sort((a,b)=>a.createdAt<b.createdAt?1:a.createdAt>b.createdAt?-1:0);
    if(!newest.length&&!pending.length)list.append(el('div',{class:'pbc-small','data-pbc':'empty',text:TEXT.empty}));
    for(const t of newest){
      const unread=unreadOf(t),orphan=Boolean(t.anchor)&&orphans.has(t.id);
      const meta=el('div',{class:'pbc-small'},[document.createTextNode(['#'+numberOf(t),when(t.createdAt),STATUS[t.status]].filter(Boolean).join(' · ')),unread?el('span',{class:'pbc-tag',text:unread+' 条新回复'}):null]);
      const node=el('div',{class:'pbc-thread','data-pbc':'thread','data-thread':t.id,...(focusThread===t.id?{'data-focus':''}:{})},[
        t.anchor?el('div',{class:'pbc-quote',text:'“'+clip(t.anchor.quote,120)+'”'}):null,el('div',{class:'pbc-text',text:t.text}),meta,
        orphan?el('div',{class:'pbc-small','data-pbc':'orphan',text:TEXT.orphan}):null,
        ...t.replies.map(r=>el('div',{class:'pbc-reply','data-pbc':'reply'},[el('div',{class:'pbc-small',text:(r.authorKind==='agent'?'作者的 AI 助手回复':'作者回复')+(when(r.createdAt)?' · '+when(r.createdAt):'')}),el('div',{class:'pbc-text',text:r.text})])),
        t.anchor?el('div',{class:'pbc-row'},[orphan?null:el('button',{type:'button',class:'pbc-link',text:'在页面中定位',on:{click:event=>{if(trusted(event))reveal(t.id)}}}),el('button',{type:'button',class:'pbc-link',text:'再评论这段',on:{click:event=>{if(trusted(event))recomment(t)}}})]):null,
      ]);
      list.append(node);
    }
    const foot=el('div',{class:'pbc-foot'});
    if(forgetAsk)foot.append(el('div',{class:'pbc-small',text:TEXT.forget}),el('div',{class:'pbc-row'},[el('button',{type:'button',class:'pbc-btn','data-pbc':'forget-confirm',text:'确定清除',on:{click:event=>{if(trusted(event))forget()}}}),el('button',{type:'button',class:'pbc-btn',text:'取消',on:{click:event=>{if(!trusted(event))return;forgetAsk=false;renderPanel()}}})]));
    else foot.append(el('button',{type:'button',class:'pbc-link','data-pbc':'forget',text:'清除本机的评论身份',on:{click:event=>{if(!trusted(event))return;forgetAsk=true;renderPanel();const b=panel.querySelector('[data-pbc=forget-confirm]');if(b)b.focus()}}}));
    panel.append(foot);
    if(focusThread){const node=list.querySelector('[data-thread="'+CSS.escape(focusThread)+'"]');if(node)node.scrollIntoView({block:'nearest'})}
  };
  const markSeen=()=>{for(const t of threads)bump(visitor.seen,t.id,t.replies.length,200);saveVisitor();postThreads()};
  const openPanel=id=>{
    if(composer)closeComposer(true,false);
    panelOpen=true;focusThread=id||null;forgetAsk=false;renderPanel();panel.hidden=false;markSeen();updateBadge();
    const first=panel.querySelector('[data-pbc=close]');if(first)first.focus();pollSoon();
  };
  const closePanel=returnFocus=>{if(!panelOpen)return;panelOpen=false;panel.hidden=true;forgetAsk=false;updateBadge();if(returnFocus)badge.focus()};
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closePanel(true);return}trap(panel,event)});
  // Esc also closes the open dialog when focus is elsewhere in the outer page (for example on the page body).
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!event.isTrusted||event.defaultPrevented)return;
    if(composer&&!composer.node.contains(event.target)){if(!composer.busy){event.preventDefault();closeComposer(true)}}
    else if(panelOpen&&!panel.contains(event.target)){event.preventDefault();closePanel(true)}
  });
  badge.addEventListener('click',event=>{if(!trusted(event))return;if(panelOpen)closePanel(true);else openPanel(null)});
  const forget=()=>{
    try{if(local)local.removeItem(visitorKey)}catch{}
    try{if(session)for(const key of Object.keys(session))if(key.startsWith(cachePrefix))session.removeItem(key)}catch{}
    visitor.secret='';visitor.seen={};visitor.pages={};threads=[];pending=[];drafts={};loaded=true;health=null;
    clearTimeout(timer);timer=0;closePanel(false);postThreads();updateBadge();focusFrame();
  };
  // Messages from the canvas frame: selection targets, marker activation and missing anchors only.
  const number=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<1e7;
  const rect=r=>r&&number(r.x)&&number(r.y)&&number(r.width)&&number(r.height)?{x:r.x,y:r.y,width:r.width,height:r.height}:null;
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==frame.contentWindow||!m||m.channel!==CHANNEL||m.releaseId!==config.releaseId||m.sessionId!==sessionId)return;
    if(m.type==='comment-runtime-ready'){frameReady=true;frameOff=m.off===true;postThreads();if(!frameOff&&!preview&&!knownCount()&&!pending.length&&!(local&&local.getItem(hintKey)))hint.hidden=false;updateBadge();return}
    if(m.type==='comment-target-clear'){if(!composer)hideFloat();return}
    if(m.type==='comment-orphans'&&Array.isArray(m.ids)&&m.ids.length<=30&&m.ids.every(id=>typeof id==='string')){orphans=new Set(m.ids);if(panelOpen)renderPanel();return}
    if(m.type==='comment-open'&&typeof m.id==='string'&&threads.some(t=>t.id===m.id)){if(active())openPanel(m.id);return}
    if(m.type!=='comment-target'||!['menu','key','select'].includes(m.trigger))return;
    let size=0;try{size=JSON.stringify(m).length}catch{return}if(size>8000)return;
    const anchor=cleanAnchor(m.anchor),r=rect(m.rect);if(!anchor||anchor.quote===undefined||!anchor.selector||!r)return;
    const t={anchor,rect:r,bounds:rect(m.bounds)||r,touch:m.touch===true};
    if(m.trigger==='select'){if(!composer)showFloat(t);return}
    if(active())openComposer(t,m.trigger);else if(!composer)showFloat(t);
  });
  updateBadge();
  if(threads.length||pending.length)postThreads();
  if(shouldPoll())schedule(0);
  })();`;
