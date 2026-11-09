// The `cache.*` events the calling test file's tests caused, newest first — a bus subscriber held
// for one test at a time, so nothing a neighbouring file did is read and nothing is left subscribed.
// A test double, not public API: not exported from `index.ts`. What production keeps is the
// subscriber's business (the `/_x` panel holds its own bounded buffer).

import { afterEach, beforeEach } from 'bun:test';
import type { CacheInvalidateEvent, CacheLookupEvent, CacheTierFailureEvent } from '@ultimat3/core';
import { subscribe } from '@ultimat3/core';

export interface CacheEvents {
  /** `cache.tier_failure`, newest first. */
  failures(): readonly CacheTierFailureEvent[];
  /** `cache.invalidate`, newest first. */
  invalidations(): readonly CacheInvalidateEvent[];
  /** `cache.hit` / `cache.miss`, in emit order, as `hit:<tier>:<key>` / `miss:<tier>:<key>`. */
  lookups(): readonly string[];
  /** Drops everything recorded so far; the subscription stays. */
  clear(): void;
}

const lookupOf = (verdict: 'hit' | 'miss', event: CacheLookupEvent): string =>
  `${verdict}:${event.tier}:${event.key}`;

/** Call once at the top of a test file: subscribes before each test, unsubscribes after it. */
export function recordCacheEvents(): CacheEvents {
  const failures: CacheTierFailureEvent[] = [];
  const invalidations: CacheInvalidateEvent[] = [];
  const lookups: string[] = [];
  const clear = (): void => {
    failures.length = 0;
    invalidations.length = 0;
    lookups.length = 0;
  };
  let off: (() => void) | undefined;
  beforeEach(() => {
    clear();
    off = subscribe('cache', (event) => {
      if (event.name === 'cache.tier_failure') failures.unshift(event.payload);
      else if (event.name === 'cache.invalidate') invalidations.unshift(event.payload);
      else if (event.name === 'cache.hit') lookups.push(lookupOf('hit', event.payload));
      else if (event.name === 'cache.miss') lookups.push(lookupOf('miss', event.payload));
    });
  });
  afterEach(() => {
    off?.();
    off = undefined;
  });
  return {
    failures: () => [...failures],
    invalidations: () => [...invalidations],
    lookups: () => [...lookups],
    clear,
  };
}
