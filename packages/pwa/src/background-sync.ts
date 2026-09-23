/**
 * Background Sync: the browser-side TRIGGER for draining the offline outbox, and nothing else.
 *
 * The outbox itself — queued mutations, their idempotency keys, the replay over HTTP — is
 * `@ultimat3/realtime`'s, and it lives in the PAGE (IndexedDB), because only the page holds the
 * store, the principal and `clientTransport`. So when the platform says connectivity is back, the
 * worker does not send anything itself: it posts `OUTBOX_DRAIN_MESSAGE` to every open window client
 * and realtime's listener drains. One outbox, not two — until 21.0.0 the worker POSTed to
 * `/_x/outbox/flush`, a route nothing in the framework ever mounted.
 *
 * With NO client open there is nobody to drain, and the handler resolves rather than faking work:
 * the queue is still in IndexedDB and the next page load replays it. Rejecting instead would only
 * make the platform re-wake a worker that still has nobody to tell.
 */

import { OUTBOX_DRAIN_MESSAGE } from '@ultimat3/core';

export const SYNC_TAG = 'x-outbox';

/**
 * Emitted into `sw.js` only when the `backgroundSync` capability is on. `drainOutbox` is also what
 * the shared message handler calls for the page's `flush-outbox` fallback (`service-worker.ts`).
 */
export function backgroundSyncSource(): string {
  return `
const SYNC_TAG=${JSON.stringify(SYNC_TAG)};
async function drainOutbox(){
  const open=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  for(const c of open)c.postMessage({type:${JSON.stringify(OUTBOX_DRAIN_MESSAGE)}});
}
self.addEventListener('sync',(event)=>{
  if(event.tag!==SYNC_TAG)return;
  event.waitUntil(drainOutbox());
});`.trim();
}

/**
 * Client-side registration. Where Background Sync is missing (Safari, Firefox) an `online`
 * listener asks the worker instead, which answers every open tab — not only the one that noticed.
 */
export function registerBackgroundSyncSource(): string {
  return `
export async function registerOutboxSync(registration){
  const sync=registration.sync;
  if(sync&&typeof sync.register==='function'){await sync.register(${JSON.stringify(SYNC_TAG)});return 'sync'}
  addEventListener('online',()=>{navigator.serviceWorker.controller?.postMessage({type:'flush-outbox'})});
  return 'fallback'
}`.trim();
}
