// A renewal that lands AFTER the worker settled the row is not a lost lease. The settle (`ack`,
// `nack`) moves the row out of `running`, and until 2026-10-30 the heartbeat was stopped only when
// `executeJob` returned — after the `onSettled` hook and the step listing. A renewal in that window
// matched no row, answered "not yours", and was logged `jobs.lease.lost` (error) and counted in
// `job_leases_lost_total` for a job that had FINISHED — and it aborted the signal the `onSettled`
// hook was running under. Production saw it on every 1 in ~250 bank runs (57 of 168 in 24 h, the
// rest were real cancels). Driven on a hand-cranked renewal schedule: the interleaving is exact.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { collectMetrics, ctxOf, frozenClock, resetMetrics, UltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import type { IntervalScheduler } from './renewal-timer';
import { jobWorker } from './worker';

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const lostCount = (): number | undefined =>
  collectMetrics()
    .metrics.find((metric) => metric.descriptor.name === 'job_leases_lost_total')
    ?.points.find((point) => point.attributes['queue'] === 'default')?.value;

/** Every renewal interval armed, cranked by hand: `fire()` runs one tick of each live one. */
function handCranked(): { schedule: IntervalScheduler; fire(): void } {
  const ticks = new Set<() => void>();
  return {
    schedule: (tick) => {
      ticks.add(tick);
      return () => ticks.delete(tick);
    },
    fire: () => {
      for (const tick of [...ticks]) tick();
    },
  };
}

afterEach(() => {
  resetJobs();
  resetMetrics();
});

async function settleRace(outcome: 'completed' | 'failed'): Promise<{
  lost: number | undefined;
  /** Why the hook's signal was aborted, if it was — a body that ended is `X_JOB_ABORTED` by design. */
  reason: string | undefined;
  renewalsAfterSettle: number;
}> {
  const crank = handCranked();
  let inHook = (): void => undefined;
  let leaveHook = (): void => undefined;
  const hookEntered = new Promise<void>((resolve) => {
    inHook = resolve;
  });
  const hookMayLeave = new Promise<void>((resolve) => {
    leaveHook = resolve;
  });
  let reason: string | undefined;
  job({
    tenant: 'none',
    name: 'settlingJob',
    input: passthrough<Record<string, never>>(),
    idempotencyKey: () => 'settling:1',
    retry: { attempts: outcome === 'failed' ? 1 : 3, jitter: false },
    run: async () => {
      if (outcome === 'failed') {
        throw new UltimateError({
          code: 'X_TEST_BROKEN',
          cause: 'the bank said no',
          fix: 'none — the attempt is meant to fail',
        });
      }
      return 'ok';
    },
    // The app's settle sink: slow, and running under the attempt's signal.
    onSettled: async ({ ctx }) => {
      inHook();
      await hookMayLeave;
      const why: unknown = ctx.signal.reason;
      reason = ctx.signal.aborted
        ? String((why as { code?: unknown } | undefined)?.code ?? why)
        : undefined;
    },
  });
  const base = memoryJobDriver();
  let settled = false;
  let renewalsAfterSettle = 0;
  const driver: JobDriver = {
    ...base,
    ack: async (...args) => {
      const done = await base.ack(...args);
      settled = true;
      return done;
    },
    nack: async (...args) => {
      const done = await base.nack(...args);
      settled = true;
      return done;
    },
    heartbeat: (...args) => {
      if (settled) renewalsAfterSettle += 1;
      return base.heartbeat(...args);
    },
  };
  await driver.enqueue({
    name: 'settlingJob',
    queue: 'default',
    input: {},
    idempotencyKey: 'settling:1',
    maxAttempts: outcome === 'failed' ? 1 : 3,
  });
  const worker = jobWorker({
    driver,
    clock: frozenClock(0),
    visibilityTimeoutMs: 30_000,
    heartbeatIntervalMs: 10_000,
    schedule: crank.schedule,
    context,
    drainOnShutdown: false,
  });
  const tick = worker.tick();
  await hookEntered;
  // The row is settled; the hook is still running. The renewal interval fires now.
  crank.fire();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  leaveHook();
  await tick;
  return { lost: lostCount(), reason, renewalsAfterSettle };
}

describe('a renewal after the settle', () => {
  test('a completed job: no lease lost, and onSettled is never cut by one', async () => {
    const race = await settleRace('completed');
    expect(race.lost).toBeUndefined();
    expect(race.reason).not.toBe('X_JOB_LEASE_LOST');
    // Stopped AT the settle: nothing renews a row this worker already handed back.
    expect(race.renewalsAfterSettle).toBe(0);
  });

  test('a failed job (nack to dead): the same', async () => {
    const race = await settleRace('failed');
    expect(race.lost).toBeUndefined();
    expect(race.reason).not.toBe('X_JOB_LEASE_LOST');
    expect(race.renewalsAfterSettle).toBe(0);
  });
});
