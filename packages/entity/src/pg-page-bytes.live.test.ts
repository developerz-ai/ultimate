// The page byte bound on Postgres: 65 rows of 1 MiB answered by the server are refused as one page
// before a row is decoded, and the same read narrowed by `select()` or a smaller `limit()` is
// answered. `page-bytes-memory.test.ts` is the same claim on memory. Skips unless
// `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import { MAX_PAGE_BYTES } from './page-bytes';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

// Unconditional and top-level: a skipped suite still registered its entities on import.
afterAll(() => {
  clearRegistry();
});

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const MIB = 1024 * 1024;
const HEAVY_ROWS = Math.ceil(MAX_PAGE_BYTES / MIB) + 1;

const docs = entity('pg_page_bytes_docs', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }), body: text() },
});

const DROP = 'drop table if exists "pg_page_bytes_docs" cascade';

const idOf = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe.skipIf(!hasPostgres)('live · postgres · a page past MAX_PAGE_BYTES', () => {
  let client: PostgresClient;
  const db = () => database({ docs }, { driver: postgresDriver() });

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [docs.$describe()],
      name: 'live page bytes',
      now: new Date('2026-11-11T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    // Built by the server: 65 MiB through the bind path would measure the insert, not the read.
    await client.execute(
      raw(
        `insert into "pg_page_bytes_docs" (id, title, body) select ('00000000-0000-7000-8000-' || lpad(n::text, 12, '0'))::uuid, 'doc ' || n, repeat('x', ${MIB}) from generate_series(1, ${HEAVY_ROWS}) as n`,
      ),
    );
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  test('is refused as X_ENTITY_PAGE_TOO_LARGE, naming the heavy column, select() and limit()', async () => {
    const error = await db()
      .docs.limit(HEAVY_ROWS)
      .all()
      .then(
        () => expect.unreachable(`${HEAVY_ROWS} MiB came back as one page`),
        (thrown: unknown) => thrown,
      );
    expect(error).toMatchObject({ code: 'X_ENTITY_PAGE_TOO_LARGE' });
    const { cause, fix } = error as { cause: string; fix: string };
    expect(cause).toContain("'body'");
    expect(fix).toContain('.select({ id: true, title: true })');
  });

  test('is answered narrowed by select() or a smaller limit()', async () => {
    const narrow = await db().docs.select({ id: true, title: true }).limit(HEAVY_ROWS).all();
    expect(narrow).toHaveLength(HEAVY_ROWS);
    expect((await db().docs.limit(50).all()).map((row) => row.id)[0]).toBe(idOf(1));
  });
});
