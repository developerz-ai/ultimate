// The finished-job sweep against a real server, with TWO sweeps over one run — what the embedded
// database cannot show: it has one session, so no batch is ever open while another runs. Each
// sweep deletes one terminal row of a shared run, and each sees the other's row as still standing;
// the step records must go anyway, once both have committed. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import {
  jobsPurgeTarget,
  SQL_JOBS_RETENTION_BATCH,
  SQL_JOBS_RETENTION_ORPHANS,
  SQL_JOBS_RETENTION_STEPS,
} from './jobs-retention';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_retention_live');
const DAY_MS = 86_400_000;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · two sweeps over one run', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let executor: PgExecutor;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 4 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    executor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        client.query<R>({ text, values }),
    };
  });

  beforeEach(async () => {
    await executor.query('delete from x_jobs', []);
    await executor.query('delete from x_job_steps', []);
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  /** Two `done` rows under one run, the first the older, and one step record under the run. */
  const sharedRun = async (): Promise<void> => {
    const runId = crypto.randomUUID();
    for (const [key, ageDays] of [
      ['a', 21],
      ['b', 20],
    ] as const) {
      await executor.query(
        `insert into x_jobs (id, name, input, idempotency_key, run_id, state, updated_at)
         values (gen_random_uuid(), 'mail.send', '{}'::jsonb, $1, $2, 'done',
                 now() - ($3::bigint * interval '1 millisecond'))`,
        [key, runId, ageDays * DAY_MS],
      );
    }
    await executor.query(
      `insert into x_job_steps (run_id, name, status) values ($1, 'render', 'done')`,
      [runId],
    );
  };

  const count = async (table: string): Promise<number> => {
    const rows = await executor.query<{ n: number }>(`select count(*)::int as n from ${table}`, []);
    return Number(rows[0]?.n ?? 0);
  };

  test('each deletes one row of the run, neither sees the other gone, and the steps still go', async () => {
    await sharedRun();
    // Sweep A: one batch of one, held OPEN — the oldest row deleted and locked, not yet committed.
    using pinned = await client.reserve();
    const sweepA: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        pinned.query<R>({ text, values }),
    };
    await sweepA.query('begin', []);
    const batchA = await sweepA.query<{ removed: number; held: string }>(SQL_JOBS_RETENTION_BATCH, [
      14 * DAY_MS,
      90 * DAY_MS,
      1,
      null,
      null,
    ]);
    expect(Number(batchA[0]?.removed)).toBe(1);

    // Sweep B, on another session meanwhile: skips A's locked row, takes the other, and to its
    // snapshot A's row still stands — so the steps cannot be its to delete yet.
    const target = jobsPurgeTarget({
      executor,
      doneRetentionMs: 14 * DAY_MS,
      deadRetentionMs: 90 * DAY_MS,
    });
    expect(await target.purgeExpired(Date.now())).toBe(1);
    expect(await count('x_job_steps')).toBe(1);

    // A commits, then runs its follow-up exactly as the target does: after its batch committed.
    await sweepA.query('commit', []);
    const held = batchA[0]?.held ?? '[]';
    expect(held).not.toBe('[]');
    await sweepA.query(SQL_JOBS_RETENTION_STEPS, [held]);

    expect(await count('x_jobs')).toBe(0);
    expect(await count('x_job_steps')).toBe(0);
  });

  // A real server's planner, over a queue the size a production one reaches (63,000 rows, a tenth
  // of them live): the run lookup must be `x_jobs_run_idx` in both statements, never a pass over
  // the whole table per batch. `explain` only plans, so nothing here is deleted.
  test('every statement finds a run’s rows through x_jobs_run_idx', async () => {
    await executor.query(
      `insert into x_jobs (id, name, input, idempotency_key, run_id, state, updated_at)
       select gen_random_uuid(), 'mail.send', '{}'::jsonb, 'k' || g, gen_random_uuid(),
              case when g % 10 = 0 then 'ready' else 'done' end,
              now() - (g % 30) * interval '1 day'
         from generate_series(1, 63000) g`,
      [],
    );
    await executor.query(
      `insert into x_job_steps (run_id, name, status, started_at)
       select run_id, 'render', 'done', updated_at from x_jobs`,
      [],
    );
    await executor.query('analyze x_jobs', []);
    await executor.query('analyze x_job_steps', []);
    const plan = async (sql: string, params: readonly unknown[]): Promise<string> => {
      const rows = await executor.query<Record<string, unknown>>(`explain ${sql}`, params);
      return rows.map((row) => Object.values(row).join('')).join('\n');
    };
    const held = JSON.stringify([crypto.randomUUID(), crypto.randomUUID()]);
    expect(
      await plan(SQL_JOBS_RETENTION_BATCH, [14 * DAY_MS, 90 * DAY_MS, 1000, null, null]),
    ).toMatch(/Index Scan using x_jobs_run_idx on x_jobs l\s+\([^)]*\)\s+Index Cond: \(run_id = /);
    expect(await plan(SQL_JOBS_RETENTION_STEPS, [held])).toContain(
      'Index Scan using x_jobs_run_idx on x_jobs j',
    );
    const orphans = await plan(SQL_JOBS_RETENTION_ORPHANS, [14 * DAY_MS, 1000]);
    expect(orphans).toContain('Index Only Scan using x_jobs_run_idx on x_jobs j');
    expect(orphans).toContain('Index Scan using x_job_steps_pkey on x_job_steps s');
  }, 60_000);

  // The production shape: a `dead` row is kept 90 days and a `done` one 14, so every batch's walk
  // in `updated_at` order over all four terminal states stepped over the young dead rows sitting
  // between the done ones — 32–40 ms a batch in production. Each window now seeks its own index.
  test('done rows are found through x_jobs_done_idx, never by walking the dead rows kept longer', async () => {
    await executor.query('truncate x_jobs, x_job_steps', []);
    await executor.query(
      `insert into x_jobs (id, name, input, idempotency_key, run_id, state, updated_at)
       select gen_random_uuid(), 'mail.send', '{}'::jsonb, 'k' || g, gen_random_uuid(),
              case when g % 3 = 0 then 'done' else 'dead' end,
              now() - (g % 60) * interval '1 day'
         from generate_series(1, 63000) g`,
      [],
    );
    await executor.query('analyze x_jobs', []);
    const rows = await executor.query<Record<string, unknown>>(
      `explain ${SQL_JOBS_RETENTION_BATCH}`,
      [14 * DAY_MS, 90 * DAY_MS, 1000, null, null],
    );
    const plan = rows.map((row) => Object.values(row).join('')).join('\n');
    expect(plan).toContain('Index Scan using x_jobs_done_idx on x_jobs');
  }, 60_000);

  // A delete leaves its index entry until vacuum. A walk from the index's start stepped over every
  // row the pass had already deleted — a heap visit each — so the last batch read the most to
  // delete the least (3,534 blocks in production). Each batch here is measured as it would run
  // (`explain analyze` inside a rolled-back transaction, on the target's own session), then run.
  test('each batch seeks past the rows the batch before deleted, so its work does not grow', async () => {
    await executor.query('truncate x_jobs, x_job_steps', []);
    await executor.query(
      `insert into x_jobs (id, name, input, idempotency_key, run_id, state, updated_at)
       select gen_random_uuid(), 'mail.send', jsonb_build_object('body', repeat('x', 300)),
              'young' || g, gen_random_uuid(), 'done',
              now() - (g % 13) * interval '1 day' - interval '1 hour'
         from generate_series(1, 30000) g`,
      [],
    );
    await executor.query(
      `insert into x_jobs (id, name, input, idempotency_key, run_id, state, updated_at)
       select gen_random_uuid(), 'mail.send', '{}'::jsonb, 'old' || g, gen_random_uuid(), 'done',
              now() - interval '20 days' - g * interval '1 second'
         from generate_series(1, 2500) g`,
      [],
    );
    await executor.query('analyze x_jobs', []);
    // An open snapshot elsewhere — a long transaction, a standby's feedback — the production case:
    // until it ends no deleted row is dead to everyone, so no scan may skip its entry unread.
    using snapshot = await client.reserve();
    await snapshot.query({ text: 'begin isolation level repeatable read', values: [] });
    await snapshot.query({ text: 'select 1', values: [] });
    using session = await client.reserve();
    const on = <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      session.query<R>({ text, values });
    const batches: PlanNode[][] = [];
    const measured: PgExecutor = {
      query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
        if (text === SQL_JOBS_RETENTION_BATCH) {
          await on('begin', []);
          const rows = await on<Record<string, unknown>>(
            `explain (analyze, buffers, format json) ${text}`,
            values,
          );
          await on('rollback', []);
          batches.push(planNodes(rows));
        }
        return await on<R>(text, values);
      },
    };
    const target = jobsPurgeTarget({
      executor: measured,
      doneRetentionMs: 14 * DAY_MS,
      deadRetentionMs: 90 * DAY_MS,
      batchSize: 500,
    });

    const removed = await target.purgeExpired(Date.now());
    await snapshot.query({ text: 'rollback', values: [] });
    expect(removed).toBe(2500);

    // Five full batches and the short one that ends the pass.
    expect(batches).toHaveLength(6);
    for (const nodes of batches) {
      const heapWalks = nodes.filter(
        (node) => node['Relation Name'] === 'x_jobs' && node['Node Type'] === 'Seq Scan',
      );
      expect(heapWalks).toEqual([]);
    }
    // A backlog past the batch is walked in order and cut at `limit`, never read whole and sorted.
    expect(
      batches[0]?.some(
        (node) => node['Node Type'] === 'Index Scan' && node['Index Name'] === 'x_jobs_done_idx',
      ),
    ).toBe(true);
    const walked = batches.map(doneBranchBlocks);
    const first = walked[0] ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(Math.max(...walked)).toBeLessThanOrEqual(first * 2);
  }, 60_000);
});

type PlanNode = Record<string, unknown> & { readonly Plans?: readonly PlanNode[] };

/** Every node of an `explain (format json)` answer, flattened. */
function planNodes(rows: readonly Record<string, unknown>[]): PlanNode[] {
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode): void => {
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  const raw = rows[0]?.['QUERY PLAN'];
  const document = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
  for (const entry of document) walk(entry.Plan);
  return nodes;
}

/**
 * Shared blocks, hit or read, the done branch spent finding its rows: an ordered walk of
 * `x_jobs_done_idx`, or — when the planner knows the range is small — a bitmap read of the whole
 * range, which is the batch. Either way the count is the branch's, not the delete's.
 */
function doneBranchBlocks(nodes: readonly PlanNode[]): number {
  const blocks = (node: PlanNode): number =>
    Number(node['Shared Hit Blocks'] ?? 0) + Number(node['Shared Read Blocks'] ?? 0);
  return nodes
    .filter(
      (node) =>
        (node['Node Type'] === 'Index Scan' && node['Index Name'] === 'x_jobs_done_idx') ||
        (node['Node Type'] === 'Bitmap Heap Scan' &&
          String(node['Recheck Cond'] ?? '').includes("state = 'done'")),
    )
    .reduce((sum, node) => sum + blocks(node), 0);
}
