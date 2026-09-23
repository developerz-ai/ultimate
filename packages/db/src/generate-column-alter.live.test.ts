// Single responsibility: a default and a nullability change that `x db gen` emits, APPLIED to a
// real server and read back from `information_schema.columns`. The unit file pins the text; only a
// server says the text does what the snapshot claims.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { raw, sql } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'ca_posts';

const status = (overrides: Partial<ColumnDescriptionLike>): EntityDescriptionLike => ({
  name: 'CaPost',
  table: TABLE,
  primaryKey: ['id'],
  columns: [
    {
      property: 'id',
      column: 'id',
      kind: 'uuid',
      notNull: true,
      primaryKey: true,
      unique: false,
      hasDefault: false,
      check: null,
      references: null,
    },
    {
      property: 'status',
      column: 'status',
      kind: 'text',
      notNull: true,
      primaryKey: false,
      unique: false,
      hasDefault: false,
      check: null,
      references: null,
      ...overrides,
    },
  ],
  indexes: [],
});

describe.skipIf(!hasPostgres)('live · postgres · a default and nullability move in place', () => {
  let client: PostgresClient;

  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };

  const described = async () =>
    client.one<{ column_default: string | null; is_nullable: string }>(
      sql`select column_default, is_nullable from information_schema.columns
          where table_name = ${TABLE} and column_name = 'status'`,
    );

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    await client.execute(raw(`drop table if exists "${TABLE}"`));
    await apply(generateMigration({ entities: [status({})], name: 'init' }).up);
  });

  afterAll(async () => {
    await client.execute(raw(`drop table if exists "${TABLE}"`));
    await client.close();
  });

  test('a new default lands on the column, and down takes it off again', async () => {
    const draft = { hasDefault: true, default: { kind: 'value', value: 'draft' } } as const;
    const moved = generateMigration({
      entities: [status(draft)],
      current: snapshotOf([status({})]),
      name: 'default',
    });
    await apply(moved.up);
    expect((await described())?.column_default).toBe("'draft'::text");
    await apply(moved.down);
    expect((await described())?.column_default).toBeNull();
  });

  test('becoming nullable applies, and down makes it NOT NULL again', async () => {
    const moved = generateMigration({
      entities: [status({ notNull: false })],
      current: snapshotOf([status({})]),
      name: 'nullable',
    });
    await apply(moved.up);
    expect((await described())?.is_nullable).toBe('YES');
    await apply(moved.down);
    expect((await described())?.is_nullable).toBe('NO');
  });
});
