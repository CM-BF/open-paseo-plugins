/**
 * Public comment threads on published pages, Google-Docs style (public-threads DESIGN §5.6 as amended by §12).
 *
 * Spliced into the static viewer only for releases with `comments.visibility: "public"` (viewer 5). The private
 * viewer (shared/visitor-comments.ts, viewer 4) is untouched; only SHA256_JS is shared (§12 A21).
 *
 * - PUBLIC_COMMENTS_RUNTIME runs inside the sandboxed canvas iframe (uses `initial` and `send`). It turns selections
 *   into anchors, locates every visible thread's passage, paints soft-yellow highlights (CSS Custom Highlight API,
 *   or a closed-shadow-root overlay) and reports document-relative passage positions. It never receives comment
 *   text, names, tags or the visitor secret: only anchors (page text) and thread IDs.
 * - PUBLIC_COMMENTS_SHELL runs in the trusted outer page (uses `config`, `frame` and `sessionId`). It owns the rail,
 *   overlay and bottom sheet, the composer and reply boxes, the visitor secret, polling and every request.
 *
 * Plain JavaScript inside String.raw: no template literals, no interpolation markers, no closing script tags.
 */
import { SHA256_JS } from "./visitor-comments";
import { INVISIBLE_SOURCE } from "./bidi";

/**
 * The rail layout (§5.6.4 with §12 A6): items sorted by passage; `y` is the passage top in document coordinates,
 * `h` the measured card height. Returns each card's top. Pure; unit-tested in server/public-release.test.ts.
 * o = {gap, lift, floor, viewTop, viewBottom, limit}: the active card sits at its passage, clamped into the view;
 * earlier cards move up, later cards move down. With no active card, cards stack down from their passages; when the
 * pile would end below `limit` (the last place the page scroll can show) and fits once packed, it is lifted just
 * enough, never above the floor. A pile that cannot fit keeps its first cards at their passages and runs past
 * `limit`: the shell lets the rail scroll beyond the page for those cards (Google Docs does the same).
 */
export const RAIL_LAYOUT_JS = String.raw`((items,active,o)=>{
    const n=items.length,top=new Array(n),gap=o.gap,lift=o.lift;
    if(!n)return top;
    const down=from=>{for(let i=from;i<n;i++)top[i]=Math.max(items[i].y-lift,top[i-1]+items[i-1].h+gap)};
    if(active>=0&&active<n){
      const h=items[active].h;let t=Math.max(o.floor,items[active].y-lift);
      if(h<=o.viewBottom-o.viewTop-o.floor-gap){t=Math.min(t,o.viewBottom-h-gap);t=Math.max(t,o.viewTop+o.floor)}
      top[active]=t;
      for(let i=active-1;i>=0;i--)top[i]=Math.min(items[i].y-lift,top[i+1]-gap-items[i].h);
      down(active+1);
    }else{
      top[0]=Math.max(o.floor,items[0].y-lift);down(1);
      let total=gap*(n-1);for(let i=0;i<n;i++)total+=items[i].h;
      if(top[n-1]+items[n-1].h>o.limit&&o.floor+total<=o.limit){
        let limit=o.limit;
        for(let i=n-1;i>=0;i--){top[i]=Math.min(top[i],limit-items[i].h);limit=top[i]-gap}
      }
    }
    return top;
  })`;

export const PUBLIC_COMMENTS_RUNTIME = String.raw`
  ;(()=>{
  const root=document.documentElement,CHANNEL='paseo-board-release-v1';
  const EDITORS='input,textarea,select,option,button,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=menu],[role=menuitem],[role=slider],[role=listbox],[role=combobox],[data-board-comments=off]';
  const TEXT_CONTROLS='input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox]';
  const NATIVE='a[href],button,summary,label,canvas,svg,[draggable=true],[role=button],[role=tab],[role=option],[role=combobox]';
  const SELECTOR=/^(?:body|#(?:[A-Za-z0-9_\-\u0080-￿]|\\[0-9a-fA-F]{1,6} |\\[^0-9a-fA-F\r\n\f])+|body(?: > [A-Za-z][A-Za-z0-9-]*:nth-of-type\([1-9]\d{0,4}\)){1,12})$/;
  let host=null,shadow=null,layer=null,threads=[],found=new Map(),hover=null,active=null,orphans=[],lastKey='',frameRequest=0,mutationTimer=0,orphanTimer=0,lastAnchor=0,lastOrphanPass=0;
  let touch=false,snapshot=null,keyAt=-1e9,idle=0,posted=false,quiet='',mouseDown=false,downAt=null,keep=null,scrollRequest=0,passId=0;
  const highlights=Boolean(window.CSS&&CSS.highlights&&window.Highlight);
  const off=()=>root.getAttribute('data-board-comments')==='off'||Boolean(document.body&&document.body.getAttribute('data-board-comments')==='off');
  const elementOf=node=>node?(node.nodeType===1?node:node.parentElement):null;
  const excluded=node=>{const el=elementOf(node);if(!el)return true;if(host&&(el===host||host.contains(el)))return true;return Boolean(el.closest(EDITORS))};
  const signature=selection=>selection&&selection.rangeCount?[selection.anchorOffset,selection.focusOffset,selection.toString().length].join(':')+String(selection.anchorNode&&selection.anchorNode.nodeName):'';
  const validRange=()=>{
    if(off())return null;
    const selection=getSelection();
    if(!selection||selection.isCollapsed||selection.rangeCount!==1||!selection.toString().trim())return null;
    if(excluded(selection.anchorNode)||excluded(selection.focusNode))return null;
    const focused=document.activeElement;if(focused&&focused!==document.body&&focused!==root&&focused.closest&&focused.closest(TEXT_CONTROLS))return null;
    const range=selection.getRangeAt(0);return range.toString().trim()?range:null;
  };
  const rectsOf=range=>Array.from(range.getClientRects()).filter(rect=>rect.width>0||rect.height>0);
  const within=(range,x,y)=>rectsOf(range).some(r=>x>=r.left-1&&x<=r.right+1&&y>=r.top-1&&y<=r.bottom+1);
  const escapeId=value=>window.CSS&&CSS.escape?CSS.escape(value):value.replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c);
  const targetOf=range=>{
    const body=document.body;let el=elementOf(range.commonAncestorContainer);
    for(let e=el;e&&e!==body&&e!==root;e=e.parentElement){
      if(!e.id)continue;const selector='#'+escapeId(e.id);
      try{if(selector.length<=500&&SELECTOR.test(selector)&&document.querySelector(selector)===e)return{el:e,selector}}catch{}
    }
    if(!body||!el||!body.contains(el))return{el:body||root,selector:'body'};
    const chain=[];for(let e=el;e&&e!==body;e=e.parentElement)chain.unshift(e);
    const parts=chain.slice(0,12).map(e=>{let n=1;for(let s=e.previousElementSibling;s;s=s.previousElementSibling)if(s.localName===e.localName)n++;return e.localName+':nth-of-type('+n+')'});
    while(parts.length){const selector='body > '+parts.join(' > ');try{if(selector.length<=500&&SELECTOR.test(selector)&&document.querySelector(selector)===chain[parts.length-1])return{el:chain[parts.length-1],selector}}catch{}parts.pop()}
    return{el:body,selector:'body'};
  };
  const offsetIn=(el,node,offset)=>{const before=document.createRange();before.selectNodeContents(el);before.setEnd(node,offset);return before.toString().length};
  const anchorOf=range=>{
    const target=targetOf(range),el=target.el,text=el.textContent||'';
    let quote=range.toString().slice(0,1000);if(/[\uD800-\uDBFF]$/.test(quote))quote=quote.slice(0,-1);
    let start=-1;try{start=offsetIn(el,range.startContainer,range.startOffset)}catch{}
    if(start<0||text.slice(start,start+quote.length)!==quote)start=text.indexOf(quote);
    const anchor={selector:target.selector,quote};
    if(start>=0&&start+quote.length<=10000000){
      let prefix=text.slice(Math.max(0,start-64),start),suffix=text.slice(start+quote.length,start+quote.length+64);
      if(/^[\uDC00-\uDFFF]/.test(prefix))prefix=prefix.slice(1);if(/[\uD800-\uDBFF]$/.test(suffix))suffix=suffix.slice(0,-1);
      if(prefix)anchor.prefix=prefix;if(suffix)anchor.suffix=suffix;anchor.start=start;anchor.end=start+quote.length;
    }
    while(JSON.stringify(anchor).length>1900){
      if(anchor.prefix||anchor.suffix){delete anchor.prefix;delete anchor.suffix}
      else{anchor.quote=anchor.quote.slice(0,Math.max(1,Math.floor(anchor.quote.length*0.8)));if(/[\uD800-\uDBFF]$/.test(anchor.quote)&&anchor.quote.length>1)anchor.quote=anchor.quote.slice(0,-1);if(anchor.start!==undefined)anchor.end=anchor.start+anchor.quote.length}
    }
    return anchor;
  };
  const box=rect=>({x:rect.left,y:rect.top,width:rect.width,height:rect.height});
  const post=(trigger,range,point)=>{
    try{const rects=rectsOf(range),whole=range.getBoundingClientRect(),last=rects[rects.length-1]||whole;send({type:'comment-target',trigger,anchor:anchorOf(range),rect:box(last),bounds:box(whole),touch,...(point?{point}:{})});posted=true}
    catch(error){console.warn('Comment target unavailable',error)}
  };
  const clear=()=>{clearTimeout(idle);if(posted){posted=false;send({type:'comment-target-clear'})}};
  const settle=delay=>{clearTimeout(idle);idle=setTimeout(()=>{if(mouseDown)return;const range=validRange();if(!range){clear();return}if(quiet&&quiet===signature(getSelection()))return;quiet='';post('select',range)},delay)};
  document.addEventListener('selectionchange',()=>{if(!validRange()){quiet='';clear();return}if(posted){posted=false;send({type:'comment-target-clear'})}settle(400)});
  const mac=/Mac/i.test(navigator.platform||''),secondary=event=>event.button===2||mac&&event.button===0&&event.ctrlKey;
  const onPointerDown=event=>{
    if(event.pointerType)touch=event.pointerType==='touch'||event.pointerType==='pen';
    if(event.button===0&&!touch&&!(mac&&event.ctrlKey))mouseDown=true;
    downAt={x:event.clientX,y:event.clientY,at:performance.now()};
    if(!secondary(event)||event.pointerType&&event.pointerType!=='mouse')return;
    const range=validRange();snapshot={at:performance.now(),inside:Boolean(range)&&within(range,event.clientX,event.clientY),range:range?range.cloneRange():null};
  };
  if(window.PointerEvent)window.addEventListener('pointerdown',onPointerDown,true);else window.addEventListener('mousedown',onPointerDown,true);
  const release=()=>{if(!mouseDown)return;mouseDown=false;if(validRange())settle(120)};
  window.addEventListener('blur',()=>{mouseDown=false});
  window.addEventListener(window.PointerEvent?'pointerup':'mouseup',event=>{if(event.button===0)release()},true);
  window.addEventListener('pointercancel',release,true);
  window.addEventListener('contextmenu',event=>{
    const snap=snapshot;snapshot=null;
    const fresh=Boolean(snap)&&performance.now()-snap.at<=1000;
    if(!fresh&&performance.now()-keyAt<1000&&event.isTrusted&&!event.defaultPrevented){event.preventDefault();return}
    if(event.defaultPrevented||!event.isTrusted||event.shiftKey)return;
    if(event.pointerType==='touch'||event.pointerType==='pen'||event.sourceCapabilities&&event.sourceCapabilities.firesTouchEvents)return;
    if(!fresh||!snap.inside)return;
    const target=elementOf(event.target);if(target&&target.closest(NATIVE))return;
    let range=validRange();
    if(!range&&snap.range&&!snap.range.collapsed){const selection=getSelection();selection.removeAllRanges();selection.addRange(snap.range);range=validRange()}
    if(!range)return;
    event.preventDefault();clearTimeout(idle);post('menu',range,{x:event.clientX,y:event.clientY});
  });
  window.addEventListener('keydown',event=>{
    if(!event.isTrusted)return;
    if(mouseDown&&!['Shift','Control','Alt','Meta'].includes(event.key))release();
    // Esc reaches the shell only when the page itself did not handle it (an authored dialog closes first).
    if(event.key==='Escape'){if(event.defaultPrevented)return;if(posted){clear();quiet=signature(getSelection())}send({type:'comment-escape'});return}
    if(event.defaultPrevented||!(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey))return;
    const range=validRange();if(!range)return;
    event.preventDefault();keyAt=performance.now();clearTimeout(idle);post('key',range);
  });
  // Highlights: one CSS highlight per state, painted with the text; a closed shadow-root overlay where unsupported.
  const COLORS={open:'rgba(255,214,0,.30)',resolved:'rgba(255,214,0,.14)',pending:'rgba(255,214,0,.30)',private:'rgba(47,111,235,.16)',hover:'rgba(255,200,0,.45)',active:'rgba(255,170,0,.58)'};
  if(highlights){
    try{
      const sheet=new CSSStyleSheet();
      sheet.replaceSync(Object.keys(COLORS).map(k=>'::highlight(pbc-'+k+'){background-color:'+COLORS[k]+';color:inherit}').join(''));
      document.adoptedStyleSheets=[...document.adoptedStyleSheets,sheet];
    }catch{const style=document.createElement('style');style.textContent=Object.keys(COLORS).map(k=>'::highlight(pbc-'+k+'){background-color:'+COLORS[k]+'}').join('');(document.head||root).appendChild(style)}
  }
  const ensureHost=()=>{
    if(host&&host.isConnected)return;
    host=document.createElement('paseo-board-comment-highlights');
    for(const [k,v] of [['position','fixed'],['inset','0'],['pointer-events','none'],['z-index','2147483646'],['display','block'],['margin','0'],['padding','0'],['border','0'],['background','none'],['transform','none'],['opacity','1'],['visibility','visible'],['mix-blend-mode','normal']])host.style.setProperty(k,v,'important');
    shadow=host.attachShadow({mode:'closed'});
    const style=document.createElement('style');
    style.textContent=':host{all:initial}div{position:absolute;left:0;top:0;border-radius:2px;pointer-events:none}div[data-state=open],div[data-state=pending]{background:'+COLORS.open+';box-shadow:inset 0 -2px rgba(230,170,0,.9)}div[data-state=resolved]{background:'+COLORS.resolved+'}div[data-state=private]{background:'+COLORS.private+'}div[data-hover]{background:'+COLORS.hover+'}div[data-active]{background:'+COLORS.active+'}div[data-outline]{border:2px solid #f59e0b;background:none}';
    layer=document.createElement('section');shadow.append(style,layer);root.appendChild(host);
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
  // One textContent read per element and pass, shared by every thread (§12 A7).
  const search=(el,a,exact,texts)=>{
    if(!el)return null;let text=texts.get(el);if(text===undefined){text=el.textContent||'';texts.set(el,text)}
    const quote=a.quote;
    if(exact&&a.start!==undefined&&text.slice(a.start,a.end)===quote)return rangeAt(el,a.start,a.end);
    let first=-1,at=-1,guard=0;
    for(let i=text.indexOf(quote);i!==-1&&guard<200;i=text.indexOf(quote,i+1),guard++){
      if(first<0)first=i;
      if((!a.prefix||text.slice(Math.max(0,i-a.prefix.length),i)===a.prefix)&&(!a.suffix||text.slice(i+quote.length,i+quote.length+a.suffix.length)===a.suffix)){at=i;break}
    }
    const index=at>=0?at:first;return index<0?null:rangeAt(el,index,index+quote.length);
  };
  const locate=(a,texts)=>{
    if(!a||!a.quote||!document.body)return null;
    let el=null;if(a.selector&&SELECTOR.test(a.selector)){try{el=document.querySelector(a.selector)}catch{}}
    if(el&&host&&(el===host||host.contains(el)))el=null;
    const range=search(el||document.body,a,Boolean(el),texts)||(el&&el!==document.body?search(document.body,a,false,texts):null);
    return range?{range,scope:el||document.body}:null;
  };
  const scrollerOf=node=>{for(let e=elementOf(node);e&&e!==document.body&&e!==root;e=e.parentElement){const s=getComputedStyle(e);if(/(auto|scroll|hidden|clip)/.test(s.overflowY+s.overflowX)&&e.scrollHeight>e.clientHeight+1)return e}return null};
  /** Re-anchors in slices of at most 8 ms per frame; only=true restricts the pass to orphans. */
  const reanchor=only=>{
    const id=++passId,texts=new Map(),list=threads.filter(t=>!only||orphans.includes(t.id));let index=0;
    const step=()=>{
      if(id!==passId)return;const begin=performance.now();
      while(index<list.length&&performance.now()-begin<8){const t=list[index++],hit=locate(t.anchor,texts);if(hit)found.set(t.id,{range:hit.range,scope:hit.scope,scroller:scrollerOf(hit.range.startContainer)});else found.delete(t.id)}
      if(index<list.length){requestAnimationFrame(step);return}
      lastAnchor=performance.now();paint();measure();
    };
    step();
  };
  const paint=()=>{
    const groups={open:[],resolved:[],pending:[],private:[],hover:[],active:[]};
    for(const t of threads){const f=found.get(t.id);if(!f)continue;(groups[t.state]||groups.open).push(f.range);if(t.id===hover)groups.hover.push(f.range);if(t.id===active)groups.active.push(f.range)}
    if(highlights){
      for(const [name,ranges] of Object.entries(groups)){const h=new Highlight(...ranges);h.priority=name==='active'?3:name==='hover'?2:1;CSS.highlights.set('pbc-'+name,h)}
      return;
    }
    if(!threads.length&&!host)return;
    ensureHost();schedule();
  };
  // The overlay fallback only: rectangles per frame for visible passages.
  const place=()=>{
    frameRequest=0;if(highlights||!layer)return;layer.textContent='';const height=innerHeight;
    for(const t of threads){
      const f=found.get(t.id);if(!f)continue;
      for(const r of rectsOf(f.range)){if(r.bottom<0||r.top>height)continue;const d=document.createElement('div');d.setAttribute('data-state',t.state);if(t.id===hover)d.setAttribute('data-hover','');if(t.id===active)d.setAttribute('data-active','');d.style.transform='translate('+Math.round(r.left)+'px,'+Math.round(r.top)+'px)';d.style.width=Math.round(r.width)+'px';d.style.height=Math.round(r.height)+'px';layer.appendChild(d)}
    }
  };
  const schedule=()=>{if(!highlights&&!frameRequest&&threads.length)frameRequest=requestAnimationFrame(place)};
  // Positions: document-relative passage tops, measured only after re-anchoring, resizes and inner scrolls.
  const measure=()=>{
    const items=[],missing=[],sy=scrollY;
    for(const t of threads){
      const f=found.get(t.id);if(!f){missing.push(t.id);continue}
      let r=f.range.getBoundingClientRect(),folded=false,clipped=false;
      if(!r.width&&!r.height){folded=true;for(let e=elementOf(f.range.startContainer);e;e=e.parentElement){const b=e.getBoundingClientRect();if(b.width||b.height){r=b;break}}}
      if(f.scroller){const c=f.scroller.getBoundingClientRect();if(r.top<c.top){r={top:c.top,height:0};clipped=true}else if(r.top>c.bottom){r={top:c.bottom-16,height:0};clipped=true}}
      items.push({id:t.id,top:Math.round(r.top+sy),height:Math.round(r.height||0),...(folded?{folded:true}:{}),...(clipped?{clipped:true}:{})});
    }
    orphans=missing;
    const message={type:'comment-positions',scrollY:Math.round(sy),viewport:{width:innerWidth,height:innerHeight},docHeight:Math.round(Math.max(root.scrollHeight,document.body?document.body.scrollHeight:0)),items,orphans:missing};
    const key=JSON.stringify(message);if(key!==lastKey){lastKey=key;send(message)}
  };
  window.addEventListener('scroll',()=>{if(posted){posted=false;send({type:'comment-target-clear'});settle(400)}if(!scrollRequest)scrollRequest=requestAnimationFrame(()=>{scrollRequest=0;send({type:'comment-scroll',scrollY:Math.round(scrollY)})});schedule()},{passive:true});
  document.addEventListener('scroll',event=>{if(event.target===document||event.target===root)return;if(posted){posted=false;send({type:'comment-target-clear'});settle(400)}if(threads.length)requestAnimationFrame(measure);schedule()},{capture:true,passive:true});
  window.addEventListener('resize',()=>{
    if(keep&&performance.now()-keep.at<1500&&keep.el.isConnected){const delta=keep.el.getBoundingClientRect().top-keep.top;if(Math.abs(delta)>1)window.scrollBy(0,delta)}
    if(threads.length)requestAnimationFrame(measure);schedule();
  });
  // Hit testing on pointer events only (§12 A7): the caret position under the pointer, then the passage rectangles.
  const caretAt=(x,y)=>{try{if(document.caretPositionFromPoint){const p=document.caretPositionFromPoint(x,y);return p?{node:p.offsetNode,offset:p.offset}:null}if(document.caretRangeFromPoint){const r=document.caretRangeFromPoint(x,y);return r?{node:r.startContainer,offset:r.startOffset}:null}}catch{}return null};
  const threadAt=(x,y)=>{
    if(!threads.length)return null;const caret=caretAt(x,y);if(!caret)return null;let best=null,size=Infinity;
    for(let i=threads.length-1;i>=0;i--){const t=threads[i],f=found.get(t.id);if(!f)continue;let inside=false;try{inside=f.range.isPointInRange(caret.node,caret.offset)}catch{}if(!inside||!within(f.range,x,y))continue;const length=t.anchor.quote.length;if(length<size){size=length;best=t.id}}
    return best;
  };
  let hoverFrame=0,lastPoint=null;
  window.addEventListener('pointermove',event=>{
    if(mouseDown&&event.buttons===0)release();
    if(event.pointerType!=='mouse'||!threads.length)return;lastPoint={x:event.clientX,y:event.clientY};
    if(hoverFrame)return;hoverFrame=requestAnimationFrame(()=>{hoverFrame=0;const id=lastPoint?threadAt(lastPoint.x,lastPoint.y):null;if(id!==hover){hover=id;paint();send({type:'comment-highlight-hover',id})}});
  },true);
  document.addEventListener('pointerleave',()=>{if(hover!==null){hover=null;paint();send({type:'comment-highlight-hover',id:null})}});
  // A click on a highlight opens its thread; a click anywhere else in the page lets the shell deactivate the open card.
  window.addEventListener('click',event=>{
    if(!event.isTrusted||event.button!==0||!threads.length)return;
    const selection=getSelection();if(selection&&!selection.isCollapsed&&selection.toString().trim())return;
    const target=elementOf(event.target),id=target&&target.closest(NATIVE)?null:threadAt(event.clientX,event.clientY);
    send(id?{type:'comment-highlight-click',id}:{type:'comment-page-click'});
  });
  // Reading the page counts as activity for the shell's polling (at most one message per 20 s).
  let activityAt=-1e9;
  const noteActivity=()=>{const now=performance.now();if(now-activityAt>20000){activityAt=now;send({type:'comment-activity'})}};
  for(const type of ['pointerdown','keydown','wheel','touchstart'])window.addEventListener(type,noteActivity,{capture:true,passive:true});
  const reveal=id=>{
    const f=found.get(id);if(!f)return;
    const el=elementOf(f.range.startContainer);if(el)el.scrollIntoView({block:'center',inline:'nearest'});
    active=id;paint();requestAnimationFrame(measure);
  };
  let watching=false,anchored=[];
  const watcher=new MutationObserver(records=>{
    if(!threads.length||records.every(record=>record.target===host||host&&host.contains(record.target)))return;
    // Changes outside every anchored element (a live clock, a chart) re-check only missing passages, at most every 2 s.
    const relevant=records.some(record=>anchored.some(el=>el===record.target||el.contains(record.target)||record.target.contains&&record.target.contains(el)));
    if(relevant){if(mutationTimer)return;mutationTimer=setTimeout(()=>{mutationTimer=0;reanchor(false)},Math.max(0,500-(performance.now()-lastAnchor)));return}
    if(orphans.length&&!orphanTimer)orphanTimer=setTimeout(()=>{orphanTimer=0;lastOrphanPass=performance.now();reanchor(true)},Math.max(500,2000-(performance.now()-lastOrphanPass)));
    else if(!mutationTimer)mutationTimer=setTimeout(()=>{mutationTimer=0;measure()},500);
  });
  const valid=t=>t&&typeof t.id==='string'&&t.id.length<=200&&['open','resolved','pending','private'].includes(t.state)&&t.anchor&&typeof t.anchor==='object'&&typeof t.anchor.quote==='string'&&t.anchor.quote.length>0&&t.anchor.quote.length<=1000&&(t.anchor.selector===undefined||typeof t.anchor.selector==='string'&&t.anchor.selector.length<=500);
  const render=list=>{
    threads=list;
    for(const id of Array.from(found.keys()))if(!threads.some(t=>t.id===id))found.delete(id);
    anchored=[];
    for(const t of threads){if(t.anchor.selector&&SELECTOR.test(t.anchor.selector)){try{const el=document.querySelector(t.anchor.selector);if(el)anchored.push(el)}catch{}}else if(document.body)anchored.push(document.body)}
    if(!watching&&threads.length){watching=true;watcher.observe(root,{childList:true,subtree:true,characterData:true})}
    reanchor(false);
  };
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==parent||!m||m.channel!==CHANNEL||m.releaseId!==initial.releaseId||m.sessionId!==initial.sessionId)return;
    if(m.type==='comment-highlights'&&Array.isArray(m.threads))render(m.threads.slice(0,200).filter(valid));
    else if(m.type==='comment-emphasis'){const h=typeof m.hover==='string'?m.hover:null,a=typeof m.active==='string'?m.active:null;if(h!==hover||a!==active){hover=h;active=a;paint()}}
    else if(m.type==='comment-reveal'&&typeof m.id==='string')reveal(m.id);
    // The wheel over the rail scrolls the page, as in Google Docs; the shell also uses it to lift a passage above its sheet.
    else if(m.type==='comment-scroll-by'&&typeof m.dy==='number'&&Number.isFinite(m.dy)&&Math.abs(m.dy)<1e6)window.scrollBy(0,m.dy);
    else if(m.type==='comment-pointer-up')release();
    // The shell closed its composer: after a send the selection goes (the passage is highlighted now); after a cancel it
    // stays, but scrolling or a click no longer offers 「评论」 for it until the selection changes.
    else if(m.type==='comment-target-done'){clearTimeout(idle);posted=false;if(m.clear===true){if(validRange())getSelection().removeAllRanges()}else quiet=signature(getSelection())}
    else if(m.type==='comment-keep-position'){const el=document.elementFromPoint(Math.round(innerWidth/2),Math.min(innerHeight-1,40));if(el&&el!==root&&el!==document.body)keep={el,top:el.getBoundingClientRect().top,at:performance.now()};else keep=null}
  });
  // Images and fonts move passages without DOM changes: re-measure when the body's size changes.
  let sizeTimer=0;
  const resized=()=>{if(!threads.length||sizeTimer)return;sizeTimer=setTimeout(()=>{sizeTimer=0;measure()},150)};
  const ready=()=>{
    send({type:'comment-runtime-ready',off:off(),highlights});
    if(window.ResizeObserver&&document.body)new ResizeObserver(resized).observe(document.body);
    if(document.fonts&&document.fonts.ready)document.fonts.ready.then(resized,()=>undefined);
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
  })();`;

export const PUBLIC_COMMENTS_SHELL = String.raw`
  ;(()=>{
  const settings=config.comments,apiBase=settings.apiBase,appKey=settings.appKey,CHANNEL='paseo-board-release-v1';
  // Threads belong to the share's stable page: this release's version archive <stable>/v/<its own hex>/ (GitHub Pages
  // series) and an explicit index.html show the stable page's discussion. Only the release's own hex is stripped.
  const preview=location.origin==='null',pagePath=(()=>{const path=location.pathname.replace(/\/index\.html$/,'/'),archive='/v/'+String(config.releaseId).slice(8)+'/';return path.length>archive.length&&path.endsWith(archive)?path.slice(0,path.length-archive.length+1):path})();
  const pageUrl=location.origin+pagePath,pageKey=pageUrl;
  const sha256=${SHA256_JS};
  const layout=${RAIL_LAYOUT_JS};
  const visitorKey='paseo-board-visitor:v2:'+appKey,publicKey='paseo-board-public:v1:'+appKey,hintKey='paseo-board-comments-hint:v1',railKey='paseo-board-comments-rail:v1';
  const cachePrefix='paseo-board-comments:p1:'+appKey+':',cacheKey=cachePrefix+pageKey,pageHash=sha256(pageKey).slice(0,16);
  const TEXT={
    sending:'发送中…',sent:'已发送',unconfirmed:'没有确认送达，评论已保留。',network:'浏览器或网络阻止了连接到评论服务（可能需要允许访问本地网络，或只能在公司网络内评论）。',
    busy:'评论服务繁忙，稍后自动重试。',poll:'暂时连接不上评论服务，稍后自动重试。',unavailable:'评论服务暂时不可用（地址指向了其他服务，或后端版本过旧）。',
    preview:'预览不连接评论后端，发布后才能看到和发送评论。',storage:'浏览器不允许本地存储：关闭页面后这个浏览器不再把你的评论标为「我」。',
    note:'公开评论：打开这个页面的人都能看到你的评论和称呼（不填称呼时显示匿名编号）。发送后可以撤回，但已经看到的人可能保留了副本。作者和作者的 AI 助手也会收到。',
    keys:'⌘/Ctrl + Enter 发送 · Esc 收起（保留草稿）',shift:'Shift + 右键：浏览器菜单',
    empty:'还没有评论。选中页面上的文字即可评论。',noneOpen:'没有未解决的评论。',orphans:'原文已修改',orphanHelp:'页面改版后找不到这些评论引用的文字。',
    resolved:'已解决',resolvedNote:'作者已把这条讨论标为已解决。',me:'我',owner:'作者',agent:'作者的 AI 助手',fresh:'新',updating:'正在更新…',privateOnly:'仅你和作者可见',
    replyNote:'回复会公开显示。',full:'这条讨论的回复已满。',threadResolved:'作者已把这条讨论标为已解决，不能再回复。',gone:'这条讨论已不存在或已被作者隐藏。',
    disabled:'评论服务关闭了公开评论。',paused:'作者暂停了新的公开评论。',
    forget:'清除后，这个浏览器不再把之前的评论标为「我」，之后发送会显示为新的匿名编号。已经公开的评论不会删除。确定清除？',
    withdraw:'撤回后，其他人不会再看到这条评论；已经看到的人可能保留了副本。确定撤回？',withdrawn:'已撤回。',anonymous:'匿名访客（发送后显示编号）',
    badName:'称呼里不能有「作者」「AI 助手」「访客」这些字样，也不能有看不见的格式字符。',refused:'评论没有发送：内容不符合评论服务的要求。',
    resolvedDraft:'你还没发送的回复（这条讨论已解决，不能再回复）：',resolvedWhileTyping:'作者刚把这条讨论标为已解决，你的回复没有发送；草稿还留在卡片里。',dropDraft:'删除草稿',
  };
  const store=kind=>{try{const s=window[kind];s.getItem(hintKey);return s}catch{return null}};
  const local=preview?null:store('localStorage'),session=preview?null:store('sessionStorage');
  let storageNotice=!preview&&(!local||!session);
  const readJson=(s,key,max)=>{try{const raw=s&&s.getItem(key);if(!raw||raw.length>max)return null;const value=JSON.parse(raw);return value&&typeof value==='object'&&!Array.isArray(value)?value:null}catch{return null}};
  const counts=(value,keyPattern,limit)=>{const out={};if(value&&typeof value==='object'&&!Array.isArray(value))for(const [k,v] of Object.entries(value).slice(-limit))if(keyPattern.test(k)&&Number.isSafeInteger(v)&&v>=0)out[k]=v;return out};
  const bump=(map,key,value,limit)=>{delete map[key];if(value!==undefined)map[key]=value;const keys=Object.keys(map);for(const k of keys.slice(0,Math.max(0,keys.length-limit)))delete map[k]};
  // The secret is shared with private pages of this app (same key and shape); public-only data has its own key.
  const shared=()=>readJson(local,visitorKey,65536)||{};
  let secret=/^[a-f0-9]{64}$/.test(shared().secret)?shared().secret:'';
  const storedPublic=readJson(local,publicKey,65536)||{};
  const mine={name:typeof storedPublic.name==='string'?storedPublic.name.slice(0,80):'',tags:{},seen:counts(storedPublic.seen,/^.{1,200}$/s,300)};
  if(storedPublic.tags&&typeof storedPublic.tags==='object')for(const [k,v] of Object.entries(storedPublic.tags).slice(-100))if(/^[a-f0-9]{16}$/.test(k)&&/^[a-f0-9]{12}$/.test(v))mine.tags[k]=v;
  const myTag=()=>mine.tags[pageHash]||'';
  const savePublic=()=>{try{if(local)local.setItem(publicKey,JSON.stringify(mine))}catch{}};
  const saveSecret=()=>{try{if(!local)return;const current=shared();current.secret=secret;if(typeof current.name!=='string')current.name='';if(!current.seen||typeof current.seen!=='object')current.seen={};if(!current.pages||typeof current.pages!=='object')current.pages={};local.setItem(visitorKey,JSON.stringify({secret:current.secret,name:current.name,seen:current.seen,pages:current.pages}))}catch{}};
  const privatePages=()=>{const p=shared().pages;return p&&typeof p==='object'&&Number.isSafeInteger(p[pageHash])?p[pageHash]:0};
  const hex=n=>Array.from(crypto.getRandomValues(new Uint8Array(n)),b=>b.toString(16).padStart(2,'0')).join('');
  const uuid=()=>{try{if(crypto.randomUUID)return crypto.randomUUID()}catch{}const h=hex(16);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-'+(8|parseInt(h[16],16)&3).toString(16)+h.slice(17,20)+'-'+h.slice(20,32)};
  // Everything visitors wrote is text; bidi, zero-width and other invisible format characters are shown as markers.
  const INVISIBLE=new RegExp(${JSON.stringify(INVISIBLE_SOURCE)},'g');
  const shown=text=>String(text).replace(INVISIBLE,run=>Array.from(run,c=>'[U+'+c.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')+']').join(''));
  // The backend's public name rule (backend/threads.mjs forbiddenPublicName), checked before anything is sent or saved.
  const badName=name=>Boolean(name)&&(/\p{Cf}/u.test(name)||/作者|ai助手|访客|訪客/.test(name.normalize('NFKC').replace(/[\s\p{Z}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Mn}]/gu,'').toLowerCase().replace(/[аαɑ⍺]/gu,'a').replace(/[іιɩӏǀı1l|!¡]/gu,'i')));
  const clip=(text,max)=>{const t=shown(text).replace(/\s+/g,' ').trim();return t.length>max?t.slice(0,max)+'…':t};
  const when=value=>{const time=Date.parse(value);if(Number.isNaN(time))return'';try{return new Date(time).toLocaleString([],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}catch{return new Date(time).toLocaleString()}};
  // Validation of everything the backend or the cache returns: unknown keys are dropped, never rendered.
  const ID=/^[\x21-\x7e]{1,200}$/,TAG=/^[a-f0-9]{12}$/;
  const str=(v,max)=>typeof v==='string'&&v.length<=max;
  const cleanAnchor=a=>{
    if(!a||typeof a!=='object'||Array.isArray(a)||!str(a.quote,1000)||!a.quote)return null;
    const out={quote:a.quote};for(const [k,max] of [['selector',500],['prefix',64],['suffix',64]])if(str(a[k],max))out[k]=a[k];
    const int=v=>Number.isSafeInteger(v)&&v>=0&&v<=10000000;if(int(a.start)&&int(a.end)&&a.start<a.end&&a.end-a.start===a.quote.length){out.start=a.start;out.end=a.end}
    return out;
  };
  const cleanMessage=m=>{
    if(!m||typeof m!=='object'||!ID.test(m.id)||!['visitor','owner','agent'].includes(m.by)||!str(m.text,8000)||!str(m.createdAt,40))return null;
    const out={id:m.id,by:m.by,text:m.text,createdAt:m.createdAt};
    if(m.by==='visitor'){if(!TAG.test(m.tag))return null;out.tag=m.tag;if(str(m.name,160)&&m.name.trim())out.name=m.name.trim()}
    else if(ID.test(m.replyTo||''))out.replyTo=m.replyTo;
    return out;
  };
  const cleanThread=t=>{
    const root=cleanMessage(t);if(!root||root.by!=='visitor')return null;
    const anchor=cleanAnchor(t.anchor);if(!anchor)return null;
    return{...root,resolved:t.resolved===true,anchor,replies:Array.isArray(t.replies)?t.replies.slice(0,60).map(cleanMessage).filter(Boolean):[],omitted:Number.isSafeInteger(t.omitted)&&t.omitted>0?t.omitted:0};
  };
  const cleanListing=body=>{
    if(!body||typeof body!=='object'||body.format!==1||!Array.isArray(body.threads))throw new Error('Invalid response');
    if(body.appKey!==appKey)return null;
    return{threads:body.threads.slice(0,200).map(cleanThread).filter(Boolean),total:Number.isSafeInteger(body.total)?body.total:0,truncated:body.truncated===true,paused:body.paused===true};
  };
  const cleanPrivate=t=>{
    if(!t||typeof t!=='object'||!ID.test(t.id)||!str(t.text,8000)||t.visibility==='public')return null;
    const anchor=cleanAnchor(t.anchor);if(!anchor)return null;
    const replies=Array.isArray(t.replies)?t.replies.slice(0,20).filter(r=>r&&ID.test(r.id)&&str(r.text,8000)&&(r.authorKind==='owner'||r.authorKind==='agent')).map(r=>({id:r.id,by:r.authorKind,text:r.text,createdAt:str(r.createdAt,40)?r.createdAt:''})):[];
    return{id:'mine:'+t.id,by:'visitor',tag:'',text:t.text,createdAt:str(t.createdAt,40)?t.createdAt:'',anchor,replies,omitted:0,resolved:false,private:true};
  };
  const cleanPending=p=>p&&typeof p==='object'&&/^p[cr]-[A-Za-z0-9._:-]{8,128}$/.test(p.key)&&p.payload&&typeof p.payload.text==='string'&&p.payload.text.length<=2000?{key:p.key,payload:p.payload,at:str(p.at,40)?p.at:'',draft:str(p.draft,400)?p.draft:''}:null;
  // The session cache renders at once, marked 正在更新… until the first poll; it is dropped after 30 s without one (§12 A23).
  const cached=readJson(session,cacheKey,262144)||{};
  let listing=null,etag='',stale=false;
  try{if(cached.listing&&typeof cached.etag==='string'&&cached.etag.length<=100){listing=cleanListing(cached.listing);if(listing){etag=cached.etag;stale=true}}}catch{listing=null}
  let pending=Array.isArray(cached.pending)?cached.pending.slice(0,5).map(cleanPending).filter(Boolean):[];
  let drafts=cached.drafts&&typeof cached.drafts==='object'&&!Array.isArray(cached.drafts)?Object.fromEntries(Object.entries(cached.drafts).filter(([k,v])=>k.length<=400&&typeof v==='string'&&v.length<=2000).slice(-8)):{};
  let rawListing=stale?cached.listing:null;
  const saveCache=()=>{if(!session)return;try{let raw=JSON.stringify({etag,listing:rawListing,pending,drafts});if(raw.length>262144)raw=JSON.stringify({etag:'',listing:null,pending,drafts});session.setItem(cacheKey,raw)}catch{}};
  // scrollTop: the page's scroll; extra: how far the rail scrolled past the page's top or end to show cards that do not fit.
  let privateThreads=[],orphans=new Set(),positions=new Map(),scrollTop=0,extra=0,railRange={min:0,max:0},docHeight=0,frameHeight=innerHeight,frameReady=false,frameOff=false,highlighted='';
  let health=null,healthCheck=null,timer=0,lastPoll=-1e9,failures=0,notBefore=0,inFlight=false,problem='',loaded=false,lastInput=performance.now(),polls=0,firstPollAt=performance.now();
  let target=null,composer=null,toastTimer=0,filter='open',active=null,hover=null,focusId=null,expandedGroups=new Set(),forgetAsk=false,orphanOpen=false,newIds=new Set(),knownIds=null,announced='';
  const replies=new Map();
  // UI: a fixed layer in the outer page; all visitor and owner text uses textContent.
  const css='.pbc,.pbc *{box-sizing:border-box;margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;letter-spacing:0;color:inherit}'+
    '.pbc{position:fixed;z-index:2147483000;color:#1d1d1f;-webkit-text-size-adjust:100%}.pbc[hidden],.pbc [hidden]{display:none!important}'+
    '.pbc button{cursor:pointer;-webkit-tap-highlight-color:transparent}.pbc :focus-visible{outline:2px solid #2f6feb;outline-offset:2px}'+
    'html[data-pbc-rail=docked] iframe{width:calc(100% - 336px)!important}html[data-pbc-rail=docked] aside[data-live]{right:344px}'+
    '.pbc-float{left:0;top:0;transform-origin:0 0;padding:6px 14px;border:0;border-radius:999px;background:#1d1d1f;color:#fff;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.25)}'+
    '.pbc-box{background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.2)}'+
    '.pbc-composer{left:0;top:0;width:min(380px,calc(100vw - 16px));padding:12px;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 16px);overflow:auto}'+
    '.pbc-composer.pbc-sheetc{left:0;right:0;top:auto;width:auto;border-radius:14px 14px 0 0;padding-bottom:max(12px,env(safe-area-inset-bottom))}'+
    '.pbc-quote{padding:4px 8px;border-left:3px solid #e6aa00;background:#fff8dc;border-radius:4px;color:#3a3a3c;max-height:4.4em;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}'+
    '.pbc input,.pbc textarea{display:block;width:100%;padding:8px 10px;border:1px solid #c7c7cc;border-radius:8px;background:#fff;color:#1d1d1f;font-size:16px}'+
    '.pbc textarea{min-height:72px;max-height:40vh;resize:vertical}.pbc-small{font-size:12px;color:#6e6e73}'+
    '.pbc-small[data-tone=error]{color:#b42318}.pbc-status{font-size:13px;color:#b42318;white-space:pre-wrap}.pbc-status[data-tone=info]{color:#3a3a3c}.pbc-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}'+
    '.pbc-btn{padding:5px 12px;border-radius:8px;border:1px solid #c7c7cc;background:#fff;font-weight:500}.pbc-btn:disabled,.pbc-btn[aria-disabled=true]{opacity:.45;cursor:default}'+
    '.pbc-primary{background:#2f6feb;border-color:#2f6feb;color:#fff}.pbc-link{padding:2px 0;border:0;background:none;color:#2f6feb;font-size:13px}'+
    '.pbc-toggle{left:12px;bottom:12px;padding:7px 14px;border-radius:999px;border:1px solid rgba(0,0,0,.14);background:#fff;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.16)}'+
    '.pbc-dot{display:inline-block;width:8px;height:8px;margin-left:6px;border-radius:4px;background:#f59e0b;vertical-align:middle}'+
    '.pbc-rail{top:0;right:0;bottom:0;width:336px;display:flex;flex-direction:column;background:#f7f7f8;border-left:1px solid rgba(0,0,0,.1)}'+
    '.pbc-rail[data-mode=overlay]{width:min(360px,calc(100vw - 48px));box-shadow:-12px 0 40px rgba(0,0,0,.18)}'+
    '.pbc-rail[data-mode=sheet]{top:auto;left:0;width:auto;max-height:75vh;border-left:0;border-radius:14px 14px 0 0;box-shadow:0 -12px 40px rgba(0,0,0,.2);padding-bottom:env(safe-area-inset-bottom)}'+
    '.pbc-head{flex:none;min-height:44px;display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid rgba(0,0,0,.08);background:inherit;position:relative;z-index:2;flex-wrap:wrap}'+
    '.pbc-title{font-weight:700;margin-right:auto}.pbc-seg{display:inline-flex;border:1px solid #c7c7cc;border-radius:8px;overflow:hidden}.pbc-seg button{border:0;background:#fff;padding:3px 8px;font-size:12px}.pbc-seg button[aria-pressed=true]{background:#1d1d1f;color:#fff}'+
    '.pbc-icon{border:0;background:none;padding:3px 6px;font-size:12px;color:#2f6feb}'+
    '.pbc-body{flex:1;position:relative;overflow:hidden;overflow:clip}.pbc-body[data-list]{overflow:auto;padding:8px 10px}'+
    '.pbc-column{position:absolute;left:0;right:0;top:0;will-change:transform}'+
    '.pbc-card{position:absolute;left:12px;right:12px;padding:9px 11px;background:#fff;border:1px solid rgba(0,0,0,.1);border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);display:flex;flex-direction:column;gap:6px;cursor:default}'+
    '.pbc-body[data-list] .pbc-card,.pbc-orphans .pbc-card{position:relative;left:0;right:0;top:auto!important;margin-bottom:8px}'+
    '.pbc-rail[data-animate] .pbc-column .pbc-card{transition:top .15s ease}@media (prefers-reduced-motion:reduce){.pbc-rail[data-animate] .pbc-column .pbc-card{transition:none}}'+
    '.pbc-card[data-hover]{border-color:#e6aa00}.pbc-card[data-active]{border-color:#e6aa00;box-shadow:0 4px 18px rgba(0,0,0,.16);z-index:1;overflow:auto}'+
    '.pbc-card[data-resolved]{background:#fbfbfb}.pbc-card[data-private]{border-left:3px solid #2f6feb}.pbc-card[data-stale]{opacity:.7}'+
    '.pbc-meta{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;font-size:12px;color:#6e6e73}.pbc-who{font-weight:600;color:#1d1d1f}.pbc-tag{color:#6e6e73}'+
    '.pbc-swatch{display:inline-block;width:8px;height:8px;border-radius:4px}'+
    '.pbc-chip{display:inline-block;padding:0 6px;border-radius:6px;font-size:11px;line-height:18px;background:#ececf0;color:#3a3a3c}.pbc-chip[data-kind=me]{background:#e3ecff;color:#1d4fbf}.pbc-chip[data-kind=owner]{background:#1d1d1f;color:#fff}.pbc-chip[data-kind=agent]{background:#5b3cc4;color:#fff}.pbc-chip[data-kind=new]{background:#fff1d6;color:#8a5300}.pbc-chip[data-kind=resolved]{background:#e5f4ea;color:#1e6b3a}'+
    '.pbc-card .pbc-link{align-self:flex-start}.pbc-text{white-space:pre-wrap;overflow-wrap:anywhere}.pbc-clamp{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}'+
    '.pbc-msg{display:flex;flex-direction:column;gap:2px}.pbc-msg+.pbc-msg{padding-top:6px;border-top:1px solid #f0f0f2}.pbc-msg[data-by=owner],.pbc-msg[data-by=agent]{padding-left:8px;border-left:2px solid #d8d8e0}.pbc-msg[data-by=agent]{border-left-color:#b9a8f0}'+
    '.pbc-foot{flex:none;padding:6px 10px 10px;border-top:1px solid rgba(0,0,0,.08);display:flex;flex-direction:column;gap:6px;max-height:45%;overflow:auto}'+
    '.pbc-toast{left:12px;bottom:58px;padding:6px 12px;border-radius:8px;background:#1d1d1f;color:#fff}.pbc-hint{left:12px;bottom:12px;padding:6px 8px 6px 12px;border-radius:999px;display:flex;gap:8px;align-items:center;background:#fff;border:1px solid rgba(0,0,0,.14);box-shadow:0 4px 16px rgba(0,0,0,.14)}.pbc-hint[data-raised]{bottom:58px}'+
    '.pbc-live{position:fixed;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);left:0;top:0}'+
    '';
  // Dark styles follow the page sheet (the release theme), not the system setting: the rail matches the page beside it.
  const DARK='.pbc{color:#f2f2f7}.pbc-rail{background:#18181b;border-color:#333}.pbc-box,.pbc-card,.pbc-toggle,.pbc-hint,.pbc input,.pbc textarea,.pbc-btn,.pbc-seg button{background:#1f1f22;color:#f2f2f7;border-color:#3a3a3f}.pbc-who{color:#f2f2f7}.pbc-card[data-resolved]{background:#1b1b1e}.pbc-quote{background:#2d2a1e;color:#e8e2cf}.pbc-small,.pbc-meta,.pbc-tag{color:#a1a1a6}.pbc-primary{background:#3b7bf0;border-color:#3b7bf0;color:#fff}.pbc-seg button[aria-pressed=true]{background:#f2f2f7;color:#1d1d1f}.pbc-float,.pbc-toast{background:#f2f2f7;color:#1d1d1f}.pbc-link,.pbc-icon{color:#6ea0ff}.pbc-status{color:#ff8a80}.pbc-status[data-tone=info]{color:#d8d8dc}';
  const scoped=DARK.replace(/(^|\})([^{}]+)\{/g,(match,close,selectors)=>close+selectors.split(',').map(item=>'html[data-pbc-scheme=dark] '+item.trim()).join(',')+'{');
  const darkPage=(()=>{try{const m=/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(document.body).backgroundColor);if(!m||m[4]==='0')return Boolean(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches);return(0.2126*m[1]+0.7152*m[2]+0.0722*m[3])/255<0.45}catch{return false}})();
  if(darkPage)document.documentElement.setAttribute('data-pbc-scheme','dark');
  const el=(tag,props,children)=>{const node=document.createElement(tag);for(const [k,v] of Object.entries(props||{})){if(k==='text')node.textContent=v;else if(k==='class')node.className=v;else if(k==='on')for(const [type,fn] of Object.entries(v))node.addEventListener(type,fn);else if(v!==undefined&&v!==false&&v!==null)node.setAttribute(k,v===true?'':v)}for(const child of children||[])if(child)node.append(child);return node};
  const trusted=event=>Boolean(event&&event.isTrusted);
  const userActive=()=>Boolean(navigator.userActivation&&navigator.userActivation.isActive);
  document.head.appendChild(el('style',{text:css+scoped}));
  const coarse=Boolean(window.matchMedia&&matchMedia('(pointer: coarse)').matches);
  const railPref=()=>{try{return local&&local.getItem(railKey)==='closed'?'closed':'open'}catch{return'open'}};
  const pickMode=()=>innerWidth<600||innerHeight<500||coarse&&innerWidth<1056?'sheet':innerWidth>=1056&&railPref()!=='closed'?'docked':'overlay';
  // Decided before the first frame, so the page never reflows when comments arrive (§12 A6).
  let mode=preview?'overlay':pickMode(),railOpen=false;
  if(mode==='docked')document.documentElement.setAttribute('data-pbc-rail','docked');
  const layer=el('div',{'data-pbc-root':''});document.body.appendChild(layer);
  const toggle=el('button',{type:'button',class:'pbc pbc-toggle','data-pbc':'toggle','aria-controls':'pbc-rail','aria-expanded':'false',hidden:true});
  document.body.insertBefore(toggle,frame);
  const floatButton=el('button',{type:'button',class:'pbc pbc-float','data-pbc':'float','aria-label':'评论选中的文字',text:'评论',hidden:true});
  const toast=el('div',{class:'pbc pbc-toast','data-pbc':'toast',role:'status','aria-live':'polite',hidden:true});
  const hint=el('div',{class:'pbc pbc-hint','data-pbc':'hint',hidden:true});
  const live=el('div',{class:'pbc-live',role:'status','aria-live':'polite','data-pbc':'announce'});
  // A div, not an aside: the viewer styles every aside as its status banner.
  const rail=el('div',{class:'pbc pbc-rail',id:'pbc-rail','data-pbc':'rail',hidden:true});
  const head=el('div',{class:'pbc-head'}),status=el('div',{class:'pbc-status','data-pbc':'problem',hidden:true}),body=el('div',{class:'pbc-body','data-pbc':'body'}),column=el('div',{class:'pbc-column'}),list=el('div',{'data-pbc':'list'}),foot=el('div',{class:'pbc-foot'});
  const orphanBox=el('div',{class:'pbc-orphans','data-pbc':'orphans'});
  body.append(column,list);rail.append(head,status,body,foot);
  layer.append(floatButton,toast,hint,rail,live);
  const post=message=>{if(frameReady)frame.contentWindow.postMessage({...message,channel:CHANNEL,releaseId:config.releaseId,sessionId},'*')};
  const focusFrame=()=>{try{frame.focus()}catch{}};
  // Threads as the rail shows them: public threads, the visitor's private threads on this page, and unsent own comments.
  const pendingThreads=()=>pending.filter(p=>p.key.startsWith('pc-')).map(p=>({id:'pending:'+p.key,by:'visitor',tag:myTag(),...(p.payload.authorName?{name:p.payload.authorName}:{}),text:p.payload.text,createdAt:p.at,anchor:cleanAnchor(p.payload.anchor),replies:[],omitted:0,resolved:false,pendingKey:p.key})).filter(t=>t.anchor);
  const allThreads=()=>[...(listing?listing.threads:[]),...privateThreads,...pendingThreads()];
  // Under 未解决 a thread resolved while the reader was writing a reply in it stays open until it is closed, so they see
  // why the reply was not sent and can still copy their draft.
  const kept=new Set();
  const visibleThreads=()=>allThreads().filter(t=>filter==='all'||!t.resolved||t.id===active&&kept.has(t.id));
  const stateOf=t=>t.pendingKey?'pending':t.private?'private':t.resolved?'resolved':'open';
  const isMine=m=>m.by==='visitor'&&Boolean(myTag())&&m.tag===myTag();
  const involves=t=>isMine(t)||t.replies.some(isMine);
  const countOf=t=>1+t.replies.length+t.omitted;
  const unreadOf=t=>t.private||t.pendingKey||!involves(t)||mine.seen[t.id]===undefined?0:Math.max(0,countOf(t)-mine.seen[t.id]);
  const markSeen=t=>{if(t&&!t.pendingKey&&!t.private&&involves(t)){bump(mine.seen,t.id,countOf(t),300);savePublic()}newIds.delete(t&&t.id)};
  // The open card is being read: replies that arrive in it while the page is visible and the card is on screen are seen
  // where they appear; ones that arrive while it is scrolled away are seen when it comes back into view.
  const onScreen=id=>{const card=cards.get(id);if(!card||!card.node.isConnected)return false;const r=card.node.getBoundingClientRect(),b=body.getBoundingClientRect();return r.height>0&&r.bottom>b.top&&r.top<b.bottom};
  const openShown=()=>{
    if(!active||document.hidden||!railVisible())return null;
    const t=visibleThreads().find(x=>x.id===active);return t&&(!orphans.has(t.id)||orphanOpen||!aligned())&&onScreen(t.id)?t:null;
  };
  /** Marks the open card's new replies seen when it is read; true when that changed anything (the caller renders). */
  const seeOpen=()=>{const t=openShown();if(t&&(unreadOf(t)||newIds.has(t.id))){markSeen(t);return true}return false};
  const label=m=>{
    if(m.by==='owner')return{text:TEXT.owner,kind:'owner'};if(m.by==='agent')return{text:TEXT.agent,kind:'agent'};
    const tag=m.tag?'访客·'+m.tag.slice(0,6):'';return{text:m.name?shown(m.name)+(tag?' · '+tag:''):tag||TEXT.anonymous,kind:'visitor'};
  };
  const swatch=tag=>el('span',{class:'pbc-swatch','aria-hidden':'true',style:'background:hsl('+(parseInt(tag.slice(0,3),16)%360)+' 55% 45%)'});
  // Network: same fetch options as the private viewer; responses are read up to 2 MiB.
  const readBody=async response=>{
    if(!response.body)return'';const reader=response.body.getReader(),chunks=[];let bytes=0;
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2097152){await reader.cancel();throw new Error('Response too large')}chunks.push(value)}
    const buffer=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength}
    return new TextDecoder().decode(buffer);
  };
  const request=async(path,init)=>{
    const controller=new AbortController(),abort=setTimeout(()=>controller.abort(),10000);
    try{const response=await fetch(apiBase+path,{...init,mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal});const text=await readBody(response);let parsed=null;try{parsed=text?JSON.parse(text):null}catch{}return{status:response.status,headers:response.headers,body:parsed}}
    finally{clearTimeout(abort)}
  };
  const retryAfter=headers=>{const raw=headers.get('retry-after')||'';return /^\d{1,9}$/.test(raw)?Number(raw):0};
  const waitText=seconds=>seconds<=120?' '+seconds+' 秒':seconds<=5400?' '+Math.ceil(seconds/60)+' 分钟':'约 '+Math.ceil(seconds/3600)+' 小时';
  const codeOf=r=>r.body&&typeof r.body.code==='string'?r.body.code:'';
  /** Before the first POST when no listing has succeeded: the address must still serve this app's public threads. */
  const checkHealth=()=>{
    if(health!==null)return Promise.resolve(health);
    if(!healthCheck)healthCheck=(async()=>{
      try{const r=await request('/_board/health',{});if(r.status===200||r.status===404){health=r.status===200&&Boolean(r.body)&&r.body.appKey===appKey&&r.body.comments===2&&r.body.publicThreads===1;return health}throw new Error('HTTP '+r.status)}
      finally{healthCheck=null}
    })();
    return healthCheck;
  };
  const jitter=ms=>ms*(0.8+Math.random()*0.4);
  const backoff=()=>[20,40,80,160,300][Math.min(failures,5)-1]*1000;
  const interval=()=>performance.now()-lastInput>900000?60000:10000;
  const setProblem=text=>{if(problem!==text){problem=text;renderAll()}};
  const schedule=delay=>{
    clearTimeout(timer);timer=0;if(preview||frameOff||document.hidden)return;
    const now=performance.now();timer=setTimeout(poll,Math.max(delay,notBefore-now,0));
  };
  const listingPath=()=>'/_board/comments/public?page='+encodeURIComponent(pageUrl)+'&release='+encodeURIComponent(config.releaseId);
  const applyListing=(body,raw)=>{
    const next=cleanListing(body);
    if(!next){health=false;setProblem(TEXT.unavailable);return}
    const ids=new Set(next.threads.map(t=>t.id));
    if(knownIds)for(const id of ids)if(!knownIds.has(id))newIds.add(id);
    knownIds=ids;
    // Unread replies in threads I wrote, announced once per poll.
    const before=listing?listing.threads:[];listing=next;rawListing=raw;stale=false;loaded=true;health=true;
    for(const old of before){
      const now=next.threads.find(t=>t.id===old.id),state=replies.get(old.id),draft=(drafts['r:'+old.id]||'').trim();
      if(!old.resolved&&state&&state.open&&draft&&(!now||now.resolved)){state.open=false;state.version++;kept.add(old.id);showToast(now?TEXT.resolvedWhileTyping:TEXT.gone)}
    }
    if(active&&!allThreads().some(t=>t.id===active))active=null;
    seeOpen();
    const unread=next.threads.reduce((sum,t)=>sum+unreadOf(t),0),previous=before.reduce((sum,t)=>sum+unreadOf(t),0);
    if(unread>previous&&announced!==String(unread)){announced=String(unread);live.textContent='有 '+unread+' 条新回复'}
    for(const t of next.threads)if(involves(t)&&mine.seen[t.id]===undefined){bump(mine.seen,t.id,countOf(t),300)}
    savePublic();saveCache();
    renderAll();
  };
  const poll=async()=>{
    timer=0;if(inFlight||document.hidden||preview||frameOff)return;
    const now=performance.now();if(now<notBefore){schedule(0);return}
    inFlight=true;lastPoll=now;polls++;let delay=jitter(interval());
    try{
      const r=await request(listingPath(),{headers:etag?{'If-None-Match':etag}:{}});
      if(r.status===200){const tag=r.headers.get('etag')||'';etag=/^"[\x21-\x7e]{1,90}"$/.test(tag)?tag:'';applyListing(r.body,r.body);failures=0;setProblem(health===false?TEXT.unavailable:'')}
      else if(r.status===304){stale=false;loaded=true;health=true;failures=0;setProblem('')}
      else{
        failures++;const code=codeOf(r),wait=retryAfter(r.headers);
        setProblem(r.status===429?TEXT.busy:r.status===404&&code==='public_disabled'?TEXT.disabled:r.status===404?TEXT.unavailable:TEXT.poll);
        delay=r.status===429&&wait?Math.min(wait,600)*1000:backoff();notBefore=performance.now()+delay;
      }
      if(secret&&privatePages()>0&&(polls===1||polls%6===0))await pollMine();
    }catch(error){failures++;setProblem(error instanceof TypeError?TEXT.network:TEXT.poll);delay=backoff();notBefore=performance.now()+delay}
    finally{inFlight=false}
    if(stale&&performance.now()-firstPollAt>30000){listing=null;rawListing=null;stale=false;renderAll()}
    schedule(delay);
  };
  // The visitor's own private comments on this page (a page switched from private to public keeps them, §12 A12).
  const pollMine=async()=>{
    try{const r=await request('/_board/comments/mine?page='+encodeURIComponent(pageUrl),{headers:{'X-Board-Visitor':secret}});if(r.status===200&&r.body&&Array.isArray(r.body.threads)){privateThreads=r.body.threads.slice(0,30).map(cleanPrivate).filter(Boolean);renderAll()}}catch{}
  };
  const pollSoon=(minimum)=>{if(inFlight||preview)return;const since=performance.now()-lastPoll;schedule(Math.max(0,(minimum===undefined?3000:minimum)-since))};
  // Back on the page: the open card's replies that arrived while it was hidden are seen now.
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);timer=0}else{pollSoon();if(active)renderAll()}});
  window.addEventListener('focus',()=>pollSoon());
  // Input in this shell or in the page (the frame reports clicks, keys, wheels and scrolls) keeps the 10 s cadence.
  const noteInput=()=>{const idle=performance.now()-lastInput>900000;lastInput=performance.now();if(idle)pollSoon()};
  for(const type of ['pointerdown','keydown','wheel'])document.addEventListener(type,noteInput,{capture:true,passive:true});
  // Sending: frozen before the request, retried with the same key and payload (as the private viewer).
  const savePending=()=>{saveCache();renderAll()};
  const deliver=async item=>{
    try{
      if(!loaded&&!(await checkHealth()))return{error:TEXT.unavailable,keep:false,disable:true};
      const r=await request('/_board/comments',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':item.key,'X-Board-Visitor':secret},body:JSON.stringify(item.payload)});
      const c=r.body&&r.body.comment,code=codeOf(r);
      if((r.status===201||r.status===200)&&c&&typeof c.externalId==='string'&&c.text===item.payload.text){
        pending=pending.filter(p=>p!==item);
        if(TAG.test(c.tag||'')){mine.tags[pageHash]=c.tag;const keys=Object.keys(mine.tags);for(const k of keys.slice(0,Math.max(0,keys.length-100)))delete mine.tags[k];savePublic()}
        // Shown at once; the immediate poll brings the stored version.
        if(listing){
          const message={id:c.externalId,by:'visitor',tag:c.tag,...(c.authorName?{name:c.authorName}:{}),text:c.text,createdAt:c.createdAt};
          if(item.payload.parentId){const t=listing.threads.find(x=>x.id===item.payload.parentId);if(t&&!t.replies.some(m=>m.id===message.id))t.replies.push(message)}
          else if(!listing.threads.some(t=>t.id===message.id)){const thread=cleanThread({...message,anchor:item.payload.anchor,replies:[],resolved:false,omitted:0});if(thread){listing.threads.unshift(thread);if(knownIds)knownIds.add(thread.id)}}
        }
        failures=0;notBefore=0;problem='';saveCache();
        if(!item.payload.parentId)active=c.externalId;
        renderAll();pollSoon(1000);return{ok:true,id:c.externalId};
      }
      if(r.status===429)return{error:'发送太频繁，请'+waitText(retryAfter(r.headers)||60)+'后再试。',keep:true};
      if(r.status===409&&code==='thread_full')return{error:TEXT.full,keep:false,gone:false};
      if(r.status===409&&code==='thread_resolved')return{error:TEXT.threadResolved,keep:false,gone:true};
      if(r.status===404&&code==='comment_not_found')return{error:TEXT.gone,keep:false,gone:true};
      if(r.status===403&&code==='public_paused')return{error:TEXT.paused,keep:false};
      if(r.status===403||r.status===404&&code==='public_disabled')return{error:TEXT.disabled,keep:false};
      if(r.status===400&&code==='name_not_allowed')return{error:TEXT.badName,keep:false,badName:true};
      if(r.status===400)return{error:TEXT.refused,keep:false};
      if(r.status>=500&&r.status!==507)return{error:TEXT.unconfirmed,keep:true,retry:true};
      return{error:'评论没有发送（HTTP '+r.status+'）。',keep:false};
    }catch(error){return{error:(error instanceof TypeError?TEXT.network+'\n':'')+TEXT.unconfirmed,keep:true,retry:true}}
  };
  const ensureSecret=()=>{if(!secret){secret=hex(32);saveSecret()}};
  const nameOf=raw=>raw.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,80);
  const showToast=text=>{toast.textContent=text;toast.hidden=false;toast.style.bottom=toggle.hidden?'12px':'58px';clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.hidden=true},2500)};
  const identityLine=name=>name?'将公开显示为：'+shown(name)+(myTag()?' · 访客·'+myTag().slice(0,6):'（后面会加上匿名编号）'):myTag()?'将公开显示为：访客·'+myTag().slice(0,6):'将公开显示为：'+TEXT.anonymous;
  // Composer for a new public comment: next to the selection, or a bottom sheet on narrow screens.
  const viewport=()=>window.visualViewport||{offsetLeft:0,offsetTop:0,width:innerWidth,height:innerHeight,scale:1};
  const clamp=(value,low,high)=>Math.min(Math.max(value,low),Math.max(low,high));
  const outer=rect=>{const f=frame.getBoundingClientRect();return{left:f.left+rect.x,top:f.top+rect.y,right:f.left+rect.x+rect.width,bottom:f.top+rect.y+rect.height}};
  const draftKey=a=>(a.selector||'')+'|'+(a.start===undefined?'':a.start)+'|'+a.quote.slice(0,200);
  const saveDraft=(key,text)=>{delete drafts[key];if(text.trim())drafts[key]=text.slice(0,2000);const keys=Object.keys(drafts);for(const k of keys.slice(0,Math.max(0,keys.length-8)))delete drafts[k];saveCache()};
  const focusables=root=>Array.from(root.querySelectorAll('button,input,textarea,[tabindex="0"]')).filter(n=>!n.disabled&&!n.hidden&&n.offsetParent!==null);
  const trap=(root,event)=>{if(event.key!=='Tab')return;const items=focusables(root);if(!items.length)return;const first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}};
  const placeComposer=()=>{
    if(!composer)return;const node=composer.node,v=viewport();
    if(innerWidth<600||innerHeight<500){node.classList.add('pbc-sheetc');node.style.transform='';node.style.bottom=Math.max(0,innerHeight-(v.offsetTop+v.height))+'px';return}
    node.classList.remove('pbc-sheetc');node.style.bottom='';
    const r=outer(composer.target.bounds||composer.target.rect),w=node.offsetWidth||380,h=node.offsetHeight||280,right=mode==='docked'?innerWidth-336:innerWidth;
    let x=r.left,y=r.bottom+10;if(y+h>v.offsetTop+v.height-8&&r.top-h-10>=v.offsetTop+8)y=r.top-h-10;
    x=clamp(x,v.offsetLeft+8,Math.min(v.offsetLeft+v.width,right)-w-8);y=clamp(y,v.offsetTop+8,v.offsetTop+v.height-h-8);
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
  const showFloat=t=>{if(composer)return;target=t;floatButton.hidden=false;placeFloat()};
  const hideFloat=()=>{floatButton.hidden=true;target=null};
  floatButton.addEventListener('click',event=>{if(trusted(event)&&target)openComposer(target,'select')});
  const blocked=()=>preview||health===false||Boolean(listing&&listing.paused);
  const updateComposer=()=>{
    if(!composer)return;const c=composer,stop=blocked();
    const bad=!c.item&&badName(nameOf(c.name.value));
    c.send.disabled=stop||bad;c.send.setAttribute('aria-disabled',stop||bad||c.busy?'true':'false');c.send.textContent=c.busy?TEXT.sending:c.retry?'重试':'发送';
    c.cancel.setAttribute('aria-disabled',c.busy?'true':'false');c.textarea.readOnly=Boolean(c.item);c.name.readOnly=Boolean(c.item);
    const notice=preview?TEXT.preview:health===false?TEXT.unavailable:listing&&listing.paused?TEXT.paused:'';
    c.notice.textContent=notice||(storageNotice?TEXT.storage:'');c.notice.hidden=!c.notice.textContent;
    c.identity.textContent=bad?TEXT.badName:identityLine(nameOf(c.name.value));if(bad)c.identity.setAttribute('data-tone','error');else c.identity.removeAttribute('data-tone');
    if(!bad&&c.status.textContent===TEXT.badName)c.status.textContent='';c.status.hidden=!c.status.textContent;
  };
  /**
   * done: 'sent' clears the page selection (its passage is highlighted now), 'closed' keeps it but the page offers no
   * 「评论」 button for it again until the selection changes, 'replaced' (another composer opens) tells the page nothing.
   */
  const closeComposer=(keepDraft,returnFocus,done)=>{
    if(!composer)return;const c=composer;composer=null;
    if(keepDraft&&!c.item)saveDraft(c.key,c.textarea.value);
    c.node.remove();if(done!=='replaced')post({type:'comment-target-done',clear:done==='sent'});if(returnFocus!==false)focusFrame();
  };
  const submit=async event=>{
    if(!trusted(event)||!composer||composer.busy||blocked())return;
    const c=composer;let item=c.item;
    if(!item){
      const text=c.textarea.value.trim();
      if(!text){c.status.textContent='请先写下评论。';updateComposer();c.textarea.focus();return}
      if(text.length>2000){c.status.textContent='评论最多 2000 字。';updateComposer();return}
      if(pending.length>=5){c.status.textContent='有 5 条评论还没确认送达，请先在评论栏里重试或放弃。';updateComposer();return}
      const name=nameOf(c.name.value);
      if(badName(name)){c.status.textContent=TEXT.badName;updateComposer();c.name.focus();return}
      ensureSecret();mine.name=name;savePublic();
      item={key:'pc-'+uuid(),payload:{text,...(name?{authorName:name}:{}),pageUrl,anchor:{...c.anchor,releaseId:config.releaseId},visibility:'public'},at:new Date().toISOString(),draft:c.key};
      pending=[...pending,item];c.item=item;delete drafts[c.key];savePending();
    }
    c.busy=true;c.status.textContent='';c.status.setAttribute('data-tone','info');updateComposer();
    const result=await deliver(item);
    if(composer!==c)return;
    c.busy=false;c.status.removeAttribute('data-tone');
    if(result.ok){closeComposer(false,false,'sent');showToast(TEXT.sent);dismissHint();openRail(false);revealCard(result.id,true);return}
    if(!result.keep){pending=pending.filter(p=>p!==item);c.item=null;savePending()}
    if(result.badName){mine.name='';savePublic()}
    c.retry=Boolean(result.retry&&c.item);c.status.textContent=result.error;updateComposer();
  };
  const openComposer=(t,trigger)=>{
    if(composer)closeComposer(true,false,'replaced');
    hideFloat();const anchor=cleanAnchor(t.anchor);if(!anchor)return;
    const key=draftKey(anchor),quote=clip(anchor.quote,120);
    const textarea=el('textarea',{'aria-label':'公开评论','placeholder':'写下你的评论…',maxlength:'2000'});textarea.value=drafts[key]||'';
    const name=el('input',{type:'text','aria-label':'称呼（可选，会公开显示）',placeholder:'称呼（可选，会公开显示）',maxlength:'80',autocomplete:'nickname'});name.value=mine.name;
    const send=el('button',{type:'button',class:'pbc-btn pbc-primary','data-pbc':'send',text:'发送'}),cancel=el('button',{type:'button',class:'pbc-btn','data-pbc':'cancel',text:'取消'});
    const statusLine=el('div',{class:'pbc-status',role:'status','aria-live':'polite',hidden:true}),notice=el('div',{class:'pbc-status','data-tone':'info',hidden:true}),identity=el('div',{class:'pbc-small','data-pbc':'identity'});
    const node=el('div',{class:'pbc pbc-box pbc-composer','data-pbc':'composer',role:'dialog','aria-modal':'true','aria-label':'公开评论选中的文字'},[
      el('div',{class:'pbc-quote',text:'“'+quote+'”'}),name,textarea,identity,el('div',{class:'pbc-small',text:TEXT.note}),notice,statusLine,
      el('div',{class:'pbc-row'},[send,cancel]),el('div',{class:'pbc-small',text:TEXT.keys}),trigger==='menu'?el('div',{class:'pbc-small',text:TEXT.shift}):null]);
    composer={node,textarea,name,send,cancel,status:statusLine,notice,identity,anchor,key,target:t,item:null,busy:false,retry:false};
    const linked=pending.find(p=>p.draft===key&&p.key.startsWith('pc-'));
    if(linked){composer.item=linked;textarea.value=linked.payload.text;name.value=linked.payload.authorName||'';composer.retry=true;statusLine.textContent=TEXT.unconfirmed}
    send.addEventListener('click',submit);
    cancel.addEventListener('click',event=>{if(!trusted(event)||!composer||composer.busy)return;if(!composer.item)saveDraft(key,textarea.value);closeComposer(false)});
    textarea.addEventListener('input',()=>{if(composer&&!composer.item)saveDraft(key,textarea.value)});
    name.addEventListener('input',()=>updateComposer());
    node.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(composer&&!composer.busy)closeComposer(true);return}
      if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void submit(event);return}
      trap(node,event);
    });
    layer.appendChild(node);updateComposer();placeComposer();
    if(storageNotice)storageNotice=false;
    textarea.focus({preventScroll:true});requestAnimationFrame(()=>placeComposer());
  };
  // Rail, overlay and bottom sheet: one element, three layouts.
  const aligned=()=>mode==='docked'||mode==='overlay'&&innerWidth>=800;
  const railVisible=()=>!frameOff&&(mode==='docked'||railOpen);
  const setRailPref=value=>{try{if(local)local.setItem(railKey,value)}catch{}};
  const applyMode=()=>{
    if(mode==='docked')document.documentElement.setAttribute('data-pbc-rail','docked');else document.documentElement.removeAttribute('data-pbc-rail');
    rail.setAttribute('data-mode',mode);
    if(mode==='sheet'){rail.setAttribute('role','dialog');rail.setAttribute('aria-modal','true')}else{rail.setAttribute('role','complementary');rail.removeAttribute('aria-modal')}
    rail.setAttribute('aria-label','评论');
  };
  const openRail=focus=>{if(mode==='docked'||frameOff)return;railOpen=true;rail.style.maxHeight='';renderAll();if(focus){const first=rail.querySelector('[data-pbc=card][tabindex="0"]')||rail.querySelector('[data-pbc=close]');if(first)first.focus({preventScroll:true})}pollSoon()};
  const closeRail=returnFocus=>{if(mode==='docked'||!railOpen)return;railOpen=false;active=null;rail.style.maxHeight='';sendEmphasis();renderAll();if(returnFocus)toggle.focus()};
  const collapse=()=>{post({type:'comment-keep-position'});setRailPref('closed');mode='overlay';railOpen=false;applyMode();renderAll();toggle.focus()};
  const expand=()=>{post({type:'comment-keep-position'});setRailPref('open');mode=pickMode();railOpen=false;applyMode();renderAll();const first=rail.querySelector('[data-pbc=card][tabindex="0"]');if(first)first.focus({preventScroll:true})};
  toggle.addEventListener('click',event=>{if(!trusted(event))return;if(railOpen)closeRail(true);else openRail(true)});
  const sendEmphasis=()=>post({type:'comment-emphasis',hover,active});
  const sorted=threads=>threads.slice().sort((a,b)=>{const pa=positions.get(a.id),pb=positions.get(b.id),ya=pa?pa.top:1e9,yb=pb?pb.top:1e9;return ya-yb||(a.createdAt<b.createdAt?-1:a.createdAt>b.createdAt?1:0)||(a.id<b.id?-1:1)});
  const placed=()=>visibleThreads().filter(t=>positions.has(t.id)&&!orphans.has(t.id));
  const orphaned=()=>visibleThreads().filter(t=>orphans.has(t.id));
  const postHighlights=()=>{
    const threads=visibleThreads().map(t=>({id:t.id,anchor:t.anchor,state:stateOf(t)})),key=JSON.stringify(threads);
    if(key!==highlighted){highlighted=key;post({type:'comment-highlights',threads})}
  };
  // Cards are keyed by thread; a card is rebuilt only when what it shows changed, so focus and typing survive polls.
  const cards=new Map();
  const cardKey=t=>JSON.stringify([t.id,t.text,t.name,t.tag,t.resolved,t.replies.map(m=>[m.id,m.text,m.name,m.by,m.replyTo]),t.omitted,t.id===active,unreadOf(t),newIds.has(t.id),stateOf(t),myTag(),aligned()&&!orphans.has(t.id),Boolean(listing&&listing.paused),stale,replies.has(t.id)?replies.get(t.id).version:0,(positions.get(t.id)||{}).folded]);
  const messageNode=(m,t,root)=>{
    const who=label(m),meta=el('div',{class:'pbc-meta'});
    if(who.kind==='visitor'){if(m.tag)meta.append(swatch(m.tag));meta.append(el('span',{class:'pbc-who',text:who.text}));if(isMine(m))meta.append(el('span',{class:'pbc-chip','data-kind':'me',text:TEXT.me}))}
    else meta.append(el('span',{class:'pbc-chip','data-kind':who.kind,text:who.text}));
    if(m.replyTo){const target=t.replies.find(x=>x.id===m.replyTo);if(target)meta.append(el('span',{text:'回复 '+label(target).text}))}
    if(when(m.createdAt))meta.append(el('span',{text:when(m.createdAt)}));
    if(root&&(newIds.has(t.id)||unreadOf(t)))meta.append(el('span',{class:'pbc-chip','data-kind':'new',text:TEXT.fresh}));
    const node=el('div',{class:'pbc-msg','data-msg':m.id,'data-by':m.by},[meta,el('div',{class:'pbc-text'+(root&&t.id!==active?' pbc-clamp':''),text:shown(m.text)})]);
    if(t.id===active&&isMine(m)&&!t.pendingKey&&!t.private){
      const ask=el('div',{class:'pbc-row',hidden:true},[el('span',{class:'pbc-small',text:TEXT.withdraw}),el('button',{type:'button',class:'pbc-btn','data-pbc':'withdraw-confirm',text:'确定撤回',on:{click:event=>{if(trusted(event))void withdraw(m.id,t.id)}}}),el('button',{type:'button',class:'pbc-btn',text:'取消',on:{click:event=>{if(trusted(event))ask.hidden=true}}})]);
      node.append(el('button',{type:'button',class:'pbc-link','data-pbc':'withdraw',text:'撤回',on:{click:event=>{if(!trusted(event))return;ask.hidden=false;ask.querySelector('button').focus()}}}),ask);
    }
    return node;
  };
  const replyBox=t=>{
    let state=replies.get(t.id);if(!state){state={open:false,editing:false,busy:false,status:'',version:0};replies.set(t.id,state)}
    if(!state.open)return el('button',{type:'button',class:'pbc-link','data-pbc':'reply-open',text:'回复',on:{click:event=>{if(!trusted(event))return;state.open=true;state.version++;renderAll();const area=cards.get(t.id)&&cards.get(t.id).node.querySelector('textarea');if(area)area.focus({preventScroll:true})}}});
    const area=el('textarea',{'data-pbc':'reply-text','aria-label':'回复这条讨论',placeholder:'回复…',maxlength:'2000'});area.value=drafts['r:'+t.id]||'';
    const name=el('input',{type:'text','data-pbc':'reply-name','aria-label':'称呼（可选，会公开显示）',placeholder:'称呼（可选，会公开显示）',maxlength:'80',hidden:!state.editing});name.value=state.name===undefined?mine.name:state.name;
    const identity=el('span',{class:'pbc-small','data-pbc':'reply-identity'});
    const showIdentity=()=>{const chosen=nameOf(name.value),bad=badName(chosen);identity.textContent=bad?TEXT.badName:identityLine(chosen).replace('将公开显示为：','显示为：');if(bad)identity.setAttribute('data-tone','error');else identity.removeAttribute('data-tone')};
    showIdentity();
    const send=el('button',{type:'button',class:'pbc-btn pbc-primary','data-pbc':'reply-send',text:state.busy?TEXT.sending:'回复','aria-disabled':state.busy||blocked()?'true':'false'});
    const cancel=el('button',{type:'button',class:'pbc-btn','data-pbc':'reply-cancel',text:'取消'});
    const line=el('div',{class:'pbc-status',role:'status',text:state.status,hidden:!state.status});
    area.addEventListener('input',()=>saveDraft('r:'+t.id,area.value));
    name.addEventListener('input',()=>{state.name=name.value;showIdentity()});
    const doSend=async()=>{
      if(state.busy||blocked())return;const text=area.value.trim();if(!text){line.textContent='请先写下回复。';line.hidden=false;return}
      const chosen=nameOf(name.value);delete state.name;
      if(!state.item&&badName(chosen)){state.editing=true;name.hidden=false;line.textContent=TEXT.badName;line.hidden=false;name.focus({preventScroll:true});return}
      ensureSecret();mine.name=chosen;savePublic();
      let item=state.item;
      if(!item){item={key:'pr-'+uuid(),payload:{text,...(chosen?{authorName:chosen}:{}),pageUrl,anchor:{releaseId:config.releaseId},visibility:'public',parentId:t.id},at:new Date().toISOString(),draft:'r:'+t.id};state.item=item;pending=[...pending,item];saveCache()}
      state.busy=true;state.status='';state.version++;renderAll();
      const result=await deliver(item);
      state.busy=false;
      if(result.ok){
        state.item=null;state.open=false;state.status='';delete drafts['r:'+t.id];saveCache();state.version++;renderAll();
        // Sent from the keyboard: focus stays in this thread (its 回复 button), not on the page body.
        const card=cards.get(t.id),focused=document.activeElement;
        if(card&&(!focused||focused===document.body||card.node.contains(focused))){const again=card.node.querySelector('[data-pbc=reply-open]');(again||card.node).focus({preventScroll:true})}
        return;
      }
      if(!result.keep){pending=pending.filter(p=>p!==item);state.item=null;saveCache()}
      if(result.badName){mine.name='';savePublic();state.editing=true}
      state.status=result.error;state.version++;
      if(result.gone){state.open=false;pollSoon(0)}
      renderAll();
    };
    send.addEventListener('click',event=>{if(trusted(event))void doSend()});
    cancel.addEventListener('click',event=>{if(!trusted(event))return;state.open=false;state.version++;renderAll();const card=cards.get(t.id);if(card)card.node.focus()});
    area.addEventListener('keydown',event=>{
      if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void doSend()}
      else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();saveDraft('r:'+t.id,area.value);state.open=false;state.version++;renderAll();const card=cards.get(t.id);if(card)card.node.focus()}
    });
    return el('div',{class:'pbc-row','data-pbc':'reply-box',style:'flex-direction:column;align-items:stretch;gap:6px'},[area,el('div',{class:'pbc-row'},[identity,el('button',{type:'button',class:'pbc-link','data-pbc':'rename',text:'修改称呼',on:{click:event=>{if(!trusted(event))return;state.editing=!state.editing;name.hidden=!state.editing;if(state.editing)name.focus()}}})]),name,el('div',{class:'pbc-small',text:TEXT.replyNote}),line,el('div',{class:'pbc-row'},[send,cancel])]);
  };
  const buildCard=t=>{
    const isActive=t.id===active,orphan=orphans.has(t.id),folded=(positions.get(t.id)||{}).folded,listMode=!aligned()||orphan;
    const node=el('article',{class:'pbc-card','data-pbc':'card','data-thread':t.id,role:'article',tabindex:'-1','aria-label':(t.private?TEXT.privateOnly:'评论')+'：'+clip(t.text,60),...(isActive?{'data-active':''}:{}),...(t.resolved?{'data-resolved':''}:{}),...(t.private?{'data-private':''}:{}),...(stale?{'data-stale':''}:{})});
    if(listMode||folded)node.append(el('div',{class:'pbc-quote',text:'“'+clip(t.anchor.quote,40)+'”'}));
    if(t.resolved&&!isActive){node.append(el('div',{class:'pbc-small'},[el('span',{class:'pbc-chip','data-kind':'resolved',text:TEXT.resolved}),document.createTextNode(' '+label(t).text+'：'+clip(t.text,40))]));return node}
    node.append(messageNode(t,t,true));
    if(t.private)node.append(el('div',{class:'pbc-small',text:TEXT.privateOnly}));
    if(t.pendingKey)node.append(el('div',{class:'pbc-small',text:'没有确认送达'}),el('div',{class:'pbc-row'},[el('button',{type:'button',class:'pbc-btn',text:'重试',on:{click:event=>{if(trusted(event))void retryPending(t.pendingKey)}}}),el('button',{type:'button',class:'pbc-btn',text:'放弃',on:{click:event=>{if(!trusted(event))return;const p=pending.find(x=>x.key===t.pendingKey);pending=pending.filter(x=>x.key!==t.pendingKey);if(p&&p.draft)saveDraft(p.draft,p.payload.text);savePending()}}})]));
    if(stale)node.append(el('div',{class:'pbc-small',text:TEXT.updating}));
    if(!isActive){
      const n=t.replies.length+t.omitted;
      if(n||t.resolved)node.append(el('div',{class:'pbc-row pbc-small'},[n?el('span',{text:n+' 条回复'}):null,t.resolved?el('span',{class:'pbc-chip','data-kind':'resolved',text:TEXT.resolved}):null]));
      return node;
    }
    if(t.omitted)node.append(el('div',{class:'pbc-small',text:'还有 '+t.omitted+' 条较早的回复没有显示'}));
    for(const m of t.replies)node.append(messageNode(m,t,false));
    if(t.resolved){
      node.append(el('div',{class:'pbc-small',text:TEXT.resolvedNote}));
      const draft=(drafts['r:'+t.id]||'').trim();
      if(draft&&!t.private)node.append(el('div',{class:'pbc-small',text:TEXT.resolvedDraft}),el('div',{class:'pbc-quote','data-pbc':'unsent-draft',text:draft}),el('button',{type:'button',class:'pbc-link','data-pbc':'drop-draft',text:TEXT.dropDraft,on:{click:event=>{if(!trusted(event))return;saveDraft('r:'+t.id,'');const r=replies.get(t.id);if(r)r.version++;renderAll();const card=cards.get(t.id);if(card)card.node.focus({preventScroll:true})}}}));
    }
    else if(!t.private&&!t.pendingKey&&!preview)node.append(listing&&listing.paused?el('div',{class:'pbc-small',text:TEXT.paused}):replyBox(t));
    return node;
  };
  const retryPending=async key=>{const item=pending.find(p=>p.key===key);if(!item)return;const result=await deliver(item);if(!result.ok&&!result.keep){pending=pending.filter(p=>p!==item);if(item.draft)saveDraft(item.draft,item.payload.text);savePending()}else if(!result.ok)showToast(result.error.split('\n').pop())};
  const withdraw=async(messageId,threadId)=>{
    try{
      const r=await request('/_board/comments/'+encodeURIComponent(messageId)+'/withdraw',{method:'POST',headers:{'X-Board-Visitor':secret}});
      if(r.status===200){showToast(TEXT.withdrawn);if(listing){if(messageId===threadId)listing.threads=listing.threads.filter(t=>t.id!==threadId);else for(const t of listing.threads)t.replies=t.replies.filter(m=>m.id!==messageId)}if(messageId===threadId)active=null;renderAll();pollSoon(1000);return}
      showToast(r.status===429?'操作太频繁，请稍后再试。':'没能撤回：HTTP '+r.status);
    }catch(error){showToast(error instanceof TypeError?TEXT.network:TEXT.poll)}
  };
  // The aligned column: cards follow their passages; one transform follows the page scroll (§12 A6).
  const HEADER=44,GAP=8,LIFT=4,GROUP=3,FLOOR=8;
  let layoutFrame=0,restoring=false;
  const relayout=()=>{
    layoutFrame=0;if(!railVisible()||!aligned())return;
    const items=[],threads=sorted(placed());let cluster=[],clusterTop=null;
    const flush=()=>{if(cluster.length>GROUP&&!expandedGroups.has(cluster[0].id)){for(const t of cluster.slice(0,2))items.push(t);items.push({group:cluster[0].id,count:cluster.length-2,top:clusterTop})}else for(const t of cluster)items.push(t);cluster=[]};
    for(const t of threads){const y=positions.get(t.id).top;if(clusterTop===null||Math.abs(y-clusterTop)>4){flush();clusterTop=y}cluster.push(t)}
    flush();
    const nodes=items.map(item=>item.group?groupCard(item):cards.get(item.id).node);
    for(const node of nodes)if(node.parentNode!==column)column.appendChild(node);
    for(const child of Array.from(column.children))if(!nodes.includes(child))child.remove();
    // Column coordinates: document-relative passage tops shifted by where the rail body starts against the frame.
    const offset=frame.getBoundingClientRect().top-body.getBoundingClientRect().top,railHeight=body.clientHeight;
    // The open card always fits the rail (its own content scrolls), so its reply box can be reached.
    const cap=Math.max(160,railHeight-2*FLOOR-GAP);
    for(const node of nodes)node.style.maxHeight=node.hasAttribute('data-active')?cap+'px':'';
    const input=items.map((item,i)=>({y:(item.group?item.top:positions.get(item.id).top)+offset,h:nodes[i].offsetHeight||40}));
    const index=items.findIndex(item=>!item.group&&item.id===active),v=view();
    // The open card is kept inside the view only while its passage is at least partly in it; scrolled away, it stays
    // beside its passage (review fix: a re-layout then pinned it into the view, and it was far from its passage when
    // the reader scrolled back).
    const passage=index>=0?positions.get(active):null,near=Boolean(passage)&&passage.top+offset+Math.max(passage.height,1)>v&&passage.top+offset<v+railHeight;
    const tops=layout(input,index,{gap:GAP,lift:LIFT,floor:FLOOR,viewTop:near?v:-1e9,viewBottom:near?v+railHeight:1e9,limit:maxScroll()+railHeight-GAP});
    nodes.forEach((node,i)=>{node.style.top=Math.round(tops[i])+'px'});
    // How far the rail may scroll past the page's top or end: enough to show every card.
    let minTop=0,maxBottom=0;tops.forEach((top,i)=>{minTop=Math.min(minTop,top-FLOOR);maxBottom=Math.max(maxBottom,top+input[i].h+FLOOR)});
    railRange={min:Math.min(0,minTop),max:Math.max(maxScroll(),maxBottom-railHeight)};
    clampExtra();applyColumn();
    if(seeOpen())renderAll();
  };
  // The rail's own scroll beyond the page (extra) exists only at the page's ends; the column follows page + extra.
  let expected=null;
  const maxScroll=()=>Math.max(0,docHeight-frameHeight);
  const pageTop=()=>expected?expected.top:scrollTop;
  const view=()=>pageTop()+extra;
  const applyColumn=()=>{column.style.transform='translateY('+Math.round(-view())+'px)'};
  const clampExtra=()=>{const top=pageTop(),end=maxScroll();extra=extra<0?(top<=0.5?Math.max(extra,railRange.min):0):extra>0?(top>=end-0.5?Math.min(extra,railRange.max-end):0):0};
  /** Scrolls the aligned rail by dy: the page scrolls (the rail follows it), and past its ends the rail moves on its own. */
  const scrollRail=dy=>{
    const end=maxScroll(),target=Math.min(Math.max(view()+dy,railRange.min),railRange.max),page=Math.min(Math.max(target,0),end),from=pageTop();
    extra=target-page;
    if(Math.abs(page-from)>0.5){post({type:'comment-scroll-by',dy:page-from});expected={top:page,until:performance.now()+400}}
    applyColumn();if(active&&seeOpen())renderAll();
  };
  const groups=new Map();
  const groupCard=item=>{let node=groups.get(item.group);if(!node){node=el('button',{type:'button',class:'pbc-card pbc-link','data-pbc':'group',on:{click:event=>{if(!trusted(event))return;expandedGroups.add(item.group);renderAll()}}});groups.set(item.group,node)}node.textContent='这里还有 '+item.count+' 条评论';return node};
  const scheduleLayout=animate=>{if(animate){rail.setAttribute('data-animate','');setTimeout(()=>rail.removeAttribute('data-animate'),220)}if(!layoutFrame)layoutFrame=requestAnimationFrame(relayout)};
  const renderHead=()=>{
    const threads=allThreads(),open=threads.filter(t=>!t.resolved).length;
    head.textContent='';
    head.append(el('span',{class:'pbc-title',text:'评论'}));
    const seg=el('span',{class:'pbc-seg',role:'group','aria-label':'筛选'});
    seg.append(el('button',{type:'button','data-pbc':'filter-open','aria-pressed':filter==='open'?'true':'false',text:'未解决 '+open,on:{click:event=>{if(trusted(event)){filter='open';renderAll(true)}}}}),el('button',{type:'button','data-pbc':'filter-all','aria-pressed':filter==='all'?'true':'false',text:'全部 '+threads.length,on:{click:event=>{if(trusted(event)){filter='all';renderAll(true)}}}}));
    head.append(seg,el('button',{type:'button',class:'pbc-icon','data-pbc':'prev','aria-label':'上一条评论',text:'上一条',on:{click:event=>{if(trusted(event))step(-1)}}}),el('button',{type:'button',class:'pbc-icon','data-pbc':'next','aria-label':'下一条评论',text:'下一条',on:{click:event=>{if(trusted(event))step(1)}}}));
    if(mode==='docked')head.append(el('button',{type:'button',class:'pbc-icon','data-pbc':'collapse','aria-label':'收起评论栏',text:'收起',on:{click:event=>{if(trusted(event))collapse()}}}));
    else{if(mode==='overlay'&&innerWidth>=1056)head.append(el('button',{type:'button',class:'pbc-icon','data-pbc':'expand',text:'展开',on:{click:event=>{if(trusted(event))expand()}}}));head.append(el('button',{type:'button',class:'pbc-icon','data-pbc':'close',text:'关闭',on:{click:event=>{if(trusted(event))closeRail(true)}}}))}
  };
  const renderFoot=()=>{
    const lost=orphaned();foot.textContent='';
    if(lost.length){
      const button=el('button',{type:'button',class:'pbc-link','data-pbc':'orphans-toggle','aria-expanded':orphanOpen?'true':'false',text:TEXT.orphans+'（'+lost.length+'）',on:{click:event=>{if(trusted(event)){orphanOpen=!orphanOpen;renderAll()}}}});
      foot.append(button);
      if(orphanOpen){orphanBox.textContent='';orphanBox.append(el('div',{class:'pbc-small',text:TEXT.orphanHelp}));for(const t of lost)orphanBox.append(cards.get(t.id).node);foot.append(orphanBox)}
    }
    if(forgetAsk)foot.append(el('div',{class:'pbc-small',text:TEXT.forget}),el('div',{class:'pbc-row'},[el('button',{type:'button',class:'pbc-btn','data-pbc':'forget-confirm',text:'确定清除',on:{click:event=>{if(trusted(event))forget()}}}),el('button',{type:'button',class:'pbc-btn',text:'取消',on:{click:event=>{if(trusted(event)){forgetAsk=false;renderAll()}}}})]));
    else if(secret||myTag())foot.append(el('button',{type:'button',class:'pbc-link','data-pbc':'forget',text:'清除本机的评论身份',on:{click:event=>{if(!trusted(event))return;forgetAsk=true;renderAll();const b=foot.querySelector('[data-pbc=forget-confirm]');if(b)b.focus()}}}));
    foot.hidden=!foot.childNodes.length;
  };
  const renderAll=animate=>{
    if(frameOff){rail.hidden=true;toggle.hidden=true;return}
    for(const id of kept)if(id!==active)kept.delete(id);
    applyMode();seeOpen();
    const threads=allThreads(),visible=visibleThreads(),open=threads.filter(t=>!t.resolved).length;
    const unread=threads.reduce((sum,t)=>sum+unreadOf(t),0);
    toggle.hidden=preview?false:mode==='docked';
    toggle.textContent=unread?'评论 '+open+' · '+unread+' 条新回复':'评论 '+open;if(unread)toggle.append(el('span',{class:'pbc-dot','aria-hidden':'true'}));
    toggle.setAttribute('aria-expanded',railOpen?'true':'false');
    rail.hidden=!railVisible();
    if(!hint.hidden){if(toggle.hidden)hint.removeAttribute('data-raised');else hint.setAttribute('data-raised','')}
    postHighlights();
    // A rebuilt card keeps the focus where it was: the same control (and caret) if it still exists, else the card. It
    // takes the old card's place until the next layout, and moving the focus back never scrolls the rail (review fix:
    // a reply arriving in the focused open card measured the new card at the column's top and scrolled the page there).
    for(const t of threads){const key=cardKey(t),entry=cards.get(t.id);if(!entry||entry.key!==key){
      const node=buildCard(t),old=entry&&entry.node,focused=document.activeElement,inside=Boolean(old&&focused&&old.contains(focused));
      const marker=inside&&focused!==old?focused.getAttribute('data-pbc'):null,caret=inside&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
      if(old){node.style.top=old.style.top;node.style.maxHeight=old.style.maxHeight}
      if(old&&old.parentNode)old.replaceWith(node);cards.set(t.id,{key,node});
      if(inside){const same=marker&&node.querySelector('[data-pbc="'+marker+'"]'),target=same&&!same.hidden?same:node;restoring=true;try{target.focus({preventScroll:true})}finally{restoring=false}if(target===same&&caret&&typeof same.setSelectionRange==='function'){try{same.setSelectionRange(caret[0],caret[1])}catch{}}}
    }}
    for(const [id,entry] of cards)if(!threads.some(t=>t.id===id)){entry.node.remove();cards.delete(id)}
    if(rail.hidden)return;
    renderHead();
    const text=problem||(preview?TEXT.preview:listing&&listing.paused?TEXT.paused:listing&&listing.truncated?'评论太多，只显示最近的 '+listing.threads.length+' 个讨论。':'');
    status.textContent=text;status.hidden=!text;status.setAttribute('data-tone',problem?'error':'info');
    const listMode=!aligned();
    if(listMode)body.setAttribute('data-list','');else body.removeAttribute('data-list');
    column.hidden=listMode;list.hidden=!listMode;
    const empty=!visible.length;
    let emptyNode=body.querySelector('[data-pbc=empty]');
    if(empty){if(!emptyNode){emptyNode=el('div',{class:'pbc-small','data-pbc':'empty',style:'padding:12px'});body.prepend(emptyNode)}emptyNode.textContent=threads.length?TEXT.noneOpen:TEXT.empty}else if(emptyNode)emptyNode.remove();
    if(listMode){
      const order=[...sorted(placed()),...visible.filter(t=>!positions.has(t.id)&&!orphans.has(t.id)),...orphaned()];
      const nodes=order.map(t=>cards.get(t.id).node);
      if(nodes.some((node,i)=>list.children[i]!==node)||list.children.length!==nodes.length){const focused=document.activeElement;for(const node of nodes)list.appendChild(node);for(const child of Array.from(list.children))if(!nodes.includes(child))child.remove();if(focused&&list.contains(focused))focused.focus({preventScroll:true})}
    }
    renderFoot();roving();
    if(!listMode)scheduleLayout(animate);
    else if(seeOpen())renderAll();
  };
  // Keyboard: one tabbable card (roving), arrows move in passage order, Enter activates and reveals.
  const cardOrder=()=>{const order=[...sorted(placed()),...visibleThreads().filter(t=>!positions.has(t.id)&&!orphans.has(t.id)),...(orphanOpen?orphaned():[])];return order.map(t=>t.id)};
  const roving=()=>{const order=cardOrder(),current=focusId&&order.includes(focusId)?focusId:active&&order.includes(active)?active:order[0];for(const [id,entry] of cards)entry.node.setAttribute('tabindex',id===current?'0':'-1')};
  const activate=(id,reveal)=>{
    const t=allThreads().find(x=>x.id===id);if(!t)return;
    active=id;focusId=id;extra=0;markSeen(t);sendEmphasis();renderAll(true);
    if(reveal&&!orphans.has(id))post({type:'comment-reveal',id});
  };
  const revealCard=(id,reveal)=>{if(!railVisible())openRail(false);activate(id,reveal);requestAnimationFrame(()=>{const card=cards.get(id);if(card&&card.node.isConnected){if(!aligned())card.node.scrollIntoView({block:'nearest'});card.node.focus({preventScroll:true})}})};
  const step=delta=>{const order=cardOrder();if(!order.length)return;const index=order.indexOf(active||focusId);const next=order[index<0?0:(index+delta+order.length)%order.length];revealCard(next,true)};
  rail.addEventListener('keydown',event=>{
    if(event.key==='Escape'){
      if(event.defaultPrevented)return;event.preventDefault();
      if(active){const id=active;active=null;sendEmphasis();renderAll(true);const card=cards.get(id);if(card)card.node.focus({preventScroll:true});return}
      if(mode!=='docked')closeRail(true);return;
    }
    if(mode==='sheet')trap(rail,event);
    const card=event.target&&event.target.closest&&event.target.closest('[data-pbc=card]');
    if(!card||card!==event.target)return;
    const order=cardOrder(),id=card.getAttribute('data-thread'),index=order.indexOf(id);
    if(event.key==='ArrowDown'||event.key==='ArrowUp'||event.key==='Home'||event.key==='End'){
      event.preventDefault();const next=order[event.key==='Home'?0:event.key==='End'?order.length-1:Math.min(order.length-1,Math.max(0,index+(event.key==='ArrowDown'?1:-1)))];
      focusId=next;roving();const node=cards.get(next);if(node){node.node.focus({preventScroll:true});if(!aligned())node.node.scrollIntoView({block:'nearest'})}
    }
    else if(event.key==='Enter'||event.key===' '){event.preventDefault();if(id===active){const area=card.querySelector('textarea');if(area)area.focus();else{const open=card.querySelector('[data-pbc=reply-open]');if(open)open.focus()}}else activate(id,true)}
  });
  const deactivate=()=>{if(!active)return;active=null;sendEmphasis();renderAll(true)};
  rail.addEventListener('click',event=>{
    if(!trusted(event))return;const card=event.target.closest&&event.target.closest('[data-pbc=card]');
    // A click on the rail's empty space closes the open card, as a click elsewhere in the page does.
    if(!card){if(body.contains(event.target)&&!event.target.closest('button,textarea,input,a'))deactivate();return}
    if(event.target.closest('button,textarea,input,a'))return;
    const id=card.getAttribute('data-thread');if(id!==active)activate(id,true);
  });
  rail.addEventListener('pointerover',event=>{const card=event.target.closest&&event.target.closest('[data-pbc=card]'),id=card?card.getAttribute('data-thread'):null;if(id!==hover){hover=id;for(const [key,entry] of cards){if(key===hover)entry.node.setAttribute('data-hover','');else entry.node.removeAttribute('data-hover')}sendEmphasis()}});
  rail.addEventListener('pointerleave',()=>{if(hover!==null){hover=null;for(const entry of cards.values())entry.node.removeAttribute('data-hover');sendEmphasis()}});
  // The wheel over the aligned rail scrolls the page (the cards follow their passages), then the rail past the page's ends.
  body.addEventListener('wheel',event=>{
    if(!aligned()||!railVisible()||body.hasAttribute('data-list'))return;
    const target=event.target&&event.target.closest&&event.target.closest('[data-pbc=card][data-active]');
    if(target&&target.scrollHeight>target.clientHeight+1){const down=event.deltaY>0;if(down?target.scrollTop+target.clientHeight<target.scrollHeight-1:target.scrollTop>0)return}
    const dy=event.deltaMode===1?event.deltaY*16:event.deltaMode===2?event.deltaY*body.clientHeight:event.deltaY;
    if(!dy)return;event.preventDefault();scrollRail(dy);
  },{passive:false});
  // Focus never scrolls the aligned rail body (that would separate cards from their passages): the rail moves instead.
  body.addEventListener('scroll',()=>{if(!body.hasAttribute('data-list')){if(body.scrollTop||body.scrollLeft){body.scrollTop=0;body.scrollLeft=0}}else if(active&&seeOpen())renderAll()});
  rail.addEventListener('focusin',event=>{
    if(restoring||!aligned()||body.hasAttribute('data-list')||!column.contains(event.target))return;
    const r=event.target.getBoundingClientRect(),b=body.getBoundingClientRect();
    if(r.top<b.top+FLOOR)scrollRail(r.top-b.top-FLOOR);else if(r.bottom>b.bottom-FLOOR)scrollRail(Math.min(r.bottom-b.bottom+FLOOR,r.top-b.top-FLOOR));
  });
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape'||!event.isTrusted||event.defaultPrevented)return;
    if(composer&&!composer.node.contains(event.target)){if(!composer.busy){event.preventDefault();closeComposer(true)}}
    else if(railOpen&&mode!=='docked'&&!rail.contains(event.target)){event.preventDefault();closeRail(true)}
  });
  // A drag that started in the page and ends over this shell's UI: the frame never sees that pointerup.
  document.addEventListener(window.PointerEvent?'pointerup':'mouseup',event=>{if(event.isTrusted&&event.button===0)post({type:'comment-pointer-up'})},true);
  const dismissHint=()=>{hint.hidden=true;try{if(local)local.setItem(hintKey,'1')}catch{}};
  hint.append(el('span',{text:'选中文字即可评论'}),el('button',{type:'button',class:'pbc-link',text:'知道了',on:{click:event=>{if(trusted(event))dismissHint()}}}));
  const forget=()=>{
    try{if(local){local.removeItem(publicKey);const current=shared();if(current.secret){delete current.secret;local.setItem(visitorKey,JSON.stringify(current))}}}catch{}
    try{if(session)for(const key of Object.keys(session))if(key.startsWith(cachePrefix))session.removeItem(key)}catch{}
    secret='';mine.tags={};mine.seen={};mine.name='';pending=[];drafts={};privateThreads=[];forgetAsk=false;
    renderAll();focusFrame();
  };
  const relayoutViewport=()=>{placeFloat();placeComposer()};
  if(window.visualViewport){visualViewport.addEventListener('resize',relayoutViewport);visualViewport.addEventListener('scroll',relayoutViewport)}
  window.addEventListener('resize',()=>{relayoutViewport();if(preview)return;const next=pickMode();if(next!==mode){if(next==='docked'||mode==='docked')post({type:'comment-keep-position'});mode=next;railOpen=false}renderAll()});
  // Messages from the canvas frame: selection targets, positions, highlight hover and clicks. Everything is checked.
  const number=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<1e7;
  const rect=r=>r&&number(r.x)&&number(r.y)&&number(r.width)&&number(r.height)?{x:r.x,y:r.y,width:r.width,height:r.height}:null;
  const known=id=>typeof id==='string'&&allThreads().some(t=>t.id===id);
  /** The tapped passage stays visible above the bottom sheet: scroll the page, and shorten the sheet if that is not enough. */
  const keepAboveSheet=id=>{
    const p=positions.get(id);if(!p||mode!=='sheet'||!railOpen)return;
    const height=Math.max(p.height,20),top=p.top-scrollTop,sheetTop=rail.getBoundingClientRect().top;
    if(top>=8&&top+height+8<=sheetTop)return;
    const page=Math.min(Math.max(p.top-12,0),maxScroll()),after=p.top-page;
    if(Math.abs(page-scrollTop)>0.5)post({type:'comment-scroll-by',dy:page-scrollTop});
    const room=Math.round(innerHeight-(after+height+12));
    rail.style.maxHeight=Math.max(Math.round(innerHeight*0.4),Math.min(Math.round(innerHeight*0.75),room))+'px';
  };
  window.addEventListener('message',event=>{
    const m=event.data;if(event.source!==frame.contentWindow||!m||m.channel!==CHANNEL||m.releaseId!==config.releaseId||m.sessionId!==sessionId)return;
    if(m.type==='comment-runtime-ready'){frameReady=true;frameOff=m.off===true;highlighted='';if(frameOff){clearTimeout(timer);renderAll();return}if(!preview&&!allThreads().length&&!(local&&local.getItem(hintKey))&&mode!=='docked')hint.hidden=false;renderAll();return}
    if(m.type==='comment-scroll'&&number(m.scrollY)){noteInput();scrollTop=m.scrollY;if(expected&&(Math.abs(scrollTop-expected.top)<1||performance.now()>expected.until))expected=null;clampExtra();applyColumn();if(active&&seeOpen())renderAll();return}
    if(m.type==='comment-activity'){noteInput();return}
    // A click in the page outside every highlight closes the open card (or the bottom sheet), as in Google Docs.
    if(m.type==='comment-page-click'){if(composer)return;if(mode==='sheet'&&railOpen)closeRail(false);else deactivate();return}
    if(m.type==='comment-positions'){
      if(!Array.isArray(m.items)||m.items.length>200||!Array.isArray(m.orphans)||m.orphans.length>200||!number(m.scrollY)||!number(m.docHeight)||!m.viewport||!number(m.viewport.height))return;
      const next=new Map();for(const item of m.items){if(!item||!known(item.id)||!number(item.top)||!number(item.height))continue;next.set(item.id,{top:item.top,height:item.height,folded:item.folded===true})}
      positions=next;orphans=new Set(m.orphans.filter(known));scrollTop=m.scrollY;if(expected&&Math.abs(scrollTop-expected.top)<1)expected=null;docHeight=m.docHeight;frameHeight=m.viewport.height;renderAll();return;
    }
    if(m.type==='comment-highlight-hover'){const id=m.id===null||known(m.id)?m.id:undefined;if(id===undefined)return;hover=id;for(const [key,entry] of cards){if(key===id)entry.node.setAttribute('data-hover','');else entry.node.removeAttribute('data-hover')}return}
    // Opens or activates inside this UI only; nothing outside the page opens, so no user activation is needed.
    if(m.type==='comment-highlight-click'&&known(m.id)){if(mode==='sheet'){openRail(false);activate(m.id,false);requestAnimationFrame(()=>{const card=cards.get(m.id);if(card){card.node.scrollIntoView({block:'nearest'});card.node.focus({preventScroll:true})}keepAboveSheet(m.id)})}else{if(!railVisible())openRail(false);activate(m.id,false)}return}
    if(m.type==='comment-target-clear'){if(!composer)hideFloat();return}
    if(m.type==='comment-escape'){if(composer){if(!composer.busy)closeComposer(true,false)}else if(railOpen&&mode!=='docked')closeRail(false);else if(active){active=null;sendEmphasis();renderAll(true)}return}
    if(m.type!=='comment-target'||!['menu','key','select'].includes(m.trigger))return;
    let size=0;try{size=JSON.stringify(m).length}catch{return}if(size>8000)return;
    const anchor=cleanAnchor(m.anchor),r=rect(m.rect);if(!anchor||!anchor.selector||!r)return;
    const t={anchor,rect:r,bounds:rect(m.bounds)||r,touch:m.touch===true};
    if(m.trigger==='select'){if(!composer)showFloat(t);return}
    if(userActive())openComposer(t,m.trigger);else if(!composer)showFloat(t);
  });
  applyMode();renderAll();
  // One listing request at load (the preview makes none); then every 10 s while visible.
  if(!preview)schedule(0);
  })();`;
