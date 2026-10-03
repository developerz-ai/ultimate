// The `/_x` SQL runner against a real Postgres (embedded PGlite): a read answers its grid, and a
// write that reached it anyway is refused by the SERVER — the read-only transaction — and leaves
// the table as it was. The parse guard upstream is a different layer; this one cannot be talked to.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPgliteClient, raw } from '@ultimat3/db';
import { DEV_SQL_MAX_ROWS, readOnlySql } from './sql-runner';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

const client = createPgliteClient();

beforeAll(async () => {
  await client.execute(raw('create table dev_probe (id integer primary key, label text)'));
  await client.execute(
    raw(
      `insert into dev_probe select n, 'row ' || n from generate_series(1, ${DEV_SQL_MAX_ROWS + 20}) as n`,
    ),
  );
}, PGLITE_BOOT_MS);

afterAll(async () => {
  await client.close();
});

const count = async (): Promise<number> =>
  (await client.query<{ n: number }>(raw('select count(*)::int as n from dev_probe')))[0]?.n ?? 0;

describe('contract · the /_x SQL runner is read-only at the server', () => {
  test(
    'a read answers columns and rows, at most the panel’s ceiling of them',
    async () => {
      const result = await readOnlySql(client)('select id, label from dev_probe order by id');
      expect(result.columns).toEqual(['id', 'label']);
      expect(result.rows[0]).toEqual([1, 'row 1']);
      expect(result.rows).toHaveLength(DEV_SQL_MAX_ROWS);
    },
    PGLITE_BOOT_MS,
  );

  test(
    'a write is refused by the transaction, and nothing changed',
    async () => {
      const before = await count();
      await expect(readOnlySql(client)("insert into dev_probe values (0, 'x')")).rejects.toThrow(
        /read-only/,
      );
      await expect(readOnlySql(client)('delete from dev_probe')).rejects.toThrow(/read-only/);
      expect(await count()).toBe(before);
    },
    PGLITE_BOOT_MS,
  );
});
