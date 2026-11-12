// A step write and a claim on two sessions of a real server: the step's fence LOCKS the job row,
// so a claim cannot take the row between the fence and the write. Each write is held open in a
// transaction to widen the window a lone statement keeps to microseconds. What the embedded
// database cannot show: it runs one statement at a time. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import type { JobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { SQL_STEP_RESOLVE } from './driver-pg-operator-sql';
import { SQL_JOBS_TABLE, SQL_STEP_PUT } from './driver-pg-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_step_fence_live');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** One job: `running` under `w1`'s first claim with its lease LAPSED, or `ready`. */
const ROW = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state, claims,
   claimed_by, visible_at)
values ($1::uuid, 'fence', 'default', '{}'::jsonb, $1::text, $2::uuid, 1, 3, $3,
        case when $3 = 'running' then 1 else 0 end,
        case when $3 = 'running' then 'w1' end,
        case when $3 = 'running' then now() - interval '1 second' end)
`;

describe.skipIf(!hasPostgres)('live · postgres · a step write locks its job row', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let executor: PgExecutor;
  let driver: JobDriver;

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
    driver = postgresJobDriver({ executor });
  });

  beforeEach(async () => {
    await executor.query('delete from x_job_steps', []);
    await executor.query('delete from x_jobs', []);
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  const job = async (state: 'running' | 'ready'): Promise<{ id: string; runId: string }> => {
    const id = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await executor.query(ROW, [id, runId, state]);
    return { id, runId };
  };

  /** `statement` inside an open transaction on its own session; the claim runs before COMMIT. */
  async function whileHeld(statement: string, values: readonly unknown[]): Promise<number> {
    using session = await client.reserve();
    const tx: PgExecutor = {
      query: <R>(text: string, params: readonly unknown[]): Promise<readonly R[]> =>
        session.query<R>({ text, values: params }),
    };
    await tx.query('begin', []);
    try {
      expect(await tx.query(statement, values)).toHaveLength(1);
      const claimed = await driver.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'w2',
      });
      return claimed.length;
    } finally {
      await tx.query('commit', []);
    }
  }

  test('a fenced put holds a lapsed lease: no claim takes the row until the step is written', async () => {
    const { id, runId } = await job('running');
    const put = [runId, 'charge', 'completed', '{"ok":true}', Date.now(), Date.now(), null, null];
    const claimed = await whileHeld(SQL_STEP_PUT, [...put, null, 1, null, id, 'w1', 1]);
    expect(claimed).toBe(0);
    // Written, released: the lapsed lease is claimable now, and the claim sees the step.
    const after = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w2',
    });
    expect(after.map((row) => row.id)).toEqual([id]);
  });

  test('a resolve holds the ready row: no claim runs it under a step half-resolved', async () => {
    const { id, runId } = await job('ready');
    await executor.query(
      `insert into x_job_steps (run_id, name, status, started_at, attempts)
       values ($1::uuid, 'charge', 'started', now(), 1)`,
      [runId],
    );
    const claimed = await whileHeld(SQL_STEP_RESOLVE, [id, 'charge', 'completed', '{"ok":true}']);
    expect(claimed).toBe(0);
  });
});
