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
import type { RowPatch } from './json';
import type { SnapshotResult } from './live-contract';
import { type NamedWrite, patchFrame, snapshotFrame } from './live-fanout';
import { fillWindow, type QueryEntry } from './query-window';
import type { Subscriber, SubscriberGate } from './subscriber-gate';
import type { Frame } from './sync-protocol';

export interface ResumeOntoDeps {
  readonly source: ResumeSource;
  readonly budget?: ReconnectBudget | undefined;
  readonly clock: Clock;
  readonly gate: SubscriberGate;
  /** The window, read once for the entry and filtered for THIS subscriber. */
  read(): Promise<SnapshotResult>;
  /** Called before the delta path fills an unread entry — a database read the caller pays for. */
  beforeFill?(): Promise<void>;
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
    // Read after every retained patch, so it holds their writes; `snapshotFrame` names only those
    // behind a row this subscriber was given. Out of the ring's window there is nothing to name,
    // and a write left unnamed settles on its own HTTP answer.
    const named = retainedWrites(deps.source.since(entry.qid, cursor.lsn) ?? []);
    return {
      cursor: resumed.cursor,
      frame: snapshotFrame(entry, who.sid, resumed.rows, resumed.cursor, named),
    };
  }
  // The gate decides about whole rows out of the shared window, and an entry nothing has read
  // yet has none — every patch would meet an empty window and be withheld. Filling is
  // conditional on purpose: a restart storm resumes onto entries that already hold a live
  // window, and re-reading per resuming subscriber is the cost a delta resume exists to skip.
  if (entry.lsn === '') {
    await deps.beforeFill?.();
    await fillWindow(entry);
  }
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
  const { bare, writes } = namedWrites(patches);
  return { cursor: seated, frame: patchFrame(who.sid, bare, seated.lsn, writes) };
}

/**
 * The writes behind the patches this subscriber is sent, each named once, and the patches as the
 * wire spells them. Read off the FILTERED list: a write behind a row the gate withheld is another
 * actor's, and naming it here would tell this page that write happened.
 */
function namedWrites(patches: readonly RowPatch[]): {
  readonly bare: readonly RowPatch[];
  readonly writes: readonly string[];
} {
  const writes = new Set<string>();
  const bare = patches.map((patch) => {
    if (patch.write === undefined) return patch;
    writes.add(patch.write);
    const { write: _named, ...rest } = patch;
    return rest;
  });
  return { bare, writes: [...writes] };
}

/** Each retained write, by the record key of the row its patch made. */
function retainedWrites(patches: readonly RowPatch[]): readonly NamedWrite[] {
  const named: NamedWrite[] = [];
  for (const patch of patches) {
    if (patch.write !== undefined) named.push({ write: patch.write, key: patch.key ?? patch.id });
  }
  return named;
}
