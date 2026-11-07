// The drift `fix:` RUN, not read: a migrated database damaged by hand, the finding `checkDrift`
// reports, its command executed the way a shell hands it to psql, and the check asked again until
// it is clean. `x db migrate` cannot be the fix for any of these — the ledger already holds the
// migration, so the migrator applies nothing — and this file is what proves each repair is one.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { checkDrift, type DriftKind } from './drift';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { type Migration, migrate } from './migrate';
import { pgliteClient } from './pglite';
import { raw } from './sql';
import { statementsOf } from './statement-split';

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

const id = column('id', { kind: 'uuid', primaryKey: true, notNull: true });

const authors: EntityDescriptionLike = {
  name: 'RepAuthor',
  table: 'rep_authors',
  primaryKey: ['id'],
  columns: [id, column('name')],
  indexes: [],
};

const posts: EntityDescriptionLike = {
  name: 'RepPost',
  table: 'rep_posts',
  primaryKey: ['id'],
  columns: [
    id,
    column('author_id', {
      kind: 'uuid',
      notNull: true,
      references: 'rep_authors.id',
      onDelete: 'cascade',
    }),
    column('title', { notNull: true }),
    column('status', {
      notNull: true,
      hasDefault: true,
      default: { kind: 'value', value: 'draft' },
    }),
    column('subtitle'),
  ],
  indexes: [
    {
      name: 'rep_posts_title_live_idx',
      columns: ['title'],
      unique: false,
      where: 'subtitle is not null',
      order: 'desc',
    },
  ],
};

const client = pgliteClient();
const generated = generateMigration({
  entities: [authors, posts],
  name: 'repair',
  now: new Date('2026-11-07T00:00:00.000Z'),
});
const migrations: readonly Migration[] = [generated];

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await client.execute(
    raw('drop table if exists "rep_posts", "rep_authors", "x_migrations" cascade'),
  );
  await migrate({ migrations, appVersion: 'test', client });
}, PGLITE_BOOT_MS);

/** The SQL inside `psql "$DATABASE_URL" -c '…'   # …`, as a shell hands it to psql. */
const printedRepair = (fix: string): string => {
  const match = /^psql "\$DATABASE_URL" -c '((?:[^']|'\\'')*)'/.exec(fix);
  if (match?.[1] === undefined) return expect.unreachable(`the fix is no psql -c command: ${fix}`);
  return match[1].replaceAll(`'\\''`, "'");
};

/**
 * Every finding's fix, run, until the check is clean — the loop an operator walks. Bounded: a
 * repair that brings its own finding back is a fix that does not fix, and this fails on it.
 */
const repairUntilClean = async (): Promise<readonly DriftKind[]> => {
  const seen: DriftKind[] = [];
  for (let round = 0; round < 4; round += 1) {
    const report = await checkDrift({ migrations, client });
    if (report.ok) return seen;
    for (const difference of report.differences) {
      seen.push(difference.kind);
      for (const statement of statementsOf(printedRepair(difference.fix))) {
        await client.execute(raw(statement));
      }
    }
  }
  return expect.unreachable(
    `still drifted: ${JSON.stringify(await checkDrift({ migrations, client }))}`,
  );
};

describe('a drift fix is a repair that runs, never x db migrate', () => {
  test('x db migrate re-run applies nothing, which is why it cannot be the fix', async () => {
    await client.execute(raw('drop index "rep_posts_title_live_idx"'));
    const again = await migrate({ migrations, appVersion: 'test', client });
    expect(again.applied).toEqual([]);
    const report = await checkDrift({ migrations, client });
    expect(report.differences.map((d) => d.kind)).toEqual(['missing-index']);
    expect(report.differences[0]?.fix).not.toBe('x db migrate');
  });

  test('an index dropped by hand: the fix rebuilds it whole, partial and descending', async () => {
    await client.execute(raw('drop index "rep_posts_title_live_idx"'));
    expect(await repairUntilClean()).toEqual(['missing-index']);
  });

  test('an index rebuilt over other columns: the fix drops it and builds the declared one', async () => {
    await client.execute(raw('drop index "rep_posts_title_live_idx"'));
    await client.execute(raw('create index "rep_posts_title_live_idx" on "rep_posts" ("status")'));
    expect(await repairUntilClean()).toEqual(['changed-index']);
  });

  test('a column dropped by hand: the fix adds it back with its default', async () => {
    await client.execute(raw('alter table "rep_posts" drop column "status"'));
    await client.execute(raw('alter table "rep_posts" drop column "subtitle"'));
    // `subtitle` takes its partial index with it; the findings run in kind order, column first.
    expect(await repairUntilClean()).toEqual(['missing-column', 'missing-column', 'missing-index']);
  });

  test('a NOT NULL column with no default comes back nullable, then the set not null', async () => {
    await client.execute(raw('alter table "rep_posts" drop column "title"'));
    // Round one adds the column nullable and rebuilds the index it took with it; round two is the
    // `set not null` the re-check asks for.
    expect(await repairUntilClean()).toEqual(['missing-column', 'missing-index', 'changed-column']);
  });

  test('a foreign key dropped by hand: the fix adds it back, on delete rule and all', async () => {
    await client.execute(raw('alter table "rep_posts" drop constraint "rep_posts_author_id_fkey"'));
    expect(await repairUntilClean()).toEqual(['missing-foreign-key']);
  });

  test('a table dropped by hand: the fix creates it, and the re-check names the rest', async () => {
    await client.execute(raw('drop table "rep_posts"'));
    expect(await repairUntilClean()).toEqual([
      'missing-table',
      'missing-foreign-key',
      'missing-index',
    ]);
  });
});
