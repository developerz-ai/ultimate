// `useQuery`'s timed re-read, as a VALUE the caller imports: `{ poll: pollEvery(ms) }`. Its own
// module so the timer (core's `visibleInterval`) is in an island's bundle only when the island
// polls — `useQuery` itself never references it, and a live-only island stays its old size.

import { type VisibleIntervalOptions, visibleInterval } from '@ultimat3/core/page';

/** What `useQuery` starts with its `refetch`; the disposer is called by `release()`. */
export interface QueryPoll {
  start(run: () => Promise<void>): () => void;
}

/**
 * Re-read every `ms` through `visibleInterval`: no read while the tab is hidden, one make-up read
 * when it shows, none after a lost session. `maxMs` backs the period off toward it. A non-finite
 * value is `visibleInterval`'s refusal (`finiteOption`), raised when the read starts.
 */
export function pollEvery(ms: number, options: VisibleIntervalOptions = {}): QueryPoll {
  return { start: (run) => visibleInterval(run, ms, options) };
}
