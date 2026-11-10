// What `inBatches` and a point read promise every driver is `@ultimat3/testing`'s
// `entityDriverConformance` (batch boundaries, cursor resume, a numeric key under any spelling).
// Left here: `keyOf`, the one spelling of a key, as a pure function; and the server's own refusal of a key its column cannot hold.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import {
  generateMigration,
  type PgliteClient,
  pgliteClient,
  raw,
  statementsOf,
} from '@ultimat3/db';
import { keyOf } from './batch-read';
import { text } from './columns';
import { bigint } from './columns-data';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

/**
 * `keyOf` files a requested id and a returned key under one string. Postgres compares `bigint` and
 * `numeric` by value, so `'007'` matched the row and was filed apart from it: the statement found
 * it, and the caller was handed `null`.
 */
describe('a numeric key has one spelling', () => {
  test.each([
    ['bigint', '007', '7'],
    ['bigint', '+7', '7'],
    ['bigint', 7, '7'],
    ['bigint', 7n, '7'],
    ['bigint', '-0', '0'],
    ['integer', ' 42 ', '42'],
    ['numeric', '2.50', '2.5'],
    ['numeric', '+02.500', '2.5'],
    ['numeric', '.5', '0.5'],
    ['numeric', '5.', '5'],
    ['numeric', '-0.00', '0'],
    ['numeric', '1e3', '1000'],
    ['numeric', 1e21, '1000000000000000000000'],
    ['numeric', 2.5, '2.5'],
  ])('%s %p', (kind, value, expected) => {
    expect(keyOf(kind, value)).toBe(expected);
  });

  test.each([
    ['bigint', 'abc'],
    ['bigint', ''],
    ['bigint', '7.0'],
    ['bigint', '0x10'],
    ['integer', '1e3'],
    ['numeric', ''],
    ['numeric', '.'],
    ['numeric', 'abc'],
    ['numeric', '1e99999999'],
  ])('%s %p is filed as written, so Postgres answers its own refusal', (kind, value) => {
    expect(keyOf(kind, value)).toBe(value);
  });

  test('every other kind stays as it compares', () => {
    expect(keyOf('text', '007')).toBe('007');
    expect(keyOf('uuid', 'ABC')).toBe('abc');
  });
});

describe('postgres · a key the column cannot hold', () => {
  // A point read batches only inside a request's context: `coalesce.ts` keys on it.
  const inRequest = <T>(read: () => Promise<T>): Promise<T> => runWithContext(ctxOf({}), read);
  const bigs = entity('batch_key_bigs', {
    columns: { id: bigint().primaryKey(), label: text({ max: 8 }) },
  });
  let pglite: PgliteClient;

  beforeAll(async () => {
    pglite = pgliteClient();
    const migration = generateMigration({
      entities: [bigs.$describe()],
      name: 'batch key parity',
      now: new Date('2026-11-02T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await pglite.execute(raw(statement));
    await postgresRepo(bigs, { client: pglite }).insert({ id: '7', label: 'big' });
  }, 30_000);

  afterAll(async () => {
    await pglite.close();
  });

  test("a key the column cannot hold is the server's own refusal", async () => {
    const repo = postgresRepo(bigs, { client: pglite });
    const refused = await inRequest(() => repo.findById('abc')).catch((error: unknown) => error);
    expect((refused as { code?: unknown }).code).toBe('X_DB_STATEMENT_FAILED');
  });
});
