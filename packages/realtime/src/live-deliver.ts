// One change, fanned out over every live window on the node. Split from `live-query.ts` at its
// size ceiling: the registry owns who holds which window, this owns the ordering of one delivery.

import type { ChangeEvent } from './changefeed';
import { type FanoutDeps, fanoutChange } from './live-fanout';
import type { QueryEntry } from './query-window';

/**
 * Fan one change out. Matched once per query id, authorized once per subscriber. Returns the
 * number of frames sent — the metric the reconnect benchmark watches.
 *
 * Each entry's turn is taken in that entry's lane. Nothing upstream orders this: `sync` fires
 * `void registry.deliver(change)` straight off the bus subscription, so two changes arriving back
 * to back would otherwise interleave inside one query id — lsn 2 delivered before lsn 1, the
 * subscriber's cursor rewound to 1, and every gate deciding against whichever window won.
 *
 * Every lane is *entered* before any of them is awaited, and nothing inside a fanout takes a
 * second lane, so holding all of them at once cannot be a cycle. That is what makes the ordering
 * claim true: two deliveries queue onto each query id in call order, serialized per query id and
 * never per node — awaiting one entry before entering the next made one slow policy pass the
 * whole node's pace, and let a lane that threw skip every entry behind it with nobody desynced.
 */
export async function deliverChange(
  entries: Iterable<QueryEntry>,
  fanout: FanoutDeps,
  change: ChangeEvent,
  onStale: (count: number) => void,
): Promise<number> {
  const lanes = [...entries].map(async (entry) => {
    try {
      const result = await entry.lock.run(() => fanoutChange(fanout, entry, change));
      onStale(result.stale);
      return result.sent;
    } catch (error) {
      // The window advanced under a fanout that did not finish, so every subscriber of this one
      // query id now holds a cursor below the change and no later flush would correct them:
      // desynced here, re-snapshotted on the next one. Silent divergence is the whole reason
      // `markDesynced` exists, and skipping this is how a failure became one.
      for (const subscription of entry.subscribers.values()) {
        subscription.socket.markDesynced(subscription.sid);
      }
      throw error;
    }
  });
  // `allSettled`, so one lane's rejection neither cancels the others nor goes unhandled. The
  // first failure still reaches the caller — `sync` logs it — but it costs one query id.
  let sent = 0;
  let failure: { readonly error: unknown } | null = null;
  for (const lane of await Promise.allSettled(lanes)) {
    if (lane.status === 'fulfilled') sent += lane.value;
    else failure ??= { error: lane.reason };
  }
  if (failure !== null) throw failure.error;
  return sent;
}
