// Single responsibility: a VALUE rule decides the same rows in three places — the app's `$assert`
// on the in-memory driver, the same call ahead of the Postgres driver, and the CHECK the migration
// emitted, asked directly with a raw statement. Over a real embedded Postgres (PGlite); the same
// claims against a server are `pg-invariant-value.live.test.ts`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  generateMigration,
  pgliteClient,
  raw,
  setDbClient,
  sqlState,
  statementsOf,
} from '@ultimat3/db';
import { integer, text, url, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { invariant } from './invariants';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const CHECK_VIOLATION = '23514';

const ledgers = entity('ip_ledgers', {
  columns: {
    id: uuid().primaryKey(),
    total: bigint(),
    rate: decimal({ precision: 8, scale: 2 }),
    share: decimal({ precision: 2, scale: 2 }).nullable(),
    code: text({ max: 20 }),
    href: url().nullable(),
  },
  invariants: (c) => [
    invariant('total_non_negative', c.total.atLeast(0)),
    invariant('rate_fixed', c.rate.eq(1.5)),
    invariant('code_is_x', c.code.trimmed().eq('x')),
  ],
});

const inOrder = (low: number, high: number): boolean => low <= high;

/** A rule only the app can judge: no CHECK exists, so the write is all that stands behind it. */
const ranges = entity('ip_ranges', {
  columns: { id: uuid().primaryKey(), low: integer(), high: integer() },
  invariants: (c) => [invariant('low_first', c.satisfies(inOrder, ['low', 'high']))],
});

const ENTITIES = { ledgers, ranges };
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: Object.values(ENTITIES).map((one) => one.$describe()),
    name: 'invariant parity',
    now: new Date('2026-10-02T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  for (const one of Object.values(ENTITIES))
    await client.execute(raw(`delete from "${one.$name}"`));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

type Outcome = { readonly ok: unknown } | { readonly code: string };

const outcome = async (work: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: await work() };
  } catch (error) {
    return { code: isUltimateError(error) ? error.code : `not coded: ${String(error)}` };
  }
};

const both = async (
  body: (db: ReturnType<typeof database<typeof ENTITIES>>) => Promise<unknown>,
): Promise<readonly [Outcome, Outcome]> => {
  const run = (driver: Driver) => outcome(() => body(database(ENTITIES, { driver })));
  return [await run(memoryDriver()), await run(postgresDriver())] as const;
};

/** The CHECK alone, with no app in front of it: `'ok'`, or the SQLSTATE it refused with. */
const check = async (total: string, rate: string, code: string): Promise<string> => {
  try {
    await client.execute(
      raw(
        `insert into "ip_ledgers" (id, total, rate, code) values (gen_random_uuid(), ${total}, ${rate}, ${code})`,
      ),
    );
    return 'ok';
  } catch (error) {
    return sqlState(error) ?? `no sqlstate: ${String(error)}`;
  }
};

const ID = '00000000-0000-7000-8000-0000000000a1';
const good = { id: ID, total: '5', rate: '1.5', code: 'x' };

describe('a numeric rule over bigint() and decimal() rows', () => {
  test("'5' is at least 0 and '1.5' equals 1.5 — app, driver and CHECK agree", async () => {
    const [memory, pg] = await both(async (db) => {
      const stored = await db.ledgers.insert(good);
      return [stored.total, stored.rate];
    });
    expect(memory).toEqual({ ok: ['5', '1.50'] });
    expect(pg).toEqual(memory);
    expect(await check('5', '1.50', "'x'")).toBe('ok');
  });

  test.each([
    ['a negative total', { total: '-1' }, ['-1', '1.5', "'x'"]],
    ['a rate that is not 1.5', { rate: '1.6' }, ['5', '1.6', "'x'"]],
  ] as const)('%s is refused by all three', async (_label, over, raw3) => {
    const [memory, pg] = await both(async (db) => db.ledgers.insert({ ...good, ...over }));
    expect(memory).toEqual({ code: 'X_INVARIANT_VIOLATED' });
    expect(pg).toEqual(memory);
    const [total, rate, code] = raw3;
    expect(await check(total, rate, code)).toBe(CHECK_VIOLATION);
  });

  test('a total past 2^53 is compared by its digits, not by a rounded Number', async () => {
    const [memory, pg] = await both(
      async (db) => (await db.ledgers.insert({ ...good, total: '9007199254740993' })).total,
    );
    expect(memory).toEqual({ ok: '9007199254740993' });
    expect(pg).toEqual(memory);
  });
});

describe('trimmed() strips spaces, as btrim() does', () => {
  test.each([
    ['spaces around it', '  x ', 'ok'],
    ['a tab before it', '\tx', CHECK_VIOLATION],
    ['a newline after it', 'x\n', CHECK_VIOLATION],
  ])('%s: app, driver and CHECK give one answer', async (_label, code, expected) => {
    const [memory, pg] = await both(
      async (db) => (await db.ledgers.insert({ ...good, code })).code,
    );
    const coded = expected === 'ok' ? { ok: code } : { code: 'X_INVARIANT_VIOLATED' };
    expect(memory).toEqual(coded);
    expect(pg).toEqual(memory);
    expect(await check('5', '1.5', `E'${code.replace('\t', '\\t').replace('\n', '\\n')}'`)).toBe(
      expected,
    );
  });
});

describe('a column stores only what the database stores', () => {
  test('int8 ends where Postgres ends it', async () => {
    const [memory, pg] = await both(async (db) => [
      (await db.ledgers.insert({ ...good, total: '9223372036854775807' })).total,
      await outcome(() =>
        db.ledgers.insert({ ...good, id: crypto.randomUUID(), total: '9223372036854775808' }),
      ),
    ]);
    expect(memory).toEqual({ ok: ['9223372036854775807', { code: 'X_INVARIANT_VIOLATED' }] });
    expect(pg).toEqual(memory);
  });

  test('numeric(2, 2) holds a value below one', async () => {
    const [memory, pg] = await both(
      async (db) => (await db.ledgers.insert({ ...good, share: '0.5' })).share,
    );
    expect(memory).toEqual({ ok: '0.50' });
    expect(pg).toEqual(memory);
  });

  test.each(['  https://a.b', 'ht\ttps://a.b', 'https:/a.b'])(
    'url() refuses %p before the CHECK can',
    async (href) => {
      const [memory, pg] = await both(async (db) => db.ledgers.insert({ ...good, href }));
      expect(memory).toEqual({ code: 'X_INVARIANT_VIOLATED' });
      expect(pg).toEqual(memory);
    },
  );
});

describe('a rule only the app can judge', () => {
  test('a refused update leaves the row as it was, in both drivers', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.ranges.insert({ id: ID, low: 1, high: 5 });
      const refused = await outcome(() => db.ranges.update(ID, { low: 9 }));
      return [refused, await db.ranges.where({ id: ID }).one()];
    });
    // The statement was sent and THEN judged: outside a transaction the violating row committed.
    expect(memory).toEqual({ ok: [{ code: 'X_INVARIANT_VIOLATED' }, { id: ID, low: 1, high: 5 }] });
    expect(pg).toEqual(memory);
  });

  test('a refused updateWhere leaves every matched row as it was', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.ranges.insert({ id: ID, low: 1, high: 5 });
      await db.ranges.insert({ id: '00000000-0000-7000-8000-0000000000a2', low: 1, high: 20 });
      const refused = await outcome(() => db.ranges.updateWhere({ low: 1 }, { low: 9 }));
      return [refused, (await db.ranges.orderBy('high').all()).map((row) => row.low)];
    });
    expect(memory).toEqual({ ok: [{ code: 'X_INVARIANT_VIOLATED' }, [1, 1]] });
    expect(pg).toEqual(memory);
  });

  test('a write that holds still lands', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.ranges.insert({ id: ID, low: 1, high: 5 });
      await db.ranges.update(ID, { low: 4 });
      return [
        await db.ranges.updateWhere({ low: 4 }, { high: 9 }),
        await db.ranges.where({ id: ID }).one(),
      ];
    });
    expect(memory).toEqual({ ok: [1, { id: ID, low: 4, high: 9 }] });
    expect(pg).toEqual(memory);
  });
});
