// A column the DATABASE computes, through the generator: emitted with its clause, recorded in the
// snapshot, and moved with `set expression` rather than dropped when the expression changes. The
// assertion that matters most is the last one — a derived column holds no source data, so a
// migration that rebuilt it by dropping it would lose its indexes and declare a data loss that
// never happened.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';

const TSV = "setweight(to_tsvector('english', coalesce(\"title\", '')), 'A')";
const TSV2 =
  "setweight(to_tsvector('english', coalesce(\"title\", '')), 'A') || " +
  "setweight(to_tsvector('english', coalesce(\"body\", '')), 'D')";

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

const posts = (expression: string): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('title', { kind: 'text', notNull: true }),
    column('body', { kind: 'text' }),
    column('search_tsv', { kind: 'tsvector', notNull: true, generated: expression }),
  ],
  indexes: [
    {
      name: 'posts_search_tsv_idx',
      columns: ['search_tsv'],
      unique: false,
      where: null,
      order: null,
      using: 'gin',
    },
  ],
});

const at = new Date('2026-08-24T12:00:00.000Z');

const migrate = (entity: EntityDescriptionLike, current?: EntityDescriptionLike) =>
  generateMigration({
    entities: [entity],
    name: 'search',
    now: at,
    ...(current === undefined ? {} : { current: snapshotOf([current]) }),
  });

describe('columnClause · a generated column', () => {
  test('carries its clause, after the type and before not null', () => {
    expect(migrate(posts(TSV)).up).toContain(
      `"search_tsv" tsvector generated always as (${TSV}) stored not null`,
    );
  });

  test('an ordinary column emits exactly the clause it always did', () => {
    expect(migrate(posts(TSV)).up).toContain('"title" text not null');
    expect(migrate(posts(TSV)).up).not.toContain('"title" text generated');
  });

  test('refuses a column that is both generated and defaulted, where the author is', () => {
    const broken: EntityDescriptionLike = {
      ...posts(TSV),
      columns: [
        column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
        column('c', { kind: 'text', hasDefault: true, generated: "'x'" }),
      ],
    };
    // Postgres refuses the pair outright (`42601`), so an unguarded generator writes DDL whose
    // first reader is `ROLE=migrate`.
    expect(() => migrate(broken)).toThrow(UltimateError);
  });
});

describe('snapshotOf · a generated column', () => {
  test('records the expression, so the next generation can see it move', () => {
    const table = snapshotOf([posts(TSV)]).tables[0];
    const recorded = table?.columns.find((c) => c.name === 'search_tsv');
    expect(recorded?.generated).toBe(TSV);
    expect(recorded?.dataType).toBe('tsvector');
  });

  test('an ordinary column carries no such field — absent, never null', () => {
    const table = snapshotOf([posts(TSV)]).tables[0];
    const recorded = table?.columns.find((c) => c.name === 'title');
    expect(recorded === undefined ? 'missing' : Object.hasOwn(recorded, 'generated')).toBe(false);
  });
});

describe('a generated column that moves', () => {
  test('is re-expressed in place, never dropped and never rebuilt', () => {
    const { up, down, destructive } = migrate(posts(TSV2), posts(TSV));
    expect(up).toContain(
      `alter table "posts" alter column "search_tsv" set expression as (${TSV2});`,
    );
    // The two statements a drop-and-recreate would have needed, and the loss it would have caused:
    // dropping the column takes its GIN index with it, and nothing in this diff recreates one.
    expect(up).not.toContain('drop column');
    expect(up).not.toContain('add column');
    // A derived column holds no source data, so this migration destroys nothing — and a marker on
    // a migration that loses nothing is a marker a reviewer learns to ignore.
    expect(destructive).toBe(false);
    expect(down).toContain(
      `alter table "posts" alter column "search_tsv" set expression as (${TSV});`,
    );
  });

  test('an unchanged expression generates nothing at all', () => {
    expect(migrate(posts(TSV), posts(TSV)).up.trim()).toBe('');
  });

  test('a type change on it drops the USING clause Postgres refuses there', () => {
    const widened: EntityDescriptionLike = {
      ...posts(TSV),
      columns: posts(TSV).columns.map((c) =>
        c.column === 'search_tsv' ? { ...c, kind: 'text' } : c,
      ),
    };
    const { up } = migrate(widened, posts(TSV));
    expect(up).toContain('alter table "posts" alter column "search_tsv" type text;');
    // `using "search_tsv"::text` is what an ordinary retype emits and what Postgres refuses on a
    // generated column: "column ... is a generated column".
    expect(up).not.toContain('using');
  });
});

describe('a generated column added to an existing table', () => {
  test('is added computed and NOT NULL in one statement, never nullable-then-backfilled', () => {
    const before: EntityDescriptionLike = {
      ...posts(TSV),
      columns: posts(TSV).columns.filter((c) => c.column !== 'search_tsv'),
      indexes: [],
    };
    const { up } = migrate(posts(TSV), before);
    expect(up).toContain(
      `alter table "posts" add column "search_tsv" tsvector generated always as (${TSV}) stored not null;`,
    );
    // The backfill comment an ordinary NOT NULL add leaves behind is a step a human must remember.
    // The database computes this column for every existing row, so there is nothing to backfill.
    expect(up).not.toContain('backfill');
    expect(up).toContain(
      'create index "posts_search_tsv_idx" on "posts" using gin ("search_tsv");',
    );
  });
});

describe('a plain column that becomes generated', () => {
  test('is replaced, and every index over it is stated again', () => {
    // The one transition `set expression` cannot make: it needs a column that already has one.
    // Reachable for real — a table created by a generator that did not yet render the clause holds
    // exactly this column, plain and empty, which is the state this whole slice exists to end.
    const before: EntityDescriptionLike = {
      ...posts(TSV),
      columns: posts(TSV).columns.map((c) =>
        c.column === 'search_tsv' ? { ...c, generated: undefined } : c,
      ),
    };
    const { up, down } = migrate(posts(TSV), before);
    expect(up).toContain('alter table "posts" drop column "search_tsv";');
    expect(up).toContain(
      `alter table "posts" add column "search_tsv" tsvector generated always as (${TSV}) stored not null;`,
    );
    // `drop column` takes the GIN index with it and `redefineIndex` sees a definition that never
    // moved — so without the rebuild set the table comes back with no index at all.
    expect(up).toContain(
      'create index "posts_search_tsv_idx" on "posts" using gin ("search_tsv");',
    );
    expect(down).toContain('alter table "posts" drop column "search_tsv";');
  });
});
