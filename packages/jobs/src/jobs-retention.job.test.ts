// The finished-job sweep against a real Postgres — the embedded one, with this package's own DDL.
// Rows are written straight into `x_jobs`, each with the age and state the case needs, because the
// statement under test reads nothing but those two columns and the two tables that can veto it.
// Opt-in (`.job.`): booting Postgres costs seconds.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { embeddedPg } from './embedded-pg-fixture';
import {
  jobsPurgeTarget,
  SQL_JOBS_RETENTION_BATCH,
  SQL_JOBS_RETENTION_ORPHANS,
  SQL_JOBS_RETENTION_STEPS,
} from './jobs-retention';

const DAY_MS = 86_400_000;

afterAll(async () => {
  await (await embeddedPg()).close();
});

beforeEach(async () => {
  await (await embeddedPg()).reset();
});

let seq = 0;

/** One job row `ageDays` old in `state`, with one step record under its run. Answers its id. */
async function jobRow(state: string, ageDays: number): Promise<string> {
  const { executor } = await embeddedPg();
  seq += 1;
  const id = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await executor.query(
    `insert into x_jobs (id, name, input, idempotency_key, run_id, state, created_at, updated_at)
     values ($1, 'mail.send', '{"to":"someone@example.test"}'::jsonb, $2, $3, $4,
             now() - ($5::bigint * interval '1 millisecond'),
             now() - ($5::bigint * interval '1 millisecond'))`,
    [id, `k${seq}`, runId, state, Math.round(ageDays * DAY_MS)],
  );
  await executor.query(
    `insert into x_job_steps (run_id, name, status) values ($1, 'render', 'done')`,
    [runId],
  );
  return id;
}

/** A second row under `of`'s run, `ageDays` old in `state` — the run's steps are `of`'s. */
async function sibling(of: string, state: string, ageDays: number): Promise<string> {
  const { executor } = await embeddedPg();
  seq += 1;
  const id = crypto.randomUUID();
  await executor.query(
    `insert into x_jobs (id, name, input, idempotency_key, run_id, state, created_at, updated_at)
     select $1, 'mail.send', '{}'::jsonb, $2, run_id, $3,
            now() - ($4::bigint * interval '1 millisecond'),
            now() - ($4::bigint * interval '1 millisecond')
       from x_jobs where id = $5`,
    [id, `k${seq}`, state, Math.round(ageDays * DAY_MS), of],
  );
  return id;
}

async function remaining(): Promise<{ readonly jobs: Set<string>; readonly steps: number }> {
  const { executor } = await embeddedPg();
  const jobs = await executor.query<{ id: string }>('select id from x_jobs', []);
  const steps = await executor.query<{ n: number }>(
    'select count(*)::int as n from x_job_steps',
    [],
  );
  return { jobs: new Set(jobs.map((row) => row.id)), steps: Number(steps[0]?.n ?? 0) };
}

const target = async (extra: { batchSize?: number; maxBatches?: number } = {}) =>
  jobsPurgeTarget({
    executor: (await embeddedPg()).executor,
    doneRetentionMs: 14 * DAY_MS,
    deadRetentionMs: 90 * DAY_MS,
    ...extra,
  });

describe('pg · the finished-job sweep', () => {
  test('a done job past its window goes with its steps; a younger one stays', async () => {
    const old = await jobRow('done', 15);
    const young = await jobRow('done', 13);
    const removed = await (await target()).purgeExpired(Date.now());
    expect(removed).toBe(1);
    const left = await remaining();
    expect(left.jobs.has(old)).toBe(false);
    expect(left.jobs.has(young)).toBe(true);
    expect(left.steps).toBe(1);
  });

  test('dead, failed and cancelled are kept for the longer window, then go', async () => {
    const kept = await Promise.all(['dead', 'failed', 'cancelled'].map((s) => jobRow(s, 30)));
    const gone = await Promise.all(['dead', 'failed', 'cancelled'].map((s) => jobRow(s, 91)));
    expect(await (await target()).purgeExpired(Date.now())).toBe(3);
    const left = await remaining();
    for (const id of kept) expect(left.jobs.has(id)).toBe(true);
    for (const id of gone) expect(left.jobs.has(id)).toBe(false);
    expect(left.steps).toBe(3);
  });

  test('a live job is never touched, however old, and neither are its steps', async () => {
    const live = await Promise.all(
      ['ready', 'delayed', 'running', 'suspended'].map((s) => jobRow(s, 365)),
    );
    expect(await (await target()).purgeExpired(Date.now())).toBe(0);
    const left = await remaining();
    for (const id of live) expect(left.jobs.has(id)).toBe(true);
    expect(left.steps).toBe(4);
  });

  test('an unpublished outbox row or a running backfill still naming the job vetoes it', async () => {
    const { executor } = await embeddedPg();
    const staged = await jobRow('done', 30);
    await executor.query(
      `insert into x_outbox (id, job, input, idempotency_key) values ($1, 'mail.send', '{}'::jsonb, 'o1')`,
      [staged],
    );
    const swept = await jobRow('dead', 120);
    await executor.query(
      `insert into x_backfills (run_id, name, checksum, app_version)
       select run_id, 'cleanup', 'c', '1' from x_jobs where id = $1`,
      [swept],
    );
    expect(await (await target()).purgeExpired(Date.now())).toBe(0);
    const left = await remaining();
    expect(left.jobs.has(staged)).toBe(true);
    expect(left.jobs.has(swept)).toBe(true);
  });

  test('deletes in batches until the backlog is gone, and stops at the pass cap', async () => {
    for (let index = 0; index < 5; index += 1) await jobRow('done', 20);
    expect(await (await target({ batchSize: 2, maxBatches: 2 })).purgeExpired(Date.now())).toBe(4);
    expect(await (await target({ batchSize: 2 })).purgeExpired(Date.now())).toBe(1);
    expect((await remaining()).jobs.size).toBe(0);
  });

  test('two finished rows of one run go in one batch, and their run’s steps with them', async () => {
    const first = await jobRow('done', 20);
    await sibling(first, 'dead', 120);
    expect(await (await target()).purgeExpired(Date.now())).toBe(2);
    expect(await remaining()).toEqual({ jobs: new Set(), steps: 0 });
  });

  test('a run with a row still standing keeps its steps, for the sweep that takes that row', async () => {
    const old = await jobRow('done', 20);
    const live = await sibling(old, 'ready', 20);
    expect(await (await target()).purgeExpired(Date.now())).toBe(1);
    const left = await remaining();
    expect([...left.jobs]).toEqual([live]);
    expect(left.steps).toBe(1);
  });

  // The race the live suite runs for real (`jobs-retention.live.test.ts`), one session wide: the
  // shared run's other row is deleted by ANOTHER sweep that commits after this batch read it as
  // standing. The follow-up statement, read after both, is what removes the steps.
  test('a held run’s steps go once the row that held them is gone by another hand', async () => {
    const { executor } = await embeddedPg();
    const old = await jobRow('done', 20);
    const other = await sibling(old, 'done', 1);
    const statements: string[] = [];
    const interleaved = jobsPurgeTarget({
      executor: {
        query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
          statements.push(text);
          const rows = await executor.query<R>(text, values);
          if (text === SQL_JOBS_RETENTION_BATCH) {
            await executor.query('delete from x_jobs where id = $1', [other]);
          }
          return rows;
        },
      },
      doneRetentionMs: 14 * DAY_MS,
      deadRetentionMs: 90 * DAY_MS,
    });
    expect(await interleaved.purgeExpired(Date.now())).toBe(1);
    expect(statements).toEqual([
      SQL_JOBS_RETENTION_BATCH,
      SQL_JOBS_RETENTION_STEPS,
      SQL_JOBS_RETENTION_ORPHANS,
    ]);
    expect(await remaining()).toEqual({ jobs: new Set(), steps: 0 });
  });

  test('a batch that held no run sends no follow-up, only the pass’s one orphan statement', async () => {
    const { executor } = await embeddedPg();
    await jobRow('done', 20);
    const statements: string[] = [];
    const recording = jobsPurgeTarget({
      executor: {
        query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
          statements.push(text);
          return executor.query<R>(text, values);
        },
      },
      doneRetentionMs: 14 * DAY_MS,
      deadRetentionMs: 90 * DAY_MS,
    });
    expect(await recording.purgeExpired(Date.now())).toBe(1);
    expect(statements).toEqual([SQL_JOBS_RETENTION_BATCH, SQL_JOBS_RETENTION_ORPHANS]);
  });

  // A sweep that committed its batch and DIED before the follow-up: the jobs are gone, the held
  // run's steps are not, and no later batch will ever name that run again.
  test('steps stranded by a sweep that died before its follow-up go on the next pass', async () => {
    const { executor } = await embeddedPg();
    const stranded = await jobRow('done', 20);
    await sibling(stranded, 'done', 20);
    await executor.query(`update x_job_steps set started_at = now() - interval '21 days'`, []);
    await executor.query('delete from x_jobs', []);
    expect(await remaining()).toEqual({ jobs: new Set(), steps: 1 });
    expect(await (await target()).purgeExpired(Date.now())).toBe(0);
    expect(await remaining()).toEqual({ jobs: new Set(), steps: 0 });
  });

  test('the orphan pass leaves a live run’s old steps and a young record alone, and is bounded', async () => {
    const { executor } = await embeddedPg();
    const suspended = await jobRow('suspended', 60);
    await executor.query(`update x_job_steps set started_at = now() - interval '60 days'`, []);
    // Two records with no job row, one older than the shorter window and one younger.
    for (const [name, age] of [
      ['old', '30 days'],
      ['young', '1 day'],
    ] as const) {
      await executor.query(
        `insert into x_job_steps (run_id, name, status, started_at)
         values (gen_random_uuid(), $1, 'done', now() - $2::interval)`,
        [name, age],
      );
    }
    for (let index = 0; index < 3; index += 1) {
      await executor.query(
        `insert into x_job_steps (run_id, name, status, started_at)
         values (gen_random_uuid(), 'extra', 'done', now() - interval '30 days')`,
        [],
      );
    }
    // Bounded at the batch size: two of the four old orphans per pass.
    await (await target({ batchSize: 2 })).purgeExpired(Date.now());
    const names = async () =>
      (
        await executor.query<{ name: string }>('select name from x_job_steps order by name', [])
      ).map((row) => row.name);
    expect(await names()).toHaveLength(4);
    await (await target({ batchSize: 2 })).purgeExpired(Date.now());
    expect(await names()).toEqual(['render', 'young']);
    expect((await remaining()).jobs).toEqual(new Set([suspended]));
  });

  test('a window that is not a positive number is refused at construction', async () => {
    const { executor } = await embeddedPg();
    expect(() =>
      jobsPurgeTarget({ executor, doneRetentionMs: 0, deadRetentionMs: 90 * DAY_MS }),
    ).toThrow(/doneRetentionMs/);
  });
});
