// `memoPerRequest(fn, key)`: the request memo for a plain function, over the same per-ctx store
// and byte bound as `memoTier` — one mechanism, a second entry point, so an app stops writing its
// own WeakMap-on-ctx wrapper. Outside a ctx it calls straight through.

import { holdValue, storeFor } from './memo-store';

/** Wrapper identities: two wrappers handed the same key string must not answer for each other. */
let wrappers = 0;

/**
 * Memoize `fn` per request: the first call for a key in a ctx runs it, every later call in that
 * ctx gets the same return value — for an async `fn`, the same promise, so concurrent calls join
 * one flight. A rejected promise is dropped, so the next call retries. Each wrapper owns its key
 * space, kept apart from `memoTier`'s keys by a NUL-prefixed namespace no tier key starts with.
 *
 * The value is held by reference, not through the cache codec: it is a function's own return
 * value inside one request, not a cache entry shared between readers, and a promise or a class
 * instance must come back as itself.
 */
export function memoPerRequest<A extends readonly unknown[], R>(
  fn: (...args: A) => R,
  key: (...args: A) => string,
): (...args: A) => R {
  wrappers += 1;
  const namespace = `\u0000memo:${wrappers}\u0000`;

  return (...args: A): R => {
    const store = storeFor(true);
    if (store === undefined) return fn(...args);
    const slot = namespace + key(...args);
    const held = store.entries.get(slot);
    if (held?.kind === 'value') return held.value as R;
    const value = fn(...args);
    holdValue(store, slot, value);
    return value;
  };
}
