/**
 * The bound, and the honesty about it. Every other memory implementation in this framework is
 * capped and says so — `memoryRateLimitStore`, `MemoryIdempotencyStore`, `createLimiter`,
 * `createTotpReplayGuard`, `createMemoryEventBus` — and this sink was the outlier: a plain array
 * with a `push`, retaining a whole `Ctx` per record. 50 audited writes a second is 4.3M immortal
 * records a day, and the pod OOMs holding the trail it was retaining.
 */

import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import type { AuditRecord } from './audit';
import { DEFAULT_MAX_AUDIT_RECORDS, memoryAuditSink } from './audit-memory';

const recordAt = (n: number): AuditRecord => ({
  at: new Date(1_700_000_000_000 + n),
  action: `act${n}`,
  mutator: false,
  surface: 'http',
  // A fresh context per record, so an evicted one is identifiable by IDENTITY.
  ctx: createContext({ actor: userActor({ id: `u${n}` }) }),
  input: { n },
  idempotencyKey: null,
  replayed: false,
  outcome: 'allowed',
  failure: null,
});

describe('the memory audit sink is bounded, and says which records it dropped', () => {
  test('it keeps its cap and no more, however many are written', () => {
    const sink = memoryAuditSink({ maxRecords: 4 });
    for (let n = 0; n < 100; n += 1) sink.write(recordAt(n));

    expect(sink.records()).toHaveLength(4);
    expect(sink.size).toBe(4);
  });

  test('the NEWEST survive — a sink that stopped recording would read as "nothing happened"', () => {
    const sink = memoryAuditSink({ maxRecords: 3 });
    for (let n = 0; n < 10; n += 1) sink.write(recordAt(n));

    expect(sink.records().map((record) => record.action)).toEqual(['act7', 'act8', 'act9']);
  });

  /**
   * The whole point of the bound: a record is not merely unreadable, its `Ctx` is unreachable.
   * Asserted by IDENTITY rather than through a `WeakRef` + `Bun.gc` — the sink has exactly one
   * structure, so "no retained record holds this object" is the whole of what it can retain, and
   * a gc-dependent assertion is a flake rather than a proof.
   */
  test('an evicted record’s Ctx is held by nothing the sink still owns', () => {
    const sink = memoryAuditSink({ maxRecords: 2 });
    const first = recordAt(0);
    sink.write(first);
    for (let n = 1; n < 20; n += 1) sink.write(recordAt(n));

    expect(sink.records().some((record) => record.ctx === first.ctx)).toBe(false);
    expect(sink.records().some((record) => record === first)).toBe(false);
  });

  test('it COUNTS what it discarded, so "it drops" is a number and not a comment', () => {
    const sink = memoryAuditSink({ maxRecords: 5 });
    for (let n = 0; n < 12; n += 1) sink.write(recordAt(n));

    expect(sink.dropped).toBe(7);
    expect(sink.dropped + sink.size).toBe(12);
  });

  test('clear() forgets the drop count too — a cleared sink has discarded nothing', () => {
    const sink = memoryAuditSink({ maxRecords: 1 });
    for (let n = 0; n < 5; n += 1) sink.write(recordAt(n));
    expect(sink.dropped).toBe(4);

    sink.clear();
    expect(sink.records()).toEqual([]);
    expect(sink.size).toBe(0);
    expect(sink.dropped).toBe(0);
  });

  test('the default cap is a real number, and an unusable one falls back to it', () => {
    expect(DEFAULT_MAX_AUDIT_RECORDS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_AUDIT_RECORDS)).toBe(true);
    // `0`, a negative and a NaN are all "no bound at all" read as a number, which is the defect.
    for (const maxRecords of [0, -1, Number.NaN]) {
      const sink = memoryAuditSink({ maxRecords });
      for (let n = 0; n < 3; n += 1) sink.write(recordAt(n));
      expect(sink.size).toBeGreaterThan(0);
      expect(sink.size).toBeLessThanOrEqual(DEFAULT_MAX_AUDIT_RECORDS);
    }
  });
});
