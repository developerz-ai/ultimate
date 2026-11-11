// A published event wakes its waiter, end to end on a real Postgres: a worker parks the run on a
// waking bus (15 min backstop), a publish makes it due in the same statement, and the very next
// tick resumes it — one replay, not a poll. Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { postgresJobDriver } from './driver-pg';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import { postgresEventBus } from './events-pg';
import { job, resetJobs } from './job';
import { WAKING_EVENT_POLL_MS } from './steps';
import { jobWorker } from './worker';

// Boot belongs to the fixture hooks; the wake assertions keep the test runner's default budget.
const PGLITE_BOOT_MS = 120_000;

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
}, PGLITE_BOOT_MS);

afterEach(() => {
  resetJobs();
});

afterAll(async () => {
  await (await embeddedPg()).close();
}, PGLITE_BOOT_MS);

describe('a waking bus over the queue database', () => {
  test('a publish resumes the parked run on the next tick, in one replay', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const events = postgresEventBus({ executor: pg.executor, wakes: true });
    const ran: string[] = [];
    const approve = job<{ id: string }>({
      name: 'approveInvoice',
      tenant: 'none',
      input: t.object({ id: t.string }),
      idempotencyKey: ({ id }) => `approve:${id}`,
      retry: { attempts: 1 },
      run: async ({ input, step }) => {
        await step.run('draft', () => {
          ran.push('draft');
          return input.id;
        });
        const paid = await step.waitForEvent('paid', 'invoice.paid', {
          schema: t.object({ amount: t.number }),
          match: input.id,
        });
        ran.push(`paid:${String(paid?.amount)}`);
      },
    });
    await driver.enqueue({
      name: approve.name,
      queue: 'default',
      input: { id: 'inv-1' },
      idempotencyKey: 'approve:inv-1',
      maxAttempts: 1,
    });
    const worker = jobWorker({
      driver,
      events,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      pollIntervalMs: 0,
      drainOnShutdown: false,
    });
    try {
      const [parked] = await worker.tick();
      expect(parked?.outcome).toBe('suspended');
      // Parked for the backstop, not the 30 s poll: the publish is what brings it forward.
      expect((parked?.resumeAt ?? 0) - Date.now()).toBeGreaterThan(WAKING_EVENT_POLL_MS - 60_000);
      expect(await worker.tick()).toEqual([]);

      await events.publish('invoice.paid', { amount: 12 }, { correlationKey: 'inv-1' });

      const [resumed] = await worker.tick();
      expect(resumed?.outcome).toBe('completed');
      expect(resumed?.replayed).toEqual(['draft']);
      expect(ran).toEqual(['draft', 'paid:12']);
    } finally {
      await worker.stop('test-end');
    }
  });
});
