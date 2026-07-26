import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { enumerated, integer, text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { invariant } from './invariants';
import { clearRegistry } from './registry';
import { defineSeed } from './seed';

const orgs = entity('db_test_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique() },
});

const posts = entity('db_test_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    slug: text({ max: 80 }),
    title: text({ max: 120 }),
    status: enumerated(['draft', 'published']).default('draft'),
    likeCount: integer().default(0),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  invariants: [invariant('like_count_non_negative', (c) => c.likeCount.atLeast(0))],
});

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';

/** Twelve posts in one org and one in another: enough to catch a missing tenant filter. */
const fixtures = defineSeed('db_test', async ({ insert }) => {
  await insert(orgs, [
    { id: ORG, slug: 'acme' },
    { id: OTHER, slug: 'tinta' },
  ]);
  await insert(
    posts,
    Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`,
      orgId: ORG,
      slug: `post-${index}`,
      title: `Post ${index}`,
      status: 'published' as const,
      createdAt: new Date(2026, 0, index + 1),
      updatedAt: new Date(2026, 0, index + 1),
    })),
  );
  await insert(posts, [
    { id: '00000000-0000-7000-8000-000000000200', orgId: OTHER, slug: 'other', title: 'Other' },
  ]);
});

let db = database({ orgs, posts }, { driver: memoryDriver() });

beforeEach(async () => {
  const driver = memoryDriver();
  db = database({ orgs, posts }, { driver });
  await fixtures.run({ driver });
});

afterAll(() => {
  clearRegistry();
});

describe('database()', () => {
  test('db.posts exists because posts was declared', () => {
    expect(typeof db.posts.where).toBe('function');
    expect(typeof db.orgs.where).toBe('function');
    expect(Object.keys(db).sort()).toEqual(['orgs', 'posts']);
  });

  test('the chainable read the app writes', async () => {
    const rows = await db.posts.where({ orgId: ORG }).orderBy('createdAt').limit(50).all();
    expect(rows).toHaveLength(12);
    expect(rows[0]?.title).toBe('Post 0');
  });

  test('it terminates in a cursor page, and the pages cover every row once', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await db.posts
        .where({ orgId: ORG })
        .orderBy('createdAt')
        .limit(5)
        .after(cursor)
        .page();
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  test('there is no offset — the builder exposes a cursor and nothing else', () => {
    expect('offset' in db.posts).toBe(false);
    expect(db.posts.where({ orgId: ORG }).limit(5).plan().limit).toBe(5);
  });

  test('the tenancy guard fires on execution, not on a promise nobody reads', async () => {
    await expect(db.posts.orderBy('createdAt').all()).rejects.toThrow(/X_TENANCY_UNSCOPED/);
    await expect(db.posts.where({ slug: 'post-1' }).one()).rejects.toThrow(/X_TENANCY_UNSCOPED/);
    expect(await db.orgs.where({ slug: 'acme' }).count()).toBe(1);
  });

  test('select() narrows the rows to the columns asked for', async () => {
    const rows = await db.posts
      .where({ orgId: ORG, status: 'published' })
      .select({ slug: true, updatedAt: true })
      .orderBy('slug')
      .limit(3)
      .all();
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0] ?? {})).toEqual(['slug', 'updatedAt']);
  });

  test('one() reads a single row and null when there is none', async () => {
    expect((await db.posts.where({ orgId: ORG, slug: 'post-3' }).one())?.title).toBe('Post 3');
    expect(await db.posts.where({ orgId: ORG, slug: 'nope' }).one()).toBeNull();
  });

  test('insert fills declared defaults and refuses a row the invariants reject', async () => {
    const row = await db.posts.insert({ orgId: ORG, slug: 'fresh', title: 'Fresh' });
    expect(row.status).toBe('draft');
    expect(row.likeCount).toBe(0);
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      db.posts.insert({ orgId: ORG, slug: 'bad', title: 'Bad', likeCount: -1 }),
    ).rejects.toThrow(/like_count_non_negative/);
  });

  test('update stamps the onUpdateNow column, delete removes the row', async () => {
    const created = await db.posts.insert({ orgId: ORG, slug: 'x', title: 'X' });
    const updated = await db.posts.update(created.id, { title: 'Y' });
    expect(updated.title).toBe('Y');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    await db.posts.delete(created.id);
    expect(await db.posts.where({ orgId: ORG, slug: 'x' }).one()).toBeNull();
  });
});

describe('defineSeed()', () => {
  test('id() is deterministic, so a bug reproduced locally reproduces in CI', async () => {
    const labels: string[] = [];
    const seed = defineSeed('ids', async ({ id }) => {
      labels.push(id('org:acme'), id('org:acme'), id('org:tinta'));
    });
    await seed.run();
    await seed.run();
    expect(labels[0]).toBe(labels[1] ?? '');
    expect(labels[0]).not.toBe(labels[2] ?? '');
    expect(labels[0]).toBe(labels[3] ?? '');
    expect(labels[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });

  test('a seed writes through the same validation as the app', async () => {
    const driver = memoryDriver();
    const broken = defineSeed('broken', async ({ insert }) => {
      await insert(posts, [{ orgId: ORG, slug: 'b', title: 'B', likeCount: -5 }]);
    });
    await expect(broken.run({ driver })).rejects.toThrow(/like_count_non_negative/);
  });
});
