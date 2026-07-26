import { describe, expect, test } from 'bun:test';
import { type Clock, frozenClock } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { formatLsn } from './changefeed';
import { defaultReconnectBudget, digestOf, makeCursor, resumeFrom, verifyDigest } from './cursor';
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
    expect(verifyDigest(result.cursor, snapshotRows)).toBe(true);
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

  test('the digest is order-sensitive, so a re-sort is detected', () => {
    const a: Row[] = [{ id: 'p1' }, { id: 'p2' }];
    const b: Row[] = [{ id: 'p2' }, { id: 'p1' }];
    expect(digestOf(a)).not.toBe(digestOf(b));
  });
});
