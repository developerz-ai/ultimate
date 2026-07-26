/**
 * Background Sync registration for the offline mutation queue.
 *
 * SRP: the queue itself — the outbox, the optimistic local twins, the conflict policy —
 * belongs to `@ultimat3/realtime`. This file owns only the browser-side trigger: register
 * a sync tag, and when the platform says connectivity is back, ask realtime to flush.
 * Nothing here knows what a mutation is, and it must stay that way.
 */

import { BUILD_ID_HEADER } from './version-skew';

export const SYNC_TAG = 'x-outbox';
export const PERIODIC_SYNC_TAG = 'x-refresh';

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
  /** Minimum interval for periodic sync, when the platform grants it. */
  readonly periodicMinIntervalMs?: number;
}

export const DEFAULT_FLUSH_ENDPOINT = '/_x/outbox/flush';

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
async function flushOutbox(){
  const res=await fetch(FLUSH_ENDPOINT,{method:'POST',headers:{${JSON.stringify(BUILD_ID_HEADER)}:BUILD_ID}});
  if(!res.ok)throw new Error('outbox flush failed: '+res.status);
  const body=await res.json().catch(()=>({remaining:0}));
  if(body.remaining>0)throw new Error('outbox partially flushed');
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
