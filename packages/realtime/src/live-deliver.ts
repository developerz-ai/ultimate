// One change, fanned out over every live window on the node. Split from `live-query.ts` at its
// size ceiling: the registry owns who holds which window, this owns the ordering of one delivery.

import { finiteOption } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { type FanoutDeps, fanoutChange } from './live-fanout';
import { DEFAULT_MAX_LANE_DEPTH } from './live-query-options';
import type { QueryEntry } from './query-window';

/**
 * The two counters every delivery on a node feeds, and the lane bound it sheds at. Owned by the
 * registry, one per node; read back as `staleChanges` / `changesShed`.
 */
export class DeliveryCounts {
  readonly maxLaneDepth: number;
  /** `live.changes_stale`: a change at or below a window's own lsn, refused rather than folded. */
  staleChanges = 0;
  /** `live.changes_shed`: a change a full lane did not queue; its window re-reads instead. */
  changesShed = 0;

  constructor(maxLaneDepth: number | undefined) {
    // At least two: depth counts the RUNNING task, and a shed is repaired by a task queued behind
    // it finding the mark. A lane of one shed with nobody behind to read it.
    this.maxLaneDepth = Math.max(
      2,
      finiteOption(
        'the live-query registry',
        'maxLaneDepth',
        maxLaneDepth ?? DEFAULT_MAX_LANE_DEPTH,
      ),
    );
  }
}

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
  counts: DeliveryCounts,
): Promise<number> {
  const lanes = [...entries].map(async (entry) => {
    if (entry.lock.depth >= counts.maxLaneDepth) {
      // Shed, never queued: the lane is a closure per change, and one slow policy pass would hold
      // them all. Staled, not desynced, because the lane is still full of changes that will run —
      // the first one in finds the mark and re-reads (`live-fanout.ts`), and that read began after
      // this change was handed to the registry, so it holds it. Over-reading is the cost; losing
      // the change is not one. Outside the lane, as `invalidate()` sets it: a read issued after
      // this answers it, and one issued before cleared the mark already and cannot clear this.
      entry.stale = true;
      counts.changesShed += 1;
      return 0;
    }
    try {
      const result = await entry.lock.run(() => fanoutChange(fanout, entry, change));
      counts.staleChanges += result.stale;
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
