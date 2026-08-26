// Keyset pagination over a NULLABLE sort key, against a real server. The entity layer refused one
// outright while `@ultimat3/query` had defined NULL ordering all along (`asc nulls last` /
// `desc nulls first`) — two pagination systems in one framework disagreeing about whether a
// nullable column is orderable. Only a live walk can say whether the seek and the `order by` agree
// about where the NULLs sit: a text assertion cannot, and `memoryRepo` sorts by its own rule.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { memoryDriver } from './database';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Page } from './repo';
import type { SortDirection } from './tenancy';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const posts = entity('pg_nulls_posts', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 40 }),
    publishedAt: timestamp().nullable(),
    /**
     * A nullable TEXT column, because the timestamp above cannot fail one way this can. The bug
     * being pinned is a NULL falling through to `String(left) < String(right)` and sorting as the
     * four characters `null` — which lands between `apple` and `zulu` in the alphabet, and by
     * accident lands in the RIGHT place for a `Date`, whose `toString()` begins with a capital.
     */
    note: text({ max: 40 }).nullable(),
  },
});

type Post = typeof posts.$row;

const DROP = 'drop table if exists "pg_nulls_posts" cascade';

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000003${String(index).padStart(2, '0')}`;

/**
 * NULLs on BOTH sides of every page boundary a size of 2 can produce: two drafts, two published
 * rows, two more drafts. Interleaved on purpose — a seek that drops its NULL term, or one that
 * puts the NULLs at the wrong end, loses a row in the middle rather than at an edge, which is
 * exactly the failure a five-row fixture hides.
 */
const SEEDED: readonly (readonly [number, string | null, string | null])[] = [
  [1, null, 'apple'],
  [2, '2026-01-01T00:00:00Z', null],
  [3, null, 'zulu'],
  [4, '2026-01-03T00:00:00Z', 'mango'],
  [5, '2026-01-02T00:00:00Z', null],
  [6, null, 'banana'],
];

describe.skipIf(!hasPostgres)('live · postgres · a nullable sort key', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [posts.$describe()],
      name: 'live nullable order',
      now: new Date('2026-08-24T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    for (const [index, at, note] of SEEDED) {
      await client.execute(
        raw(
          `insert into "pg_nulls_posts" ("id", "title", "published_at", "note") values ` +
            `('${id(index)}', 'p${index}', ${at === null ? 'null' : `'${at}'`}, ` +
            `${note === null ? 'null' : `'${note}'`})`,
        ),
      );
    }
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  /** Every row the walk hands back, one page at a time, from the top. */
  const walk = async (
    read: (cursor: string | null) => Promise<Page<Post>>,
  ): Promise<readonly string[]> => {
    const seen: string[] = [];
    let cursor: string | null = null;
    // Bounded: a seek that stops advancing has to fail the test, never hang the run.
    for (let page = 0; page < 10; page += 1) {
      const result = await read(cursor);
      seen.push(...result.rows.map((row) => row.title));
      if (result.nextCursor === null) return seen;
      cursor = result.nextCursor;
    }
    return expect.unreachable('the walk never reached a null cursor');
  };

  const pagedByColumn =
    (
      repo: { findMany: (args: Record<string, unknown>) => Promise<Page<Post>> },
      column: string,
      direction: SortDirection,
      limit: number,
    ) =>
    (cursor: string | null): Promise<Page<Post>> =>
      repo.findMany({ orderBy: [{ column, direction }], limit, cursor });

  const pagedBy = (
    repo: { findMany: (args: Record<string, unknown>) => Promise<Page<Post>> },
    direction: SortDirection,
    limit: number,
  ): ((cursor: string | null) => Promise<Page<Post>>) =>
    pagedByColumn(repo, 'publishedAt', direction, limit);

  /** One statement, no cursor: what the server itself says the order is. */
  const wholeTable = async (
    direction: SortDirection,
    column = 'publishedAt',
  ): Promise<readonly string[]> =>
    (await postgresRepo(posts).findMany({ orderBy: [{ column, direction }], limit: 100 })).rows.map(
      (row) => row.title,
    );

  test('asc puts the nulls last, and a paged walk matches the unpaged read', async () => {
    const whole = await wholeTable('asc');
    expect(whole).toEqual(['p2', 'p5', 'p4', 'p1', 'p3', 'p6']);
    for (const limit of [1, 2, 3, 5]) {
      expect(await walk(pagedBy(postgresRepo(posts), 'asc', limit))).toEqual(whole);
    }
  });

  test('desc puts the nulls first, and a paged walk matches the unpaged read', async () => {
    const whole = await wholeTable('desc');
    // The tiebreak is `id desc` under a descending order, so the three NULLs come back reversed.
    expect(whole).toEqual(['p6', 'p3', 'p1', 'p4', 'p5', 'p2']);
    for (const limit of [1, 2, 3, 5]) {
      expect(await walk(pagedBy(postgresRepo(posts), 'desc', limit))).toEqual(whole);
    }
  });

  test('the in-memory driver walks the identical order, page for page', async () => {
    // The parity rule this package exists on: a nullable sort key means one thing in both drivers
    // or a test that passes against memory says nothing about Postgres.
    const rows = (await postgresRepo(posts).findMany({ limit: 100 })).rows;
    for (const direction of ['asc', 'desc'] as const) {
      const memory = memoryRepo(posts, rows);
      expect(await walk(pagedBy(memory, direction, 2))).toEqual(await wholeTable(direction));
    }
    // And the driver seam agrees too, so nothing here depends on building a repo by hand.
    expect(memoryDriver().repo(posts)).toBeDefined();
  });

  test('a nullable TEXT key agrees too, where a stringified NULL would not', async () => {
    // `String(null)` is `"null"`, which sorts between `mango` and `zulu`. A comparator that let a
    // NULL fall through to a string compare therefore answers a DIFFERENT listing here while
    // agreeing by accident on the `Date` column above — which is why this case exists at all.
    for (const direction of ['asc', 'desc'] as const) {
      const server = await wholeTable(direction, 'note');
      const memory = memoryRepo(posts, (await postgresRepo(posts).findMany({ limit: 100 })).rows);
      // Annotated `readonly`, because `toEqual` takes its expected type from the RECEIVED one: a
      // mutable `string[]` here makes the readonly listing `wholeTable` answers with unassignable.
      const unpaged: readonly string[] = (
        await memory.findMany({ orderBy: [{ column: 'note', direction }], limit: 100 })
      ).rows.map((row) => row.title);
      expect(unpaged).toEqual(server);
      expect(await walk(pagedByColumn(memory, 'note', direction, 2))).toEqual(server);
      expect(await walk(pagedByColumn(postgresRepo(posts), 'note', direction, 2))).toEqual(server);
    }
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
