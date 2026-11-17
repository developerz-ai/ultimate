// A NOT NULL column added with no default, generated and APPLIED on the real embedded engine, then
// checked the way `x db migrate`, `x db reset` and `bun run setup` check it: `checkDrift` after the
// run. Before the contract was generated, a FRESH database failed that check forever — the expand
// file's snapshot claimed NOT NULL over a nullable `add column` — with a `psql` fix that an
// embedded database (no `DATABASE_URL`) cannot even run.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { checkDrift } from './drift';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { type GeneratedMigration, generateMigration } from './generate';
import { type Migration, migrate } from './migrate';
import { pgliteClient } from './pglite';
import { raw, sql } from './sql';

const PGLITE_BOOT_MS = 30_000;

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

const posts = (...extra: readonly ColumnDescriptionLike[]): EntityDescriptionLike => ({
  name: 'NnPost',
  table: 'nn_posts',
  primaryKey: ['id'],
  columns: [column('id', { kind: 'integer', primaryKey: true, notNull: true }), ...extra],
  indexes: [],
});

/** Every file one generation writes, in apply order, each with the snapshot it records. */
const files = (generated: GeneratedMigration): readonly Migration[] =>
  [generated, ...(generated.followUp === undefined ? [] : [generated.followUp])].map((each) => ({
    id: each.id,
    name: each.name,
    up: each.up,
    down: each.down,
    snapshot: each.snapshot,
  }));

const initial = generateMigration({
  entities: [posts()],
  current: { tables: [] },
  name: 'initial',
  now: new Date('2026-11-17T10:00:00.000Z'),
});
const added = generateMigration({
  entities: [posts(column('summary', { notNull: true }))],
  current: initial.snapshot,
  name: 'record summary',
  now: new Date('2026-11-17T11:00:00.000Z'),
});
const migrations = [...files(initial), ...files(added)];

const client = pgliteClient();

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.execute(raw('drop table if exists "nn_posts", "x_migrations" cascade'));
}, PGLITE_BOOT_MS);

const nullable = async (): Promise<boolean | undefined> =>
  (
    await client.one<{ nullable: boolean }>(
      sql`select is_nullable = 'YES' as nullable from information_schema.columns
          where table_name = 'nn_posts' and column_name = 'summary'`,
    )
  )?.nullable;

describe('a required column added with no default · the embedded database', () => {
  test(
    'a fresh database migrates to a clean drift check, the column NOT NULL',
    async () => {
      await migrate({ migrations, appVersion: 'test', client });
      expect(await checkDrift({ migrations, client })).toEqual({ ok: true, differences: [] });
      expect(await nullable()).toBe(false);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a NULL row stops the contract; backfilled, the next migrate finishes it and drift is clean',
    async () => {
      await migrate({ migrations: files(initial), appVersion: 'test', client });
      await client.execute(raw('insert into "nn_posts" ("id") values (1)'));
      const refused = await migrate({ migrations, appVersion: 'test', client }).then(
        () => 'applied',
        (error: unknown) => (error as { code?: string }).code ?? 'uncoded',
      );
      expect(refused).not.toBe('applied');
      // The expand step committed; its snapshot says nullable, so the half-way database is not drift.
      expect(await nullable()).toBe(true);
      await client.execute(
        raw(`update "nn_posts" set "summary" = 'filled' where "summary" is null`),
      );
      await migrate({ migrations, appVersion: 'test', client });
      expect(await checkDrift({ migrations, client })).toEqual({ ok: true, differences: [] });
      expect(await nullable()).toBe(false);
    },
    PGLITE_BOOT_MS,
  );
});
