// `ratePerTenant` at the size a busy tenant reaches: the window was COPIED and filtered on every
// acquire, so a window of n stamps cost O(n) per claim — 20k acquires were 3.9 s of event loop.
// The window is a queue with a head now; this holds its cost and its answers.

import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { concurrencyLimiter } from './limits';

const T0 = 1_760_000_000_000;

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

const N = 20_000;

describe('a large rate window', () => {
  test(`${N} acquires in one window are linear, and the next one is refused`, () => {
    const clock = fakeClock(T0);
    const limiter = concurrencyLimiter({ ratePerTenant: { limit: N, windowMs: 60_000 } }, clock);
    const started = performance.now();
    for (let index = 0; index < N; index += 1) {
      const lease = limiter.tryAcquire({ queue: 'q', tenantId: 'org' });
      if (lease === undefined) return expect.unreachable(`acquire ${index} was refused`);
      lease.release();
      if (index % 10 === 0) clock.advance(1);
    }
    // Was ~3.9 s. Budgeted at 250 ms, not the 100 ms measured headroom, so a loaded CI runner is
    // not a red build; a quadratic window is an order of magnitude past either.
    expect(performance.now() - started).toBeLessThan(250);
    expect(limiter.tryAcquire({ queue: 'q', tenantId: 'org' })).toBeUndefined();
    expect(limiter.blockedBy({ queue: 'q', tenantId: 'org' })).toBe('rate');
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
