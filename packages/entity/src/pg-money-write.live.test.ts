// Single responsibility: a `bigint` minor unit handed to a write reaches a REAL table as a value
// this framework can read back — or reaches it not at all.
//
// Neither half is observable against a recording client. `MoneyInput` lets a writer hand a
// `bigint`; Bun's client BINDS one happily (measured — an `int8` parameter is accepted verbatim),
// and the row comes back off the wire as decimal TEXT that `parseMinor` turns into a `number`
// whatever went in. So with no narrowing at all the driver's own ANSWER still looks right, and the
// only witness is the table: a minor unit past ±2^53 would be committed, and then refused by the
// decode of the `returning *` the same statement produced — a row the app wrote and can never
// read. That is what makes the refusal's POSITION, not its existence, the thing worth a server.
//
// Skips unless `TEST_DATABASE_URL` is set, exactly like `pg-driver.live.test.ts`; CI's `postgres`
// service container sets it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { money, text, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { RowWrite } from './types';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const invoices = entity('pg_money_write_invoices', {
  columns: { id: uuid().primaryKey(), reference: text({ max: 40 }), total: money() },
});

type Invoice = typeof invoices.$row;

const DROP = 'drop table if exists "pg_money_write_invoices" cascade';

/** `9007199254740993` — the first integer no JS number holds, and one the `bigint` column does. */
const PAST_SAFE = 9_007_199_254_740_993n;

describe.skipIf(!hasPostgres)('live · postgres · a bigint minor unit at a write', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [invoices.$describe()],
      name: 'money write',
      now: new Date('2026-08-25T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  const repo = () => postgresRepo(invoices);

  const wide = (id: string, reference: string, minor: bigint): RowWrite<Invoice> => ({
    id,
    reference,
    total: { minor, currency: 'EUR' },
  });

  test('one inside ±2^53 round-trips as the value type, through the real column', async () => {
    const id = '00000000-0000-7000-8000-0000000000c1';
    const written = await repo().insert(wide(id, 'INV-1', 129_900n));
    expect(written.total).toEqual({ minor: 129_900, currency: 'EUR' });

    // Read back on its own statement, so this is the TABLE's answer and not the write's echo.
    const read = await repo().findById(id);
    expect(read?.total).toEqual({ minor: 129_900, currency: 'EUR' });
    expect(typeof read?.total.minor).toBe('number');

    // And the column really is holding the digits, not a rounded double dressed up on the way out.
    const stored = await client.one<{ total_minor: unknown }>(
      raw('select total_minor from "pg_money_write_invoices" where "reference" = \'INV-1\''),
    );
    expect(String(stored?.total_minor)).toBe('129900');
  });

  test('one past ±2^53 is refused before the statement, so nothing is committed', async () => {
    const before = await repo().count();
    await expect(
      repo().insert(wide('00000000-0000-7000-8000-0000000000c2', 'INV-2', PAST_SAFE)),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
    // The load-bearing assertion. Narrowed anywhere later than the write method's entry, the row
    // is INSERTed, committed, and only then refused by the decode of its own `returning *` — the
    // caller sees the same rejection and the table holds a row nothing can ever read.
    expect(await repo().count()).toBe(before);
    expect(await repo().findById('00000000-0000-7000-8000-0000000000c2')).toBeNull();
  });

  test('a batch past ±2^53 takes the rows beside it with it', async () => {
    const before = await repo().count();
    await expect(
      repo().insertAll([
        wide('00000000-0000-7000-8000-0000000000c3', 'INV-3', 1_000n),
        wide('00000000-0000-7000-8000-0000000000c4', 'INV-4', PAST_SAFE),
      ]),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
    // All or nothing, and for the same reason: the whole batch is judged before any statement
    // exists, so the good row ahead of the bad one is never sent either.
    expect(await repo().count()).toBe(before);
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
