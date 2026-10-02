// What a window read that just returned owes the retained ring, and the position the subscriber it
// serves is told. The rule itself is `change-buffer.ts`'s (`Ring`); this is its one caller for a
// read, split from `live-query.ts` at that file's size ceiling.

import type { ResumeSource } from './cursor';
import type { FilledWindow, QueryEntry } from './query-window';

export interface NodePosition {
  /** The newest change this node has received; `''` before the first. */
  readonly lastLsn: string;
  /** This node's own mark for a read with no position behind it. Sorts below every real lsn. */
  readonly origin: string;
}

/**
 * Synchronous on purpose: the caller awaits a policy pass next, and the position has to be the
 * one these ROWS were read at — read after that await, a change folded in meanwhile would be
 * claimed by a snapshot that does not hold it.
 */
export function floorAfterRead(
  source: ResumeSource,
  entry: QueryEntry,
  window: FilledWindow,
  node: NodePosition,
): string {
  // Served out of a window that was already filled: its patch history is still true.
  if (window.landed === null) return window.lsn;
  // A read with no position behind it is marked with this node's own origin, so the cursor it
  // mints is one no other node could have issued.
  const lsn = window.lsn === '' ? node.origin : window.lsn;
  if (entry.lsn === '') entry.lsn = lsn;
  if (window.landed === 'forced') source.floorAt?.(entry.qid, lsn, { exclusive: true });
  else source.floorAt?.(entry.qid, lsn, { sole: node.lastLsn === '' || window.lsn === '' });
  return lsn;
}
