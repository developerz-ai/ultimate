/**
 * The emitted worker's read of a precached ASSET — a stylesheet, an island chunk, a placeholder.
 * Its own module because `service-worker.ts` is the rest of `sw.js`; spliced in after the precache
 * manifest, and read by the fetch block before any route rule. `service-worker-assets.test.ts`.
 */

import type { PrecacheManifest } from './precache';

/**
 * Until this ran, the install block filled `x-precache-<build>` with every stylesheet and nothing
 * ever read one: no rule matched `/styles/<hash>.css`, so an offline document rendered unstyled
 * beside its own stylesheet, and a precached island chunk was downloaded a second time into the
 * runtime cache. `[url, immutable]` — immutable when the revision IS the url, the caller's
 * declaration that the URL is content-addressed (`sw-precache-plan.ts` writes it for every chunk).
 */
export function precachedAssetSource(manifest: PrecacheManifest): string {
  const rows = manifest.entries
    .filter((entry) => entry.reason === 'asset')
    .map((entry) => [entry.url, entry.revision === entry.url]);
  return `// Keyed by absolute href, as the install block stores them (new Request(e.url)).
const PRECACHED_ASSETS=new Map(${JSON.stringify(rows)}.map(([u,i])=>[new URL(u,self.location.origin).href,i]));
// Content-addressed: the precache first, the bytes cannot differ. Otherwise the network first, so
// a newer build's bytes at the same URL win online, and the precached copy answers offline.
async function precachedAsset(req,immutable){
  const c=await caches.open(PRECACHE);
  if(immutable){const hit=await c.match(req);return hit||fetch(req)}
  try{return await fetch(req)}catch(e){const hit=await c.match(req);if(hit)return hit;throw e}
}`;
}
