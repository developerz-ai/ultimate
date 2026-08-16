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
    expect(buffer.since('q49', '0'.repeat(16))).not.toBeNull();
    expect(buffer.since('q0', '0'.repeat(16))).toBeNull();
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

  test('the default node budget is a real memory ceiling, not a patch count', () => {
    expect(DEFAULT_MAX_BUFFER_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_BUFFER_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024);
  });
});
