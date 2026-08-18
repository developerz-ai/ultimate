// What `defineSeed` promises: a second run writes nothing new, on a store that refuses a duplicate.
// `seed.live.test.ts` runs the same replay against a real server; this file pins the rules a driver
// stub can decide — the write verbs, the refusals, the metrics and the tier table.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { boolean, integer, money, text, timestamp, uuid } from './columns';
import type { Driver } from './database';
import { memoryDriver } from './database';
import { type EntityCore, entity } from './entity';
import type { EntityError } from './errors';
import { invariant } from './invariants';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import { defineSeed, isSeed, seedTiersFor } from './seed';

const orgs = entity('seed_test_orgs', {
  columns: {
    id: uuid().primaryKey(),
    slug: text({ max: 40 }).unique(),
    name: text({ max: 80 }),
    createdAt: timestamp().defaultNow(),
  },
});

/** Tenant-scoped, and its only unique key is global — the shape an updating upsert cannot take. */
const posts = entity('seed_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    title: text({ max: 80 }),
    likeCount: integer().default(0),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [invariant('seed_like_count_non_negative', c.likeCount.atLeast(0))],
});

/** Reference data: the table owns the id, so `code + currency` is the only key a seed can name. */
const plans = entity('seed_test_plans', {
  columns: {
    code: text({ max: 20 }),
    currency: text({ max: 3 }),
    monthly: money(),
    active: boolean().default(true),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['code', 'currency'],
});

const reports = entity('seed_test_reports', {
  columns: { id: uuid().primaryKey(), day: text({ max: 10 }), total: integer() },
});

const notes = entity('seed_test_notes', {
  columns: {
    id: uuid().primaryKey(),
    body: text({ max: 80 }),
    deletedAt: timestamp().nullable(),
  },
});

const ORG = '00000000-0000-7000-8000-0000000000b1';
const POST = '00000000-0000-7000-8000-0000000000b2';

/**
 * A store that refuses a second row on one primary key, the way Postgres answers `23505`.
 *
 * It exists because the defect is INVISIBLE on `memoryDriver()`: its `insert` overwrites by key, so
 * a seed replayed twice against memory passed while the same seed against `postgresDriver()` died
 * on its first row. Everything else delegates, so `upsertAll` still resolves a collision exactly as
 * the memory driver does — which is the whole assertion: the seed must not reach `insert` at all.
 */
const durableDriver = (): Driver => {
  const base = memoryDriver();
  const written = new Map<string, Set<string>>();
  return {
    repo<Row>(subject: EntityCore<Row>): Repo<Row> {
      const repo = base.repo(subject);
      return {
        ...repo,
        async insert(values, options) {
          const key = subject.$primaryKey
            .map((property) => String((values as Record<string, unknown>)[property]))
            .join('/');
          const seen = written.get(subject.$name) ?? new Set<string>();
          if (seen.has(key)) {
            throw new Error(`23505 duplicate key value violates unique constraint on ${key}`);
          }
          seen.add(key);
          written.set(subject.$name, seen);
          return repo.insert(values, options);
        },
      };
    },
    reset: () => base.reset?.(),
  };
};

const fixtures = defineSeed('seed_test_fixtures', async ({ insert, id }) => {
  await insert(orgs, [{ id: ORG, slug: 'acme', name: 'Acme' }]);
  await insert(posts, [
    { id: POST, orgId: ORG, title: 'Tenancy is a column' },
    { id: id('seed:second'), orgId: ORG, title: 'Second' },
  ]);
});

let driver: Driver;

beforeEach(() => {
  driver = durableDriver();
});

afterAll(() => {
  clearRegistry();
});

describe('defineSeed() · replay', () => {
  test('a second run against a store that refuses duplicates writes nothing and raises nothing', async () => {
    const first = await fixtures.run({ driver });
    expect(first.metrics).toEqual({ inserted: 3, updated: 0, skipped: 0 });

    const second = await fixtures.run({ driver });
    expect(second.metrics).toEqual({ inserted: 0, updated: 0, skipped: 3 });

    const stored = await driver
      .repo(posts)
      .findMany({ where: [{ column: 'orgId', op: 'eq', value: ORG }] });
    expect(stored.rows).toHaveLength(2);
  });

  test('a tenant-scoped entity replays too — its only unique key is the global primary key', async () => {
    // `onMatch: 'update'` would be `X_TENANCY_UNSCOPED` here: the conflict target carries no tenant
    // column and `posts` declares no per-tenant unique constraint to point at. `do nothing` is the
    // form that replays, and this is the test that stops anyone "improving" it into an update.
    const seed = defineSeed('seed_test_tenant', async ({ insert }) => {
      await insert(posts, [{ id: POST, orgId: ORG, title: 'One' }]);
    });
    await seed.run({ driver });
    const replay = await seed.run({ driver });
    expect(replay.metrics.skipped).toBe(1);
  });

  test('a generated primary key the row leaves out is refused — every replay would duplicate it', async () => {
    // The silent half: `uuid().primaryKey()` carries `GENERATED_UUID`, so `$parse` FILLS the key,
    // the row is valid, the conflict target matches nothing, and run five leaves five copies.
    // Nothing else in the framework can see it — the row it refuses is a legal row.
    const seed = defineSeed('seed_test_generated', async ({ insert }) => {
      await insert(posts, [{ orgId: ORG, title: 'Anonymous' }]);
    });
    const error = await seed.run({ driver }).catch((thrown: unknown) => thrown);
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect((error as EntityError).cause).toContain('generated default');
    expect((error as EntityError).fix).toContain('id(');
  });

  test('a seed still writes through the same validation as the app', async () => {
    const broken = defineSeed('seed_test_broken', async ({ insert }) => {
      await insert(posts, [{ id: POST, orgId: ORG, title: 'B', likeCount: -5 }]);
    });
    await expect(broken.run({ driver })).rejects.toThrow(/seed_like_count_non_negative/);
  });
});

describe('defineSeed() · upsert on a natural key', () => {
  const catalog = (monthly: number, active = true) =>
    defineSeed(
      'seed_test_catalog',
      async ({ upsert }) => {
        await upsert(
          plans,
          { by: ['code', 'currency'] },
          {
            code: 'team',
            currency: 'EUR',
            monthly: { minor: monthly, currency: 'EUR' },
            active,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        );
      },
      { tier: 'reference' },
    );

  test('inserts once, skips an identical replay, updates a changed row', async () => {
    expect((await catalog(2500).run({ driver })).metrics).toEqual({
      inserted: 1,
      updated: 0,
      skipped: 0,
    });
    expect((await catalog(2500).run({ driver })).metrics).toEqual({
      inserted: 0,
      updated: 0,
      skipped: 1,
    });
    expect((await catalog(3000).run({ driver })).metrics).toEqual({
      inserted: 0,
      updated: 1,
      skipped: 0,
    });
    const stored = await driver.repo(plans).findMany({});
    expect(stored.rows).toHaveLength(1);
    expect((stored.rows[0] as { monthly: { minor: number } }).monthly.minor).toBe(3000);
  });

  test('an update never resets createdAt — a replay must not move when the row arrived', async () => {
    await driver.repo(plans).insert(
      plans.$parse({
        code: 'team',
        currency: 'EUR',
        monthly: { minor: 1000, currency: 'EUR' },
        createdAt: new Date('2024-05-05T00:00:00.000Z'),
      }),
    );
    await catalog(3000).run({ driver });
    const stored = await driver.repo(plans).findMany({});
    expect((stored.rows[0] as { createdAt: Date }).createdAt.toISOString()).toBe(
      '2024-05-05T00:00:00.000Z',
    );
    expect((stored.rows[0] as { monthly: { minor: number } }).monthly.minor).toBe(3000);
  });
});

describe('defineSeed() · the file-level guard', () => {
  test('exists()/count() answer the sentinel a bulk seed guards itself with', async () => {
    const seen: boolean[] = [];
    const bulk = defineSeed('seed_test_bulk', async ({ insert, exists, id }) => {
      seen.push(await exists(reports));
      if (await exists(reports)) return;
      await insert(
        reports,
        Array.from({ length: 20 }, (_, index) => ({
          id: id(`report:${index}`),
          day: `2026-01-${String(index + 1).padStart(2, '0')}`,
          total: index,
        })),
      );
    });
    expect((await bulk.run({ driver })).metrics.inserted).toBe(20);
    expect((await bulk.run({ driver })).metrics.inserted).toBe(0);
    expect(seen).toEqual([false, true]);
    expect(await driver.repo(reports).count()).toBe(20);
  });

  test('deleteWhere() is refused on a soft-deleting entity — the stamp keeps the key forever', async () => {
    const wipe = defineSeed('seed_test_wipe', async ({ deleteWhere }) => {
      await deleteWhere(notes, { body: 'gone' });
    });
    const error = await wipe.run({ driver }).catch((thrown: unknown) => thrown);
    expect(error).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect((error as EntityError).cause).toContain('deletedAt');
    expect((error as EntityError).fix).toContain('x db reset');
  });
});

describe('defineSeed() · dry run, tiers and identity', () => {
  test('a dry run writes nothing and still reports what it would have written', async () => {
    const run = await fixtures.run({ driver, dryRun: true });
    expect(run.metrics.inserted).toBe(3);
    expect(await driver.repo(orgs).count()).toBe(0);
  });

  test('id() is deterministic, so a bug reproduced locally reproduces in CI', async () => {
    const labels: string[] = [];
    const seed = defineSeed('seed_test_ids', async ({ id }) => {
      labels.push(id('org:acme'), id('org:acme'), id('org:tinta'));
    });
    await seed.run();
    await seed.run();
    expect(labels[0]).toBe(labels[1] ?? '');
    expect(labels[0]).not.toBe(labels[2] ?? '');
    expect(labels[0]).toBe(labels[3] ?? '');
    expect(labels[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });

  test('a seed is dev-tier until its author says otherwise, and the run reports which', async () => {
    expect(fixtures.tier).toBe('dev');
    expect(defineSeed('seed_test_ref', async () => {}, { tier: 'reference' }).tier).toBe(
      'reference',
    );
    expect((await fixtures.run({ driver })).tier).toBe('dev');
  });

  test('production takes reference seeds only, and a named tier is both selection and consent', () => {
    expect(seedTiersFor('development')).toEqual(['reference', 'dev']);
    expect(seedTiersFor('staging')).toEqual(['reference', 'dev']);
    expect(seedTiersFor('production')).toEqual(['reference']);
    expect(seedTiersFor('production', 'dev')).toEqual(['dev']);
  });

  test('the context carries the environment it resolved, from the env it was handed', async () => {
    const seen: string[] = [];
    const seed = defineSeed('seed_test_env', async ({ environment }) => {
      seen.push(environment);
    });
    await seed.run({ driver, env: { ULTIMATE_ENV: 'staging' } });
    expect(seen).toEqual(['staging']);
  });

  test('isSeed() takes a seed and nothing that merely looks like one', () => {
    expect(isSeed(fixtures)).toBe(true);
    expect(isSeed({ name: 'dev', run: () => Promise.resolve() })).toBe(false);
    expect(isSeed({ name: 'dev', tier: 'nightly', run: () => Promise.resolve() })).toBe(false);
    expect(isSeed(null)).toBe(false);
  });
});
