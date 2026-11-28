// The tenant status and cancel scenarios against the pg driver and the embedded Postgres: the
// memory suite proves the logic, this proves the fence in `SQL_JOB_STATUS_FOR` and
// `SQL_JOB_CANCEL_FOR`. Opt-in (`.job.`): booting Postgres costs seconds.

import { describe, setDefaultTimeout } from 'bun:test';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { jobStatusScenarios } from './job-status-fixture';

/** The embedded Postgres boot rides the first scenario — the ceiling `queue-wake.job.test.ts` pins. */
setDefaultTimeout(120_000);

describe('a tenant reads and cancels its own job, on the pg driver', () => {
  jobStatusScenarios('pg', {
    async driver() {
      const pg = await embeddedPg();
      await pg.reset();
      return postgresJobDriver({ executor: pg.executor });
    },
  });
});
