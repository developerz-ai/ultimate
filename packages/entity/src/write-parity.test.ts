// Single responsibility: every WRITE answers the same in both drivers — `memoryDriver()` and
// `postgresDriver()` over a real embedded Postgres (PGlite). Each case runs one body against both
// and asserts the two outcomes are equal, so a rule added to one driver and not the other is red.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  createPgliteClient,
  generateMigration,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { integer, text, timestamp, url, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { enumerated } from './enum-column';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import { defineSeed } from './seed';

const PGLITE_BOOT_MS = 30_000;

const notes = entity('wp_notes', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 40 }),
    body: text({ max: 40 }).nullable(),
  },
});

const tags = entity('wp_tags', {
  columns: {
    code: text({ max: 20 }).primaryKey(),
    slug: text({ max: 20 }),
  },
  indexes: [{ on: ['slug'], unique: true }],
});

const STATES = ['draft', 'live', 'archived'] as const;
const coupons = entity('wp_coupons', {
  columns: {
    code: text({ max: 20 }).primaryKey(),
    status: enumerated(STATES)
      .transitions({ draft: ['live'], live: ['archived'], archived: [] })
      .default('draft'),
  },
});

const rates = entity('wp_rates', {
  columns: {
    id: uuid().primaryKey(),
    rate: decimal({ precision: 8, scale: 2 }),
    loose: decimal().nullable(),
    big: bigint().nullable(),
  },
});

const countries = entity('wp_countries', {
  columns: {
    id: uuid().primaryKey(),
    iso: text({ max: 2 }),
    name: text({ max: 40 }),
    createdAt: timestamp().defaultNow(),
  },
  indexes: [{ on: ['iso'], unique: true }],
});

const links = entity('wp_links', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 3 }),
    hits: integer(),
    href: url(),
  },
});

const ENTITIES = { notes, tags, coupons, rates, countries, links };
const client = createPgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: Object.values(ENTITIES).map((one) => one.$describe()),
    name: 'write parity',
    now: new Date('2026-09-23T00:00:00.000Z'),
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

/** The body's answer, or the code it refused with — never a raw throw. */
const outcome = async (work: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { ok: await work() };
  } catch (error) {
    return { code: isUltimateError(error) ? error.code : `not coded: ${String(error)}` };
  }
};

/** One body, both drivers; the two outcomes, memory first. */
const both = async (
  body: (db: ReturnType<typeof database<typeof ENTITIES>>) => Promise<unknown>,
): Promise<readonly [Outcome, Outcome]> => {
  const run = (driver: Driver) => outcome(() => body(database(ENTITIES, { driver })));
  return [await run(memoryDriver()), await run(postgresDriver())] as const;
};

const ID = '00000000-0000-7000-8000-000000000001';

describe('a — an undefined patch value is not a NULL', () => {
  test(
    'update keeps the column a patch names as undefined',
    async () => {
      const [memory, pg] = await both(async (db) => {
        await db.notes.insert({ id: ID, title: 'kept', body: 'kept body' });
        await db.notes.update(ID, { title: 'moved', body: undefined });
        return db.notes.where({ id: ID }).one();
      });
      expect(memory).toEqual({ ok: { id: ID, title: 'moved', body: 'kept body' } });
      expect(pg).toEqual(memory);
    },
    PGLITE_BOOT_MS,
  );

  test('a patch naming ONLY undefined values answers the same in both', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.notes.insert({ id: ID, title: 'kept', body: 'kept body' });
      await db.notes.update(ID, { body: undefined });
      return db.notes.where({ id: ID }).one();
    });
    expect(pg).toEqual(memory);
  });

  test('updateWhere keeps it too', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.notes.insert({ id: ID, title: 'kept', body: 'kept body' });
      await db.notes.updateWhere({ id: ID }, { title: 'moved', body: undefined });
      return db.notes.where({ id: ID }).one();
    });
    expect(memory).toEqual({ ok: { id: ID, title: 'moved', body: 'kept body' } });
    expect(pg).toEqual(memory);
  });
});

describe('b — memory keeps the keys Postgres keeps', () => {
  test('a duplicate primary key is refused, not a silent replace', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.tags.insert({ code: 'a', slug: 'one' });
      await db.tags.insert({ code: 'a', slug: 'two' });
    });
    expect(pg).toEqual({ code: 'X_DB_UNIQUE_VIOLATION' });
    expect(memory).toEqual(pg);
  });

  test('a duplicate unique column is refused', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.tags.insert({ code: 'a', slug: 'one' });
      await db.tags.insert({ code: 'b', slug: 'one' });
    });
    expect(pg).toEqual({ code: 'X_DB_UNIQUE_VIOLATION' });
    expect(memory).toEqual(pg);
  });

  test('insertAll with a duplicate inside the batch stores nothing', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.tags
        .insertAll([
          { code: 'a', slug: 'one' },
          { code: 'a', slug: 'two' },
        ])
        .catch(() => undefined);
      return (await db.tags.all()).length;
    });
    expect(pg).toEqual({ ok: 0 });
    expect(memory).toEqual(pg);
  });

  test('a patch moving the primary key leaves one row, not two', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.tags.insert({ code: 'a', slug: 'one' });
      await db.tags.update('a', { code: 'z' });
      return (await db.tags.all()).map((row) => row.code);
    });
    expect(pg).toEqual({ ok: ['z'] });
    expect(memory).toEqual(pg);
  });
});

describe('c — a transition on an entity keyed by another column', () => {
  test('moves a code-keyed row in both drivers', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.coupons.insert({ code: 'SPRING', status: 'draft' });
      return db.coupons.transition('status', 'SPRING', { from: 'draft', to: 'live' });
    });
    expect(pg).toEqual({ ok: { code: 'SPRING', status: 'live' } });
    expect(memory).toEqual(pg);
  });
});

describe('d — decimals are one canonical string', () => {
  test.each([
    ['007.5', '7.50'],
    ['2.5', '2.50'],
    ['-0', '0.00'],
    ['-0.00', '0.00'],
    ['12', '12.00'],
  ])('%p reads back as %p', async (given, canonical) => {
    const [memory, pg] = await both(async (db) => {
      await db.rates.insert({ id: ID, rate: given });
      return (await db.rates.where({ id: ID }).one())?.rate;
    });
    expect(pg).toEqual({ ok: canonical });
    expect(memory).toEqual(pg);
  });

  test.each([
    ['007.50', '7.50'],
    ['-0', '0'],
    ['-000.10', '-0.10'],
  ])('an unbounded decimal %p reads back as %p', async (given, canonical) => {
    const [memory, pg] = await both(async (db) => {
      await db.rates.insert({ id: ID, rate: '1', loose: given });
      return (await db.rates.where({ id: ID }).one())?.loose;
    });
    expect(pg).toEqual({ ok: canonical });
    expect(memory).toEqual(pg);
  });

  test.each([
    ['007', '7'],
    ['-0', '0'],
    ['-007', '-7'],
  ])('a bigint %p reads back as %p', async (given, canonical) => {
    const [memory, pg] = await both(async (db) => {
      await db.rates.insert({ id: ID, rate: '1', big: given });
      return (await db.rates.where({ id: ID }).one())?.big;
    });
    expect(pg).toEqual({ ok: canonical });
    expect(memory).toEqual(pg);
  });

  test('sum and max agree', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.rates.insert({ id: ID, rate: '007.5' });
      await db.rates.insert({ id: '00000000-0000-7000-8000-000000000002', rate: '2.5' });
      return [await db.rates.sum('rate'), await db.rates.max('rate')];
    });
    expect(memory).toEqual(pg);
  });

  test.each([
    ['1.234', 'excess scale'],
    ['1234567.00', 'overflow'],
  ])('%p stays refused (%s)', async (given) => {
    const [memory, pg] = await both(async (db) => db.rates.insert({ id: ID, rate: given }));
    expect(memory).toEqual({ code: 'X_INVARIANT_VIOLATED' });
    expect(pg).toEqual(memory);
  });
});

describe('e — a seed upsert on a table whose id the table owns', () => {
  test('the second run of the same seed reports skipped', async () => {
    const seed = defineSeed('countries', async ({ upsert }) => {
      await upsert(countries, { by: ['iso'] }, { iso: 'NZ', name: 'New Zealand' });
    });
    for (const driver of [memoryDriver(), postgresDriver()]) {
      await seed.run({ driver });
      const second = await seed.run({ driver });
      expect(second.metrics).toEqual({ inserted: 0, updated: 0, skipped: 1 });
    }
  });

  test('a changed named column is still an update, and the id does not move', async () => {
    for (const driver of [memoryDriver(), postgresDriver()]) {
      let name = 'New Zealand';
      const seed = defineSeed('countries', async ({ upsert }) => {
        await upsert(countries, { by: ['iso'] }, { iso: 'NZ', name });
      });
      await seed.run({ driver });
      const before = (await driver.repo(countries).findMany({})).rows[0]?.id;
      name = 'Aotearoa New Zealand';
      const second = await seed.run({ driver });
      expect(second.metrics).toEqual({ inserted: 0, updated: 1, skipped: 0 });
      const after = (await driver.repo(countries).findMany({})).rows;
      expect(after.map((row): readonly unknown[] => [row.id, row.name])).toEqual([
        [before, 'Aotearoa New Zealand'],
      ]);
    }
  });
});

describe('k — memory refuses what Postgres refuses', () => {
  const link = { id: ID, label: 'abc', hits: 1, href: 'https://a.b' };

  test.each([
    ['a label past text({ max: 3 })', { label: 'abcdef' }],
    ['an integer past int4', { hits: 3_000_000_000 }],
    ['an integer below int4', { hits: -2_147_483_649 }],
  ])('%s is refused in both', async (_label, over) => {
    const [memory, pg] = await both(async (db) => db.links.insert({ ...link, ...over }));
    expect(memory).toEqual({ code: 'X_INVARIANT_VIOLATED' });
    expect(pg).toEqual(memory);
  });

  test('max counts code points, as char_length does', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.links.insert({ ...link, label: '👍👍👍' });
      return (await db.links.where({ id: ID }).one())?.label;
    });
    expect(memory).toEqual({ ok: '👍👍👍' });
    expect(pg).toEqual(memory);
  });

  test('an upper-case scheme is stored in its canonical lower case, in both', async () => {
    const [memory, pg] = await both(async (db) => {
      await db.links.insert({ ...link, href: 'HTTPS://a.b/Path' });
      return (await db.links.where({ id: ID }).one())?.href;
    });
    expect(memory).toEqual({ ok: 'https://a.b/Path' });
    expect(pg).toEqual(memory);
  });

  test.each([2.5, Number.NaN, 0, -1])(
    'text({ max: %p }) is refused where it is declared',
    (max) => {
      expect(() => text({ max })).toThrow();
    },
  );
});
