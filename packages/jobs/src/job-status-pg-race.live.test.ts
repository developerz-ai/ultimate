// `cancelJobFor` racing a worker's settle on two sessions of a real server: the cancel waits on the
// settle's row lock, finds the row no longer live once it commits, and must answer the state the
// settle wrote — never the snapshot its statement began on. What the embedded database cannot
// show: it runs one statement at a time. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import type { JobDriver } from './driver';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { cancelJobFor } from './job-status';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_status_race_live');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

describe.skipIf(!hasPostgres)('live · postgres · a tenant cancel racing a settle', () => {
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

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  /** Polled, never slept: the cancel is provably parked on the settle's lock before it commits. */
  async function waitForLockWait(): Promise<void> {
    for (let tries = 0; tries < 500; tries += 1) {
      const rows = await executor.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect.unreachable('the cancel never waited on the settle’s row lock');
  }

  test('a cancel the settle beat answers the finished state, not the running snapshot', async () => {
    const { id } = await driver.enqueue({
      name: 'report.build',
      queue: 'default',
      input: {},
      idempotencyKey: 'race',
      maxAttempts: 1,
      tenantId: 'org-a',
    });
    const [held] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
    });
    if (held === undefined) return expect.unreachable('the fresh row was claimable');

    using session = await client.reserve();
    const settle: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        session.query<R>({ text, values }),
    };
    await settle.query('begin', []);
    await settle.query(`update x_jobs set state = 'done', updated_at = now() where id = $1`, [id]);
    const cancel = cancelJobFor(driver, { jobId: id, tenantId: 'org-a' });
    await waitForLockWait();
    await settle.query('commit', []);

    expect((await cancel)?.state).toBe('done');
  });
});
