// `partitions()` on a real server: the migration makes this month and next; the job, its clock moved
// a month at a time, makes the next one ahead each time and drops the partition `retain` expired —
// and a second run at the same instant changes nothing. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ctxOf,
  frozenClock,
  probeDatabaseName,
  sweepProbeDatabases,
  userActor,
} from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import {
  dbExecutor,
  generateMigration,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { clearRegistry, entity, text, timestamp, uuid } from '@ultimat3/entity';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import { partitions } from './partitions';
import { resetTasks } from './task';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_partitions_live');
const DAY_MS = 86_400_000;

const events = entity('pl_events', {
  columns: { id: uuid(), at: timestamp(), kind: text() },
  primaryKey: ['id', 'at'],
  partitionBy: { column: 'at', interval: 'month', ahead: 1, retain: { after: '20d' } },
});

/** The server's now: the migration judged its first partitions by it, not by the test's clock. */
let serverNow = new Date(0);

/** The first instant of the UTC month `offset` months from the server's (the migration's) now. */
const monthStart = (offset: number): Date =>
  new Date(Date.UTC(serverNow.getUTCFullYear(), serverNow.getUTCMonth() + offset, 1));
const suffix = (at: Date): string =>
  `pl_events_p${at.toISOString().slice(0, 10).replaceAll('-', '')}`;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

afterAll(() => {
  clearRegistry();
  resetJobs();
  resetTasks();
});

describe.skipIf(!hasPostgres)('live · postgres · partitions()', () => {
  let admin: PostgresClient;
  let client: PostgresClient;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'web', profile: { max: 2 } });
    setDbClient(client);
    const [row] = await client.query<{ ms: string }>(
      raw('select (extract(epoch from now()) * 1000)::bigint::text as ms'),
    );
    serverNow = new Date(Number(row?.ms));
    const { up } = generateMigration({ entities: [events.$describe()], name: 'partitioned' });
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    setDbClient(undefined);
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  const children = async (): Promise<readonly string[]> =>
    (
      await client.query<{ name: string }>(
        raw(
          "select c.relname::text as name from pg_inherits h join pg_class c on c.oid = h.inhrelid where h.inhparent = 'pl_events'::regclass order by 1",
        ),
      )
    ).map((row) => row.name);

  test('the clock moving a month at a time makes the next partition and drops the expired', async () => {
    const clock = frozenClock(new Date(monthStart(0).getTime() + 14 * DAY_MS));
    const maintain = partitions({ name: 'pl.partitions', clock });
    expect(maintain.schedule.name).toBe('pl.partitions.schedule');
    const run = async (input: { readonly from?: string } = {}) => {
      const driver = memoryJobDriver();
      await driver.enqueue({
        name: maintain.name,
        queue: maintain.queue,
        input,
        idempotencyKey: maintain.name,
        maxAttempts: 1,
      });
      const [claimed] = await driver.claim({
        queues: [maintain.queue],
        limit: 1,
        visibilityTimeoutMs: 30_000,
        workerId: 'w1',
      });
      const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
      const execution = await executeJob({
        driver,
        claimed: claimed as ClaimedJob,
        handle: maintain as AnyJobHandle,
        ctx,
      });
      expect(execution.outcome).toBe('completed');
      return execution.result;
    };

    // The migration already made this month and the next: nothing to do.
    expect(await run()).toEqual({ tables: [{ table: 'pl_events', created: [], dropped: [] }] });
    expect(await children()).toEqual([suffix(monthStart(0)), suffix(monthStart(1))]);

    clock.advance(31 * DAY_MS);
    expect(await run()).toEqual({
      tables: [{ table: 'pl_events', created: [suffix(monthStart(2))], dropped: [] }],
    });

    clock.advance(31 * DAY_MS);
    expect(await run()).toEqual({
      tables: [
        { table: 'pl_events', created: [suffix(monthStart(3))], dropped: [suffix(monthStart(0))] },
      ],
    });
    expect(await run()).toEqual({ tables: [{ table: 'pl_events', created: [], dropped: [] }] });
    expect(await children()).toEqual([
      suffix(monthStart(1)),
      suffix(monthStart(2)),
      suffix(monthStart(3)),
    ]);

    // Before a backfill copies old rows in: `from` creates every partition back to the oldest
    // row's and sweeps nothing, so the month retention just dropped comes back for the copy.
    const oldest = new Date(monthStart(-2).getTime() + 9 * DAY_MS);
    expect(await run({ from: oldest.toISOString() })).toEqual({
      tables: [
        {
          table: 'pl_events',
          created: [suffix(monthStart(-2)), suffix(monthStart(-1)), suffix(monthStart(0))],
          dropped: [],
        },
      ],
    });
  });
});
