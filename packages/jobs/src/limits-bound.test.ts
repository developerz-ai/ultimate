// The limiter's per-tenant state is BOUNDED. It was four maps with no sweep and no cap in a
// process that never restarts: `bump(…, -1)` wrote `0` and kept the key, `refusals` cleared only on
// a matching acquire, and `starts` held an array per tenant forever — so self-service org creation
// added four permanent entries per org to every worker.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { createLimiter, DEFAULT_MAX_LIMIT_TENANTS } from './limits';

const T0 = Date.UTC(2026, 0, 1);

// The clock below is core's own `frozenClock`, never a local `{ now, advance }` cast to `Clock`:
// that double is missing `monotonic()`, and a test double that lies about the interface it
// implements is the one kind of double a suite may not carry.

describe('the concurrency counters are bounded by what is in flight', () => {
  test('a released slot leaves NO entry behind — zero and absent are the same answer', () => {
    const limiter = createLimiter({ perTenant: 2 });
    const lease = limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' });
    expect(limiter.snapshot().byTenant['org-1']).toBe(1);

    lease?.release();
    // The defect: `0` was stored under `org-1`, and one org that ever ran one job was one
    // permanent key. The count it answers is unchanged either way.
    expect(Object.keys(limiter.snapshot().byTenant)).toEqual([]);
    expect(Object.keys(limiter.snapshot().byQueue)).toEqual([]);
    expect(limiter.inFlight({ queue: 'default', tenantId: 'org-1' })).toBe(0);
  });

  test('ten thousand one-job tenants leave ten thousand nothing', () => {
    const limiter = createLimiter({ perTenant: 2 });
    for (let index = 0; index < 10_000; index += 1) {
      limiter.tryAcquire({ queue: 'default', tenantId: `org-${index}` })?.release();
    }
    expect(Object.keys(limiter.snapshot().byTenant)).toHaveLength(0);
  });
});

describe('the rate window and the refusal log are swept and capped', () => {
  test('a spent rate window is forgotten, not kept as an empty array', () => {
    const clock = frozenClock(T0);
    const limiter = createLimiter({ ratePerTenant: { limit: 2, windowMs: 1_000 } }, clock);

    for (let index = 0; index < 500; index += 1) {
      limiter.tryAcquire({ queue: 'default', tenantId: `org-${index}` })?.release();
    }
    expect(limiter.snapshot().tracked.rateWindows).toBe(500);

    // Past the window every one of those is indistinguishable from a tenant that never ran.
    clock.advance(61_000);
    limiter.tryAcquire({ queue: 'default', tenantId: 'org-fresh' })?.release();
    expect(limiter.snapshot().tracked.rateWindows).toBe(1);
  });

  test('a stale refusal answers as a missing one, and the sweep drops it', () => {
    const clock = frozenClock(T0);
    const limiter = createLimiter({ perTenant: 0 }, clock);

    expect(limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' })).toBeUndefined();
    expect(limiter.blockedBy({ queue: 'default', tenantId: 'org-1' })).toBe('per-tenant');

    clock.advance(61_000);
    // The refusal explained a decision nobody is looking at any more.
    expect(limiter.blockedBy({ queue: 'default', tenantId: 'org-1' })).toBeUndefined();
    limiter.tryAcquire({ queue: 'default', tenantId: 'org-2' });
    expect(limiter.snapshot().tracked.refusals).toBe(1);
  });

  test('the cap holds even when nothing has expired — one org per request cannot grow the heap', () => {
    const clock = frozenClock(T0);
    const limiter = createLimiter(
      { perTenant: 0, ratePerTenant: { limit: 2, windowMs: 3_600_000 } },
      clock,
      { maxTenants: 100 },
    );

    // Every one of these is refused, so each mints a refusal entry; none is old enough to expire.
    for (let index = 0; index < 5_000; index += 1) {
      limiter.tryAcquire({ queue: 'default', tenantId: `org-${index}` });
      clock.advance(1);
    }
    expect(limiter.snapshot().tracked.refusals).toBeLessThanOrEqual(100);
  });

  test('the cap evicts the LEAST throttled window first — a full one is never a free reset', () => {
    const clock = frozenClock(T0);
    const limiter = createLimiter({ ratePerTenant: { limit: 5, windowMs: 3_600_000 } }, clock, {
      maxTenants: 4,
    });

    // `org-hot` spends four of its five starts; everyone else spends one.
    for (let index = 0; index < 4; index += 1) {
      limiter.tryAcquire({ queue: 'default', tenantId: 'org-hot' })?.release();
    }
    for (let index = 0; index < 20; index += 1) {
      limiter.tryAcquire({ queue: 'default', tenantId: `org-${index}` })?.release();
      clock.advance(1);
    }

    const tracked = limiter.snapshot().tracked;
    expect(tracked.rateWindows).toBeLessThanOrEqual(4);
    // Evicting it would hand the busiest tenant its whole allowance back.
    expect(limiter.snapshot().tracked.rateWindows).toBeGreaterThan(0);
    for (let index = 0; index < 2; index += 1) {
      limiter.tryAcquire({ queue: 'default', tenantId: 'org-hot' })?.release();
    }
    expect(limiter.tryAcquire({ queue: 'default', tenantId: 'org-hot' })).toBeUndefined();
  });

  test('a cap that is not a finite number is refused where it is written, not at the first claim', () => {
    // `Math.floor(NaN)` is `NaN` and `Math.floor(Infinity)` is `Infinity`, so every `size > cap`
    // below reads FALSE and the option quietly means "no cap at all" — the setting this bound
    // exists to make unreachable. `Number(process.env.WHATEVER)` is how a deploy writes the first.
    for (const maxTenants of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => createLimiter({}, frozenClock(T0), { maxTenants })).toThrow(/maxTenants/);
    }
    // The default is still a number a limiter can be built with, so the guard refuses the bad
    // value rather than the option.
    expect(() =>
      createLimiter({}, frozenClock(T0), { maxTenants: DEFAULT_MAX_LIMIT_TENANTS }),
    ).not.toThrow();
  });
});
