// `preload()` against a real Postgres. `preload-statements.test.ts` proves the statement *shape*
// against a recording client; nothing there proves the server accepts the `in (…)` it renders,
// that a cross-tenant or soft-deleted target really excludes, or that the attached rows round-trip
// through `decodeRow`. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  setStatementObserver,
  statementsOf,
} from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

// `TEST_DATABASE_URL` only: `beforeAll`/`afterAll` run `drop table … cascade`, so falling back to
// the app's own `DATABASE_URL` would hand this file whatever database a developer had exported.
const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const orgs = entity('pg_preload_live_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const members = entity('pg_preload_live_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    email: text({ max: 120 }),
    deletedAt: timestamp().nullable(),
  },
});

const posts = entity('pg_preload_live_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    authorId: uuid().references(() => members.id),
    /** Nullable on purpose: the missing-key case a `belongsTo` has to attach `null` for. */
    reviewerId: uuid()
      .references(() => members.id)
      .nullable(),
    title: text({ max: 120 }),
  },
});

const DROP =
  'drop table if exists "pg_preload_live_posts", "pg_preload_live_members", ' +
  '"pg_preload_live_orgs" cascade';

/**
 * A `hasMany` is named for the entity the rows come from, and both inbound keys want that name —
 * so every member of the group takes its long form, exactly as `preload.test.ts` spells it.
 */
const BY_AUTHOR = 'pg_preload_live_postsByAuthor';
const BY_REVIEWER = 'pg_preload_live_postsByReviewer';

const field = (row: unknown, key: string): unknown => (row as Record<string, unknown>)[key];

describe.skipIf(!hasPostgres)('live · postgres · preload', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      // Declaration order is dependency order: both foreign keys need their targets first.
      entities: [orgs.$describe(), members.$describe(), posts.$describe()],
      name: 'live preload',
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

  const db = () => database({ orgs, members, posts }, { driver: postgresDriver() });

  /** What a call produced, and every statement it sent that matched — the count claim needs both. */
  const counting = async <T>(match: string, work: () => Promise<T>): Promise<[T, string[]]> => {
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

  const newOrg = async (slug: string): Promise<string> =>
    (await database({ orgs }, { driver: postgresDriver() }).orgs.insert({ slug })).id;

  /** A tenant nobody else writes to, plus its two members and three cross-linked posts. */
  const seed = async (slug: string) => {
    const org = await newOrg(slug);
    const ana = (await db().members.insert({ orgId: org, email: `ana-${slug}@example.com` })).id;
    const ben = (await db().members.insert({ orgId: org, email: `ben-${slug}@example.com` })).id;
    const p1 = (await db().posts.insert({ orgId: org, authorId: ana, title: 'First' })).id;
    const p2 = (
      await db().posts.insert({ orgId: org, authorId: ana, reviewerId: ben, title: 'Second' })
    ).id;
    const p3 = (await db().posts.insert({ orgId: org, authorId: ben, title: 'Third' })).id;
    return { org, ana, ben, p1, p2, p3 };
  };

  test('a belongsTo attaches the related row, a missing key attaches null', async () => {
    const { org, ana, ben } = await seed('belongs-to');

    const rows = await db().posts.where({ orgId: org }).orderBy('title').preload('author').all();

    expect(rows).toHaveLength(3);
    expect(field(rows[0], 'author')).toMatchObject({ id: ana });
    expect(field(rows[2], 'author')).toMatchObject({ id: ben });

    const withReviewer = await db()
      .posts.where({ orgId: org })
      .orderBy('title')
      .preload('reviewer')
      .all();

    // 'First' has no reviewer at all: null, and present, never absent.
    expect(field(withReviewer[0], 'reviewer')).toBeNull();
    expect('reviewer' in (withReviewer[0] as object)).toBe(true);
    // 'Second' resolves to the row Postgres actually stored for it.
    expect(field(withReviewer[1], 'reviewer')).toMatchObject({ id: ben });
  });

  test('a hasMany attaches an array, empty when the page has none', async () => {
    const { org, ana, ben, p1, p2, p3 } = await seed('has-many');

    const byAuthor = await db()
      .members.where({ orgId: org })
      .orderBy('email')
      .preload(BY_AUTHOR)
      .all();
    const anaRow = byAuthor.find((row) => field(row, 'id') === ana);
    const benRow = byAuthor.find((row) => field(row, 'id') === ben);
    // The attached array is not sorted here: it arrives in the related read's own total order,
    // which is that entity's primary key ascending — and a uuid sorts the same way in Postgres as
    // its lower-case text does here. The ids are the server's, hence the sort on the expectation.
    expect((field(anaRow, BY_AUTHOR) as readonly unknown[]).map((row) => field(row, 'id'))).toEqual(
      [p1, p2].sort(),
    );
    expect((field(benRow, BY_AUTHOR) as readonly unknown[]).map((row) => field(row, 'id'))).toEqual(
      [p3],
    );

    const byReviewer = await db()
      .members.where({ orgId: org })
      .orderBy('email')
      .preload(BY_REVIEWER)
      .all();
    const anaReviewed = byReviewer.find((row) => field(row, 'id') === ana);
    const benReviewed = byReviewer.find((row) => field(row, 'id') === ben);
    // Nobody named ana as reviewer on this seed — an empty array, not an absent one.
    expect(field(anaReviewed, BY_REVIEWER)).toEqual([]);
    expect(
      (field(benReviewed, BY_REVIEWER) as readonly unknown[]).map((row) => field(row, 'id')),
    ).toEqual([p2]);
  });

  test('exactly one extra statement per relation, over the distinct keys the page carried', async () => {
    const { org } = await seed('one-statement');

    const [rows, sent] = await counting('from "pg_preload_live_members"', () =>
      db().posts.where({ orgId: org }).orderBy('title').preload('author').preload('reviewer').all(),
    );

    expect(rows).toHaveLength(3);
    // Two relations named, two statements sent — never one merged, never one per row.
    expect(sent).toHaveLength(2);
    // Two authors are distinct across three posts: two binds, not three. One reviewer named across
    // three posts: one bind. Counted rather than indexed — the two relations resolve concurrently,
    // so arrival order is not the order they were named in and pinning it would flake.
    expect(sent.filter((text) => text.includes('in ($1, $2)'))).toHaveLength(1);
    expect(sent.filter((text) => text.includes('in ($1)'))).toHaveLength(1);
  });

  test('the page tenant scope carries onto the preload statement, and a cross-tenant target excludes', async () => {
    const ours = await seed('scope-ours');
    const theirs = await seed('scope-theirs');
    // A post in our tenant pointing at a member row that lives in the other tenant — the FK is
    // satisfiable (both rows exist), but the tenant boundary is not.
    const crossed = (
      await db().posts.insert({ orgId: ours.org, authorId: theirs.ana, title: 'Crossed' })
    ).id;

    const [rows, sent] = await counting('from "pg_preload_live_members"', () =>
      db().posts.where({ orgId: ours.org, id: crossed }).preload('author').all(),
    );

    expect(field(rows[0], 'author')).toBeNull();
    // The tenant predicate really is inside the SQL Postgres ran, not only in this process's memory.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"org_id" =');
  });

  test('a soft-deleted target is as invisible to a preload as it is to any other read', async () => {
    const { org, ana } = await seed('soft-delete');
    await db().members.delete(ana, { orgId: org });
    const authored = (await db().posts.insert({ orgId: org, authorId: ana, title: 'Orphaned' })).id;

    const [rows, sent] = await counting('from "pg_preload_live_members"', () =>
      db().posts.where({ orgId: org, id: authored }).preload('author').all(),
    );

    expect(field(rows[0], 'author')).toBeNull();
    // The clause any other read of `members` carries is inside the preload statement too.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"deleted_at" is null');
  });

  test('count() reads no row, so it sends no extra statement', async () => {
    const { org } = await seed('count-no-extra');

    const [total, sent] = await counting('from "pg_preload_live_members"', () =>
      db().posts.where({ orgId: org }).preload('author').count(),
    );

    expect(total).toBe(3);
    expect(sent).toHaveLength(0);
  });
});
