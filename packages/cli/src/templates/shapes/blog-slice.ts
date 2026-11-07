// The `blog` shape's `post` slice: an entity with no tenant (a blog is one publication), the repo,
// two public reads the site renders, and the seed. Writes go through `/admin`, which derives its
// screens from the entity, so the slice declares no write action of its own.

import type { GeneratedFile, NameSet } from '../naming';

const DIR = 'apps/web/app/post';

const entity =
  (): string => `// A post: a slug, a title and a body, published when \`publishedAt\` is set. No \`tenant:\` — a blog
// is one publication, so every reader reads the same rows.

import { entity, invariant, text, timestamp, uuid } from '@ultimat3/entity';

export const post = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    slug: text({ max: 120 }).unique(),
    title: text({ max: 200 }),
    body: text(),
    /** Null is a draft: no read below returns it, so no page renders it. */
    publishedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [
    invariant('post_title_not_blank', c.title.trimmed().minLength(1)),
    invariant('post_slug_not_blank', c.slug.trimmed().minLength(1)),
  ],
  indexes: [{ on: ['publishedAt'] }],
});

export type Post = typeof post.$row;
`;

const entityTest =
  (): string => `// The table as declared: shared by every reader, with its two invariants.
import { expect, unitTest } from '@ultimat3/testing';
import { post } from './entity';

unitTest('post is one table every reader shares, with its two invariants', () => {
  expect(post.$name).toBe('posts');
  expect(post.$tenantColumn).toBeNull();
  expect(post.$invariants.map((rule) => rule.name)).toEqual([
    'post_title_not_blank',
    'post_slug_not_blank',
  ]);
});
`;

const repo = (
  app: NameSet,
): string => `// The only reads of \`posts\`: published rows, newest first, and one by its slug.

import { db } from '@${app.kebab}/db';
import type { Post } from './entity';

export async function published(limit: number): Promise<readonly Post[]> {
  return db.posts
    .andWhere('publishedAt', 'is-not-null')
    .orderBy('publishedAt', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .all();
}

export async function publishedBySlug(slug: string): Promise<readonly Post[]> {
  return db.posts.where({ slug }).andWhere('publishedAt', 'is-not-null').limit(1).all();
}
`;

const repoTest = (
  app: NameSet,
): string => `// The repo's two reads, against the in-memory driver: never a draft, newest first.
import { db, driver } from '@${app.kebab}/db';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import * as repo from './repo';

const at = (iso: string): Date => new Date(iso);

afterEach(() => {
  driver.reset?.();
});

const write = async (slug: string, publishedAt: Date | null): Promise<void> => {
  await db.posts.insert({ slug, title: slug, body: 'body', publishedAt });
};

unitTest('published is newest first, bounded, and never a draft', async () => {
  await write('old', at('2026-01-01T00:00:00Z'));
  await write('new', at('2026-02-01T00:00:00Z'));
  await write('draft', null);
  expect((await repo.published(10)).map((row) => row.slug)).toEqual(['new', 'old']);
  expect((await repo.published(1)).map((row) => row.slug)).toEqual(['new']);
});

unitTest('publishedBySlug answers one published row, and nothing for a draft', async () => {
  await write('live', at('2026-01-01T00:00:00Z'));
  await write('draft', null);
  expect((await repo.publishedBySlug('live')).map((row) => row.slug)).toEqual(['live']);
  expect(await repo.publishedBySlug('draft')).toEqual([]);
});
`;

const publishedPosts =
  (): string => `// The blog index: published posts, newest first. Public — \`allow('public')\` says so out loud.

import { allow } from '@ultimat3/policy';
import { from, query, t } from '@ultimat3/query';
import type { Post } from '../entity';
import * as repo from '../repo';

export const publishedPosts = query({
  input: t.object({ limit: t.number.int().min(1).max(50).default(20) }),
  policy: allow('public'),
  mcp: { expose: true, description: 'The published posts, newest first' },
  sql: ({ limit }) =>
    from<Post>('posts', () => repo.published(limit))
      .compare('publishedAt', '!=', null)
      .orderBy('publishedAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit),
});
`;

const publishedPost =
  (): string => `// One published post by its slug: a page of at most one row, so a missing slug is an empty page
// (the route answers 404) rather than an error every crawler logs.

import { allow } from '@ultimat3/policy';
import { from, query, t } from '@ultimat3/query';
import type { Post } from '../entity';
import * as repo from '../repo';

export const publishedPost = query({
  input: t.object({ slug: t.string.max(120) }),
  policy: allow('public'),
  mcp: { expose: true, description: 'One published post, by its slug' },
  sql: ({ slug }) =>
    from<Post>('posts', () => repo.publishedBySlug(slug))
      .where({ slug })
      .compare('publishedAt', '!=', null)
      .limit(1),
});
`;

const queriesTest = (
  app: NameSet,
): string => `// The two public reads, called as an anonymous visitor: published rows only.
import { db, driver } from '@${app.kebab}/db';
import { anonymousActor } from '@ultimat3/core';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import { publishedPost } from './published-post';
import { publishedPosts } from './published-posts';

const index = publishedPosts.named('publishedPosts');
const one = publishedPost.named('publishedPost');

afterEach(() => {
  driver.reset?.();
});

unitTest('anyone reads the published posts, and no draft', async () => {
  await db.posts.insert({ slug: 'hello', title: 'Hello', body: 'b', publishedAt: new Date(0) });
  await db.posts.insert({ slug: 'wip', title: 'Wip', body: 'b', publishedAt: null });
  const rows = await index.as(anonymousActor(), {});
  expect(rows.map((row) => row.slug)).toEqual(['hello']);
  expect((await one.as(anonymousActor(), { slug: 'hello' })).map((row) => row.title)).toEqual([
    'Hello',
  ]);
  expect(await one.as(anonymousActor(), { slug: 'wip' })).toEqual([]);
});
`;

const seed = (app: NameSet): string => `import { defineSeed } from '@ultimat3/entity';
import { post } from './schema';

/** Stable across runs: \`id('post:hello')\` is a UUID v5 of the label, not a random one. */
export const ${app.camel}Seed = defineSeed('${app.kebab}', async ({ insert, id }) => {
  await insert(post, [
    {
      id: id('post:hello'),
      slug: 'hello',
      title: 'Hello, world',
      body: 'The first post. Edit it, or write the next one, at /admin.',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
    },
    {
      id: id('post:draft'),
      slug: 'draft',
      title: 'A draft',
      body: 'Unpublished: no page renders it until publishedAt is set.',
      publishedAt: null,
    },
  ]);
});
`;

const seedTest = (
  app: NameSet,
): string => `// The seed, run against the in-memory driver: what it writes, and that a second run writes nothing.
import { isSeed } from '@ultimat3/entity';
import { afterEach, expect, unitTest } from '@ultimat3/testing';
import { db, driver } from './client';
import { ${app.camel}Seed } from './seed';

afterEach(() => {
  driver.reset?.();
});

unitTest('the seed is one x db seed discovers, in the dev tier', () => {
  expect(isSeed(${app.camel}Seed)).toBe(true);
  expect(${app.camel}Seed.tier).toBe('dev');
});

unitTest('it writes one published post and one draft, once', async () => {
  const first = await ${app.camel}Seed.run({ driver });
  expect(first.metrics.inserted).toBe(2);
  const rows = await db.posts.orderBy('slug').all();
  expect(rows.map((row) => [row.slug, row.publishedAt === null])).toEqual([
    ['draft', true],
    ['hello', false],
  ]);
  expect((await ${app.camel}Seed.run({ driver })).metrics.inserted).toBe(0);
});
`;

const authTest =
  (): string => `// The auth instance is built once per process, on first use. Built here over a MIGRATED database,
// never the process default: the adapter keeps the client it was built over, so an instance first
// built with no database installed is the one every later sign-in test in this process reaches —
// unable to reach any database, in a file that installed its own.
import { migratedDatabase } from '@ultimat3/cli';
import { setDbClient } from '@ultimat3/db';
import { afterAll, beforeAll, expect, reusableDatabase, unitTest } from '@ultimat3/testing';
import { appAuth } from './auth';

// A template restore is ~0.5 s; its first build (initdb plus every migration) is what this bounds.
const BOOT_MS = 120_000;

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));
beforeAll(async () => {
  setDbClient(await workerDatabase());
}, BOOT_MS);
afterAll(() => setDbClient(undefined));

unitTest('appAuth builds one instance and hands it back every time', () => {
  expect(appAuth()).toBe(appAuth());
});
`;

/** The slice, its tests, and the seed that replaces the empty one. */
export function blogSliceFiles(app: NameSet): readonly GeneratedFile[] {
  return [
    { path: `${DIR}/entity.ts`, contents: entity() },
    { path: `${DIR}/entity.test.ts`, contents: entityTest() },
    { path: `${DIR}/repo.ts`, contents: repo(app) },
    { path: `${DIR}/repo.test.ts`, contents: repoTest(app) },
    { path: `${DIR}/queries/published-posts.ts`, contents: publishedPosts() },
    { path: `${DIR}/queries/published-post.ts`, contents: publishedPost() },
    { path: `${DIR}/queries/queries.test.ts`, contents: queriesTest(app) },
    { path: 'packages/db/src/seed.ts', contents: seed(app) },
    { path: 'packages/db/src/seed.test.ts', contents: seedTest(app) },
    { path: 'apps/web/app/auth/auth.test.ts', contents: authTest() },
  ];
}
