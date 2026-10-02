// One subscriber resuming onto its window from a cursor: replay the retained patches when the
// cursor is inside them, serve one bounded snapshot when it is not. Split from `live-query.ts` at
// that file's size ceiling — the registry owns the entry table and who is attached to what; this
// owns what a returning subscriber is SENT. It attaches nothing: the caller seats the cursor.

import type { Clock } from '@ultimat3/core';
import {
  advance,
  type LiveCursor,
  type ReconnectBudget,
  type ResumeSource,
  resumeFrom,
} from './cursor';
import type { SnapshotResult } from './live-contract';
import { snapshotFrame } from './live-fanout';
import { fillWindow, type QueryEntry } from './query-window';
import type { Subscriber, SubscriberGate } from './subscriber-gate';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

export interface ResumeOntoDeps {
  readonly source: ResumeSource;
  readonly budget?: ReconnectBudget | undefined;
  readonly clock: Clock;
  readonly gate: SubscriberGate;
  /** The window, read once for the entry and filtered for THIS subscriber. */
  read(): Promise<SnapshotResult>;
}

/**
 * The frame a resuming subscriber needs and the cursor it is seated under. The caller has already
 * established that `cursor` names THIS window: a cursor is client data, and one minted for another
 * window is a cold start, never a replay of a ring this window does not own.
 */
export async function resumeOnto(
  deps: ResumeOntoDeps,
  entry: QueryEntry,
  who: Subscriber,
  cursor: LiveCursor,
  now: number,
): Promise<{ readonly cursor: LiveCursor; readonly frame: Frame }> {
  const resumed = await resumeFrom(cursor, {
    source: deps.source,
    ...(deps.budget ? { budget: deps.budget } : {}),
    clock: deps.clock,
    snapshot: () => deps.read(),
  });
  if (resumed.kind !== 'delta') {
    return {
      cursor: resumed.cursor,
      frame: snapshotFrame(entry, who.sid, resumed.rows, resumed.cursor),
    };
  }
  // The gate decides about whole rows out of the shared window, and an entry nothing has read
  // yet has none — every patch would meet an empty window and be withheld. Filling is
  // conditional on purpose: a restart storm resumes onto entries that already hold a live
  // window, and re-reading per resuming subscriber is the cost a delta resume exists to skip.
  if (entry.lsn === '') await fillWindow(entry);
  // The live entry on purpose: a resume runs outside the lane, so the window under it may
  // have moved on — always forwards, and a row whose grant was revoked in the meantime is
  // one this pass must refuse rather than replay from the state it had at the cursor's lsn.
  const patches = await deps.gate.filterPatches(entry, who, resumed.patches, new Set(cursor.ids));
  // Advanced over the FILTERED list, never over `resumed.cursor` — which `resumeFrom` built
  // by advancing across the retained window, and that window is PRE-POLICY. Seated as it
  // came back, this subscriber's `cursor.ids` gained the id of every row inserted for every
  // OTHER actor while it was away; `subscriber-gate` then reads `held.has(patch.id)` off it,
  // takes the "the subscriber holds this row" branch, and delivers a `delete` frame carrying
  // another tenant's row id and the instant it went. The leak that branch closes, re-opened
  // one layer up. `live-fanout.ts` advances over `allowed` for exactly this reason.
  const seated = advance(cursor, patches, resumed.cursor.lsn, now);
  return {
    cursor: seated,
    frame: { type: 'patch', v: PROTOCOL_VERSION, sid: who.sid, patches, lsn: seated.lsn },
  };
}
