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
    const observer = postgresClient({ url: url ?? '' });
    try {
      using held = await reader.reserve();
      await held.execute(raw('begin isolation level repeatable read'));
      await held.query(raw(`select count(*) from "${TABLE}"`));

      let settled = false;
      const running = migrate({ migrations: chain, client, lockTimeoutMs: 200 }).finally(() => {
        settled = true;
      });
      // Released only once the build is SEEN waiting on a lock — otherwise a build that started
      // after the reader committed would pass this test under any lock_timeout at all.
      const waiting = async (): Promise<boolean> => {
        const [row] = await observer.query<{ n: number }>(
          raw(
            `select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' ` +
              `and query like '%create unique index concurrently%${STATUS.name}%'`,
          ),
        );
        return (row?.n ?? 0) > 0;
      };
      for (let tries = 0; !(await waiting()); tries += 1) {
        expect(tries).toBeLessThan(200);
        expect(settled).toBe(false);
        // real-clock: polling ANOTHER Postgres session's state; nothing here owns its timers.
        await Bun.sleep(25);
      }
      // real-clock: past the 200 ms bound, while the build is still blocked on the reader.
      await Bun.sleep(400);
      expect(settled).toBe(false);
      expect(await waiting()).toBe(true);

      await held.execute(raw('commit'));
      const report = await running;

      expect(report.applied.map((each) => each.id)).toEqual([built.id]);
      expect(await validity()).toBe(true);
    } finally {
      await observer.close();
      await reader.close();
    }
  });

  test('a constraint key renamed to a concurrent replacement: the replacement first, then the key', async () => {
    // `status` already carries the built key from the chain; make the old one a real CONSTRAINT
    // and rename it to a concurrently built replacement. The step builds the new unique index
    // while the constraint still guards writes, and unhooks the constraint only after.
    await client.execute(raw(`drop index "${STATUS.name}"`));
    await client.execute(
      raw(`alter table "${TABLE}" add constraint "${STATUS.name}" unique ("status")`),
    );
    const renamed = generateMigration({
      entities: [runs([{ ...STATUS, name: `${TABLE}_status_uq` }])],
      current: snapshotOf([runs([STATUS])]),
      name: 'rename the key',
      now: new Date('2026-10-31T14:00:00.000Z'),
    });
    const statements = renamed.up.split('\n');
    const build = statements.findIndex((each) => each.startsWith('create unique index'));
    const unhook = statements.findIndex((each) => each.includes('drop constraint'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(unhook).toBeGreaterThan(build);

    await migrate({ migrations: [...chain, renamed], client });

    const keys = await client.query<{ name: string; constraint: string | null }>(
      raw(
        `select c.relname as name, con.conname as constraint from pg_index i ` +
          `join pg_class c on c.oid = i.indexrelid left join pg_constraint con on con.conindid = c.oid ` +
          `where i.indrelid = '"${TABLE}"'::regclass and not i.indisprimary order by 1`,
      ),
    );
    expect(keys).toEqual([{ name: `${TABLE}_status_uq`, constraint: null }]);
    const duplicate = await client
      .execute(raw(`insert into "${TABLE}" (id, status) values (9, 'x')`))
      .then(
        () => 'inserted',
        () => 'refused',
      );
    expect(duplicate).toBe('refused');
  });
});
