// `SQL_SCALER_DEPTH` against a real Postgres: the jobs a fleet must size for — running on a SERVING
// worker, or due and claimable — and not the ones a draining worker still holds (its replacement
// cannot take them), nor a future or paused one. Opt-in (`.job.`): booting Postgres costs seconds.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { SQL_SCALER_DEPTH } from './scaler-depth-fixture';

const SEED = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state, run_at,
   claimed_by)
values
  (gen_random_uuid(), 'scrape', $1, '{}'::jsonb, gen_random_uuid()::text, gen_random_uuid(), 1, 3,
   $2, now() + ($3::int * interval '1 second'), $4)
`;

describe('the scaler depth on the pg driver', () => {
  test('counts serving work and due work; leaves out a draining worker’s, a future one and a paused queue', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const driver = postgresJobDriver({ executor: pg.executor, clock: frozenClock(Date.now()) });
    const registry = driver.introspect;
    if (registry === undefined) return expect.unreachable('the pg driver has a registry');
    const worker = (id: string, draining: boolean) =>
      registry.announceWorker(
        {
          id,
          host: id,
          startedAt: Date.now(),
          queues: ['banks'],
          concurrency: 10,
          inFlight: [],
          draining,
        },
        30_000,
      );
    await worker('worker-new', false);
    await worker('worker-old', true);
    const seed = (queue: string, state: string, inSeconds: number, claimedBy: string | null) =>
      pg.executor.query(SEED, [queue, state, inSeconds, claimedBy]);

    await seed('banks', 'running', 0, 'worker-new'); // counted: serving
    await seed('banks', 'running', 0, 'worker-old'); // NOT counted: draining
    await seed('banks', 'running', 0, 'worker-old'); // NOT counted: draining
    await seed('banks', 'running', 0, 'worker-gone'); // counted: no row says it drains
    await seed('banks', 'ready', 0, null); // counted: due
    await seed('banks', 'delayed', 600, null); // NOT counted: not due
    await seed('banks-paused', 'ready', 0, null); // NOT counted: paused queue
    await seed('other', 'ready', 0, null); // NOT counted: not this fleet's queue
    await pg.executor.query(
      `insert into x_job_pauses (kind, name) values ('queue', 'banks-paused')`,
      [],
    );

    const depth = async (): Promise<number> => {
      const rows = await pg.executor.query<{ depth: number | string }>(SQL_SCALER_DEPTH, [
        ['banks', 'banks-paused'],
      ]);
      return Number(rows[0]?.depth);
    };
    expect(await depth()).toBe(3);

    // The draining worker's row lapses (killed, or its pod gone): its rows count again until the
    // queue takes them back — they are work somebody must pick up.
    await pg.age(31_000);
    await worker('worker-new', false);
    expect(await depth()).toBe(5);
  });
});
