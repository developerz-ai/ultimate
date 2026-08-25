// Single responsibility: the generated-column statements against a real server. Every one of them
// rests on a claim only Postgres can settle — the clause order, that `set expression` recomputes
// every row, and that the column's indexes survive it. A text assertion says the generator wrote
// the statement; it cannot say the statement means what the comment above it claims.

import { describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TITLE_ONLY = `setweight(to_tsvector('english', coalesce("title", '')), 'A')`;
const TITLE_AND_BODY =
  `setweight(to_tsvector('english', coalesce("title", '')), 'A') || ` +
  `setweight(to_tsvector('english', coalesce("body", '')), 'D')`;

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

const docs = (expression: string): EntityDescriptionLike => ({
  name: 'GenDoc',
  table: 'gen_docs',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('title', { kind: 'text', notNull: true }),
    column('body', { kind: 'text' }),
    column('tsv', { kind: 'tsvector', notNull: true, generated: expression }),
  ],
  indexes: [
    {
      name: 'gen_docs_tsv_idx',
      columns: ['tsv'],
      unique: false,
      where: null,
      order: null,
      using: 'gin',
    },
  ],
});

const at = new Date('2026-08-24T00:00:00.000Z');

describe.skipIf(!hasPostgres)('live · postgres · a generated column through the generator', () => {
  const apply = async (client: PostgresClient, sql: string): Promise<void> => {
    for (const statement of statementsOf(sql)) await client.execute(raw(statement));
  };

  test('is created computed, re-expressed in place, and keeps its index across the change', async () => {
    const client = createPostgresClient({ url: url ?? '' });
    try {
      await client.execute(raw('drop table if exists "gen_docs" cascade'));
      // 1. `create table` — the clause order the generator writes has to be one Postgres accepts,
      //    and the column has to populate itself with no writer naming it.
      await apply(
        client,
        generateMigration({ entities: [docs(TITLE_ONLY)], name: 'a', now: at }).up,
      );
      await client.execute(
        raw(
          `insert into "gen_docs" ("id", "title", "body") values ('${'0'.repeat(8)}-0000-7000-8000-000000000001', 'running fast', 'about cats')`,
        ),
      );
      const first = await client.query<{ tsv: string }>(raw('select "tsv"::text from "gen_docs"'));
      // Stemmed and weighted by the database, from a statement that never mentioned the column.
      expect(first[0]?.tsv).toContain("'fast':2A");
      expect(first[0]?.tsv).not.toContain('cat');

      // 2. The change case. `set expression` is Postgres 17 and is what the generator emits instead
      //    of a drop-and-recreate: the rows are recomputed and the GIN index is still there after.
      const change = generateMigration({
        entities: [docs(TITLE_AND_BODY)],
        name: 'b',
        now: at,
        current: snapshotOf([docs(TITLE_ONLY)]),
      });
      expect(change.up).toContain('set expression as');
      await apply(client, change.up);
      const second = await client.query<{ tsv: string }>(raw('select "tsv"::text from "gen_docs"'));
      // The body's lexemes are in the vector of a row nobody rewrote.
      expect(second[0]?.tsv).toContain("'cat':4");
      const indexes = await client.query<{ indexname: string }>(
        raw(`select indexname from pg_indexes where tablename = 'gen_docs'`),
      );
      expect(indexes.map((row) => row.indexname)).toContain('gen_docs_tsv_idx');

      // 3. And `down` puts the old expression back, on the same rows.
      await apply(client, change.down);
      const third = await client.query<{ tsv: string }>(raw('select "tsv"::text from "gen_docs"'));
      expect(third[0]?.tsv).not.toContain('cat');
    } finally {
      await client.execute(raw('drop table if exists "gen_docs" cascade'));
      await client.close();
    }
  });

  test('is added to a POPULATED table computed and not null, in one statement', async () => {
    const client = createPostgresClient({ url: url ?? '' });
    try {
      await client.execute(raw('drop table if exists "gen_docs" cascade'));
      const before: EntityDescriptionLike = {
        ...docs(TITLE_ONLY),
        columns: docs(TITLE_ONLY).columns.filter((each) => each.column !== 'tsv'),
        indexes: [],
      };
      await apply(client, generateMigration({ entities: [before], name: 'a', now: at }).up);
      await client.execute(
        raw(
          `insert into "gen_docs" ("id", "title", "body") values ('${'0'.repeat(8)}-0000-7000-8000-000000000002', 'existing row', null)`,
        ),
      );
      // The claim the ordinary NOT NULL path would have broken: emitted nullable with a
      // `-- backfill` comment, this column could never be made NOT NULL, because a generated
      // column cannot be written to at all.
      await apply(
        client,
        generateMigration({
          entities: [docs(TITLE_ONLY)],
          name: 'b',
          now: at,
          current: snapshotOf([before]),
        }).up,
      );
      const rows = await client.query<{ tsv: string }>(raw('select "tsv"::text from "gen_docs"'));
      expect(rows[0]?.tsv).toContain("'exist':1A");
      // NOT NULL in the catalog, in that one statement. The ordinary path emits the column nullable
      // and leaves `-- backfill "tsv", then: … set not null;` — an instruction nobody can carry
      // out, because `update … set tsv = …` on a generated column is `428C9`.
      const meta = await client.query<{ is_nullable: string; is_generated: string }>(
        raw(
          `select is_nullable, is_generated from information_schema.columns ` +
            `where table_name = 'gen_docs' and column_name = 'tsv'`,
        ),
      );
      expect(meta[0]?.is_nullable).toBe('NO');
      expect(meta[0]?.is_generated).toBe('ALWAYS');
    } finally {
      await client.execute(raw('drop table if exists "gen_docs" cascade'));
      await client.close();
    }
  });
});
