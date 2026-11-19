// What a pg fire REPORTS for each job it queued: the row it inserted, by position. The key is unique
// only per (name, tenant, key), so two jobs of one occurrence may share a key — and mapping the
// answer back by key alone told both callers the same id, which the memory store never does.
// Opt-in (`.job.`): the embedded Postgres costs seconds to boot.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { postgresJobDriver } from './driver-pg';
import type { EmbeddedPg } from './embedded-pg-fixture';
import { embeddedPg } from './embedded-pg-fixture';
import { postgresSchedulerState } from './scheduler-pg';

const T0 = Date.UTC(2026, 6, 26, 3, 0, 0);

let pg: EmbeddedPg;

beforeEach(async () => {
  pg = await embeddedPg();
  await pg.reset();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

const job = (name: string) => ({
  name,
  queue: 'default',
  input: {},
  idempotencyKey: `nightly:${T0}`,
  maxAttempts: 1,
  runAt: T0,
});

describe('a pg fire reports each job by the row it inserted', () => {
  test('two jobs sharing an idempotency key get their own ids and run ids', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const state = postgresSchedulerState(pg.executor);

    const results = await state.fire(driver, {
      task: 'nightly',
      occurrenceMs: T0,
      jobs: [job('digest'), job('cleanup')],
    });

    const rows = (await driver.introspect?.list()) ?? [];
    const idOf = (name: string): string =>
      rows.find((row) => row.name === name)?.id ?? expect.unreachable(`no ${name} row was queued`);
    expect(results?.map((result) => result.deduped)).toEqual([false, false]);
    // Position for position: what the caller is told is the row its own request produced.
    expect(results?.map((result) => result.id)).toEqual([idOf('digest'), idOf('cleanup')]);
    expect(new Set(results?.map((result) => result.runId) ?? []).size).toBe(2);
  });

  test('a fire queues each job under its declared tenant: two orgs with one key are two rows', async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const state = postgresSchedulerState(pg.executor);

    const results = await state.fire(driver, {
      task: 'nightly',
      occurrenceMs: T0,
      jobs: [
        { ...job('digest'), tenantId: 'A' },
        { ...job('digest'), tenantId: 'B' },
      ],
    });

    expect(results?.map((result) => result.deduped)).toEqual([false, false]);
    const rows = (await driver.introspect?.list()) ?? [];
    expect(rows.map((row) => row.tenantId).sort()).toEqual(['A', 'B']);
  });

  test("a fired row carries the producer span's traceparent, and who it is attributed to", async () => {
    const driver = postgresJobDriver({ executor: pg.executor });
    const state = postgresSchedulerState(pg.executor);
    const trace = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    await state.fire(driver, {
      task: 'nightly',
      occurrenceMs: T0,
      jobs: [{ ...job('digest'), traceparent: trace, enqueuedBy: 'scheduler' }, job('cleanup')],
    });

    const rows = (await driver.introspect?.list()) ?? [];
    const digest = rows.find((row) => row.name === 'digest');
    const cleanup = rows.find((row) => row.name === 'cleanup');
    expect(digest?.traceparent).toBe(trace);
    expect(digest?.enqueuedBy).toBe('scheduler');
    // Absent stays absent: a request with no trace opens a root, as it did.
    expect(cleanup?.traceparent).toBeUndefined();
    expect(cleanup?.tenantId).toBeUndefined();
  });
});
