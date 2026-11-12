// `contains` on a text column against a real server: the same rows as memory, and a plan a
// `gin_trgm_ops` index serves — the whole reason the operator is `ilike` on the bare column.
// The index is created by hand here; declaring it on the entity is `operatorClass` (E8).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  sql,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { countStatement } from './pg-sql';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const notes = entity('pg_text_contains', {
  columns: { id: uuid().primaryKey(), title: text() },
});

type Row = typeof notes.$row;

const DROP = 'drop table if exists "pg_text_contains" cascade';

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const ROWS: readonly Row[] = [
  { id: id(1), title: 'Say Hello World' },
  { id: id(2), title: 'help wanted' },
  { id: id(3), title: '50% off_today' },
  { id: id(4), title: '50x offXtoday' },
  { id: id(5), title: 'ÉCOLE in caps' },
];

describe.skipIf(!hasPostgres)('live · postgres · text contains', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [notes.$describe()],
      name: 'live text contains',
      now: new Date('2026-11-11T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    await client.execute(raw('create extension if not exists pg_trgm'));
    await client.execute(
      raw(
        'create index pg_text_contains_title_trgm on "pg_text_contains" using gin ("title" gin_trgm_ops)',
      ),
    );
    await postgresRepo(notes).insertAll(ROWS);
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  const ids = async (repo: Repo<Row>, value: unknown): Promise<readonly string[]> =>
    (await repo.findMany({ where: [{ column: 'title', op: 'contains', value }] })).rows.map(
      (row) => row.id,
    );

  const agrees = async (value: unknown, expected: readonly number[]): Promise<void> => {
    const want = expected.map(id);
    expect(await ids(postgresRepo(notes), value)).toEqual(want);
    expect(await ids(memoryRepo(notes, ROWS), value)).toEqual(want);
  };

  test('case-insensitive substring, the same rows in both drivers', async () => {
    await agrees('HELLO', [1]);
    await agrees('hel', [1, 2]);
    await agrees('école', [5]);
  });

  test('a wildcard typed in the term is a character to find in both drivers', async () => {
    await agrees('50%', [3]);
    await agrees('f_t', [3]);
    await agrees('', [1, 2, 3, 4, 5]);
  });

  test('a term that is not text matches no row in both drivers', async () => {
    await agrees(5, []);
  });

  test('the trigram index serves the statement', async () => {
    let plan = '';
    const statement = countStatement(
      notes,
      {
        entity: notes.$name,
        where: [{ column: 'title', op: 'contains', value: 'hello' }],
        orderBy: [{ column: 'id', direction: 'asc' }],
        limit: 50,
      },
      { includeDeleted: false },
    );
    await client.execute(raw('analyze "pg_text_contains"'));
    // Off because the table is five rows: this asks whether the index CAN serve `ilike`, which is
    // a property of the operator class, not whether it is cheapest at this size.
    await client.execute(raw('set enable_seqscan = off'));
    try {
      const rows = await client.query<Record<string, string>>(
        sql`explain (costs off) ${statement}`,
      );
      plan = rows.map((row) => row['QUERY PLAN'] ?? '').join('\n');
    } finally {
      await client.execute(raw('set enable_seqscan = on'));
    }
    expect(plan).toContain('Bitmap Index Scan');
    expect(plan).toContain('Index Cond');
    expect(plan).toContain('pg_text_contains_title_trgm');
  });
});

afterAll(() => {
  clearRegistry();
});
