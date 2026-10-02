// Single responsibility: the value rules `invariant-parity.test.ts` proves on an embedded engine,
// against a REAL server — a numeric rule over `bigint()`/`decimal()` rows, `trimmed()` against
// `btrim()`, and an app-only rule whose refusal has to take the statement with it. Skips unless
// `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  sqlState,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { database } from './database';
import { entity } from './entity';
import { invariant } from './invariants';
import { postgresDriver, postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;
const CHECK_VIOLATION = '23514';

const ledgers = entity('pg_value_ledgers', {
  columns: {
    id: uuid().primaryKey(),
    total: bigint(),
    rate: decimal({ precision: 8, scale: 2 }),
    share: decimal({ precision: 2, scale: 2 }).nullable(),
    code: text({ max: 20 }),
  },
  invariants: (c) => [
    invariant('total_non_negative', c.total.atLeast(0)),
    invariant('rate_fixed', c.rate.eq(1.5)),
    invariant('code_is_x', c.code.trimmed().eq('x')),
  ],
});

const inOrder = (low: number, high: number): boolean => low <= high;

const ranges = entity('pg_value_ranges', {
  columns: { id: uuid().primaryKey(), low: integer(), high: integer() },
  invariants: (c) => [invariant('low_first', c.satisfies(inOrder, ['low', 'high']))],
});

const DROP = 'drop table if exists "pg_value_ledgers", "pg_value_ranges" cascade';
const id = (n: number): string => `00000000-0000-7000-8000-0000000008${String(n).padStart(2, '0')}`;

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'ok';
  } catch (error) {
    return isUltimateError(error) ? error.code : `not coded: ${String(error)}`;
  }
};

describe.skipIf(!hasPostgres)('live · postgres · a value rule means one thing', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [ledgers.$describe(), ranges.$describe()],
      name: 'live value rules',
      now: new Date('2026-10-02T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  /** The CHECK alone: `'ok'`, or the SQLSTATE the server refused with. */
  const check = async (total: string, rate: string, code: string): Promise<string> => {
    try {
      await client.execute(
        raw(
          `insert into "pg_value_ledgers" (id, total, rate, code) values (gen_random_uuid(), ${total}, ${rate}, ${code})`,
        ),
      );
      return 'ok';
    } catch (error) {
      return sqlState(error) ?? `no sqlstate: ${String(error)}`;
    }
  };

  test('a row the app accepts is a row the CHECK accepts, digits past 2^53 included', async () => {
    const repo = postgresRepo(ledgers);
    const stored = await repo.insert({
      id: id(1),
      total: '5',
      rate: '1.5',
      share: '0.5',
      code: ' x ',
    });
    expect([stored.total, stored.rate, stored.share]).toEqual(['5', '1.50', '0.50']);
    const wide = { id: id(2), total: '9223372036854775807', rate: '1.50', share: null, code: 'x' };
    expect((await repo.insert(wide)).total).toBe('9223372036854775807');
  });

  test.each([
    ['a negative total', { total: '-1' }, ['-1', '1.5', "'x'"]],
    ['a rate that is not 1.5', { rate: '1.51' }, ['5', '1.51', "'x'"]],
    ['a tab the app used to trim', { code: '\tx' }, ['5', '1.5', "E'\\tx'"]],
  ] as const)('%s is refused by the app AND by the CHECK', async (_label, over, raw3) => {
    const row = { id: id(3), total: '5', rate: '1.5', share: null, code: 'x', ...over };
    expect(await codeOf(() => postgresRepo(ledgers).insert(row))).toBe('X_INVARIANT_VIOLATED');
    const [total, rate, code] = raw3;
    expect(await check(total, rate, code)).toBe(CHECK_VIOLATION);
  });

  test('one past int8 is refused before the server answers 22003', async () => {
    const row = { id: id(4), total: '9223372036854775808', rate: '1.5', share: null, code: 'x' };
    // Through `database()`: the table handle is what runs the column's `$parse`.
    const db = database({ ledgers }, { driver: postgresDriver() });
    expect(await codeOf(() => db.ledgers.insert(row))).toBe('X_INVARIANT_VIOLATED');
    expect(await check('9223372036854775808', '1.5', "'x'")).toBe('22003');
  });

  test('a refused app-only rule leaves the row as it was — update and updateWhere', async () => {
    const repo = postgresRepo(ranges);
    await repo.insert({ id: id(5), low: 1, high: 5 });
    expect(await codeOf(() => repo.update(id(5), { low: 9 }))).toBe('X_INVARIANT_VIOLATED');
    expect(await codeOf(() => repo.updateWhere({ id: id(5) }, { high: 0 }))).toBe(
      'X_INVARIANT_VIOLATED',
    );
    expect(await repo.findById(id(5))).toEqual({ id: id(5), low: 1, high: 5 });
    // And a write that holds still lands, committed.
    expect((await repo.update(id(5), { low: 4 })).low).toBe(4);
  });

  test('the same holds through a repository pinned to its own client', async () => {
    const repo = postgresRepo(ranges, { client });
    await repo.insert({ id: id(6), low: 1, high: 5 });
    expect(await codeOf(() => repo.update(id(6), { low: 9 }))).toBe('X_INVARIANT_VIOLATED');
    expect(await repo.findById(id(6))).toEqual({ id: id(6), low: 1, high: 5 });
  });

  test('a pinned repository inside a transaction opened on its own client does the same', async () => {
    const repo = postgresRepo(ranges, { client });
    await repo.insert({ id: id(8), low: 1, high: 5 });
    await withTransaction(
      async () => {
        await repo.update(id(8), { high: 6 });
        expect(await codeOf(() => repo.update(id(8), { low: 9 }))).toBe('X_INVARIANT_VIOLATED');
      },
      { client },
    );
    expect(await repo.findById(id(8))).toEqual({ id: id(8), low: 1, high: 6 });
  });

  test('inside an open transaction the refusal undoes its own statement and nothing else', async () => {
    const repo = postgresRepo(ranges);
    await repo.insert({ id: id(7), low: 1, high: 5 });
    await withTransaction(async () => {
      await repo.update(id(7), { high: 6 });
      expect(await codeOf(() => repo.update(id(7), { low: 9 }))).toBe('X_INVARIANT_VIOLATED');
    });
    // The caller caught the refusal, so the outer work commits — without the refused write.
    expect(await repo.findById(id(7))).toEqual({ id: id(7), low: 1, high: 6 });
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
