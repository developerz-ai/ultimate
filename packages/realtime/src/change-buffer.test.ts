// The retained window is memory, so it is bounded by BYTES. `packages/cache/src/lru.ts:1-2` states
// the rule the entry-count budget here broke: "an entry count budget is a memory leak with extra
// steps" — 4,096 queries x 1,024 patches is 4.19M retained `RowPatch` objects, each holding a row.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_MAX_BUFFER_BYTES, RingChangeBuffer } from './change-buffer';
import type { RowPatch } from './json';

function patchOf(lsn: number, size: number): RowPatch {
  return {
    op: 'insert',
    id: `row-${lsn}`,
    row: { id: `row-${lsn}`, blob: 'x'.repeat(size) },
    lsn: String(lsn).padStart(16, '0'),
  };
}

const lsnOf = (position: number): string => String(position).padStart(16, '0');

describe('the retained change window', () => {
  test('a single query is bounded by bytes, not by a patch count', () => {
    const buffer = new RingChangeBuffer({ maxBytesPerQuery: 4_000 });
    for (let i = 1; i <= 100; i += 1) buffer.append('q1', patchOf(i, 1_000));
    // Ten 1KB patches would be well inside the 1,024-patch count budget and 100KB of heap.
    expect(buffer.bytes).toBeLessThanOrEqual(4_000);
    // A cursor just behind the head still resumes from the retained tail.
    const kept = buffer.since('q1', String(98).padStart(16, '0')) ?? [];
    expect(kept.map((patch) => patch.id)).toEqual(['row-99', 'row-100']);
    // What fell out is not silently replayable: a cursor below the eviction point re-snapshots.
    expect(buffer.since('q1', String(1).padStart(16, '0'))).toBeNull();
  });

  test('the node total is bounded across queries, and evicts the least recently written', () => {
    const buffer = new RingChangeBuffer({ maxBytes: 20_000, maxBytesPerQuery: 8_000 });
    for (let q = 0; q < 50; q += 1) buffer.append(`q${q}`, patchOf(q + 1, 2_000));
    expect(buffer.bytes).toBeLessThanOrEqual(20_000);
    expect(buffer.queryCount).toBeLessThanOrEqual(10);
    // The most recent write survives; the first one is long gone.
    expect(buffer.since('q49', lsnOf(50))).not.toBeNull();
    expect(buffer.since('q0', lsnOf(1))).toBeNull();
  });

  test('forget releases the bytes as well as the ring', () => {
    const buffer = new RingChangeBuffer();
    buffer.append('q1', patchOf(1, 500));
    expect(buffer.bytes).toBeGreaterThan(0);
    buffer.forget('q1');
    expect(buffer.queryCount).toBe(0);
    expect(buffer.bytes).toBe(0);
    expect(buffer.since('q1', '0'.repeat(16))).toBeNull();
  });

  test('a ring re-created after forget does not claim the window it never held', () => {
    // The gap `since` could not see: `forget` deleted `evictedThrough` with the ring, so the next
    // `append` built one that reported itself complete from the beginning of the stream.
    const buffer = new RingChangeBuffer();
    buffer.append('q1', patchOf(1, 10));
    buffer.append('q1', patchOf(2, 10));
    buffer.forget('q1');
    buffer.append('q1', patchOf(9, 10));

    // lsn 2 was dropped and nothing will ever replay it, so a cursor from before lsn 9 must
    // re-snapshot rather than fold lsn 9 onto a window that stopped at lsn 1.
    expect(buffer.since('q1', String(1).padStart(16, '0'))).toBeNull();
    expect(buffer.since('q1', String(8).padStart(16, '0'))).toBeNull();
    // A cursor at the ring's own first patch has already applied it; everything after is retained.
    expect(buffer.since('q1', String(9).padStart(16, '0'))).toEqual([]);
  });

  test('the LRU eviction of a live query is a forget, not a silent restart', () => {
    // The LRU path fires on a query that still has subscribers, and it took the same `forget`.
    const buffer = new RingChangeBuffer({ maxQueries: 2 });
    buffer.append('q1', patchOf(1, 10));
    buffer.append('q2', patchOf(2, 10));
    buffer.append('q3', patchOf(3, 10));
    expect(buffer.since('q1', String(1).padStart(16, '0'))).toBeNull();

    buffer.append('q1', patchOf(7, 10));
    expect(buffer.since('q1', String(1).padStart(16, '0'))).toBeNull();
    expect(buffer.since('q1', String(7).padStart(16, '0'))).toEqual([]);
  });

  test('a ring born from a patch is complete from that patch, never from the start of time', () => {
    // The rolling-deploy shape: a client held this query on ANOTHER node at lsn 1, that node
    // drained, changes 2..4 happened where this node had no entry, and the first change this node
    // retains is 5. `since` answered `[5]` — a delta onto a window missing three changes.
    const buffer = new RingChangeBuffer();
    buffer.append('q1', patchOf(5, 10));
    expect(buffer.since('q1', lsnOf(1))).toBeNull();
    expect(buffer.since('q1', lsnOf(4))).toBeNull();
    expect(buffer.since('q1', lsnOf(5))).toEqual([]);
    buffer.append('q1', patchOf(6, 10));
    expect((buffer.since('q1', lsnOf(5)) ?? []).map((patch) => patch.id)).toEqual(['row-6']);
  });

  test('a ring floored at the window read serves every cursor minted from that read', () => {
    // What a cold subscriber on THIS node holds: a cursor at the lsn its snapshot was read at,
    // which is before the first change. The floor is that lsn, so it resumes as a delta — and a
    // cursor from before the read still does not.
    const buffer = new RingChangeBuffer();
    buffer.floorAt('q1', lsnOf(3));
    expect(buffer.since('q1', lsnOf(3))).toEqual([]);
    expect(buffer.since('q1', lsnOf(2))).toBeNull();
    buffer.append('q1', patchOf(5, 10));
    expect((buffer.since('q1', lsnOf(3)) ?? []).map((patch) => patch.id)).toEqual(['row-5']);
    expect(buffer.since('q1', lsnOf(2))).toBeNull();
  });

  test('a re-read raises the floor and drops what it superseded', () => {
    // A window marked stale was re-read at lsn 9 BECAUSE changes were missed: the ring's patches
    // up to there are a history with a hole in it, and must not be served as one without.
    const buffer = new RingChangeBuffer();
    buffer.floorAt('q1', lsnOf(1));
    buffer.append('q1', patchOf(2, 10));
    buffer.append('q1', patchOf(3, 10));
    const before = buffer.bytes;
    buffer.floorAt('q1', lsnOf(9));
    expect(buffer.bytes).toBeLessThan(before);
    expect(buffer.since('q1', lsnOf(2))).toBeNull();
    expect(buffer.since('q1', lsnOf(9))).toEqual([]);
    // Never lowered: an older read landing late claims nothing back.
    buffer.floorAt('q1', lsnOf(4));
    expect(buffer.since('q1', lsnOf(5))).toBeNull();
  });

  test('a window with no position yet floors nothing', () => {
    const buffer = new RingChangeBuffer();
    buffer.floorAt('q1', '');
    expect(buffer.queryCount).toBe(0);
    buffer.append('q1', patchOf(5, 10));
    expect(buffer.since('q1', lsnOf(1))).toBeNull();
  });

  test('a floored ring with no patches is still bounded by the query ceiling', () => {
    const buffer = new RingChangeBuffer({ maxQueries: 2 });
    for (let q = 0; q < 50; q += 1) buffer.floorAt(`q${q}`, lsnOf(q + 1));
    expect(buffer.queryCount).toBeLessThanOrEqual(2);
    // The evicted one reads as unknown, which is a snapshot — never a delta it cannot back.
    expect(buffer.since('q0', lsnOf(1))).toBeNull();
    expect(buffer.since('q49', lsnOf(50))).toEqual([]);
  });

  test('the default node budget is a real memory ceiling, not a patch count', () => {
    expect(DEFAULT_MAX_BUFFER_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_BUFFER_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024);
  });
});
