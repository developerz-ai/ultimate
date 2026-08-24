// Single responsibility: the scope inside which a read may be served by a replica, and the one bit
// that closes read-your-writes — has this scope written yet. A mutable value on an async context,
// the same shape `transaction.ts` uses for `TxState.live`, so a write at any depth and across any
// `await` is seen by every later read in the same scope.

import { asyncContext } from '@ultimat3/core';

/**
 * Deliberately mutable, and deliberately not `readonly`. The whole mechanism is that a write ten
 * frames and three `await`s below the scope's opener flips this, and the read after it sees it —
 * a fresh object per statement could not carry that, and threading a parameter would be the same
 * fact written at every call site, with every path an author forgot serving a stale row.
 */
export interface ReplicaScope {
  wrote: boolean;
}

const scope = asyncContext<ReplicaScope>('the replica read scope');

/**
 * Declare that reads inside `fn` may be served by a replica — until `fn` writes, after which every
 * read in it is the primary's for the rest of the scope.
 *
 * **Opt-in, and that is the safety argument, not an ergonomic one.** `packages/db` cannot see a
 * request boundary: `@ultimat3/http`'s pipeline opens the `Ctx` and nothing tells this tier when a
 * request ended, so a write-marker keyed on `Ctx.requestId` would be a `Map` that only grows —
 * ~100 bytes per request, forever — and any eviction policy that forgets a request that WROTE
 * serves it a stale row, which is worse than the capacity problem replicas exist to solve. With no
 * scope open nothing routes and the client is byte-identical to a single-pool one, so the failure
 * mode of "nobody opened one" is today's behaviour rather than a wrong answer.
 *
 * Nesting is one scope, not two: an inner `withReplicaReads` inside a scope that has already
 * written must not un-write it. The innermost call reuses the store it finds.
 */
export function withReplicaReads<T>(fn: () => T): T {
  const open = scope.get();
  if (open !== undefined) return fn();
  return scope.run({ wrote: false }, fn);
}

/** The scope in flight, or `undefined` — which is every caller that never opened one. */
export function replicaScope(): ReplicaScope | undefined {
  return scope.get();
}

/**
 * Record that this scope has written. Called for every statement that is not provably a plain read
 * — including `begin`, a `set`, and anything the router could not classify — because the direction
 * that is safe to be wrong in is "assume it wrote". A no-op outside a scope, where nothing routes.
 */
export function markScopeWrote(): void {
  const open = scope.get();
  if (open !== undefined) open.wrote = true;
}
