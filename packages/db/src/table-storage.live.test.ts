// The declaration against a real server: the rendered DDL creates the table unlogged with its
// fillfactor, re-applying it converges a table created plain, drift is clean after apply and red
// after a hand `alter`. Its own table, dropped on the way in and on the way out.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { raw } from './sql';
import { createTableDdl, readTableStorageDrift, tableStorage } from './table-storage';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const STORAGE = tableStorage('x_table_storage_probe', { fillfactor: 70, unlogged: true });

describe.skipIf(!hasPostgres)('tableStorage on Postgres', () => {
  let client: PostgresClient;

  /** The boot's own way: the text split on `;`, one statement per round trip. */
  const apply = async (ddl: string): Promise<void> => {
    for (const statement of ddl.split(';').filter((part) => part.trim().length > 0)) {
      await client.execute(raw(statement));
    }
  };
  const ddl = createTableDdl(STORAGE, 'key text primary key, n int not null');

  beforeAll(async () => {
    client = postgresClient({ url: url as string });
    await client.execute(raw('drop table if exists x_table_storage_probe'));
  });

  afterAll(async () => {
    await client.execute(raw('drop table if exists x_table_storage_probe'));
    await client.close();
  });

  test('a fresh apply creates it unlogged at fillfactor 70, and drift is clean', async () => {
    await apply(ddl);
    const [row] = await client.query<{ readonly persistence: string; readonly options: string }>(
      raw(`select relpersistence as persistence, array_to_string(reloptions, ',') as options
             from pg_class where oid = 'x_table_storage_probe'::regclass`),
    );
    expect(row).toEqual({ persistence: 'u', options: 'fillfactor=70' });
    expect(await readTableStorageDrift(client, [STORAGE])).toEqual([]);
  });

  test('drift is red after a hand alter, and the next apply converges it', async () => {
    await client.execute(raw('alter table x_table_storage_probe set logged'));
    await client.execute(raw('alter table x_table_storage_probe reset (fillfactor)'));
    const drift = await readTableStorageDrift(client, [STORAGE]);
    expect(drift.map((difference) => difference.parameter)).toEqual(['persistence', 'fillfactor']);
    // Each difference's statement converges it.
    for (const { statement } of drift) if (statement !== null) await client.execute(raw(statement));
    expect(await readTableStorageDrift(client, [STORAGE])).toEqual([]);
    await client.execute(raw('alter table x_table_storage_probe set logged'));
    await apply(ddl);
    expect(await readTableStorageDrift(client, [STORAGE])).toEqual([]);
  });

  test('re-applying to a table already unlogged rewrites nothing', async () => {
    const before = await client.query<{ readonly node: string }>(
      raw(`select relfilenode::text as node from pg_class where relname = 'x_table_storage_probe'`),
    );
    await apply(ddl);
    const after = await client.query<{ readonly node: string }>(
      raw(`select relfilenode::text as node from pg_class where relname = 'x_table_storage_probe'`),
    );
    expect(after).toEqual(before);
  });

  test('an absent table is reported, never silently clean', async () => {
    const absent = tableStorage('x_table_storage_absent', { unlogged: true });
    const drift = await readTableStorageDrift(client, [absent]);
    expect(drift.map((difference) => difference.parameter)).toEqual(['table']);
  });
});
