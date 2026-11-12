// The expiry scenarios against the pg driver and the embedded Postgres: the memory suite proves
// the logic, this proves `SQL_CLAIM`'s expiry arm. Opt-in (`.job.`): booting Postgres costs seconds.

import { describe, setDefaultTimeout } from 'bun:test';
import { driverExpiryScenarios } from './driver-expiry-fixture';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';

/** The embedded Postgres boot rides the first scenario — the ceiling `queue-wake.job.test.ts` pins. */
setDefaultTimeout(120_000);

describe('when expiry buries a row, on the pg driver', () => {
  driverExpiryScenarios('pg', {
    async driver() {
      const pg = await embeddedPg();
      await pg.reset();
      return postgresJobDriver({ executor: pg.executor });
    },
    async now() {
      const pg = await embeddedPg();
      const [row] = await pg.executor.query<{ ms: string }>(
        'select (extract(epoch from now()) * 1000)::bigint::text as ms',
        [],
      );
      return Number(row?.ms);
    },
    async elapse(_driver, ms) {
      await (await embeddedPg()).age(ms);
    },
  });
});
