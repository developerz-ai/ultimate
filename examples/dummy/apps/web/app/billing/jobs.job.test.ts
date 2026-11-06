/**
 * job — the billing vendor, read both ways through the real queue `runJobs` installs. What can
 * fail: the consumer's cursor not landing beside its batch (a restart would re-read the feed from
 * the top), a re-run not resuming from it, and the paged import losing or repeating a page.
 *
 * Both are jobs — `consumer()` and `backfill()` are factories over `job()` — so this is a
 * `.job.test.ts`, the step the gate types it by. Against the app's MIGRATED database, the recipe
 * `../posts/repo-join.test.ts` uses: a batch and its cursor commit in one `withTransaction`, which
 * the memory store has no client for.
 */

import { db } from '@postly/db';
import { migratedDatabase } from '@ultimat3/cli';
import { setDbClient } from '@ultimat3/db';
import { afterAll, beforeAll, expect, jobTest, reusableDatabase } from '@ultimat3/testing';
import { planCatalog } from './backfills/plan-catalog';
import { PLAN_PRICES, planPrices, positionAfter, streamOf } from './jobs/plan-prices';
import { VENDOR_ACCOUNT, VENDOR_PRICES } from './vendor';

// A template restore is ~0.5 s; its first build (initdb plus every migration) is what this bounds.
const BOOT_MS = 120_000;

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));

beforeAll(async () => {
  setDbClient(await workerDatabase());
}, BOOT_MS);
// Back to memory, so this file's database never reaches the next file's tests.
afterAll(() => setDbClient(undefined));

const team = { code: 'team', currency: 'USD' } as const;

/** A price nobody publishes, written straight to the row: what a re-read would overwrite. */
const hand = { minor: 1234, currency: 'USD' } as const;

jobTest('planPrices is a job with a supervisor, because consumer() is a factory', () => {
  expect(planPrices.kind).toBe('job');
  expect(planPrices.name).toBe(PLAN_PRICES);
  expect(planPrices.supervisor.name).toBe(`${PLAN_PRICES}.supervisor`);
  expect(planPrices.idempotencyKeyFor({ key: VENDOR_ACCOUNT })).toBe(
    `consumer:${PLAN_PRICES}:${VENDOR_ACCOUNT}`,
  );
});

jobTest('the cursor past a batch is its highest seq', () => {
  expect(positionAfter(VENDOR_PRICES.slice(0, 3))).toBe(3);
  expect(positionAfter([...VENDOR_PRICES].reverse())).toBe(VENDOR_PRICES.length);
});

jobTest(
  'one run reads the whole feed and commits its position, and the next resumes past it',
  async ({ runJobs }) => {
    const first = await runJobs(planPrices, { key: VENDOR_ACCOUNT });
    expect(first.executions.map((execution) => execution.outcome)).toEqual(['completed']);
    expect(await db.streamCursors.where({ stream: streamOf(VENDOR_ACCOUNT) }).one()).toEqual({
      stream: streamOf(VENDOR_ACCOUNT),
      position: VENDOR_PRICES.length,
    });

    // Resumed from the saved cursor, the feed has nothing new: a hand-edited price survives. A run
    // that re-read from the top would put the vendor's price back.
    await db.plans.upsertAll([{ ...team, monthly: hand, seats: 25 }], {
      onConflict: ['code', 'currency'],
    });
    await runJobs(planPrices, { key: VENDOR_ACCOUNT });
    expect((await db.plans.where(team).one())?.monthly).toEqual(hand);
  },
);

jobTest('planCatalog imports every page of the vendor catalog', async ({ runJobs }) => {
  await db.plans.upsertAll([{ ...team, monthly: hand, seats: 25 }], {
    onConflict: ['code', 'currency'],
  });

  const trace = await runJobs(planCatalog, {});
  expect(trace.executions.map((execution) => execution.outcome)).toEqual(['completed']);
  // Six prices at two a page: three page steps, each run once.
  expect(Object.keys(trace.steps)).toHaveLength(Math.ceil(VENDOR_PRICES.length / 2));
  expect((await db.plans.where(team).one())?.monthly).toEqual({ minor: 1900, currency: 'USD' });
});
