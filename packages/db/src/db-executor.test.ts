// `dbExecutor()` is the process's Postgres as core's `PgExecutor` (issue #688). Two properties, and
// a bound client has neither: it resolves the client per STATEMENT, so an executor declared at
// module scope — before boot installs the client — still uses the boot's; and inside
// `withTransaction` it runs on the transaction's own connection, so a store's write commits or
// rolls back with the business rows.

import { afterEach, describe, expect, test } from 'bun:test';
import { type ReservableClient, setDbClient } from './client';
import { dbExecutor } from './db-executor';
import { type RecordingClient, recordingClient } from './fake';
import { withTransaction } from './transaction';

/** A pool whose reserved connection records apart from it — so "which connection" is visible. */
function pooled(pool: RecordingClient, connection: RecordingClient): ReservableClient {
  return {
    query: (fragment) => pool.query(fragment),
    one: (fragment) => pool.one(fragment),
    execute: (fragment) => pool.execute(fragment),
    reserve: () => {
      const release = (): void => undefined;
      return Promise.resolve({
        query: (fragment) => connection.query(fragment),
        one: (fragment) => connection.one(fragment),
        execute: (fragment) => connection.execute(fragment),
        release,
        [Symbol.dispose]: release,
      });
    },
  };
}

afterEach(() => {
  setDbClient(undefined);
});

describe('dbExecutor', () => {
  test('hands the client the text and values as one fragment', async () => {
    const client = recordingClient().on('select $1', { rows: [{ id: 1 }] });
    setDbClient(client);
    const rows = await dbExecutor().query<{ id: number }>('select $1::int as id', [1]);
    expect(rows).toEqual([{ id: 1 }]);
    expect(client.statements).toEqual([{ text: 'select $1::int as id', values: [1] }]);
  });

  test('declared before the client is installed, it still reaches the installed one', async () => {
    const executor = dbExecutor();
    const booted = recordingClient();
    setDbClient(booted);
    await executor.query('select 1', []);
    expect(booted.texts).toEqual(['select 1']);
  });

  test('inside withTransaction it joins the transaction; outside it, the pool', async () => {
    const pool = recordingClient();
    const connection = recordingClient();
    setDbClient(pooled(pool, connection));
    const executor = dbExecutor();

    await withTransaction(async () => {
      await executor.query('insert into x_store values ($1)', ['a']);
    });
    await executor.query('select 2', []);

    expect(connection.texts).toEqual(['BEGIN', 'insert into x_store values ($1)', 'COMMIT']);
    expect(pool.texts).toEqual(['select 2']);
  });

  test('a resolver names the client instead — the boot’s queue reads its own pool, never a tx', async () => {
    const own = recordingClient();
    const ambient = recordingClient();
    setDbClient(ambient);
    await dbExecutor(() => own).query('select 3', []);
    expect(own.texts).toEqual(['select 3']);
    expect(ambient.texts).toEqual([]);
  });
});
