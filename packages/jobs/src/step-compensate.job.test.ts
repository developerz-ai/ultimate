// Durable compensation on a real Postgres: a lease that lapses on the FINAL attempt is re-offered
// by `SQL_CLAIM` (the row carries `UNWIND_MARGIN` more attempts), the unwind runs, and the row ends
// `dead`. A lapse on every unwind attempt buries it, `unwinding` visible. Opt-in (`.job.`).

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import { postgresJobDriver } from './driver-pg';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import type { AnyJobHandle } from './job';
import { job, resetJobs } from './job';
import { enqueuedAttempts } from './retry';
import { jobWorker } from './worker';

const VISIBILITY_MS = 30_000;

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
});

afterEach(() => resetJobs());

afterAll(async () => {
  await (await embeddedPg()).close();
});

async function setUp(calls: string[]) {
  const driver = postgresJobDriver({ executor: pg.executor });
  const handle: AnyJobHandle = job<{ id: string }>({
    name: 'pgCheckout',
    tenant: 'none',
    input: t.object({ id: t.string }),
    idempotencyKey: ({ id }) => `pg-checkout:${id}`,
    retry: { attempts: 1 },
    compensates: true,
    run: async ({ step }) => {
      await step.run('charge', () => 'ch-1', {
        compensate: (charge) => {
          calls.push(`refund:${charge}`);
        },
      });
      await step.run('ship', () => {
        calls.push('ship');
        return 'shipped';
      });
    },
  });
  const { id } = await driver.enqueue({
    name: handle.name,
    queue: 'default',
    input: { id: 'o-1' },
    idempotencyKey: 'pg-checkout:o-1',
    maxAttempts: enqueuedAttempts(handle.retry, handle.compensates),
  });
  /** A worker that claims and dies: its lease is left to lapse. */
  const dies = async (workerId: string) => {
    const [held] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: VISIBILITY_MS,
      workerId,
    });
    await pg.age(VISIBILITY_MS + 1_000);
    return held;
  };
  const worker = jobWorker({
    driver,
    context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    pollIntervalMs: 0,
    visibilityTimeoutMs: VISIBILITY_MS,
    drainOnShutdown: false,
  });
  return { driver, id, dies, worker };
}

describe('a crash on the final attempt, on Postgres', () => {
  test('the claim re-offers the lapsed row, the unwind runs, and it ends dead', async () => {
    const calls: string[] = [];
    const { driver, id, dies, worker } = await setUp(calls);
    expect((await driver.introspect?.job(id))?.maxAttempts).toBe(3);
    const held = await dies('dead-worker');
    expect(held?.attempt).toBe(1);
    // It charged before it died: the one step the unwind has to undo.
    await driver.steps.put({
      runId: held?.runId ?? '',
      name: 'charge',
      status: 'completed',
      output: 'ch-1',
      startedAt: Date.now(),
      attempts: 1,
    });
    try {
      const [unwound] = await worker.tick();
      expect(unwound?.attempt).toBe(2);
      expect(unwound?.outcome).toBe('dead-lettered');
      expect(calls).toEqual(['refund:ch-1']);
      const row = await driver.introspect?.job(id);
      expect(row?.state).toBe('dead');
      expect(row?.lastError).toBe(LEASE_LAPSED_FINAL_ATTEMPT);
      const steps = await driver.steps.list(held?.runId ?? '');
      expect(Object.fromEntries(steps.map((step) => [step.name, step.status]))).toEqual({
        charge: 'completed',
        unwinding: 'completed',
        'compensate:charge': 'completed',
      });
    } finally {
      await worker.stop('test-end');
    }
  });

  test('a lapse on every unwind attempt too buries the row, unwinding visible', async () => {
    const calls: string[] = [];
    const { driver, id, dies, worker } = await setUp(calls);
    const first = await dies('dying-1');
    expect((await dies('dying-2'))?.attempt).toBe(2);
    await driver.steps.put({
      runId: first?.runId ?? '',
      name: 'unwinding',
      status: 'completed',
      output: { error: LEASE_LAPSED_FINAL_ATTEMPT },
      startedAt: Date.now(),
      attempts: 1,
    });
    expect((await dies('dying-3'))?.attempt).toBe(3);
    try {
      expect(await worker.tick()).toEqual([]);
      expect((await driver.introspect?.job(id))?.state).toBe('dead');
      const steps = await driver.steps.list(first?.runId ?? '');
      expect(steps.map((step) => step.name)).toContain('unwinding');
      expect(calls).toEqual([]);
    } finally {
      await worker.stop('test-end');
    }
  });
});
