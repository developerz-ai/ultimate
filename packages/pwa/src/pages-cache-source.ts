/**
 * The emitted worker's cache access, as source: the guard every strategy opens a cache through, the
 * background copy, the offline page read and the sign-out purge. Its own module because
 * `service-worker.ts` is the rest of `sw.js`; it is spliced into the fetch block and reads that
 * block's constants (`PAGES`, `PAGES_PREFIX`, `SCOPE_HEADER`) and `warming` from the activate block.
 * `service-worker-pages.test.ts` runs both modes.
 */

/**
 * What a page posts to the active worker on sign-out — `navigator.serviceWorker.controller
 * ?.postMessage({ type: 'clear-pages' })` — to empty every build's pages cache. The worker answers
 * the posting window with `{ type: 'pages-cleared' }` once they are gone.
 */
export const CLEAR_PAGES_MESSAGE = 'clear-pages';
export const PAGES_CLEARED_MESSAGE = 'pages-cleared';

/** Every build's pages cache starts with this — `cacheNamespace(id, 'pages')` is `x-pages-<id>`. */
export const PAGES_CACHE_PREFIX = 'x-pages-';

/**
 * What the worker does with a page rendered for someone — `pwa.offline.personalPages`.
 *
 * `'never'`, the default `As of 22.3.3`: not cached, in any cache, under any rule, and a personal
 * route is `network-only`. `'last-member'`: 21.0.0's offline-first mode, kept for an app that
 * declares it — never answered from cache online, kept only in the most recent member's own
 * partition for offline. An app that picks it must clear on sign-out (`clear-pages`, or
 * `Clear-Site-Data: "storage"`): on a shared device the partition is the previous member's data.
 */
export type PersonalPages = 'never' | 'last-member';

const SHARED = `// A cache copy the strategy does NOT await: handed to the event's waitUntil when there is one, and
// never allowed to reject into nobody — a failed copy costs the copy, not the response.
function later(wait,p){const settled=p.catch(()=>{});if(wait)wait(settled);return settled}
function isPrivate(r){
  if(r.headers.has(SCOPE_HEADER))return true;
  return /(^|,)\\s*(private|no-store)\\s*(,|$)/i.test(r.headers.get('cache-control')||'')
}
// Every cache but the pages cache is GUARDED in both modes: a private response is never stored there.
function guarded(c){return{match:(req)=>c.match(req),put:async(req,r)=>{if(!isPrivate(r))return c.put(req,r)}}}
function fallbackFor(rule,req){return rule.c==='pages'?()=>pageOffline(req):()=>offlineFallback(req)}
// The app's sign-out: every build's pages cache, and every per-member partition.
async function clearPages(){
  const names=await caches.keys();
  await Promise.all(names.filter((n)=>n.startsWith(PAGES_PREFIX)).map((n)=>caches.delete(n)));
}`;

const NEVER = `// A private response (\`private\`/\`no-store\`, or carrying the scope header) is never stored,
// whatever the rule. 21.0.0 kept one per member for offline, and after sign-out an offline
// navigation on a shared device answered the previous member's data. \`no-store\` means what it says.
function openCache(cn){return caches.open(cn).then(guarded)}
/** Offline only: the shared copy (a warm-up may have landed it late), then the offline document. */
async function pageOffline(req){
  await warming;
  const shared=await (await caches.open(PAGES)).match(req);
  if(shared)return shared;
  return offlineFallback(req)
}`;

const LAST_MEMBER = `// personalPages: 'last-member'. The pages cache is a FACADE: a shareable document is stored and
// read as before; a private one is never read from here — so no strategy answers it from cache
// while online — and is kept only in its principal's own partition, PAGES~<scope>, which offline
// alone reads. Storing one principal's page wipes every other partition. clear-pages empties them.
function openCache(cn){return cn===PAGES?Promise.resolve(pagesCache()):caches.open(cn).then(guarded)}
function pagesCache(){return{
  match:async(req)=>(await caches.open(PAGES)).match(req),
  put:async(req,r)=>{
    if(!isPrivate(r))return (await caches.open(PAGES)).put(req,r);
    const scope=r.headers.get(SCOPE_HEADER);
    // Private with no scope: no principal to file it under, so it is not kept at all.
    if(scope===null)return;
    // In the background: a private document is usually a stream, and the offline read waits for it.
    keeping=keeping.then(()=>keepScoped(req,r,PAGES+'~'+scope)).catch(()=>{});
  }
}}
let keeping=Promise.resolve();
async function keepScoped(req,r,name){
  await (await caches.open(name)).put(req,r);
  const names=await caches.keys();
  await Promise.all(names.filter((n)=>n.startsWith(PAGES+'~')&&n!==name).map((n)=>caches.delete(n)));
}
/** Offline only: the shared copy, then the most recent member's own copy, then the offline document. */
async function pageOffline(req){
  await warming;
  await keeping;
  const shared=await (await caches.open(PAGES)).match(req);
  if(shared)return shared;
  for(const n of await caches.keys()){
    if(!n.startsWith(PAGES+'~'))continue;
    const hit=await (await caches.open(n)).match(req);
    if(hit)return hit;
  }
  return offlineFallback(req)
}`;

export const pagesCacheSource = (mode: PersonalPages): string =>
  `${mode === 'last-member' ? LAST_MEMBER : NEVER}\n${SHARED}`;
