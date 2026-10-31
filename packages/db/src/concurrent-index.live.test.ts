// `concurrently: true` against a Postgres server: the step really runs outside a transaction (a
// concurrent build inside one is 25001), it carries no `lock_timeout` (a concurrent build WAITS for
// every older transaction, and a 3 s bound turned that wait into an INVALID index), and an
// interrupted build is recovered on the next run. `concurrent-index-embedded.test.ts` runs the same
// recovery on PGlite; this one is the server `ROLE=migrate` talks to.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { LEDGER_TABLE, type Migration, migrate } from './migrate';
import { raw, sql } from './sql';
import { sqlState } from './sqlstate';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'ci_live_runs';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const runs = (indexes: readonly IndexDescriptionLike[]): EntityDescriptionLike => ({
  name: 'CiLiveRun',
  table: TABLE,
  primaryKey: ['id'],
  columns: [column('id', { kind: 'integer', primaryKey: true, notNull: true }), column('status')],
  indexes,
});

const STATUS: IndexDescriptionLike = {
  name: `${TABLE}_status_key`,
  columns: ['status'],
  unique: true,
  where: null,
  order: null,
  concurrently: true,
};

const at = new Date('2026-10-31T12:00:00.000Z');
const created = generateMigration({ entities: [runs([])], name: 'create runs', now: at });
const built = generateMigration({
  entities: [runs([STATUS])],
  current: snapshotOf([runs([])]),
  name: 'unique status',
  now: new Date('2026-10-31T13:00:00.000Z'),
});
const chain: readonly Migration[] = [created, built];

describe.skipIf(!hasPostgres)('live · postgres · a concurrent index step', () => {
  let client: PostgresClient;

  const clean = async (): Promise<void> => {
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    await client.execute(raw(`drop table if exists ${LEDGER_TABLE}`));
  };

  const validity = async (): Promise<boolean | null> => {
    const row = await client.one<{ valid: boolean }>(
      sql`select i.indisvalid as valid from pg_index i where i.indexrelid = to_regclass(${`"${STATUS.name}"`})`,
    );
    return row?.valid ?? null;
  };

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    await clean();
  });

  afterAll(async () => {
    await clean();
    const left = await client.query<{ n: number }>(
      raw(`select count(*)::int as n from pg_class where relname like 'ci\\_live\\_%'`),
    );
    expect(left[0]?.n).toBe(0);
    await client.close();
  });

  test('the premise: Postgres refuses the build inside a transaction block (25001)', async () => {
    expect(built.transactional).toBe(false);
    await migrate({ migrations: [created], client });
    const statement = built.up.split('\n')[1] ?? '';
    using pinned = await client.reserve();
    await pinned.execute(raw('begin'));
    const inside = await pinned.execute(raw(statement)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await pinned.execute(raw('rollback'));
    expect(sqlState(inside)).toBe('25001');
  });

  test('an interrupted build is INVALID with no ledger row; the next run rebuilds it', async () => {
    await client.execute(raw(`insert into "${TABLE}" (id, status) values (1, 'x'), (2, 'x')`));
    const failed = await migrate({ migrations: chain, client }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeDefined();
    expect(await validity()).toBe(false);

    await client.execute(raw(`update "${TABLE}" set status = 'y' where id = 2`));
    const report = await migrate({ migrations: chain, client });

    expect(report.applied.map((each) => each.id)).toEqual([built.id]);
    expect(await validity()).toBe(true);
  });

  test('the step sets no lock_timeout — the build waits out an older transaction', async () => {
    // Back to before the build, then a reader holding a snapshot open across it. A concurrent
    // build waits for every such transaction, and that wait IS a lock wait: under the 3 s bound
    // the transactional path takes it would be 55P03 and an INVALID index. 200 ms here, so the
    // test says the same thing in a fraction of the time.
    await client.execute(raw(`drop index "${STATUS.name}"`));
    await client.execute(raw(`delete from ${LEDGER_TABLE} where id = '${built.id}'`));
    const reader = postgresClient({ url: url ?? '' });
    try {
      using held = await reader.reserve();
      await held.execute(raw('begin isolation level repeatable read'));
      await held.query(raw(`select count(*) from "${TABLE}"`));
      // real-clock: the reader is ANOTHER Postgres session; the build waits on its transaction.
      const release = Bun.sleep(1_000).then(() => held.execute(raw('commit')));

      const report = await migrate({ migrations: chain, client, lockTimeoutMs: 200 });
      await release;

      expect(report.applied.map((each) => each.id)).toEqual([built.id]);
      expect(await validity()).toBe(true);
    } finally {
      await reader.close();
    }
  });
});
