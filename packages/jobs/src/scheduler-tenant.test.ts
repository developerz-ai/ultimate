// A scheduler fire queues each job under the tenant its handle declares. The idempotency namespace
// is `(name, tenant, key)`, so a fan-out per org that left the tenant off deduped every org onto
// the first one's row — and `perTenant` counted the survivor as nobody's.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { resetJobsFacade } from './outbox';
import type { CronResolver } from './scheduler';
import { jobScheduler } from './scheduler';
import { resetTasks, task } from './task';

interface OrgInput {
  readonly orgId: string;
}

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

/** Deterministic stand-in for @ultimat3/time: fires daily at 03:00 UTC. */
const dailyAt3: CronResolver = (_cron, options) => {
  const dayMs = 86_400_000;
  const from = options.from.getTime();
  const at3 = Math.floor(from / dayMs) * dayMs + 3 * 3_600_000;
  return new Date(at3 > from ? at3 : at3 + dayMs);
};

// 2026-07-26T00:00:00Z.
const T0 = Date.UTC(2026, 6, 26, 0, 0, 0);

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
  resetJobsFacade();
});

afterEach(() => {
  resetJobDriver();
  resetJobsFacade();
});

describe('a scheduler fire and the tenant a job declares', () => {
  test('a fire queues each job under its declared tenant: two orgs with one key are two rows', async () => {
    const digest = job<OrgInput>({
      tenant: (input) => input.orgId,
      name: 'digest',
      input: passthrough<OrgInput>(),
      idempotencyKey: () => 'digest',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    task({
      name: 'nightlyDigest',
      cron: '0 3 * * *',
      tz: 'UTC',
      enqueue: () => [
        [digest, { orgId: 'A' }],
        [digest, { orgId: 'B' }],
      ],
    });
    const clock = fakeClock(T0);
    const driver = memoryJobDriver({ clock });
    const scheduler = jobScheduler({ driver, clock, cron: dailyAt3 });

    await scheduler.tick();
    clock.advance(4 * 3_600_000);
    const [dispatched] = await scheduler.tick();

    expect(dispatched?.jobs.map((entry) => entry.result.deduped)).toEqual([false, false]);
    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows.map((row) => row.tenantId).sort()).toEqual(['A', 'B']);
  });

  test('a job declared for no tenant is queued for none', async () => {
    const sweep = job({
      tenant: 'none',
      name: 'sweep',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'sweep',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    task({ name: 'nightlySweep', cron: '0 3 * * *', tz: 'UTC', enqueue: () => [[sweep, {}]] });
    const clock = fakeClock(T0);
    const driver = memoryJobDriver({ clock });
    const scheduler = jobScheduler({ driver, clock, cron: dailyAt3 });

    await scheduler.tick();
    clock.advance(4 * 3_600_000);
    await scheduler.tick();

    const [row] = (await driver.introspect?.list()) ?? [];
    expect(row?.tenantId).toBeUndefined();
  });
});
