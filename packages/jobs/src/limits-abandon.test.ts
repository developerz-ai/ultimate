// `ratePerTenant` counts STARTS. A lease handed back for a run that never started — shed over a
// fleet cap, refused by its key, stranded by a lease-store failure — must take its stamp with it,
// or a tenant queued behind a full `job.concurrency` spends its whole window on sheds.

import { describe, expect, test } from 'bun:test';
import type { Clock, Ctx } from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from './driver';
import { concurrencyLimiter } from './limits';
import { createAdmission } from './worker-admit';
import type { FleetSlots, SlotGrant } from './worker-fleet-slots';

const T0 = 1_760_000_000_000;
const KEY = { queue: 'default', tenantId: 'org-1' };

function fakeClock(): Clock & { advance(ms: number): void } {
  let current = T0;
  return {
    now: () => new Date(current),
    monotonic: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('a lease abandoned before its run started', () => {
  test('pops its own rate stamp: three sheds leave the whole window', () => {
    const limiter = concurrencyLimiter(
      { ratePerTenant: { limit: 3, windowMs: 60_000 } },
      fakeClock(),
    );
    for (let shed = 0; shed < 3; shed += 1) limiter.tryAcquire(KEY)?.abandon();
    expect(limiter.snapshot().tracked.rateWindows).toBe(0);
    for (let start = 0; start < 3; start += 1) limiter.tryAcquire(KEY)?.release();
    expect(limiter.tryAcquire(KEY)).toBeUndefined();
    expect(limiter.blockedBy(KEY)).toBe('rate');
  });

  test('a run that STARTED keeps its stamp, and release() after abandon() frees nothing twice', () => {
    const clock = fakeClock();
    const limiter = concurrencyLimiter(
      { global: 2, ratePerTenant: { limit: 2, windowMs: 1_000 } },
      clock,
    );
    const started = limiter.tryAcquire(KEY);
    clock.advance(10);
    const shed = limiter.tryAcquire(KEY);
    shed?.abandon();
    shed?.release();
    shed?.abandon();
    expect(limiter.inFlight()).toBe(1);
    started?.release();
    started?.abandon();
    expect(limiter.inFlight()).toBe(0);
    // One stamp left — the started run's — so exactly one more start fits the window.
    expect(limiter.tryAcquire(KEY)).toBeDefined();
    expect(limiter.tryAcquire(KEY)).toBeUndefined();
  });

  test('takes ITS stamp and not a neighbour taken in the same millisecond', () => {
    const limiter = concurrencyLimiter(
      { ratePerTenant: { limit: 2, windowMs: 1_000 } },
      fakeClock(),
    );
    const a = limiter.tryAcquire(KEY);
    const b = limiter.tryAcquire(KEY);
    b?.abandon();
    a?.release();
    expect(limiter.tryAcquire(KEY)).toBeDefined();
    expect(limiter.tryAcquire(KEY)).toBeUndefined();
  });
});

const claimed = (id: string): ClaimedJob =>
  ({ id, name: 'capped', queue: 'default', tenantId: 'org-1', attempt: 1, claim: 1 }) as ClaimedJob;

function admission(grants: (SlotGrant | Error)[]) {
  const limiter = concurrencyLimiter(
    { ratePerTenant: { limit: 1, windowMs: 60_000 } },
    fakeClock(),
  );
  const driver = { name: 'fake', nack: () => Promise.resolve(true) } as unknown as JobDriver;
  const fleetSlots: FleetSlots = {
    acquire() {
      const next = grants.shift() ?? { outcome: 'granted' };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    startRenewal: () => () => undefined,
    release: () => Promise.resolve(),
  };
  const admit = createAdmission({
    driver,
    limiter,
    fleetSlots,
    workerId: 'w1',
    pollIntervalMs: 25,
    context: () => ({}) as Ctx,
  });
  return { admit, limiter };
}

describe('the admission hands the rate back with the slot', () => {
  test('a job shed over job.concurrency does not spend its tenant a start', async () => {
    const { admit, limiter } = admission([{ outcome: 'wait', limit: 1, key: undefined }]);
    expect((await admit(claimed('j1'), 'default', [])).kind).toBe('waiting');
    expect(limiter.inFlight()).toBe(0);
    // limit 1: the shed above was the tenant's whole window before the fix.
    expect((await admit(claimed('j1'), 'default', [])).kind).toBe('run');
  });

  test('a lease-store failure hands the rate back too', async () => {
    const { admit } = admission([new Error('57P01')]);
    let thrown: unknown;
    try {
      await admit(claimed('j1'), 'default', []);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe('57P01');
    expect((await admit(claimed('j1'), 'default', [])).kind).toBe('run');
  });

  test('an undecidable key STARTS — the attempt fails in executeJob — and keeps its stamp', async () => {
    const { admit } = admission([{ outcome: 'undecidable', error: new Error('no key') }]);
    const first = await admit(claimed('j1'), 'default', []);
    expect(first.kind).toBe('run');
    if (first.kind === 'run') first.lease.release();
    expect((await admit(claimed('j2'), 'default', [])).kind).toBe('waiting');
  });
});
