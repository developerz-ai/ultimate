// `ratePerTenant` at the size a busy tenant reaches: the window was COPIED and filtered on every
// acquire, so a window of n stamps cost O(n) per claim — 20k acquires were 3.9 s of event loop.
// The window is a queue with a head now; this holds its cost, counted, and its answers.

import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { concurrencyLimiter } from './limits';

const T0 = 1_760_000_000_000;

/** Its `Date` is built on `advance`, never on a read: a read is part of the work counted below. */
function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  let reading = new Date(current);
  return {
    now: () => reading,
    advance(ms: number) {
      current += ms;
      reading = new Date(current);
    },
  } as Clock & { advance(ms: number): void };
}

const N = 20_000;

/** Every array built-in that walks or copies elements: the shapes an O(n)-per-claim window took. */
const WALKS = [
  'filter',
  'slice',
  'splice',
  'map',
  'concat',
  'indexOf',
  'lastIndexOf',
  'includes',
  'find',
  'findIndex',
  'some',
  'every',
  'reduce',
  'forEach',
] as const;

/**
 * Elements the array built-ins visit while `run` runs: each walk counts the array's length, each
 * iterator step one. Work counted, never timed — a scheduler pause cannot move it.
 */
function arrayVisits(run: () => void): number {
  const proto = Array.prototype as unknown as Record<PropertyKey, unknown>;
  const saved = new Map<PropertyKey, unknown>();
  let visits = 0;
  for (const name of WALKS) {
    const original = proto[name] as (this: unknown[], ...args: unknown[]) => unknown;
    saved.set(name, original);
    proto[name] = function counted(this: unknown[], ...args: unknown[]): unknown {
      visits += this.length;
      return original.apply(this, args);
    };
  }
  const iterate = Array.prototype[Symbol.iterator];
  saved.set(Symbol.iterator, iterate);
  proto[Symbol.iterator] = function counted(this: unknown[]) {
    const walk = iterate.call(this);
    return {
      next: () => {
        visits += 1;
        return walk.next();
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  };
  try {
    run();
  } finally {
    for (const [name, original] of saved) proto[name] = original;
  }
  return visits;
}

describe('a large rate window', () => {
  // Judged by the work done, never the clock: a window COPIED or filtered per claim visits every
  // stamp it holds, so the last quarter of the acquires (a window of 3N/4 stamps) visits ~N²/5
  // elements; a head-indexed queue visits none, and its compaction at most one per claim.
  test(`${N} acquires in one window are linear, and the next one is refused`, () => {
    const clock = fakeClock(T0);
    const limiter = concurrencyLimiter({ ratePerTenant: { limit: N, windowMs: 60_000 } }, clock);
    const quarter = N / 4;
    const quarters: number[] = [];
    let refused = -1;
    for (let at = 0; at < 4 && refused < 0; at += 1) {
      quarters.push(
        arrayVisits(() => {
          for (let index = at * quarter; index < (at + 1) * quarter; index += 1) {
            const lease = limiter.tryAcquire({ queue: 'q', tenantId: 'org' });
            if (lease === undefined) {
              refused = index;
              return;
            }
            lease.release();
            if (index % 10 === 0) clock.advance(1);
          }
        }),
      );
    }
    expect(refused).toBe(-1);
    for (const visits of quarters) expect(visits).toBeLessThanOrEqual(quarter);
    expect(limiter.tryAcquire({ queue: 'q', tenantId: 'org' })).toBeUndefined();
    expect(limiter.blockedBy({ queue: 'q', tenantId: 'org' })).toBe('rate');
  });

  test(`a window sliding through ${N} stamps compacts in O(1) a claim`, () => {
    const clock = fakeClock(T0);
    // ~5,000 stamps live at once, every one leaving: the spent prefix is compacted over and over.
    const limiter = concurrencyLimiter({ ratePerTenant: { limit: N, windowMs: 500 } }, clock);
    const claims = 4 * N;
    const visits = arrayVisits(() => {
      for (let index = 0; index < claims; index += 1) {
        limiter.tryAcquire({ queue: 'q', tenantId: 'org' })?.release();
        if (index % 10 === 0) clock.advance(1);
      }
    });
    // A compaction copies the live half of an array at most twice its size, and is counted at the
    // whole length: ~2 a claim, amortised. A filter per claim would be ~5,000.
    expect(visits).toBeLessThanOrEqual(4 * claims);
  });

  test('stamps leave the window as it slides, a few at a time', () => {
    const clock = fakeClock(T0);
    const limiter = concurrencyLimiter({ ratePerTenant: { limit: 3, windowMs: 100 } }, clock);
    const take = () => limiter.tryAcquire({ queue: 'q', tenantId: 'org' });
    take()?.release();
    clock.advance(40);
    take()?.release();
    clock.advance(40);
    take()?.release();
    expect(take()).toBeUndefined();
    // The first stamp (T0) is out at T0 + 100: exactly one slot frees.
    clock.advance(20);
    expect(take()).toBeDefined();
    expect(take()).toBeUndefined();
    clock.advance(40);
    expect(take()).toBeDefined();
  });

  test('abandon hands back its stamp out of a large window, and only one', () => {
    const clock = fakeClock(T0);
    const limiter = concurrencyLimiter(
      { ratePerTenant: { limit: 5_000, windowMs: 60_000 } },
      clock,
    );
    const leases = Array.from({ length: 5_000 }, (_, index) => {
      if (index % 100 === 0) clock.advance(1);
      return limiter.tryAcquire({ queue: 'q', tenantId: 'org' });
    });
    expect(limiter.tryAcquire({ queue: 'q', tenantId: 'org' })).toBeUndefined();
    leases[2_500]?.abandon();
    leases[2_500]?.abandon();
    expect(limiter.tryAcquire({ queue: 'q', tenantId: 'org' })).toBeDefined();
    expect(limiter.tryAcquire({ queue: 'q', tenantId: 'org' })).toBeUndefined();
  });
});
