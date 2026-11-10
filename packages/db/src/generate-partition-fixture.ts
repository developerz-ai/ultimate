// TEST-ONLY. The one proof of `entity({ partitionBy })`'s SQL, run against a real server by two
// suites: Postgres (`generate-partition.live.test.ts`) and the embedded PGlite
// (`generate-partition-embedded.test.ts`). Monthly partitions are created, an insert routes to its
// month, the maintenance call creates ahead and its retention drops whole partitions.

import { expect } from 'bun:test';
import { renderThrowable } from '@ultimat3/core';
import type { DbClient } from './client';
import { diffSchema } from './drift';
import type {
  ColumnDescriptionLike,
  EntityDescriptionLike,
  PartitionDescriptionLike,
} from './entity-shape';
import { generateMigration } from './generate';
import { partitionMaintenance, RETIRING_COMMENT } from './generate-partition';
import { maintainPartitions } from './generate-partition-run';
import { introspectSchema } from './introspect';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const column = (name: string, kind: string, primaryKey = false): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind,
  notNull: true,
  primaryKey,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const DAY_MS = 86_400_000;

/** A monthly `events` table keyed `(id, at)`, as `entity({ partitionBy })` describes one. */
export const partitionedEvents = (
  table: string,
  partition: PartitionDescriptionLike | null = { column: 'at', interval: 'month', ahead: 2 },
): EntityDescriptionLike => ({
  name: table,
  table,
  primaryKey: ['id', 'at'],
  columns: [column('id', 'uuid', true), column('at', 'timestamptz', true), column('kind', 'text')],
  indexes: [
    { name: `${table}_kind_idx`, columns: ['kind'], unique: false, where: null, order: null },
  ],
  ...(partition === null ? {} : { partition }),
});

/** `<table>_pYYYYMM01` for the month `months` after `at`'s, UTC — the function's own naming. */
export const monthPartition = (table: string, at: Date, months: number): string => {
  const first = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + months, 1));
  return `${table}_p${first.toISOString().slice(0, 10).replaceAll('-', '')}`;
};

/** The partitions of `table`, by name, as the catalog holds them. */
export const partitionsOf = async (client: DbClient, table: string): Promise<string[]> =>
  (
    await client.query<{ name: string }>(
      raw(
        'select c.relname::text as name from pg_inherits h join pg_class c on c.oid = h.inhrelid ' +
          `where h.inhparent = '"${table}"'::regclass order by 1`,
      ),
    )
  ).map((row) => row.name);

const apply = async (client: DbClient, script: string): Promise<void> => {
  for (const statement of statementsOf(script)) await client.execute(raw(statement));
};

/** The text a refused statement carried, server error included. */
const refusal = async (send: Promise<unknown>): Promise<string> => {
  try {
    await send;
  } catch (error) {
    const source = (error as { sourceError?: unknown }).sourceError ?? error;
    return `${renderThrowable(error)} ${renderThrowable(source)}`;
  }
  return expect.unreachable('the statement was not refused');
};

export async function provePartitioning(client: DbClient, table: string): Promise<void> {
  await client.execute(raw(`drop table if exists "${table}" cascade`));
  const entity = partitionedEvents(table);
  const migration = generateMigration({ entities: [entity], name: 'events', now: new Date() });
  expect(migration.destructive).toBe(false);
  await apply(client, migration.up);

  // The migration created this month and two ahead, judged at APPLY time by the SERVER's clock —
  // the test runner's `Date` may be pinned, the database's never is.
  const clock = await client.one<{ now: string }>(raw(`select to_json(now())#>>'{}' as now`));
  const now = new Date(clock?.now ?? '');
  const created = [0, 1, 2].map((months) => monthPartition(table, now, months));
  const [first = '', second = ''] = created;
  expect(await partitionsOf(client, table)).toEqual(created);

  // An insert routes to its month's partition; a read of the parent sees both.
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15));
  await client.execute(
    raw(
      `insert into "${table}" (id, at, kind) values ` +
        `('00000000-0000-7000-8000-000000000001', '${now.toISOString()}', 'a'), ` +
        `('00000000-0000-7000-8000-000000000002', '${next.toISOString()}', 'b')`,
    ),
  );
  const routed = await client.query<{ kind: string; part: string }>(
    raw(`select kind, tableoid::regclass::text as part from "${table}" order by kind`),
  );
  expect(routed.map((row) => [row.kind, row.part.replaceAll('"', '')])).toEqual([
    ['a', first],
    ['b', second],
  ]);

  // A row past every partition is refused by Postgres — no default partition hides it.
  const far = new Date(now.getTime() + 400 * DAY_MS).toISOString();
  expect(
    await refusal(
      client.execute(
        raw(
          `insert into "${table}" values ('00000000-0000-7000-8000-000000000003', '${far}', 'c')`,
        ),
      ),
    ),
  ).toContain('partition');

  // Sixteen months on, a 400-day window (about thirteen months): this month and two ahead of then
  // are created, and the first two months — whose upper bounds the window passed — are detached
  // and dropped with their rows.
  const later = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 16, 2));
  const retained: EntityDescriptionLike = {
    ...entity,
    partition: {
      column: 'at',
      interval: 'month',
      ahead: 2,
      retain: { after: '400d', afterMs: 400 * DAY_MS },
    },
  };
  const run = await maintainPartitions(client, retained, later);
  expect(run.created).toEqual([0, 1, 2].map((m) => monthPartition(table, later, m)));
  expect(run.dropped).toEqual([first, second]);
  expect(await partitionsOf(client, table)).not.toContain(first);
  const left = await client.query<{ kind: string }>(raw(`select kind from "${table}"`));
  expect(left).toEqual([]);

  // A second run at the same instant is a no-op both ways.
  expect(await maintainPartitions(client, retained, later)).toEqual({ created: [], dropped: [] });

  // A run that died after its detach left a marked, detached table: the next run drops it. An
  // unmarked table of the same shape of name is not this package's and is never touched.
  const third = monthPartition(table, now, 2);
  await client.execute(raw(`comment on table "${third}" is '${RETIRING_COMMENT}'`));
  await client.execute(raw(`alter table "${table}" detach partition "${third}"`));
  const stray = monthPartition(table, now, -30);
  await client.execute(raw(`create table "${stray}" (id int)`));
  const resumed = await maintainPartitions(
    client,
    retained,
    new Date(later.getTime() + 62 * DAY_MS),
  );
  expect(resumed.dropped).toContain(third);
  expect(resumed.dropped).not.toContain(stray);
  expect(await client.one(raw(`select to_regclass('"${third}"') as t`))).toEqual({ t: null });
  await client.execute(raw(`drop table "${stray}"`));

  // Drift judges the parent: still the table the snapshot records, partitions or not.
  const live = await introspectSchema({ client });
  const mine = { tables: live.tables.filter((each) => each.name === table) };
  expect(diffSchema(mine, migration.snapshot).differences).toEqual([]);

  // Adopting partitionBy on a PLAIN table is refused at migrate time, with the code.
  const plain = `${table}_plain`;
  await client.execute(raw(`drop table if exists "${plain}" cascade`));
  const created2 = generateMigration({
    entities: [partitionedEvents(plain, null)],
    name: 'plain',
    now: new Date(),
  });
  await apply(client, created2.up);
  const adopt = generateMigration({
    entities: [partitionedEvents(plain)],
    current: created2.snapshot,
    name: 'adopt',
    now: new Date(),
  });
  expect(await refusal(apply(client, adopt.up))).toContain('X_MIGRATION_PARTITION_CHANGE');

  await client.execute(raw(`drop table if exists "${plain}" cascade`));
  await client.execute(raw(`drop table "${table}" cascade`));
}

/**
 * The recovery recipe, runnable: a new partitioned table receives rows older than its first
 * partition — a `backfill()` from the table it replaces. `partitionMaintenance(…, { from })`
 * creates every partition back to the oldest row first, so the copy routes instead of `23514`.
 */
export async function proveBackfillFrom(client: DbClient, table: string): Promise<void> {
  await client.execute(raw(`drop table if exists "${table}" cascade`));
  const entity = partitionedEvents(table);
  await apply(
    client,
    generateMigration({ entities: [entity], name: 'events', now: new Date() }).up,
  );
  const clock = await client.one<{ now: string }>(raw(`select to_json(now())#>>'{}' as now`));
  const now = new Date(clock?.now ?? '');
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 20));
  const insertOld = () =>
    client.execute(
      raw(
        `insert into "${table}" (id, at, kind) values ` +
          `('00000000-0000-7000-8000-000000000009', '${oldest.toISOString()}', 'old')`,
      ),
    );
  // Without the bound: the recipe's first copied row has no partition.
  expect(await refusal(insertOld())).toContain('partition');

  const back = partitionMaintenance(entity, now, { from: oldest });
  if (back === null) return expect.unreachable('a partitioned entity has maintenance');
  const [answer] = await client.query<{ result: { created: string[] } }>(back);
  expect(answer?.result.created).toEqual(
    [-5, -4, -3, -2, -1].map((months) => monthPartition(table, now, months)),
  );
  await insertOld();
  const [row] = await client.query<{ part: string }>(
    raw(`select tableoid::regclass::text as part from "${table}" where kind = 'old'`),
  );
  expect(row?.part.replaceAll('"', '')).toBe(monthPartition(table, now, -5));
  await client.execute(raw(`drop table "${table}" cascade`));
}
