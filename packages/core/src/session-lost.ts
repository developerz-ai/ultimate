/**
 * "This page's session is gone", said once. A tab past its session otherwise asks for a 401
 * forever; every poll and every scheduled refresh reads this one flag and stops. The flag lives on
 * the page handle (`record-sink.ts`) because every island chunk carries its own copy of core.
 */

import { onRescope } from './client-scope';
import { sessionLostCell } from './record-sink';
import { SESSION_REFUSAL_CODES } from './session-refusal';

/** Whether a refusal has said this page's session is gone. `rescope()` clears it. */
export function sessionIsLost(): boolean {
  return sessionLostCell().lost;
}

/**
 * Called once per page when the session is lost; at once for a subscriber that arrives after.
 * Returns the unsubscribe. The sign-in UI is the app's: the framework says "lost", nothing more.
 */
export function onSessionLost(fn: () => void): () => void {
  const cell = sessionLostCell();
  if (cell.lost) {
    fn();
    return (): void => {};
  }
  // Wrapped, so one function subscribed twice is two subscriptions with two unsubscribes.
  const entry = (): void => fn();
  cell.listeners.add(entry);
  return (): void => {
    cell.listeners.delete(entry);
  };
}

/**
 * Internal, the pollers': `start` runs while the page holds a session — now, unless it is already
 * lost — and its returned stop is called on a loss. The next rescope to a signed-in principal
 * starts it again, fresh: a poll stopped by a 401 is not one stopped for good once the visitor
 * signs back in. A rescope to `null` keeps waiting, since an anonymous page's 401 never stops it.
 * Returns the idempotent disposer, which stops a running `start` too.
 */
export function whileSessionHeld(start: () => () => void): () => void {
  let stopRun: (() => void) | undefined;
  let offLost = (): void => {};
  let disposed = false;
  const pause = (): void => {
    const stop = stopRun;
    stopRun = undefined;
    stop?.();
  };
  const begin = (): void => {
    stopRun = start();
    offLost = onSessionLost(pause);
  };
  const offScope = onRescope((next) => {
    if (stopRun === undefined && typeof next.principal === 'string') begin();
  });
  if (!sessionIsLost()) begin();
  return (): void => {
    if (disposed) return;
    disposed = true;
    offScope();
    offLost();
    pause();
  };
}

/** The refusal as `client-dispatch.ts` saw it: the answer's status, its URL and its code. */
export interface Refusal {
  readonly status: number;
  readonly url: string;
  readonly code: string;
}

/**
 * Internal, `client-dispatch.ts`'s: a refusal answered to a page acting for `principal`. Only a
 * page that HAD a principal can lose one — an anonymous page's 401 is a wrong password — and only
 * a 401 from this page's own origin speaks for the cookie it was rendered with: another origin's
 * 401 is about that origin's credential.
 */
export function noteRefusal(refusal: Refusal, principal: string | null | undefined): void {
  if (typeof principal !== 'string' || refusal.status !== 401) return;
  if (!SESSION_REFUSAL_CODES.has(refusal.code) || !isPageOrigin(refusal.url)) return;
  const cell = sessionLostCell();
  if (cell.lost) return;
  cell.lost = true;
  const listeners = [...cell.listeners];
  cell.listeners.clear();
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // Re-raised off this stack: the caller is mid-refusal, and a listener's bug must neither
      // replace that refusal nor silence the listeners after it. The page's error hook sees it.
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

/** Stands in for the page's origin where there is none (a server, a test): only a relative URL is. */
const NO_ORIGIN = 'http://page-origin.invalid';

/** Whether `url` resolves to the page's origin; relative URLs always do. */
function isPageOrigin(url: string): boolean {
  const location: unknown = Reflect.get(globalThis, 'location');
  const stated =
    typeof location === 'object' && location !== null ? Reflect.get(location, 'origin') : undefined;
  // `'null'` is an opaque origin (a sandboxed frame): no absolute URL can match it.
  const base = typeof stated === 'string' && stated !== 'null' ? stated : NO_ORIGIN;
  if (!URL.canParse(url, base)) return false;
  return new URL(url, base).origin === new URL(base).origin;
}
