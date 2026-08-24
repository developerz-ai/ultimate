// Reconnect. The highest-risk surface in the framework: a deploy drops N sockets at once and
// every one of them asks "what changed since X?". The cursor exists to make that answer cheap,
// and the budget exists to make the expensive answer (a snapshot) the *chosen* one, not the
// accidental one. See README "Reconnect is the hard part".

import { type Clock, systemClock } from '@ultimat3/core';
import { CursorStaleError } from './errors';
import type { Row, RowPatch } from './json';

/** Ids are bounded so a cursor stays small enough to ship on every `subscribe` frame. */
export const CURSOR_ID_LIMIT = 512;

/**
 * What a resume decides from, and nothing else. `digest` and `count` were here until 2026-08-24
 * and were written by every snapshot, encoded and validated on every `subscribe` frame, and read
 * by nothing — the same shape `verifyDigest()` was deleted for one release earlier, one field
 * down. `digest` cost a `canonicalJson` plus a hash over EVERY ROW of every snapshot, paid once
 * per live query per reconnecting socket in the restart storm this package is measured on; and
 * `count` would have been wrong had it ever gained a reader, because `advance` seeds its set from
 * the already-truncated `ids`, so a delete of a row past `CURSOR_ID_LIMIT` never decremented it.
 */
export interface LiveCursor {
  readonly qid: string;
  /** Last lsn the subscriber has applied. Lexicographically comparable (see `formatLsn`). */
  readonly lsn: string;
  /** Last-seen row ids, truncated at `CURSOR_ID_LIMIT`. */
  readonly ids: readonly string[];
  readonly at: number;
}

export interface ReconnectBudget {
  /** Hard ceiling on replayed patches, independent of the cost model. */
  readonly maxPatches: number;
  /** A cursor older than this is presumed to have drifted; re-snapshot instead of trusting it. */
  readonly maxLagMs: number;
  /** Cost of one snapshot, expressed in replayed-patch equivalents. This is the crossover point. */
  readonly snapshotCost: number;
  readonly patchCost: number;
}

/**
 * 250 patch-equivalents per snapshot is the measured-intent default: a bounded `orderBy + limit`
 * snapshot is one indexed query, a patch is one buffer read plus one frame. Replaying more than
 * ~250 patches costs more wall-clock *and* more client work than starting over.
 */
export const defaultReconnectBudget: ReconnectBudget = {
  maxPatches: 500,
  maxLagMs: 5 * 60_000,
  snapshotCost: 250,
  patchCost: 1,
};

export type ResumeReason =
  | 'in-window'
  | 'unknown-query'
  | 'out-of-window'
  | 'lag-exceeded'
  | 'budget-exceeded';

export interface ResumeDecision {
  readonly resnapshot: boolean;
  readonly reason: ResumeReason;
  /** Replay cost in patch-equivalents, for logs and the reconnect benchmark. */
  readonly cost: number;
}

/** Retained-change source behind a resume. Implemented by `RingChangeBuffer` in the replicator. */
export interface ResumeSource {
  append(qid: string, patch: RowPatch): void;
  /** Patches strictly after `lsn`, or `null` when the gap is not covered by the retained window. */
  since(qid: string, lsn: string): RowPatch[] | null;
  headLsn(qid: string): string | null;
  /**
   * The last subscriber of this query went away, so nothing will ever resume from its retained
   * patches. Optional because a source may retain nothing; the registry calls it when it drops
   * the entry, which is the only moment anything knows the window is unreachable.
   */
  forget?(qid: string): void;
}

export type ResumeResult<R extends Row = Row> =
  | { readonly kind: 'delta'; readonly patches: readonly RowPatch[]; readonly cursor: LiveCursor }
  | { readonly kind: 'snapshot'; readonly rows: readonly R[]; readonly cursor: LiveCursor };

export interface ResumeDeps<R extends Row = Row> {
  readonly source: ResumeSource;
  /** Bounded re-read of the query at a current lsn. Omit only if a stale cursor should throw. */
  readonly snapshot?: (qid: string) => Promise<{ rows: readonly R[]; lsn: string }>;
  readonly budget?: ReconnectBudget;
  readonly clock?: Clock;
}

export function makeCursor(
  qid: string,
  lsn: string,
  rows: readonly Row[],
  now: number,
): LiveCursor {
  return {
    qid,
    lsn,
    ids: rows.slice(0, CURSOR_ID_LIMIT).map((r) => r.id),
    at: now,
  };
}

export function shouldResnapshot(
  cursor: LiveCursor,
  available: readonly RowPatch[] | null,
  now: number,
  budget: ReconnectBudget = defaultReconnectBudget,
): ResumeDecision {
  if (available === null) {
    return { resnapshot: true, reason: 'out-of-window', cost: budget.snapshotCost };
  }
  if (now - cursor.at > budget.maxLagMs) {
    return { resnapshot: true, reason: 'lag-exceeded', cost: budget.snapshotCost };
  }
  const cost = available.length * budget.patchCost;
  if (available.length > budget.maxPatches || cost > budget.snapshotCost) {
    return { resnapshot: true, reason: 'budget-exceeded', cost };
  }
  return { resnapshot: false, reason: 'in-window', cost };
}

/**
 * The reconnect entry point. Cheap path = replay the retained window. Fallback = one bounded
 * snapshot. There is deliberately no third path: WAL history traversal is what turns a rolling
 * restart into a self-inflicted outage.
 */
export async function resumeFrom<R extends Row = Row>(
  cursor: LiveCursor,
  deps: ResumeDeps<R>,
): Promise<ResumeResult<R>> {
  const clock = deps.clock ?? systemClock;
  const budget = deps.budget ?? defaultReconnectBudget;
  const now = clock.now().getTime();
  const available = deps.source.since(cursor.qid, cursor.lsn);
  const decision = shouldResnapshot(cursor, available, now, budget);

  if (!decision.resnapshot && available !== null) {
    const head = deps.source.headLsn(cursor.qid) ?? cursor.lsn;
    return { kind: 'delta', patches: available, cursor: advance(cursor, available, head, now) };
  }

  if (!deps.snapshot) {
    throw new CursorStaleError({ qid: cursor.qid, lsn: cursor.lsn, reason: decision.reason });
  }
  const fresh = await deps.snapshot(cursor.qid);
  return {
    kind: 'snapshot',
    rows: fresh.rows,
    cursor: makeCursor(cursor.qid, fresh.lsn, fresh.rows, now),
  };
}

/** Advance a cursor across a delta without re-reading rows: ids are patchable. */
export function advance(
  cursor: LiveCursor,
  patches: readonly RowPatch[],
  lsn: string,
  now: number,
): LiveCursor {
  const ids = new Set(cursor.ids);
  for (const patch of patches) {
    if (patch.op === 'delete') ids.delete(patch.id);
    else if (patch.op === 'insert') ids.add(patch.id);
  }
  return {
    qid: cursor.qid,
    lsn,
    ids: [...ids].slice(0, CURSOR_ID_LIMIT),
    at: now,
  };
}
