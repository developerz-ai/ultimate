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

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60 * 1000,
});

/**
 * Deterministic exponential backoff — no jitter here on purpose: the Background Sync
 * scheduler already spreads wake-ups across clients, and a deterministic delay is
 * testable and reproducible in a bug report.
 */
export function retryDelayMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const clamped = Math.max(1, Math.min(attempt, policy.maxAttempts));
  return Math.min(policy.baseDelayMs * 2 ** (clamped - 1), policy.maxDelayMs);
}

export function shouldRetry(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): boolean {
  return attempt < policy.maxAttempts;
}

export interface BackgroundSyncOptions {
  /** Endpoint `@ultimat3/realtime` exposes to flush the outbox. */
  readonly flushEndpoint?: string;
  readonly retry?: RetryPolicy;
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
  const retry = options.retry ?? DEFAULT_RETRY;
  return `
const SYNC_TAG=${JSON.stringify(SYNC_TAG)};
const FLUSH_ENDPOINT=${JSON.stringify(endpoint)};
const SYNC_MAX_ATTEMPTS=${retry.maxAttempts};
${SYNC_ERROR_CLASS}
async function flushOutbox(){
  const res=await fetch(FLUSH_ENDPOINT,{method:'POST',headers:{${JSON.stringify(BUILD_ID_HEADER)}:BUILD_ID}});
  if(!res.ok)throw new PwaSyncError(${JSON.stringify(PwaSyncFlushFailedError.code)},'outbox flush POST '+FLUSH_ENDPOINT+' returned '+res.status,'curl -i -X POST '+FLUSH_ENDPOINT+' — @ultimat3/realtime must mount it and answer 2xx');
  // ||{} rather than a default inside the catch: json() on a 200 body of null RESOLVES with null,
  // so the catch never fires and body.remaining raised inside waitUntil instead of refusing coded.
  const body=(await res.json().catch(()=>null))||{};
  if(body.remaining>0)throw new PwaSyncError(${JSON.stringify(PwaSyncIncompleteError.code)},'outbox flush at '+FLUSH_ENDPOINT+' left '+body.remaining+' mutation(s) queued','x dev --role sync   # drain the outbox, or raise pwa.backgroundSync.retry.maxAttempts in app.config.ts');
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
