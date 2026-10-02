// The replay, against a real server. `seed.test.ts` proves the rules a driver stub can decide; only
// Postgres can say that a second run of the same seed does not raise `23505` — the memory driver
// overwrites by primary key, so the defect this file pins is invisible everywhere else.
// Skips unless `TEST_DATABASE_URL` is set, exactly as the rest of the live suite does.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { integer, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import { defineSeed } from './seed';

// `TEST_DATABASE_URL` only: this file drops its own tables, so falling back to `DATABASE_URL` would
// point it at whatever database a developer had exported.
const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orgs = entity('seed_live_orgs', {
  columns: {
    id: uuid().primaryKey(),
    slug: text({ max: 40 }).unique(),
    name: text({ max: 80 }),
    createdAt: timestamp().defaultNow(),
  },
});

/** Tenant-scoped: its unique keys carry no tenant column, which is what `do nothing` survives. */
const posts = entity('seed_live_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    title: text({ max: 80 }),
    likeCount: integer().default(0),
    createdAt: timestamp().defaultNow(),
  },
});

/** Reference data whose id the TABLE owns — `(code, currency)` is the only key a seed can name. */
const plans = entity('seed_live_plans', {
  columns: {
    code: text({ max: 20 }),
    currency: text({ max: 3 }),
    monthly: money(),
    createdAt: timestamp().defaultNow(),
  },
  primaryKey: ['code', 'currency'],
});

const DROP = 'drop table if exists "seed_live_posts", "seed_live_plans", "seed_live_orgs" cascade';

const fixture = (minor: number) =>
  defineSeed('seed_live', async ({ insert, upsert, id }) => {
    await insert(orgs, [{ id: id('org:acme'), slug: 'acme', name: 'Acme' }]);
    await insert(posts, [
      { id: id('post:one'), orgId: id('org:acme'), title: 'One' },
      { id: id('post:two'), orgId: id('org:acme'), title: 'Two' },
    ]);
    await upsert(
      plans,
      { by: ['code', 'currency'] },
      {
        code: 'team',
        currency: 'EUR',
        monthly: { minor, currency: 'EUR' },
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    );
  });

describe.skipIf(!hasPostgres)('live · postgres · a seed replays', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [orgs.$describe(), plans.$describe(), posts.$describe()],
      name: 'live seed replay',
      now: new Date('2026-08-18T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  const countOf = async (table: string): Promise<number> =>
    Number((await client.query<{ n: string }>(raw(`select count(*) as n from "${table}"`)))[0]?.n);

  test('a dry run is the real run rolled back: it reports the writes and keeps none', async () => {
    // On an EMPTY database, so the posts' foreign key is only satisfiable because the dry run
    // really wrote the org a statement earlier — and then took all of it back.
    const dry = await fixture(2500).run({ driver: postgresDriver(), dryRun: true });
    expect(dry.metrics).toEqual({ inserted: 4, updated: 0, skipped: 0 });
    expect(await countOf('seed_live_orgs')).toBe(0);
    expect(await countOf('seed_live_posts')).toBe(0);
    expect(await countOf('seed_live_plans')).toBe(0);
  });

  test('through a driver PINNED to its own client the dry run still rolls back', async () => {
    // The dry run's transaction is opened on the pinned client, so the pinned repositories join it
    // (`tx.origin`). Refusing here would make a dry run fail where the real run works.
    const pinned = postgresDriver({ client });
    const dry = await fixture(2500).run({ driver: pinned, dryRun: true });
    expect(dry.metrics).toEqual({ inserted: 4, updated: 0, skipped: 0 });
    expect(await countOf('seed_live_orgs')).toBe(0);
    expect(await countOf('seed_live_posts')).toBe(0);
  });

  test('inside an open transaction — the shape x db seed runs it in — it undoes only itself', async () => {
    const other = '00000000-0000-7000-8000-0000000000d1';
    await withTransaction(async () => {
      await postgresDriver()
        .repo(orgs)
        .insert({ id: other, slug: 'kept', name: 'Kept', createdAt: new Date() });
      const dry = await fixture(2500).run({ driver: postgresDriver(), dryRun: true });
      expect(dry.metrics).toEqual({ inserted: 4, updated: 0, skipped: 0 });
    });
    expect(await countOf('seed_live_orgs')).toBe(1);
    expect(await countOf('seed_live_posts')).toBe(0);
    await client.execute(raw(`delete from "seed_live_orgs" where id = '${other}'`));
  });

  test('a second run raises nothing and writes nothing — the whole point of a seed', async () => {
    const driver = postgresDriver();
    const first = await fixture(2500).run({ driver });
    expect(first.metrics).toEqual({ inserted: 4, updated: 0, skipped: 0 });

    // Against the `insert`-per-row implementation this replaced, this line is `23505` on the first
    // org — which is what the demo app's hand-written Driver decorator existed to work around.
    const second = await fixture(2500).run({ driver });
    expect(second.metrics).toEqual({ inserted: 0, updated: 0, skipped: 4 });

    expect(await countOf('seed_live_orgs')).toBe(1);
    expect(await countOf('seed_live_posts')).toBe(2);
    expect(await countOf('seed_live_plans')).toBe(1);
  });

  test('a changed reference row is updated in one statement, and keeps its created_at', async () => {
    const driver = postgresDriver();
    await client.execute(
      raw(`update "seed_live_plans" set created_at = '2024-05-05T00:00:00Z' where code = 'team'`),
    );
    const run = await fixture(3000).run({ driver });
    expect(run.metrics.updated).toBe(1);
    const rows = await client.query<{ monthly_minor: string; created_at: Date }>(
      raw('select monthly_minor, created_at from "seed_live_plans"'),
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.monthly_minor)).toBe(3000);
    expect(rows[0]?.created_at.toISOString()).toBe('2024-05-05T00:00:00.000Z');
  });
  test('a key another tenant holds is skipped by the dry run, as the real run skips it', async () => {
    // After the runs above `post:one` belongs to acme. The conflict target is the primary key, and
    // a key is global — so a seed naming that id under another org writes nothing, dry or not.
    const theirs = '00000000-0000-7000-8000-0000000000d2';
    await client.execute(
      raw(`insert into "seed_live_orgs" (id, slug, name) values ('${theirs}', 'them', 'Them')`),
    );
    const seed = defineSeed('seed_live_two_tenants', async ({ insert, id }) => {
      await insert(posts, [{ id: id('post:one'), orgId: theirs, title: 'Taken' }]);
    });
    const dry = await seed.run({ driver: postgresDriver(), dryRun: true });
    expect(dry.metrics).toEqual({ inserted: 0, updated: 0, skipped: 1 });
    expect((await seed.run({ driver: postgresDriver() })).metrics).toEqual(dry.metrics);
    expect(await countOf('seed_live_posts')).toBe(2);
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
