// A `concurrently: true` index and an index removal, generated and then APPLIED by `migrate()` on the
// real embedded engine — the only judge of `25001`, of whether a step really ran outside a
// transaction, and of what an interrupted concurrent build leaves behind. The INVALID index here
// is a real one: a unique build over duplicate rows fails half-way exactly as a cancelled one does.
// `concurrent-index.live.test.ts` is the same story on a Postgres server.

import { afterAll, describe, expect, test } from 'bun:test';
import type { DbClient } from './client';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  IndexDescriptionLike,
} from './entity-shape';
import type { GeneratedMigration } from './generate';
import { generateMigration, snapshotOf } from './generate';
import { type Migration, migrate, rollback } from './migrate';
import { pgliteClient } from './pglite';
import { raw, sql } from './sql';

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

const runs = (
  indexes: readonly IndexDescriptionLike[],
  extra: readonly ColumnDescriptionLike[] = [],
  refUnique = true,
): EntityDescriptionLike => ({
  name: 'Run',
  table: 'runs',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'integer', primaryKey: true, notNull: true }),
    // `unique` on the COLUMN: Postgres backs it with the CONSTRAINT `runs_ref_key`.
    column('ref', { unique: refUnique }),
    column('status'),
    ...extra,
  ],
  indexes,
});

const KEY = { name: 'runs_ref_key', columns: ['ref'], unique: true, where: null, order: null };
const UNIQUE_STATUS: IndexDescriptionLike = {
  name: 'runs_status_key',
  columns: ['status'],
  unique: true,
  where: null,
  order: null,
  concurrently: true,
};

/** Every file a generation writes, in apply order — the two steps when there are two. */
const files = (generated: GeneratedMigration): readonly Migration[] =>
  [generated, ...(generated.followUp === undefined ? [] : [generated.followUp])].map((each) => ({
    id: each.id,
    name: each.name,
    up: each.up,
    down: each.down,
  }));

const validity = async (client: DbClient, name: string): Promise<boolean | null> => {
  const row = await client.one<{ valid: boolean }>(
    sql`select i.indisvalid as valid from pg_index i where i.indexrelid = to_regclass(${name})`,
  );
  return row?.valid ?? null;
};

const ledger = async (client: DbClient): Promise<readonly string[]> =>
  (await client.query<{ id: string }>(sql`select id from x_migrations order by id`)).map(
    (row) => row.id,
  );

describe('concurrent index steps · the real embedded database', () => {
  const PGLITE_BOOT_MS = 30_000;
  const client = pgliteClient();
  const initial = generateMigration({
    entities: [runs([KEY])],
    current: { tables: [] },
    name: 'create runs',
    now: new Date('2026-10-31T10:00:00.000Z'),
  });
  const build = generateMigration({
    entities: [runs([KEY, UNIQUE_STATUS])],
    current: snapshotOf([runs([KEY])]),
    name: 'unique status',
    now: new Date('2026-10-31T11:00:00.000Z'),
  });
  const migrations = [...files(initial), ...files(build)];

  afterAll(async () => {
    await client.close();
  });

  test(
    'an interrupted build leaves an INVALID index and no ledger row; the re-run rebuilds it',
    async () => {
      await migrate({ migrations: files(initial), appVersion: 'test', client });
      // Two rows sharing a status: the unique build fails half-way, as a cancelled one does.
      await client.execute(
        raw(`insert into runs (id, ref, status) values (1, 'a', 'x'), (2, 'b', 'x')`),
      );

      const failed = await migrate({ migrations, appVersion: 'test', client }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failed).toBeDefined();
      // Outside a transaction nothing rolled the half-built index back — it is there, INVALID,
      // holding the name `if not exists` would otherwise skip over.
      expect(await validity(client, 'runs_status_key')).toBe(false);
      expect(await ledger(client)).toEqual([initial.id]);

      await client.execute(raw(`update runs set status = 'y' where id = 2`));
      const report = await migrate({ migrations, appVersion: 'test', client });

      expect(report.applied.map((each) => each.id)).toEqual([build.id]);
      expect(await validity(client, 'runs_status_key')).toBe(true);
      expect(await ledger(client)).toEqual([initial.id, build.id]);
      // And it holds: a duplicate is refused by the rebuilt index.
      const duplicate = await client
        .execute(raw(`insert into runs (id, ref, status) values (3, 'c', 'y')`))
        .then(
          () => 'inserted',
          () => 'refused',
        );
      expect(duplicate).toBe('refused');
    },
    PGLITE_BOOT_MS,
  );

  test('a rollback reverses the step outside a transaction too', async () => {
    expect(await rollback({ migrations, client })).toEqual([build.id]);
    expect(await validity(client, 'runs_status_key')).toBeNull();
    // Forwards again, so the next test starts from the full schema.
    await migrate({ migrations, appVersion: 'test', client });
    expect(await validity(client, 'runs_status_key')).toBe(true);
  });

  test('two steps, expand then contract: a column and a removal, including a CONSTRAINT', async () => {
    // `runs_ref_key` is a constraint's index and `runs_status_key` a plain one: the snapshot
    // cannot tell them apart, and `drop index concurrently` on the first is 2BP01.
    const contract = generateMigration({
      entities: [runs([], [column('note')], false)],
      current: snapshotOf([runs([KEY, UNIQUE_STATUS])]),
      name: 'drop the uniques',
      now: new Date('2026-10-31T12:00:00.000Z'),
      allowDestructive: true,
    });
    expect(contract.followUp).toBeDefined();
    const all = [...migrations, ...files(contract)];

    const report = await migrate({ migrations: all, appVersion: 'test', client });

    expect(report.applied.map((each) => each.id)).toEqual([
      contract.id,
      `${contract.id}_concurrently`,
    ]);
    expect(await validity(client, 'runs_ref_key')).toBeNull();
    expect(await validity(client, 'runs_status_key')).toBeNull();

    // Both back, in reverse: the concurrent step first, then the column.
    expect(await rollback({ migrations: all, client, steps: 2 })).toEqual([
      `${contract.id}_concurrently`,
      contract.id,
    ]);
    expect(await validity(client, 'runs_ref_key')).toBe(true);
    expect(await validity(client, 'runs_status_key')).toBe(true);
  });
});
