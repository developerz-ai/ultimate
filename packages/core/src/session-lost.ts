/**
 * "This page's session is gone", said once. A tab past its session otherwise asks for a 401
 * forever; every poll and every scheduled refresh reads this one flag and stops. The flag lives on
 * the page handle (`record-sink.ts`) because every island chunk carries its own copy of core.
 */

import { sessionLostCell } from './record-sink';

/** The two codes that mean the credential this page was rendered with no longer resolves. */
const LOSS_CODES: ReadonlySet<string> = new Set(['X_UNAUTHENTICATED', 'X_SESSION_EXPIRED']);

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
 * Internal, `client-dispatch.ts`'s: a refusal `code` answered to a page acting for `principal`.
 * Only a page that HAD a principal can lose one — an anonymous page's 401 is a wrong password.
 */
export function noteRefusal(code: string, principal: string | null | undefined): void {
  if (typeof principal !== 'string' || !LOSS_CODES.has(code)) return;
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
