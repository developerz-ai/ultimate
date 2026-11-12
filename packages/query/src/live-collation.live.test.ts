// The divergence `X_LIVE_ORDER_COLLATION` exists for, shown on a real server: a text column with a
// non-C collation orders `apple, Banana` in SQL while the matcher's code-point order says
// `Banana, apple` — so a live window ordered by it is flagged, and a `collate "C"` column agrees with
// the matcher. The collation is EXPLICIT on each column, so the proof holds on a `C` cluster too.
// Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text } from '@ultimat3/entity';
import { SQL } from 'bun';
import { divergentOrderKey } from './live-collation';
import { from } from './source';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const TABLE = 'query_live_collation_live';

interface Word {
  readonly id: string;
  readonly word: string;
  readonly code: string;
}

const WORDS: readonly Word[] = [
  { id: '1', word: 'apple', code: 'apple' },
  { id: '2', word: 'Banana', code: 'Banana' },
];

// File scope and unconditional, as `compare-parity.live.test.ts` does it: a hook inside a skipped
// block never runs.
afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · text order under a non-C collation', () => {
  let sql: SQL;

  beforeAll(async () => {
    entity(TABLE, {
      columns: {
        id: text({ max: 8 }).primaryKey(),
        word: text({ max: 20 }),
        code: text({ max: 20 }).collate('C'),
      },
    });
    sql = new SQL(url ?? '');
    await sql.unsafe(`drop table if exists "${TABLE}"`);
    await sql.unsafe(
      `create table "${TABLE}" ("id" text primary key, "word" text collate "und-x-icu" not null, ` +
        `"code" text collate "C" not null)`,
    );
    for (const row of WORDS) {
      await sql.unsafe(`insert into "${TABLE}" values ($1, $2, $3)`, [row.id, row.word, row.code]);
    }
  });

  afterAll(async () => {
    await sql.unsafe(`drop table if exists "${TABLE}"`);
    await sql.close();
  });

  const served = async (column: string): Promise<readonly string[]> =>
    (
      (await sql.unsafe(`select "${column}" from "${TABLE}" order by "${column}" asc`)) as Record<
        string,
        string
      >[]
    ).map((row) => row[column] ?? '');

  test('Postgres and the matcher disagree on a default-collation column, so it is flagged', async () => {
    const builder = from<Word>(TABLE, WORDS).orderBy('word');
    const matched = await builder.execute();
    expect(await served('word')).toEqual(['apple', 'Banana']);
    expect(matched.map((row) => row.word)).toEqual(['Banana', 'apple']);
    expect(divergentOrderKey(builder.shape())).toEqual({ column: 'word', collatable: true });
  });

  test('a collate("C") column orders as the matcher does, so it is not', async () => {
    const builder = from<Word>(TABLE, WORDS).orderBy('code');
    const matched = await builder.execute();
    expect(await served('code')).toEqual(matched.map((row) => row.code));
    expect(divergentOrderKey(builder.shape())).toBeUndefined();
  });
});
