// The `/_x` cache panel's log: every `cache.invalidate` event this process emitted, newest first,
// bounded. A bus subscriber `x dev` installs at boot — the cache package keeps no ring buffer of
// its own (`X_INSTRUMENT_SLOT_FORBIDDEN`), so the one panel that reads the history holds it.

import type { InvalidationFact } from '@ultimat3/admin/dev';
import type { CacheInvalidateEvent, Clock } from '@ultimat3/core';
import { finiteCount, systemClock } from '@ultimat3/core';

/** The panel shows recent busts; it does not page through history. The cache's old log's figure. */
const DEFAULT_LIMIT = 100;

export interface InvalidationLog {
  /** Feed it every bust: `subscribe('cache.invalidate', (e) => log.record(e.payload))`. */
  record(event: CacheInvalidateEvent): void;
  /** Newest first, a copy. */
  facts(): readonly InvalidationFact[];
  reset(): void;
}

export function createInvalidationLog(
  options: { readonly limit?: number; readonly clock?: Clock } = {},
): InvalidationLog {
  const limit = finiteCount('createInvalidationLog', 'limit', options.limit ?? DEFAULT_LIMIT, 1);
  const clock = options.clock ?? systemClock;
  let log: InvalidationFact[] = [];
  return {
    record(event) {
      log.unshift({
        at: clock.now().toISOString(),
        tags: event.tags,
        busted: event.busted,
        // The span active when the bust was ASKED for, stamped by the cache at the call — the
        // subscriber runs inside the cache's own span, whose name would be every row's source.
        source: event.source ?? 'cache',
      });
      if (log.length > limit) log.length = limit;
    },
    facts: () => [...log],
    reset() {
      log = [];
    },
  };
}
