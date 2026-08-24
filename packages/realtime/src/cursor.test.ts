import { describe, expect, test } from 'bun:test';
import { type Clock, frozenClock } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { formatLsn } from './changefeed';
import { advance, defaultReconnectBudget, makeCursor, resumeFrom } from './cursor';
import { CursorStaleError } from './errors';
import type { Row, RowPatch } from './json';

const QID = 'liveFeed:abcd1234';

/** Reconnect decisions are time-dependent, so time is injected and never read from the wall. */
const at = (now: number): Clock => frozenClock(now);

function patchAt(position: number, id: string): RowPatch {
  return { op: 'update', id, row: { likes: position }, lsn: formatLsn(position) };
}

function fill(buffer: RingChangeBuffer, count: number, from = 1): void {
  for (let i = from; i < from + count; i += 1) buffer.append(QID, patchAt(i, `p${i}`));
}

const snapshotRows: readonly Row[] = [{ id: 'p1', likes: 99 }];
const snapshot = async () => ({ rows: snapshotRows, lsn: formatLsn(500) });

describe('cursor resume', () => {
  test('a small gap resumes as a delta — no DB work', async () => {
    const buffer = new RingChangeBuffer();
    fill(buffer, 3);
    const cursor = makeCursor(QID, formatLsn(0), [], 1_000);

    const result = await resumeFrom(cursor, { source: buffer, snapshot, clock: at(1_000) });

    expect(result.kind).toBe('delta');
    if (result.kind !== 'delta') throw new Error('unreachable');
    expect(result.patches.map((patch) => patch.id)).toEqual(['p1', 'p2', 'p3']);
    expect(result.cursor.lsn).toBe(formatLsn(3));
  });

  test('past the reconnect budget it takes the snapshot instead', async () => {
    const buffer = new RingChangeBuffer();
    fill(buffer, 40);
    const cursor = makeCursor(QID, formatLsn(0), [], 1_000);

    const budget = { ...defaultReconnectBudget, snapshotCost: 10 };
    const result = await resumeFrom(cursor, {
      source: buffer,
      snapshot,
      budget,
      clock: at(1_000),
    });

    expect(result.kind).toBe('snapshot');
    if (result.kind !== 'snapshot') throw new Error('unreachable');
    expect(result.rows).toEqual(snapshotRows);
    expect(result.cursor.lsn).toBe(formatLsn(500));
    // What a snapshot must seat is the id list a later delta patches — the whole of what a resume
    // reads. `digest` used to be asserted here and was deleted with the field it described.
    expect(result.cursor.ids).toEqual(['p1']);
  });

  test('a cursor whose gap fell out of the retained window re-snapshots', async () => {
    const buffer = new RingChangeBuffer({ capacity: 4 });
    fill(buffer, 12);
    const cursor = makeCursor(QID, formatLsn(1), [], 1_000);

    const result = await resumeFrom(cursor, { source: buffer, snapshot, clock: at(1_000) });

    expect(result.kind).toBe('snapshot');
  });

  test('a stale cursor with no snapshot path is a typed error, never a silent gap', async () => {
    const buffer = new RingChangeBuffer({ capacity: 2 });
    fill(buffer, 8);
    const cursor = makeCursor(QID, formatLsn(1), [], 1_000);

    await expect(resumeFrom(cursor, { source: buffer, clock: at(1_000) })).rejects.toThrow(
      CursorStaleError,
    );
  });

  test('a cursor older than the lag budget re-snapshots even inside the window', async () => {
    const buffer = new RingChangeBuffer();
    fill(buffer, 2);
    const cursor = makeCursor(QID, formatLsn(0), [], 0);

    const result = await resumeFrom(cursor, {
      source: buffer,
      snapshot,
      clock: at(defaultReconnectBudget.maxLagMs + 1),
    });

    expect(result.kind).toBe('snapshot');
  });
});

/**
 * `digest` and `count` were written on every snapshot and read by nothing outside these tests —
 * the same shape `verifyDigest()` was deleted for, one field down. `digestOf` ran `canonicalJson`
 * over every row of every snapshot, so 50,000 reconnecting sockets each paid a full serialize and
 * hash per live query for a value no client, no node and no test path consumed.
 */
describe('a cursor carries what a resume reads, and nothing else', () => {
  test('makeCursor answers exactly qid, lsn, ids and at', () => {
    const cursor = makeCursor(QID, formatLsn(1), [{ id: 'p1' }, { id: 'p2' }], 1_000);
    expect(Object.keys(cursor).sort()).toEqual(['at', 'ids', 'lsn', 'qid']);
  });

  test('advance answers the same four, and invents no count to drift', () => {
    const cursor = makeCursor(QID, formatLsn(1), [{ id: 'p1' }], 1_000);
    const next = advance(cursor, [patchAt(2, 'p2')], formatLsn(2), 2_000);
    expect(Object.keys(next).sort()).toEqual(['at', 'ids', 'lsn', 'qid']);
  });

  /**
   * The cost half, and the one a key check cannot make: `canonicalJson` recurses, so a `digestOf`
   * still on the snapshot path blows the stack on a row that refers to itself. A cursor that comes
   * back is a snapshot that serialized nothing.
   */
  test('a snapshot serializes no row — a cycle no hash could walk still answers a cursor', () => {
    const cyclic: Row = { id: 'p1' };
    (cyclic as Record<string, unknown>)['self'] = cyclic;
    expect(makeCursor(QID, formatLsn(1), [cyclic], 1_000).ids).toEqual(['p1']);
  });
});
