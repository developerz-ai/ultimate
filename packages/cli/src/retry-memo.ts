// One in-flight attempt, shared — and a FAILED one not kept. `started ??= boot()` caches the
// rejection with the value, so a Postgres that refused a connection once answered every later
// call in the session with that same error and no retry was possible short of restarting the host.

/**
 * A lazily made attempt that may be made again.
 *
 * `started()` is the half `??=` has no spelling for: it answers the attempt already in flight or
 * already made, and `undefined` when nobody has asked yet — so a `close()` can stop what was
 * booted without BOOTING one in order to stop it.
 */
export interface RetryMemo<T> {
  get(): Promise<T>;
  started(): Promise<T> | undefined;
}

/**
 * `start` runs at most once per SUCCESS. `@ultimat3/db`'s `createPgliteClient` states the rule this
 * generalises — "a failed boot must not be cached" — and the clearing handler is attached at
 * creation for the reason that matters: it therefore runs ahead of every caller's own `await`
 * continuation, so by the time anyone sees the rejection the slot is already empty and the next
 * call really does start a new attempt. Cleared inside the caller's `catch` instead, there is a
 * window in which a second call is handed the dead promise.
 */
export function retryMemo<T>(start: () => Promise<T>): RetryMemo<T> {
  let attempt: Promise<T> | undefined;
  return {
    get(): Promise<T> {
      attempt ??= start().catch((error: unknown) => {
        attempt = undefined;
        throw error;
      });
      return attempt;
    },
    started: (): Promise<T> | undefined => attempt,
  };
}
