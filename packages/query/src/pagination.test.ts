import { beforeEach, describe, expect, test } from 'bun:test';
import {
  configureCursorSigning,
  createContext,
  decodeCursor,
  encodeCursor,
  userActor,
} from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { CursorInvalidError } from './errors';
import { paginate } from './pagination';
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
    const cursor = encodeCursor({ scope: 'feed:abc', key: [20], id: 'b' });
    expect(cursor).not.toContain('feed');
    expect(decodeCursor(cursor, 'feed:abc')).toEqual({ scope: 'feed:abc', key: [20], id: 'b' });
  });

  test('a key holding non-ASCII text round trips', () => {
    // `btoa` alone throws above code point 0xFF, so this package's old encoder broke
    // paging on one accented title. The codec encodes UTF-8 bytes; keep it that way.
    const key = ['café — piñata 🎉'];
    const cursor = encodeCursor({ scope: 'feed:abc', key, id: 'b' });
    expect(decodeCursor(cursor, 'feed:abc').key).toEqual(key);
  });

  test('a tampered cursor is X_CURSOR_INVALID', () => {
    const cursor = encodeCursor({ scope: 'feed:abc', key: [20], id: 'b' });
    const [body, signature] = cursor.split('.');
    const forged = encodeCursor({ scope: 'feed:abc', key: [40], id: 'd' }).split('.')[0];

    for (const tampered of [`${forged}.${signature}`, `${body}.deadbeef`, 'garbage']) {
      let failure: unknown;
      try {
        decodeCursor(tampered, 'feed:abc');
      } catch (error) {
        failure = error;
      }
      // The class this package re-exports must be the one core throws: one code, one class.
      expect(failure).toBeInstanceOf(CursorInvalidError);
      expect((failure as { code?: string }).code).toBe('X_CURSOR_INVALID');
    }
  });

  test('a cursor from another query is refused', () => {
    const cursor = encodeCursor({ scope: 'other:abc', key: [20], id: 'b' });
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

  test('a cursor from another query cannot page this one', async () => {
    const feed = registerQuery('orgFeed', defineFeed());
    const foreign = encodeCursor({ scope: 'other:abc', key: [20], id: 'b' });
    await expect(paginate(feed, { orgId: ORG }, { first: 2, ctx, after: foreign })).rejects.toThrow(
      CursorInvalidError,
    );
  });
});
