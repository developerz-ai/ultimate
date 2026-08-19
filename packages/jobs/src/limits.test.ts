import { beforeEach, describe, expect, test } from 'bun:test';
import type { Clock, Ctx } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { createMemoryDriver } from './driver-memory';
import type { JobHandle } from './job';
import { job, resetJobs } from './job';
import { createLimiter, tenantKeyFrom } from './limits';
import { createWorker } from './worker';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  } as Clock & { advance(ms: number): void };
}

const T0 = 1_760_000_000_000;

interface Payload {
  readonly n: number;
}

let ran: number[];
let countedJob: JobHandle<Payload>;

beforeEach(() => {
  resetJobs();
  ran = [];
  countedJob = job<Payload>({
    tenant: 'none',
    name: 'countedJob',
    input: passthrough<Payload>(),
    idempotencyKey: ({ n }) => `counted:${n}`,
    retry: { attempts: 3 },
    run: ({ input }) => {
      ran.push(input.n);
      return Promise.resolve();
    },
  });
});

describe('createLimiter', () => {
  test('the N+1th acquire for a tenant is refused until a lease is released', () => {
    const limiter = createLimiter({ perTenant: 2 });
    const a = limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' });
    const b = limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' });
    const c = limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' });

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeUndefined();
    expect(limiter.blockedBy({ queue: 'default', tenantId: 'org-1' })).toBe('per-tenant');

    // A second tenant is unaffected: one org cannot starve another.
    expect(limiter.tryAcquire({ queue: 'default', tenantId: 'org-2' })).toBeDefined();

    a?.release();
    expect(limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' })).toBeDefined();
  });

  test('a double release cannot leak slots back into the pool', () => {
    const limiter = createLimiter({ perTenant: 1 });
    const lease = limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' });
    lease?.release();
    lease?.release();
    expect(limiter.inFlight()).toBe(0);
  });

  // `blockedBy` reads `{queue, tenantId}` as ONE key (`${queue}\0${tenant}`); `inFlight` used to
  // drop the queue whenever a tenant was present, so the same key asked two questions of two
  // functions and the second answered "this tenant, everywhere".
  test('inFlight answers the key it was given, not the widest part of it', () => {
    const limiter = createLimiter({});
    limiter.tryAcquire({ queue: 'mail', tenantId: 'org-1' });
    limiter.tryAcquire({ queue: 'import', tenantId: 'org-1' });
    limiter.tryAcquire({ queue: 'mail', tenantId: 'org-2' });

    expect(limiter.inFlight()).toBe(3);
    expect(limiter.inFlight({ queue: 'mail' })).toBe(2);
    expect(limiter.inFlight({ queue: 'mail', tenantId: 'org-1' })).toBe(1);
    expect(limiter.inFlight({ queue: 'import', tenantId: 'org-1' })).toBe(1);
    expect(limiter.inFlight({ queue: 'export', tenantId: 'org-1' })).toBe(0);
  });

  test('a released composite slot is dropped, never left at zero', () => {
    const limiter = createLimiter({});
    const lease = limiter.tryAcquire({ queue: 'mail', tenantId: 'org-1' });
    expect(limiter.inFlight({ queue: 'mail', tenantId: 'org-1' })).toBe(1);
    lease?.release();
    lease?.release();
    expect(limiter.inFlight({ queue: 'mail', tenantId: 'org-1' })).toBe(0);
  });

  test('the per-queue cap applies across tenants and the global cap across queues', () => {
    const limiter = createLimiter({ perQueue: 1, global: 2 });
    expect(limiter.tryAcquire({ queue: 'mail', tenantId: 'org-1' })).toBeDefined();
    expect(limiter.tryAcquire({ queue: 'mail', tenantId: 'org-2' })).toBeUndefined();
    expect(limiter.blockedBy({ queue: 'mail', tenantId: 'org-2' })).toBe('per-queue');
    expect(limiter.tryAcquire({ queue: 'import' })).toBeDefined();
    expect(limiter.tryAcquire({ queue: 'export' })).toBeUndefined();
    expect(limiter.blockedBy({ queue: 'export' })).toBe('global');
  });

  test('the rate limit refuses starts once the window is full, and recovers after it', () => {
    const clock = fakeClock(T0);
    const limiter = createLimiter({ ratePerTenant: { limit: 2, windowMs: 1_000 } }, clock);
    limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' })?.release();
    limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' })?.release();
    expect(limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' })).toBeUndefined();
    expect(limiter.blockedBy({ queue: 'default', tenantId: 'org-1' })).toBe('rate');
    clock.advance(1_001);
    expect(limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' })).toBeDefined();
  });

  test('the tenant key comes from the actor orgId', () => {
    expect(tenantKeyFrom({ orgId: 'org-7' })).toBe('org-7');
    expect(tenantKeyFrom(undefined)).toBe('global');
  });
});

describe('worker concurrency', () => {
  test('a tenant at its concurrency cap has the next claim handed straight back, unrun', async () => {
    const clock = fakeClock(T0);
    const driver = createMemoryDriver({ clock });
    const limiter = createLimiter({ perTenant: 2 });
    const worker = createWorker({
      driver,
      limiter,
      clock,
      concurrency: 10,
      context: () => ({}) as Ctx,
      drainOnShutdown: false,
    });

    await driver.enqueue({
      name: 'countedJob',
      queue: 'default',
      input: { n: 1 },
      idempotencyKey: countedJob.idempotencyKeyFor({ n: 1 }),
      maxAttempts: 3,
      tenantId: 'org-1',
    });

    // Two of this tenant's slots are already held by in-flight runs on this worker.
    const held = [
      limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' }),
      limiter.tryAcquire({ queue: 'default', tenantId: 'org-1' }),
    ];

    expect(await worker.tick()).toEqual([]);
    expect(ran).toEqual([]);

    // `ready`, not `suspended`: a job over a cap is still WAITING, and a row hidden in the
    // suspended bucket is a row `queue_depth` and `queue_oldest_ready_seconds` do not count.
    const shed = (await driver.introspect?.list({ state: 'ready' })) ?? [];
    expect(shed.length).toBe(1);
    expect((await driver.introspect?.list({ state: 'suspended' })) ?? []).toEqual([]);
    // Being over a cap must not burn a retry attempt — that fact is `countsAsAttempt`, and it is
    // the only one of the two the shed still asserts.
    expect(shed[0]?.attempt).toBe(0);
    // And it never ran, so it failed at nothing: the reason is a log field, not a `lastError`
    // `x jobs show` renders as this job's own failure.
    expect(shed[0]?.lastError).toBeUndefined();

    for (const lease of held) lease?.release();
    clock.advance(1_000); // past the re-delivery delay the nack set
    const executions = await worker.tick();
    expect(ran).toEqual([1]);
    expect(executions.map((execution) => execution.outcome)).toEqual(['completed']);
  });
});
