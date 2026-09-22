/**
 * The principal fence: which principal the page is acting for, and an epoch that moves exactly
 * when that changes. A response, frame or persisted row from the previous principal must never
 * land in the next one's store, so every client layer reads this one signal.
 *
 * Subscriber contract (`onRescope`): called SYNCHRONOUSLY, once per real change, in registration
 * order, before `rescope()` returns — so by the time a sign-in action's caller continues, every
 * read was aborted, the store wiped its non-persisted records, the socket dropped its channels
 * and the persister switched scope. A throwing subscriber does not stop the others; the first
 * throw is re-raised after all have run. The TRIGGER is not core's: the page bootstrap calls
 * `rescope()` with the principal the server rendered, and sign-in / sign-out call it on success.
 */

import type { ScopeCell } from './record-sink';
import { heldRecords, scopeCell } from './record-sink';

export interface ClientScope {
  /**
   * An opaque principal id; `null` for a page rendered for an anonymous visitor; `undefined` for
   * an UNSCOPED page — one rendered for nobody (a shared, cacheable document carries no scope
   * meta). Nothing is persisted while unscoped (plan 101 slice 12): there is no principal to key
   * the rows by, and guessing one is how one visitor's cache restores into another's.
   */
  readonly principal: string | null | undefined;
  /** Bumped once per principal change. Work captured at another epoch is not this scope's. */
  readonly epoch: number;
}

/** Move the page to `principal`. Same principal = no-op: no epoch bump, no notification. */
export function rescope(principal: string | null): void {
  const cell: ScopeCell = scopeCell();
  const prev = cell.current;
  if (prev.principal === principal) return;
  const next: ClientScope = Object.freeze({ principal, epoch: prev.epoch + 1 });
  cell.current = next;
  // Held early records belong to the principal that just left; they never reach the next store.
  heldRecords()?.clear();
  let failure: { readonly error: unknown } | undefined;
  // A snapshot: a subscriber that unsubscribes (or subscribes) mid-notify changes the NEXT round.
  for (const listener of [...cell.listeners]) {
    try {
      listener(next, prev);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== undefined) throw failure.error;
}

/** Subscribe to principal changes. Returns the unsubscribe. */
export function onRescope(fn: (next: ClientScope, prev: ClientScope) => void): () => void {
  const listeners = scopeCell().listeners;
  // Wrapped, so the same function registered twice is two subscriptions with two unsubscribes.
  const entry = (next: ClientScope, prev: ClientScope): void => fn(next, prev);
  listeners.add(entry);
  return (): void => {
    listeners.delete(entry);
  };
}
