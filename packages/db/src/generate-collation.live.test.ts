// Single responsibility: a declared `collate "C"` that `x db gen` emits, APPLIED to a real server
// over an indexed, populated column and read back by the order the server answers. The unit file
// pins the text; only a server says `apple, Banana` becomes `Banana, apple` and back again.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'collation_words';

const base: Omit<ColumnDescriptionLike, 'property' | 'column'> = {
  kind: 'text',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
};

const words = (word: Partial<ColumnDescriptionLike>): EntityDescriptionLike => ({
  name: 'CollationWord',
  table: TABLE,
  primaryKey: ['id'],
  columns: [
    { ...base, property: 'id', column: 'id', primaryKey: true },
    { ...base, property: 'word', column: 'word', ...word },
  ],
  indexes: [
    { name: `${TABLE}_word_idx`, columns: ['word'], unique: false, where: null, order: null },
  ],
});

describe.skipIf(!hasPostgres)('live · postgres · a declared collation moves in place', () => {
  let client: PostgresClient;

  const apply = async (script: string): Promise<void> => {
    for (const statement of statementsOf(script)) await client.execute(raw(statement));
  };

  // `und-x-icu` is an explicit non-C baseline, so the proof holds on a cluster whose default is `C`.
  const icu = words({ collation: 'und-x-icu' });
  const declared = words({ collation: 'C' });

  const ordered = async (): Promise<readonly string[]> =>
    (await client.query<{ word: string }>(raw(`select word from "${TABLE}" order by word`))).map(
      (row) => row.word,
    );

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    await client.execute(raw(`drop table if exists "${TABLE}"`));
    await apply(generateMigration({ entities: [icu], name: 'init' }).up);
    await client.execute(raw(`insert into "${TABLE}" values ('1', 'apple'), ('2', 'Banana')`));
  });

  afterAll(async () => {
    await client.execute(raw(`drop table if exists "${TABLE}"`));
    await client.close();
  });

  test('up orders by code point, and down restores the recorded collation', async () => {
    expect(await ordered()).toEqual(['apple', 'Banana']);
    const moved = generateMigration({
      entities: [declared],
      current: snapshotOf([icu]),
      name: 'collate',
    });
    await apply(moved.up);
    expect(await ordered()).toEqual(['Banana', 'apple']);
    await apply(moved.down);
    expect(await ordered()).toEqual(['apple', 'Banana']);
  });
});
