// The keyed-concurrency scenarios against the PG driver and a real Postgres — the embedded one,
// with this package's own DDL applied. The memory suite proves the worker's logic; this proves the
// statements: `SQL_LEASE_ACQUIRE`'s primary-key race, `SQL_LEASE_HOLDERS`, and `SQL_NACK` filing a
// refused run `failed`. Opt-in (`.job.`): booting Postgres costs seconds.
//
// Time passes by AGING rows (`embedded-pg-fixture.ts` says why): `now()` is the database's.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { JobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { resetJobs } from './job';
import type { KeyedHarness } from './keyed-concurrency-fixture';
import {
  accountJob,
  enqueueRun,
  keyedConcurrencyScenarios,
  rowOf,
  workerOn,
} from './keyed-concurrency-fixture';
import { jobLeaseKey } from './leases';

const harness: KeyedHarness = {
  async driver(): Promise<JobDriver> {
    const pg = await embeddedPg();
    await pg.reset();
    return postgresJobDriver({ executor: pg.executor });
  },
  async elapse(_driver, ms): Promise<void> {
    await (await embeddedPg()).age(ms);
  },
};

afterEach(() => {
  resetJobs();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

describe('keyed concurrency on the pg driver', () => {
  keyedConcurrencyScenarios('pg', harness);

  test('pg: the lease row is keyed by job AND key, and a refused run leaves none behind', async () => {
    const driver = await harness.driver();
    const probe = accountJob({
      concurrency: { key: ({ account }) => account, limit: 1, whenBusy: 'fail' },
      hold: true,
    });
    await enqueueRun(driver, probe, 'acct-1');
    const second = await enqueueRun(driver, probe, 'acct-1');
    const a = workerOn(harness, driver, 'worker-a');
    const b = workerOn(harness, driver, 'worker-b');

    const holding = a.tick();
    await probe.started(1);
    await b.tick();

    const pg = (await embeddedPg()).executor;
    const rows = await pg.query<{ lease_key: string; holder: string }>(
      'select lease_key, holder from x_job_leases order by lease_key, slot',
      [],
    );
    expect(rows.map((row) => row.lease_key)).toEqual([jobLeaseKey(probe.handle.name, 'acct-1')]);
    expect(rows[0]?.holder).toMatch(/^worker-a:/);
    expect((await rowOf(driver, second)).state).toBe('failed');

    probe.release();
    await holding;
    // Settled, so released: a keyed cap leaves no row per key behind a finished run.
    expect(await pg.query('select lease_key from x_job_leases', [])).toEqual([]);
  });
});
