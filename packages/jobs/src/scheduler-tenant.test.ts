// A scheduler fire queues each job under the tenant its handle declares. The idempotency namespace
// is `(name, tenant, key)`, so a fan-out per org that left the tenant off deduped every org onto
// the first one's row — and `perTenant` counted the survivor as nobody's.

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { type Clock, logger } from '@ultimat3/core';
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
  mock.restore();
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

  // Decided 2026-11-19: an entry whose tenant() throws (or answers empty) fails the WHOLE
  // occurrence — the same as a refused key one line above it — and loudly: one error naming the
  // task, the job and the entry. Nothing is queued and the watermark stays, so the next tick owes
  // the same occurrence again and says so again; once the declaration or the data is repaired,
  // that tick queues every entry of it. Never a partial fire, never a silent skip.
  test('one entry whose tenant() throws: the occurrence queues nothing, says which entry, and the next tick retries it', async () => {
    let broken = true;
    const digest = job<OrgInput>({
      tenant: (input) => (broken && input.orgId === 'B' ? '' : input.orgId),
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
    const error = spyOn(logger, 'error').mockImplementation(() => undefined);
    const refusals = () =>
      error.mock.calls.filter(([message]) => message === 'jobs.scheduler.entry-refused');

    await scheduler.tick();
    clock.advance(4 * 3_600_000);
    expect(await scheduler.tick()).toEqual([]);

    expect((await driver.introspect?.list()) ?? []).toEqual([]);
    expect(refusals()).toEqual([
      [
        'jobs.scheduler.entry-refused',
        expect.objectContaining({ task: 'nightlyDigest', job: 'digest', entry: 1 }),
      ],
    ]);

    // Still owed: the next tick tries the same occurrence and says so again.
    clock.advance(60_000);
    expect(await scheduler.tick()).toEqual([]);
    expect(refusals()).toHaveLength(2);

    // Repaired: the same occurrence fires whole, both orgs, nothing lost.
    broken = false;
    clock.advance(60_000);
    const [dispatched] = await scheduler.tick();
    expect(dispatched?.occurrenceMs).toBe(T0 + 3 * 3_600_000);
    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows.map((row) => row.tenantId).sort()).toEqual(['A', 'B']);
  });
});
