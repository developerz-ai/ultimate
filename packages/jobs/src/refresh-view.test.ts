// `refreshView()` on the embedded PGlite, run by `executeJob`: the materialized view `x db gen`
// created answers the source table's new rows only after the job ran — concurrently and not — and
// the declarations Postgres cannot refresh are refused where they were written.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { bigint, clearRegistry, entity, uuid } from '@ultimat3/entity';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';
import { refreshView } from './refresh-view';

const PGLITE_BOOT_MS = 30_000;

const hits = entity('rv_hits', { columns: { id: uuid().primaryKey(), postId: uuid() } });
const totals = entity('rv_totals', {
  view: {
    sql: 'select post_id, count(*) as total from rv_hits group by post_id',
    materialized: true,
  },
  columns: { postId: uuid().unique(), total: bigint() },
  primaryKey: ['postId'],
});
const plain = entity('rv_plain', {
  view: { sql: 'select post_id from rv_hits' },
  columns: { postId: uuid().primaryKey() },
});
const unindexed = entity('rv_unindexed', {
  view: { sql: 'select post_id from rv_hits', materialized: true },
  columns: { postId: uuid().primaryKey() },
});

const client = pgliteClient();
const POST = '00000000-0000-7000-8000-000000000001';

beforeAll(async () => {
  setDbClient(client);
  const { up } = generateMigration({
    entities: [hits.$describe(), totals.$describe()],
    name: 'refresh view',
  });
  for (const statement of statementsOf(up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  resetJobs();
  clearRegistry();
});

const runOnce = async (handle: AnyJobHandle): Promise<string> => {
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: {},
    idempotencyKey: handle.name,
    maxAttempts: 1,
  });
  const [claimed] = await driver.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  const ctx = ctxOf({ role: 'worker', actor: userActor({ id: 'worker-1' }) });
  const execution = await executeJob({ driver, claimed: claimed as ClaimedJob, handle, ctx });
  return execution.outcome;
};

const total = async (): Promise<unknown> =>
  (await client.query<{ total: unknown }>(raw('select total::int as total from rv_totals')))[0]
    ?.total;

describe('refreshView run by executeJob', () => {
  test.each([false, true])(
    'the view answers the new rows once the job ran (concurrently: %p)',
    async (concurrently) => {
      const handle = refreshView({
        name: `refresh-totals-${concurrently}`,
        view: totals,
        concurrently,
      }) as AnyJobHandle;
      const before = await total();
      await client.execute(raw(`insert into rv_hits values (gen_random_uuid(), '${POST}')`));
      expect(await total()).toEqual(before);
      expect(await runOnce(handle)).toBe('completed');
      expect(await total()).toBe(Number(before ?? 0) + 1);
    },
    PGLITE_BOOT_MS,
  );
});

describe('what refreshView refuses', () => {
  test('a table', () => {
    expect(() => refreshView({ name: 'rv-table', view: hits })).toThrow(
      expect.objectContaining({ code: 'X_JOB_REFRESH_VIEW_INVALID' }),
    );
  });

  test('a plain view, which stores nothing to refresh', () => {
    expect(() => refreshView({ name: 'rv-plain', view: plain })).toThrow(
      expect.objectContaining({ code: 'X_JOB_REFRESH_VIEW_INVALID' }),
    );
  });

  test('concurrently over a view with no unique index', () => {
    expect(() =>
      refreshView({ name: 'rv-unindexed', view: unindexed, concurrently: true }),
    ).toThrow(expect.objectContaining({ code: 'X_JOB_REFRESH_VIEW_INVALID' }));
    expect(refreshView({ name: 'rv-unindexed-ok', view: unindexed }).name).toBe('rv-unindexed-ok');
  });
});
