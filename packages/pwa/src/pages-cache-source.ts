/**
 * The emitted worker's page storage, as source: the facade every strategy opens the pages cache
 * through, the per-principal partitions a private document is kept in, the background copy, and
 * the offline read. Its own module because `service-worker.ts` is the rest of `sw.js`; it is
 * spliced into the fetch block and reads that block's constants (`PAGES`, `SCOPE_HEADER`) and
 * `warming` from the activate block. `service-worker-pages.test.ts` runs it.
 */

export const PAGES_CACHE_SOURCE = `// The pages cache is a FACADE, because a document rendered for one member is not a page: keyed by
// URL alone, /feed rendered for kenji answered bruno on the same browser. A shareable document is
// stored and read as before. A private one (\`private\`/\`no-store\`, or carrying the scope header)
// is never read from here — so no strategy can answer it from cache while online — and is kept
// only in its principal's own partition, PAGES~<scope>, which offline alone reads. Storing one
// principal's page wipes every other partition: offline answers the most recent member only.
function openCache(cn){return cn===PAGES?pagesCache():caches.open(cn)}
// A cache copy the strategy does NOT await: handed to the event's waitUntil when there is one, and
// never allowed to reject into nobody — a failed copy costs the copy, not the response.
function later(wait,p){const settled=p.catch(()=>{});if(wait)wait(settled);return settled}
function isPrivate(r){
  if(r.headers.has(SCOPE_HEADER))return true;
  return /(^|,)\\s*(private|no-store)\\s*(,|$)/i.test(r.headers.get('cache-control')||'')
}
function pagesCache(){return{
  match:async(req)=>(await caches.open(PAGES)).match(req),
  put:async(req,r)=>{
    if(!isPrivate(r))return (await caches.open(PAGES)).put(req,r);
    const scope=r.headers.get(SCOPE_HEADER);
    // Private with no scope: no principal to file it under, so it is not kept at all.
    if(scope===null)return;
    // NOT awaited by the strategy: a private document is usually a stream, and a strategy awaits
    // its put before answering — the navigation would wait for the whole body to be copied into
    // the cache. The offline read waits for it instead (pageOffline), which is the only reader.
    keeping=keeping.then(()=>keepScoped(req,r,PAGES+'~'+scope)).catch(()=>{});
  }
}}
let keeping=Promise.resolve();
async function keepScoped(req,r,name){
  await (await caches.open(name)).put(req,r);
  const names=await caches.keys();
  await Promise.all(names.filter((n)=>n.startsWith(PAGES+'~')&&n!==name).map((n)=>caches.delete(n)));
}
/** Offline only: the most recent member's own copy, then the offline document. */
async function pageOffline(req){
  await warming;
  await keeping;
  // The shared copy first — a warm-up may have landed it after the strategy's own read missed.
  const shared=await (await caches.open(PAGES)).match(req);
  if(shared)return shared;
  for(const n of await caches.keys()){
    if(!n.startsWith(PAGES+'~'))continue;
    const hit=await (await caches.open(n)).match(req);
    if(hit)return hit;
  }
  return offlineFallback(req)
}
function fallbackFor(rule,req){return rule.c==='pages'?()=>pageOffline(req):()=>offlineFallback(req)}`;
