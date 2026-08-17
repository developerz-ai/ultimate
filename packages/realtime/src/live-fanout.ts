// One change, one query id, inside that query's lane: match it, fold it into the shared window,
// then one policy pass per subscriber over what came out. Split from `live-query.ts` because the
// registry owns the lanes and the entry table while this owns what happens inside one of them —
// and because one file runs one job. The lane itself is never taken here: the caller is holding it.

import type { Clock } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { advance, type LiveCursor, makeCursor, type ResumeSource } from './cursor';
import type { Row, RowPatch } from './json';
import type { LiveSubscription } from './live-contract';
import { applyToWindow, bridgeChange } from './matcher-bridge';
import { type QueryEntry, refillWindowInLane } from './query-window';
import type { Subscriber, SubscriberGate } from './subscriber-gate';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

export interface FanoutDeps {
  readonly gate: SubscriberGate;
  readonly source: ResumeSource;
  readonly clock: Clock;
}

export interface FanoutResult {
  /** Frames that left this node for this query id. */
  readonly sent: number;
  /** `1` when the change was at or below the window's own lsn — `live.changes_stale`. */
  readonly stale: number;
}

/**
 * The fanout for one entry, run inside that entry's lane — so the window this mutates at the top is
 * still the window every subscriber's gate reads at the bottom, and the patches reach the retained
 * buffer in the order the client will be asked to fold them.
 */
export async function fanoutChange(
  deps: FanoutDeps,
  entry: QueryEntry,
  change: ChangeEvent,
): Promise<FanoutResult> {
  // A window that missed a change must be replaced before it is patched again, and it can only be
  // replaced here — a fanout holds this entry's lane, and `fillWindow` takes the same one.
  if (entry.stale) await refillWindowInLane(entry);
  // The consume-side twin of the replicator's own duplicate guard, which had none. `entry.lsn =
  // change.lsn` was unconditional, so a change the window already holds — a redelivery, or one
  // that arrived behind the snapshot that already included it — rewound every subscriber's cursor
  // to it and asked them to fold state they had already folded over newer rows.
  if (entry.lsn !== '' && change.lsn <= entry.lsn) return { sent: 0, stale: 1 };
  const result = bridgeChange(entry.shape, entry.matcher, change, entry.rows);
  if (!result) return { sent: 0, stale: 0 };
  entry.lsn = change.lsn;
  entry.rows = applyToWindow(entry.rows, result.patches);
  // The window lost its tail, so what it holds is a guess — the next delivery re-reads it rather
  // than patching a guess, and every subscriber below is re-snapshotted out of what that returns.
  if (result.refill) entry.stale = true;
  // The retained window holds the pre-policy patch; resume re-filters it per subscriber.
  for (const patch of result.patches) deps.source.append(entry.qid, patch);

  let sent = 0;
  for (const subscription of entry.subscribers.values()) {
    // `desynced` had four writers and no reader: a subscriber whose patch was dropped by
    // backpressure, whose gate failed, or whose window lost its tail was recorded as diverged and
    // then served the next patch as if nothing had happened — permanently and silently stale on a
    // healthy socket. A marked subscriber is re-snapshotted out of the shared window instead, at
    // the cost of one frame and no DB read, and only then is the mark cleared.
    if (subscription.socket.desynced.has(subscription.sid)) {
      if (await resnapshot(deps, entry, subscription)) sent += 1;
      continue;
    }
    if (result.refill) {
      // The window lost its tail: guessing is how a sync engine silently diverges.
      subscription.socket.markDesynced(subscription.sid);
      continue;
    }
    const who: Subscriber = { sid: subscription.sid, actor: subscription.socket.actor };
    let allowed: readonly RowPatch[];
    try {
      allowed = await deps.gate.filterPatches(
        entry,
        who,
        result.patches,
        new Set(subscription.cursor.ids),
      );
    } catch {
      // Already counted and reported as a gate failure. Degrade this one subscriber the way a
      // lost window tail degrades them — desynced, re-snapshotted on the next flush — because
      // rejecting here would abandon the fanout to every other subscriber over one actor's
      // broken rule, and delivering the patches anyway would be the leak.
      subscription.socket.markDesynced(subscription.sid);
      continue;
    }
    if (allowed.length === 0) continue;
    const frame: Frame = {
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid: subscription.sid,
      patches: allowed,
      lsn: change.lsn,
    };
    if (subscription.socket.send(frame)) {
      subscription.cursor = advance(subscription.cursor, allowed, change.lsn, change.at);
      sent += 1;
    } else {
      subscription.socket.markDesynced(subscription.sid);
    }
  }
  return { sent, stale: 0 };
}

/**
 * The repair for one diverged subscriber, out of the window the lane is already holding — no DB
 * read, one frame. Its cursor is rebuilt from what this subscriber may actually see, exactly as
 * `subscribe` does, because a cursor over the pre-policy window would claim ids the client was
 * never sent. The mark is cleared only on a frame that left: a send refused by backpressure keeps
 * the subscriber diverged, which is the state it is actually in.
 */
async function resnapshot(
  deps: FanoutDeps,
  entry: QueryEntry,
  subscription: LiveSubscription,
): Promise<boolean> {
  const who: Subscriber = { sid: subscription.sid, actor: subscription.socket.actor };
  let rows: readonly Row[];
  try {
    rows = await deps.gate.filterRows(entry, who, entry.rows);
  } catch {
    // Counted and reported as a gate failure already. It stays desynced: a subscriber whose rule
    // cannot decide is not one to serve rows to, and the next change tries again.
    return false;
  }
  const cursor = makeCursor(entry.qid, entry.lsn, rows, deps.clock.now().getTime());
  if (!subscription.socket.send(snapshotFrame(entry, subscription.sid, rows, cursor))) return false;
  subscription.cursor = cursor;
  subscription.socket.clearDesynced(subscription.sid);
  return true;
}

/** The one place a snapshot frame is built, so the identity scope cannot be told to one caller only. */
export function snapshotFrame(
  entry: QueryEntry,
  sid: string,
  rows: readonly Row[],
  cursor: LiveCursor,
): Frame {
  const base = { type: 'snapshot', v: PROTOCOL_VERSION, sid, rows, cursor } as const;
  return entry.rowEntity === null ? base : { ...base, entity: entry.rowEntity };
}
