import { beforeEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toLiveQuery } from './live';
import { match } from './matcher';
import { query } from './query';
import { registerQuery, resetRegistry } from './registry';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: number;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const readerActor = { ...userActor({ id: 'u1' }), permissions: ['feed:read'] };
const member = createContext({ actor: readerActor });
const anonymous = createContext({});

const posts: readonly Post[] = [
  { id: 'a', orgId: ORG, createdAt: 10 },
  { id: 'b', orgId: ORG, createdAt: 20 },
];

const defineFeed = () =>
  query({
    input: t.object({ orgId: t.uuid }),
    policy: can('feed:read'),
    live: true,
    sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }).orderBy('createdAt').limit(50),
  });

describe('live query descriptor', () => {
  beforeEach(() => {
    resetRegistry();
  });

  test('carries the shape, the dependency set and the generated SQL', async () => {
    const feed = registerQuery('liveFeed', defineFeed());
    const live = await toLiveQuery(feed, { orgId: ORG }, { ctx: member, epoch: 'build-1' });

    expect(live.shape.entity).toBe('posts');
    expect(live.reads).toEqual(['posts']);
    expect(live.limit).toBe(50);
    expect(live.sqlText).toContain('order by "createdAt" asc');
  });

  test('policy is evaluated per subscriber, not once per query', async () => {
    const feed = registerQuery('liveFeed', defineFeed());
    const live = await toLiveQuery(feed, { orgId: ORG }, { ctx: member, epoch: 'build-1' });

    live.authorize({ actor: readerActor, input: {}, ctx: member, query: 'liveFeed' });
    const denial = await live
      .authorize({ actor: null, input: {}, ctx: anonymous, query: 'liveFeed' })
      .catch((error: unknown) => error);
    expect((denial as { code?: string }).code).toBe('X_UNAUTHENTICATED');
    expect((denial as { denial?: { close?: number } }).denial?.close).toBe(4403);
  });

  test('the cursor resumes on the same epoch and refetches on a new build', async () => {
    const feed = registerQuery('liveFeed', defineFeed());
    const live = await toLiveQuery(feed, { orgId: ORG }, { ctx: member, epoch: 'build-1' });
    const cursor = live.initialCursor(posts);

    expect(cursor.seek).toEqual({ key: [20], id: 'b' });
    expect(live.resume(cursor).mode).toBe('resume');

    const stale = { ...cursor, epoch: 'build-0' };
    expect(live.resume(stale).mode).toBe('refetch');
    expect(live.resume(stale).reason).toContain('epoch');
  });

  test('applied patches advance the version and the row count', async () => {
    const feed = registerQuery('liveFeed', defineFeed());
    const live = await toLiveQuery(feed, { orgId: ORG }, { ctx: member, epoch: 'build-1' });
    const cursor = live.initialCursor(posts);

    const incoming = { id: 'c', orgId: ORG, createdAt: 30 };
    const patches = match('liveFeed', live.shape, posts, {
      entity: 'posts',
      op: 'insert',
      row: incoming,
    });
    const next = live.advance(cursor, patches, incoming);

    expect(patches).toEqual([{ kind: 'add', position: 2, row: incoming }]);
    expect(next.version).toBe(1);
    expect(next.rows).toBe(3);
    expect(next.seek).toEqual({ key: [30], id: 'c' });
  });
});
