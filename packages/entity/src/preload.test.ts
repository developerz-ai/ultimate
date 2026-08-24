// What `preload('<relation>')` means, in the driver a test can seed: which rows attach, what a
// missing one reads as, and the four refusals. The statement count it costs is pinned against the
// recording client in `preload-statements.test.ts` — the same feature, from the wire's side.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { tableFor } from './query';
import { clearRegistry } from './registry';

/** The tenant root: scoped by nobody, which is what makes it the target of a `belongsTo`. */
const orgs = entity('preload_test_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }) },
});

const members = entity('preload_test_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    email: text({ max: 120 }),
  },
});

const posts = entity('preload_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    authorId: uuid().references(() => members.id),
    /** Nullable on purpose: a post nobody reviewed is data, not a broken key. */
    reviewerId: uuid()
      .references(() => members.id)
      .nullable(),
    title: text({ max: 120 }),
    deletedAt: timestamp().nullable(),
  },
});

/** Unscoped itself, pointing at a scoped entity — the read a tenant predicate cannot be guessed for. */
const audits = entity('preload_test_audits', {
  columns: {
    id: uuid().primaryKey(),
    memberId: uuid().references(() => members.id),
    action: text({ max: 40 }),
  },
});

/**
 * Scoped by `workspaceId`, and carrying an ordinary `orgId` column that is a filter and not its
 * tenancy — the one shape where matching the target's column name alone would carry a predicate
 * nobody proved this reader owns.
 */
const tickets = entity('preload_test_tickets', {
  columns: {
    id: uuid().primaryKey(),
    workspaceId: uuid().tenant(),
    orgId: uuid(),
    memberId: uuid().references(() => members.id),
  },
});

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

/**
 * A `hasMany` is named for the entity the rows come from, and both inbound keys want that name —
 * so every member of the group takes its long form. Spelled out here because the entity names in
 * a test file carry a prefix and the derived name carries it too.
 */
const BY_AUTHOR = 'preload_test_postsByAuthor';
const BY_REVIEWER = 'preload_test_postsByReviewer';

const ORG = idAt(1);
const OTHER_ORG = idAt(2);
const ANA = idAt(10);
const BEN = idAt(11);
const THEIRS = idAt(12);

type Db = ReturnType<typeof handle>;

const handle = () =>
  database({ orgs, members, posts, audits, tickets }, { driver: memoryDriver() });

let db: Db;

beforeEach(async () => {
  db = handle();
  await db.orgs.insert({ id: ORG, slug: 'ours' });
  await db.orgs.insert({ id: OTHER_ORG, slug: 'theirs' });
  await db.members.insert({ id: ANA, orgId: ORG, email: 'ana@example.com' });
  await db.members.insert({ id: BEN, orgId: ORG, email: 'ben@example.com' });
  await db.members.insert({ id: THEIRS, orgId: OTHER_ORG, email: 'them@example.com' });
  await db.posts.insert({ id: idAt(20), orgId: ORG, authorId: ANA, title: 'First' });
  await db.posts.insert({
    id: idAt(21),
    orgId: ORG,
    authorId: ANA,
    reviewerId: BEN,
    title: 'Second',
  });
  await db.posts.insert({ id: idAt(22), orgId: ORG, authorId: BEN, title: 'Third' });
});

afterAll(() => {
  clearRegistry();
});

const field = (row: unknown, key: string): unknown => (row as Record<string, unknown>)[key];

describe('what attaches', () => {
  test('a belongsTo attaches the row itself, under the relation the foreign key names', async () => {
    const rows = await db.posts.where({ orgId: ORG }).orderBy('id').preload('author').all();

    expect(rows).toHaveLength(3);
    expect(field(rows[0], 'author')).toMatchObject({ id: ANA, email: 'ana@example.com' });
    expect(field(rows[2], 'author')).toMatchObject({ id: BEN });
  });

  test('a key that resolved to nothing attaches null — never a missing property', async () => {
    const rows = await db.posts.where({ orgId: ORG }).orderBy('id').preload('reviewer').all();

    expect(field(rows[0], 'reviewer')).toBeNull();
    expect(field(rows[1], 'reviewer')).toMatchObject({ id: BEN });
    // Present on every row: "nobody reviewed it" and "nobody preloaded the reviewer" must differ.
    expect(rows.every((row) => 'reviewer' in (row as object))).toBe(true);
  });

  test('a hasMany attaches an array, empty rather than absent when the page has none', async () => {
    const rows = await db.members.where({ orgId: ORG }).orderBy('id').preload(BY_AUTHOR).all();

    expect(
      (field(rows[0], BY_AUTHOR) as readonly unknown[]).map((row) => field(row, 'id')),
    ).toEqual([idAt(20), idAt(21)]);
    expect(field(rows[1], BY_AUTHOR)).toHaveLength(1);
    // One relation named is one relation attached: the other inbound key is nobody's business.
    expect(field(rows[0], BY_REVIEWER)).toBeUndefined();

    const reviewed = await db.members
      .where({ orgId: ORG })
      .orderBy('id')
      .preload(BY_REVIEWER)
      .all();
    expect(field(reviewed[0], BY_REVIEWER)).toEqual([]);
  });

  test('several relations attach together, each under its own name', async () => {
    const [row] = await db.posts
      .where({ orgId: ORG, id: idAt(21) })
      .preload('author')
      .preload('reviewer')
      .all();

    expect(field(row, 'author')).toMatchObject({ id: ANA });
    expect(field(row, 'reviewer')).toMatchObject({ id: BEN });
  });

  test('every terminal that returns rows preloads; count() has no row to attach to', async () => {
    const chain = () => db.posts.where({ orgId: ORG }).orderBy('id').preload('author');

    expect(field((await chain().page()).rows[0], 'author')).toMatchObject({ id: ANA });
    expect(field(await chain().one(), 'author')).toMatchObject({ id: ANA });
    expect(await chain().count()).toBe(3);
  });

  test('a projection narrows the columns, never the relations', async () => {
    const chain = db.posts
      .where({ orgId: ORG })
      .orderBy('id')
      .select({ id: true, title: true })
      .preload('author');
    const [row] = await chain.all();

    expect(field(row, 'author')).toMatchObject({ id: ANA });
    // The key the preload reads is asked for even though the caller did not name it.
    expect(chain.plan().select).toEqual(['id', 'title', 'authorId']);
  });

  test('the attachment is a copy — the driver keeps handing back an unpreloaded row', async () => {
    await db.posts.where({ orgId: ORG }).preload('author').all();
    const [plain] = await db.posts.where({ orgId: ORG, id: idAt(20) }).all();

    expect('author' in (plain as object)).toBe(false);
  });
});

describe('the refusals', () => {
  test('an unknown relation fails on the chain, not one page later', () => {
    let error: unknown;
    try {
      db.posts.where({ orgId: ORG }).preload('authorr');
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeUltimateError('X_PRELOAD_UNKNOWN_RELATION');
    // The names that do exist are in the fix, because a relation is derived and listed nowhere.
    expect(String((error as { fix: string }).fix)).toContain('author');
  });

  test('a relation whose other end the database() call never named is refused', async () => {
    const partial = database({ posts }, { driver: memoryDriver() });
    await partial.posts.insert({ id: idAt(20), orgId: ORG, authorId: ANA, title: 'Alone' });

    await expect(
      partial.posts.where({ orgId: ORG }).preload('author').all(),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
  });

  test('a table built by hand reaches no other table, and says so the same way', async () => {
    const row = posts.$parse({ id: idAt(20), orgId: ORG, authorId: ANA, title: 'Alone' });
    const bare = tableFor(posts, memoryRepo(posts, [row]));

    await expect(bare.where({ orgId: ORG }).preload('author').all()).rejects.toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
  });

  test('a tenant scope is carried, never guessed — an unscoped source refuses a scoped target', async () => {
    await db.audits.insert({ id: idAt(30), memberId: ANA, action: 'login' });

    await expect(db.audits.preload('member').all()).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
  });

  test('a predicate that only shares the target’s column name is not this source’s tenancy', async () => {
    // `tickets` is scoped by `workspaceId`; its `orgId` is an ordinary filter. Carrying it would
    // scope the members read to a tenant the reader never proved they own.
    await db.tickets.insert({ id: idAt(31), workspaceId: idAt(3), orgId: ORG, memberId: ANA });

    await expect(
      db.tickets
        .where({ workspaceId: idAt(3), orgId: ORG })
        .preload('member')
        .all(),
    ).rejects.toBeUltimateError('X_TENANCY_UNSCOPED');
  });
});

describe('the scope the page was read under', () => {
  test('another tenant’s row is not attached, whichever tenant asks', async () => {
    // A post pointing across the tenant boundary: the FK is there, the row is not readable.
    await db.posts.insert({ id: idAt(23), orgId: ORG, authorId: THEIRS, title: 'Crossed' });

    const [crossed] = await db.posts
      .where({ orgId: ORG, id: idAt(23) })
      .preload('author')
      .all();

    expect(field(crossed, 'author')).toBeNull();
  });

  test('a soft-deleted row is as invisible to a preload as it is to any other read', async () => {
    await db.posts.delete(idAt(20), { orgId: ORG });

    const [ana] = await db.members.where({ orgId: ORG, id: ANA }).preload(BY_AUTHOR).all();

    expect((field(ana, BY_AUTHOR) as readonly unknown[]).map((row) => field(row, 'id'))).toEqual([
      idAt(21),
    ]);
  });
});
