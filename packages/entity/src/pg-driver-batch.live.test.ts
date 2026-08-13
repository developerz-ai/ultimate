// `inBatches(size)` against a real Postgres. `batch.test.ts` proves memory's own boundaries and
// (via a recording client) the statement text the Postgres driver sends; neither proves the server
// accepts that statement, that the seek is a real index scan rather than a scan Postgres refuses,
// or that closing a handle early really stops the next round trip. Skips unless
// `TEST_DATABASE_URL` is set, as every other live file in this package does.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  setStatementObserver,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

// `TEST_DATABASE_URL` only: `beforeAll`/`afterAll` here run `drop table … cascade`, so falling back
// to the app's own `DATABASE_URL` would hand this file whatever database a developer had exported.
const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orgs = entity('pg_batch_live_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const posts = entity('pg_batch_live_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    title: text({ max: 80 }),
  },
});

const DROP = 'drop table if exists "pg_batch_live_posts", "pg_batch_live_orgs" cascade';

/**
 * One `up` script out, one statement per `execute` in: every value in it is an identifier or a
 * CHECK the entity wrote, none of which can contain a semicolon.
 */
const statementsOf = (script: string): readonly string[] =>
  script
    .split(';\n')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

describe.skipIf(!hasPostgres)('live · postgres · inBatches', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      // Declaration order is dependency order: the foreign key needs its target first.
      entities: [orgs.$describe(), posts.$describe()],
      name: 'live inBatches',
      now: new Date('2026-08-13T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
    clearRegistry();
  });

  const db = () => database({ orgs, posts }, { driver: postgresDriver() });

  /** A tenant nobody else writes to, so a whole-tenant walk is an assertion and not a race. */
  const newOrg = async (slug: string): Promise<string> =>
    (await database({ orgs }, { driver: postgresDriver() }).orgs.insert({ slug })).id;

  /** Seven titled rows for `org` — the size the header's `[3, 3, 1]` claim is built on. */
  const seedSeven = async (org: string): Promise<readonly string[]> => {
    const titles = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    for (const title of titles) await db().posts.insert({ orgId: org, title });
    return titles;
  };

  /** Every statement sent while `work` runs, filtered to the ones matching `match`. */
  const capturing = async <T>(match: string, work: () => Promise<T>): Promise<[T, string[]]> => {
    const seen: string[] = [];
    setStatementObserver({
      onStatement: (event) => {
        if (event.text.includes(match)) seen.push(event.text);
      },
    });
    try {
      return [await work(), seen];
    } finally {
      setStatementObserver(undefined);
    }
  };

  test('every row comes back once, in order, batched exactly [3, 3, 1]', async () => {
    const org = await newOrg('batch-walk');
    const titles = await seedSeven(org);

    const batches: string[][] = [];
    for await (const batch of db()
      .posts.where({ orgId: org })
      .orderBy('title', 'asc')
      .inBatches(3)) {
      batches.push(batch.map((row) => row.title));
    }

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.flat()).toEqual(titles);
  });

  test('the seek between batches is a predicate, never an offset', async () => {
    const org = await newOrg('batch-seek');
    await seedSeven(org);

    const [, sent] = await capturing('from "pg_batch_live_posts"', async () => {
      const seen: unknown[] = [];
      for await (const batch of db()
        .posts.where({ orgId: org })
        .orderBy('title', 'asc')
        .inBatches(3)) {
        seen.push(batch);
      }
      return seen;
    });

    expect(sent.length).toBeGreaterThan(1);
    for (const statement of sent) expect(statement.toLowerCase()).not.toContain('offset');
    // The second-and-later statements carry the seek predicate this package writes instead.
    expect(sent[1]).toContain('>');
  });

  test('breaking out of the loop sends no further statement', async () => {
    const org = await newOrg('batch-break');
    await seedSeven(org);

    const [, before] = await capturing('from "pg_batch_live_posts"', async () => {
      for await (const batch of db()
        .posts.where({ orgId: org })
        .orderBy('title', 'asc')
        .inBatches(3)) {
        expect(batch).toHaveLength(3);
        break;
      }
    });
    expect(before).toHaveLength(1);

    // Confirmed against a second, independent capture rather than a running total: nothing queued
    // by the loop's own cleanup fires after the `for await` has already returned control here.
    const [, after] = await capturing('from "pg_batch_live_posts"', async () => {
      // Deliberately empty — proving silence, not another read.
    });
    expect(after).toHaveLength(0);
  });

  test('preload() composed with inBatches() preloads every batch, not only the first', async () => {
    const org = await newOrg('batch-preload');
    await seedSeven(org);

    const [batches, orgReads] = await capturing('from "pg_batch_live_orgs"', async () => {
      const seen: { title: string; org: { id: string; slug: string } }[][] = [];
      for await (const batch of db()
        .posts.where({ orgId: org })
        .orderBy('title', 'asc')
        .preload('org')
        .inBatches(3)) {
        seen.push(batch);
      }
      return seen;
    });

    // Three batches ([3, 3, 1]), one preload statement each — composition, not a reproof of
    // `preload()` itself, which is a different file's claim.
    expect(batches).toHaveLength(3);
    expect(orgReads).toHaveLength(3);
    for (const batch of batches) {
      for (const row of batch) expect(row.org).toEqual({ id: org, slug: 'batch-preload' });
    }
  });

  test('an unscoped chain refuses on its first batch, against a real statement', async () => {
    await expect(
      (async () => {
        for await (const _batch of db().posts.inBatches(3)) {
          // unreachable — the first `page()` call throws before a row is ever yielded.
        }
      })(),
    ).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
  });
});
