// `inBatches(10_000)` over 10,000 rows of ~10 KB on Postgres: the first statement answers ~100 MB,
// past `MAX_PAGE_BYTES`, and is refused before a row is decoded; the batch is re-read at 5,000 and
// the sweep finishes. Statements counted: one refused, then one per batch — the halving is bounded
// by ⌈log2(size)⌉, never a statement per row. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { subscribe } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

// Unconditional and top-level: a skipped suite still registered its entities on import.
afterAll(() => {
  clearRegistry();
});

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const ROWS = 10_000;
const BODY = 10 * 1024;

const notes = entity('pg_batch_bytes_notes', {
  columns: { id: uuid().primaryKey(), body: text() },
});

const DROP = 'drop table if exists "pg_batch_bytes_notes" cascade';

let client: PostgresClient;

beforeAll(async () => {
  if (!hasPostgres) return;
  client = postgresClient({ url: url ?? '' });
  setDbClient(client);
  await client.execute(raw(DROP));
  const migration = generateMigration({
    entities: [notes.$describe()],
    name: 'live batch bytes',
    now: new Date('2026-11-11T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  await client.execute(
    raw(
      `insert into "pg_batch_bytes_notes" (id, body) select ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, repeat('x', ${BODY}) from generate_series(1, ${ROWS}) as n`,
    ),
  );
});

afterAll(async () => {
  if (!hasPostgres) return;
  await client.execute(raw(DROP));
  await client.close();
  setDbClient(undefined);
});

test.skipIf(!hasPostgres)(
  'live · postgres · a 10,000-row inBatches over ~10 KB rows completes in 3 statements',
  async () => {
    const seen: string[] = [];
    const off = subscribe('db.statement', ({ payload: event }) => {
      if (event.text.includes('pg_batch_bytes_notes')) seen.push(event.text);
    });
    const sizes: number[] = [];
    try {
      const db = database({ notes }, { driver: postgresDriver() });
      for await (const batch of db.notes.inBatches(ROWS)) sizes.push(batch.length);
    } finally {
      off();
    }
    expect(sizes).toEqual([ROWS / 2, ROWS / 2]);
    // 10,000 refused, then 5,000 twice. The third answers 5,000 rows and no next row, so it ends.
    expect(seen).toHaveLength(3);
  },
);
