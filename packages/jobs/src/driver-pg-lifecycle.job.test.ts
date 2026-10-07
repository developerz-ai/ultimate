// The lifecycle and answer scenarios against the PG driver and a real Postgres: the memory suite
// proves the logic, this proves the STATEMENTS — the claim that buries a poison row, the cancel
// fenced on live states, the one-statement requeue. Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, afterEach, describe } from 'bun:test';
import type { JobDriver } from './driver';
import { driverAnswerScenarios, type HoldKeys } from './driver-answers-fixture';
import { driverLifecycleScenarios } from './driver-lifecycle-fixture';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { resetJobs } from './job';
import type { OperatorHarness } from './operator-surface-fixture';
import { postgresSchedulerState } from './scheduler-pg';
import { workerExhaustedScenarios } from './worker-exhausted-fixture';

/** `count` finished rows in one statement, newest last in `g`. */
const SEED = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state, created_at)
select gen_random_uuid(), $1, $2, '{}'::jsonb, 'seed:' || $1 || ':' || g, gen_random_uuid(), 1, 1,
       $3, now() - (g * interval '1 millisecond')
  from generate_series(1, $4::int) as g
`;

const harness: OperatorHarness = {
  async driver(): Promise<JobDriver> {
    const pg = await embeddedPg();
    await pg.reset();
    return postgresJobDriver({ executor: pg.executor });
  },
  async elapse(_driver, ms): Promise<void> {
    await (await embeddedPg()).age(ms);
  },
  async seed(_driver, { name, state, count, queue = 'default' }): Promise<void> {
    await (await embeddedPg()).executor.query(SEED, [name, queue, state, count]);
  },
  async schedulerState() {
    return postgresSchedulerState((await embeddedPg()).executor);
  },
};

/**
 * Live rows holding `keys`, in ONE statement — the shape `SEED` already uses. A thousand
 * `enqueue`s cost ~5 ms each on the embedded Postgres (a round trip plus the ready-notify), which
 * made the requeue scenario's SETUP 3.5 s alone and a timeout under a loaded gate; the verb under
 * test, `requeueMany`, was 44 ms of it.
 */
const HOLD = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state)
select gen_random_uuid(), $1, $2, '{}'::jsonb, key, gen_random_uuid(), 0, 1, 'ready'
  from unnest($3::text[]) as key
`;

const holdKeys: HoldKeys = async (_driver, { name, queue, keys }) => {
  await (await embeddedPg()).executor.query(HOLD, [name, queue, keys]);
};

afterEach(() => {
  resetJobs();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

describe('how a row ends, on the pg driver', () => {
  driverLifecycleScenarios('pg', harness);
});

describe('what a driver answers, on the pg driver', () => {
  driverAnswerScenarios('pg', harness, holdKeys);
});

describe('what the worker does with a burial, on the pg driver', () => {
  workerExhaustedScenarios('pg', harness);
});
