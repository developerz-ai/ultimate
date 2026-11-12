// The enqueue wake against a real server, for a row written inside a LONG transaction: the slot
// dedupe (`notifyJobReady`) must not let a row that commits long after its statement stay silent
// behind a row another session announced in "the same slot". Skips unless `TEST_DATABASE_URL` is
// set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { postgresJobDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { JOBS_WAKE_CHANNEL, WAKE_SLOT_MS } from './driver-pg-wake-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_wake_long_tx');

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

async function until(condition: () => boolean, budgetMs = 3_000): Promise<void> {
  const deadline = performance.now() + budgetMs;
  while (!condition()) {
    if (performance.now() > deadline) expect.unreachable('the condition never became true');
    // real-clock: a NOTIFY is delivered on the server's time, after another session's commit
    await Bun.sleep(5);
  }
}

describe.skipIf(!hasPostgres)('live · postgres · the enqueue wake of a long transaction', () => {
  let admin: PostgresClient;
  let listener: PostgresClient;
  let webPod: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    listener = postgresClient({ url: probeUrl(), role: 'worker', profile: { max: 1 } });
    webPod = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await listener.execute(raw(statement));
    }
  });

  afterAll(async () => {
    await listener.close();
    await webPod.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  test('a row enqueued in a transaction older than a slot wakes at its commit, even behind a row another session announced', async () => {
    const wakes: string[] = [];
    const subscription = await listener.listen(JOBS_WAKE_CHANNEL, (queue) => wakes.push(queue));
    using session = await webPod.reserve();
    const inTx: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        session.query<R>({ text, values }),
    };
    const request = (key: string) => ({
      name: 'longTx',
      queue: 'reports',
      input: { key },
      idempotencyKey: key,
      maxAttempts: 1,
      // The test preload freezes this process's `Date`; the server's clock is real.
      runAt: 1,
    });
    try {
      await inTx.query('begin', []);
      // The app's transaction has been open longer than a slot when it enqueues: its `now()` is
      // that old, so a slot read off it spans every row created since it began.
      await inTx.query(`select pg_sleep(${(WAKE_SLOT_MS + 50) / 1_000})`, []);

      // Another session's row, committed now: it announces itself, a worker wakes and finds it.
      await postgresJobDriver({ executor: dbExecutor(() => webPod) }).enqueue(request('first'));
      await until(() => wakes.length === 1);

      // The long transaction's row: invisible to that worker until COMMIT, which may come any time
      // later — so its statement may not lean on the wake the first row sent.
      await postgresJobDriver({ executor: inTx }).enqueue(request('late'));
      await inTx.query('commit', []);
      await until(() => wakes.length === 2);
      expect(wakes).toEqual(['reports', 'reports']);
    } finally {
      await subscription.unlisten();
    }
  });
});
