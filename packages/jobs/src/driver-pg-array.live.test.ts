// This package's two statements that bind an array, run against a real Postgres through the
// executor every booted role gets: `@ultimat3/db`'s client, `{ text, values }`, which is what
// `cli/src/runtime-queue.ts`'s `pgExecutorFor` builds. Issue #384: `Bun.SQL` joins a JS array's
// elements with commas, so both answered `malformed array literal` (22P02) — `SQL_CLAIM` is the
// entire loop of every `ROLE=worker` container the framework produces.
//
// HERE, NOT IN `@ultimat3/cli`. These cases lived in `cli/src/pg-array.live.test.ts`, and that one
// reader was the only reason `SQL_CLAIM` and `SQL_OUTBOX_RELEASE` were public: a test that runs a
// statement belongs to the statement's package, where it needs no export (`sql-export-readers`).
//
// WHY THE GAP LASTED: every other test of these statements runs against a recording executor and
// asserts their SQL as TEXT, which cannot see whether a parameter parses. PGlite — what `x dev`
// runs — encodes an array correctly, so the framework's own dev loop was blind by construction.
// Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, statementsOf } from '@ultimat3/db';
import { SQL_CLAIM, SQL_JOBS_TABLE, SQL_OUTBOX_RELEASE } from './driver-pg-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

// EVERY value this file writes or matches on is minted per run. `TEST_DATABASE_URL` may name a
// database that already holds jobs — CI's does — and a claim over the literal `default` and `mail`
// queues would claim somebody else's row, leave it claimed, and make `toEqual([ID])` fail on a
// statement that worked. A run-scoped queue name is the isolation; the ids are minted for the same
// reason a fixed one collides with an interrupted run's leftovers.
const RUN = crypto.randomUUID().slice(0, 8);
const QUEUES = [`q-${RUN}-a`, `q-${RUN}-b`] as const;
const UNCLAIMED_QUEUE = `q-${RUN}-c`;
const ID = crypto.randomUUID();
const MISS_ID = crypto.randomUUID();
const DROPPED_JOB = `probe-dropped-${RUN}`;
const KEPT_JOB = `probe-kept-${RUN}`;

describe.skipIf(!hasPostgres)('live · postgres · the jobs statements that bind an array', () => {
  let client: PostgresClient | undefined;
  let executor: PgExecutor | undefined;

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '', role: 'worker' });
    const owned = client;
    // `pgExecutorFor`'s body, verbatim: the composition under test, not a stand-in for it.
    executor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        owned.query<R>({ text, values }),
    };
    // `statementsOf` and not `split(';')`: the DDL carries comments and the package's own splitter is
    // the one answer to where a statement ends.
    for (const statement of statementsOf(SQL_JOBS_TABLE)) await executor.query(statement, []);
  });

  afterAll(async () => {
    await client?.close();
  });

  // The worker's whole loop. Nothing asserted about the ROWS — an empty queue returns none, and the
  // claim is what the test is about: this statement raised 22P02 on every call, so a worker against
  // a real Postgres never claimed anything and every job sat in the queue forever.
  test('SQL_CLAIM executes — the loop every ROLE=worker container runs', async () => {
    expect(SQL_CLAIM).toContain('any($1::text[])');
    expect(SQL_CLAIM).toContain('any($5::text[])');
    const rows = await executor?.query(SQL_CLAIM, [[...QUEUES], 1, `w-${RUN}`, 30_000, []]);
    expect(rows).toEqual([]);
  });

  test('SQL_OUTBOX_RELEASE executes — the relay giving a batch back', async () => {
    expect(SQL_OUTBOX_RELEASE).toContain('any($1::uuid[])');
    await executor?.query(SQL_OUTBOX_RELEASE, [[ID], 'relay-1']);
  });

  // A claim that executes is not yet a claim that MATCHES. `any` over a mis-encoded array could
  // match nothing and still not throw, which would leave the tests above green over a worker that
  // claims no job — the same shape of green this whole issue is about.
  test('the claim really matches on the queue names it was given', async () => {
    const rows = await executor?.query<{ id: string; queue: string }>(
      // `$2` and not `$1` again: one placeholder in both a uuid and a text column deduces two
      // types and Postgres refuses the statement (42P08) before any array is bound.
      `insert into x_jobs (id, name, queue, input, idempotency_key, run_id)
       values ($1, 'probe', $3, '{}'::jsonb, $2, $1) returning id, queue`,
      [ID, ID, QUEUES[1]],
    );
    expect(rows?.[0]?.queue).toBe(QUEUES[1]);
    try {
      const claimed = await executor?.query<{ id: string }>(SQL_CLAIM, [
        [...QUEUES],
        5,
        `w-match-${RUN}`,
        30_000,
        [],
      ]);
      expect(claimed?.map((row) => row.id)).toEqual([ID]);
    } finally {
      await executor?.query('delete from x_jobs where id = $1', [ID]);
    }
  });

  // The negative control on the same statement: a queue the array does NOT name must not be
  // claimed, or the test above is satisfied by an encoder that turns every array into a wildcard.
  test('a queue the array does not name is not claimed', async () => {
    await executor?.query(
      `insert into x_jobs (id, name, queue, input, idempotency_key, run_id)
       values ($1, 'probe', $3, '{}'::jsonb, $2, $1)`,
      [MISS_ID, MISS_ID, UNCLAIMED_QUEUE],
    );
    try {
      const claimed = await executor?.query(SQL_CLAIM, [
        [...QUEUES],
        5,
        `w-miss-${RUN}`,
        30_000,
        [],
      ]);
      expect(claimed).toEqual([]);
    } finally {
      await executor?.query('delete from x_jobs where id = $1', [MISS_ID]);
    }
  });

  // The statement's SECOND array, `$5`: the job names a burial drops (`retry.deadLetter: false`).
  // Two rows whose lease lapsed on their final attempt, one named in the array and one not — an
  // encoder that bound it as a wildcard, or as nothing, gets one of the two states wrong.
  test('the names array decides how an exhausted row is buried: failed when named, dead when not', async () => {
    const lapsed = (id: string, name: string): Promise<unknown> | undefined =>
      executor?.query(
        `insert into x_jobs
           (id, name, queue, input, idempotency_key, run_id, state, attempt, max_attempts,
            claimed_by, visible_at)
         values ($1, $3, $4, '{}'::jsonb, $2, $1, 'running', 1, 1, 'gone',
                 now() - interval '1 minute')`,
        [id, id, name, QUEUES[0]],
      );
    await lapsed(ID, DROPPED_JOB);
    await lapsed(MISS_ID, KEPT_JOB);
    try {
      const rows = await executor?.query<{ id: string; state: string }>(SQL_CLAIM, [
        [...QUEUES],
        5,
        `w-bury-${RUN}`,
        30_000,
        [DROPPED_JOB, 'never-queued'],
      ]);
      const states = new Map(rows?.map((row) => [row.id, row.state]));
      expect(states.get(ID)).toBe('failed');
      expect(states.get(MISS_ID)).toBe('dead');
    } finally {
      await executor?.query('delete from x_jobs where id = any($1::uuid[])', [[ID, MISS_ID]]);
      // The burial counts itself in the same statement: those two rows are this run's as well.
      await executor?.query('delete from x_job_counters where job = any($1::text[])', [
        [DROPPED_JOB, KEPT_JOB],
      ]);
    }
  });
});
