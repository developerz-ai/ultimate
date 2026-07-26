import { beforeEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { configureCursorSigning, decodeCursor, encodeCursor, paginate } from './pagination';
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
const ctx = createContext({ actor: readerActor });

const posts: readonly Post[] = [
  { id: 'a', orgId: ORG, createdAt: 10 },
  { id: 'b', orgId: ORG, createdAt: 20 },
  { id: 'c', orgId: ORG, createdAt: 30 },
  { id: 'd', orgId: ORG, createdAt: 40 },
];

const defineFeed = () =>
  query({
    input: t.object({ orgId: t.uuid }),
    policy: can('feed:read'),
    sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }).orderBy('createdAt'),
  });

describe('cursor pagination', () => {
  beforeEach(() => {
    resetRegistry();
    configureCursorSigning('test-secret');
  });

  test('encode/decode round trips and stays opaque', () => {
    const cursor = encodeCursor({ q: 'feed:abc', seek: { key: [20], id: 'b' } });
    expect(cursor).not.toContain('feed');
    expect(decodeCursor(cursor)).toEqual({ q: 'feed:abc', seek: { key: [20], id: 'b' } });
  });

  test('a tampered cursor is X_CURSOR_INVALID', () => {
    const cursor = encodeCursor({ q: 'feed:abc', seek: { key: [20], id: 'b' } });
    const [body, signature] = cursor.split('.');
    const forged = encodeCursor({ q: 'feed:abc', seek: { key: [40], id: 'd' } }).split('.')[0];

    for (const tampered of [`${forged}.${signature}`, `${body}.deadbeef`, 'garbage']) {
      let code: unknown;
      try {
        decodeCursor(tampered);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe('X_CURSOR_INVALID');
    }
  });

  test('a cursor from another query is refused', () => {
    const cursor = encodeCursor({ q: 'other:abc', seek: { key: [20], id: 'b' } });
    expect(() => decodeCursor(cursor, 'feed:abc')).toThrow();
  });

  test('pages walk forward without offset and report hasNextPage', async () => {
    const feed = registerQuery('orgFeed', defineFeed());
    const first = await paginate(feed, { orgId: ORG }, { first: 2, ctx });
    expect(first.rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(first.hasNextPage).toBe(true);

    const second = await paginate(
      feed,
      { orgId: ORG },
      {
        first: 2,
        ctx,
        ...(first.endCursor === null ? {} : { after: first.endCursor }),
      },
    );
    expect(second.rows.map((row) => row.id)).toEqual(['c', 'd']);
    expect(second.hasNextPage).toBe(false);
  });
});
