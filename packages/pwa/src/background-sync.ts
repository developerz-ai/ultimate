/**
 * Background Sync registration for the offline mutation queue.
 *
 * SRP: the queue itself — the outbox, the optimistic local twins, the conflict policy —
 * belongs to `@ultimat3/realtime`. This file owns only the browser-side trigger: register
 * a sync tag, and when the platform says connectivity is back, ask realtime to flush.
 * Nothing here knows what a mutation is, and it must stay that way.
 *
 * The two failures below (`X_PWA_SYNC_FLUSH_FAILED`, `X_PWA_SYNC_INCOMPLETE`, documented in
 * `./errors.ts`) run inside the string emitted into `sw.js` — the browser's service-worker
 * realm, which has no bundler and cannot import `@ultimat3/core`. What it *can* have is a class
 * of its own, so `SYNC_ERROR_CLASS` emits one: a bare `Error` carries a message and nothing a
 * caller can read, while the emitted class exposes the same `code`, `cause`, `fix` and `docs` an
 * `UltimateError` does everywhere else in the framework.
 */

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { PwaSyncFlushFailedError, PwaSyncIncompleteError } from './errors';
import { BUILD_ID_HEADER } from './version-skew';

export const SYNC_TAG = 'x-outbox';

/**
 * `retry` was removed 2026-08-23, with `RetryPolicy`, `DEFAULT_RETRY`, `retryDelayMs` and
 * `shouldRetry`: **this package schedules no retry and never did.** The one-shot `sync` handler
 * rejects, and the PLATFORM decides when to wake it again — `flushOutbox` counts no attempts and
 * has nowhere to apply a delay. Of the policy only `maxAttempts` ever reached the worker, as a
 * `SYNC_MAX_ATTEMPTS` constant nothing read; the two exported functions were called by their own
 * test and by nothing else. Same rule as `PwaConfig.installPrompt` and `JobsConfig.driver`
 * (`packages/core/src/config.ts`): a knob that produces neither a build error nor a runtime effect
 * is worse than no knob, because an author sets it, ships, and nothing changes.
 */
export interface BackgroundSyncOptions {
  /** Endpoint `@ultimat3/realtime` exposes to flush the outbox. */
  readonly flushEndpoint?: string;
}

export const DEFAULT_FLUSH_ENDPOINT = '/_x/outbox/flush';

/**
 * Where the emitted class sends a reader — `@ultimat3/core`'s `ERROR_DOCS_URL`, interpolated into
 * the worker source rather than restated, because a URL retyped in a generated string is a second
 * constant that drifts silently. One page for every code, not one per code: `wiki/` is the
 * framework's only public documentation surface and a code lives there in a table row, which has no
 * anchor. `background-sync.test.ts` asserts the emitted value still equals what the registry says.
 */
const SYNC_DOCS = ERROR_DOCS_URL;

/**
 * The generated realm's own coded error, as source. Small on purpose — this ships in `sw.js` — and
 * deliberately not a bare `Error`: `code` is what a reporting hook groups on, `fix` is what the
 * developer in devtools acts on, and neither survives being flattened into a message alone. The
 * message still renders the contract's own line shape, because an uncaught `waitUntil` rejection
 * prints nothing else.
 */
const SYNC_ERROR_CLASS = `
class PwaSyncError extends Error{
  constructor(code,cause,fix){
    const docs=${JSON.stringify(SYNC_DOCS)};
    super(code+': '+cause+'\\n  fix:   '+fix+'\\n  docs:  '+docs);
    this.name='PwaSyncError';this.code=code;this.cause=cause;this.fix=fix;this.docs=docs;
  }
}`.trim();

/**
 * Emitted into `sw.js` only when the `backgroundSync` capability is on. The handler posts
 * to realtime's flush endpoint; a non-2xx keeps the sync registration alive so the
 * platform retries with its own scheduling.
 */
export function backgroundSyncSource(options: BackgroundSyncOptions = {}): string {
  const endpoint = options.flushEndpoint ?? DEFAULT_FLUSH_ENDPOINT;
  return `
const SYNC_TAG=${JSON.stringify(SYNC_TAG)};
const FLUSH_ENDPOINT=${JSON.stringify(endpoint)};
${SYNC_ERROR_CLASS}
async function flushOutbox(){
  const res=await fetch(FLUSH_ENDPOINT,{method:'POST',headers:{${JSON.stringify(BUILD_ID_HEADER)}:BUILD_ID}});
  if(!res.ok)throw new PwaSyncError(${JSON.stringify(PwaSyncFlushFailedError.code)},'outbox flush POST '+FLUSH_ENDPOINT+' returned '+res.status,'curl -i -X POST '+FLUSH_ENDPOINT+' — @ultimat3/realtime must mount it and answer 2xx');
  // ||{} rather than a default inside the catch: json() on a 200 body of null RESOLVES with null,
  // so the catch never fires and body.remaining raised inside waitUntil instead of refusing coded.
  const body=(await res.json().catch(()=>null))||{};
  if(body.remaining>0)throw new PwaSyncError(${JSON.stringify(PwaSyncIncompleteError.code)},'outbox flush at '+FLUSH_ENDPOINT+' left '+body.remaining+' mutation(s) queued','x dev --role sync   # run the role that drains the outbox; the browser reschedules this sync on its own');
}
self.addEventListener('sync',(event)=>{
  if(event.tag!==SYNC_TAG)return;
  // Rejecting keeps the registration so the platform retries on its own schedule.
  event.waitUntil(flushOutbox());
});`.trim();
}

/** Client-side registration. Falls back to an `online` listener where sync is missing. */
export function registerBackgroundSyncSource(): string {
  return `
export async function registerOutboxSync(registration){
  const sync=registration.sync;
  if(sync&&typeof sync.register==='function'){await sync.register(${JSON.stringify(SYNC_TAG)});return 'sync'}
  addEventListener('online',()=>{navigator.serviceWorker.controller?.postMessage({type:'flush-outbox'})});
  return 'fallback'
}`.trim();
}
