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
import type { Builder, SqlSource } from './source';
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

  test('a read with no id refuses to page rather than sign "undefined" as a position', async () => {
    // `String(undefined)` is a position every row matches, so the cursor is signed, opaque and
    // meaningless — page two would then be page one, forever, with nothing to read off the wire.
    const anonymous = registerQuery(
      'anonymousFeed',
      query({
        input: t.object({ orgId: t.uuid }),
        policy: can('feed:read'),
        sql: () => from<{ createdAt: number }>('totals', [{ createdAt: 10 }]).orderBy('createdAt'),
      }),
    );
    const failure = paginate(anonymous, { orgId: ORG }, { first: 2, ctx });
    await expect(failure).rejects.toBeUltimateError('X_QUERY_NOT_PAGEABLE');
  });
});

/**
 * Both halves of the same contract: a source that pushes the seek into SQL and one that cannot.
 * The fallback used to locate the cursor's row by id and slice after it, which is not what a
 * cursor means — the two paths disagreed exactly when it mattered, under a concurrent write.
 */
describe('cursor pagination under concurrent writes', () => {
  let live: Post[] = [];

  const ordered = (org: string): Builder<Post> =>
    from<Post>('posts', () => Promise.resolve(live))
      .where({ orgId: org })
      .orderBy('createdAt');

  /** The same rows behind a source with no `seek()`, so pagination must slice them itself. */
  const withoutPushdown = (org: string): SqlSource<Post> => {
    const base = ordered(org);
    return { toSQL: () => base.toSQL(), execute: () => base.execute(), shape: () => base.shape() };
  };

  /** A page with no cursor fails the test here rather than seeking from an empty position. */
  const cursorOf = (page: { readonly endCursor: string | null }): string => {
    expect(page.endCursor).not.toBeNull();
    return page.endCursor ?? '';
  };

  const feedOver = (name: string, source: (org: string) => SqlSource<Post>) =>
    registerQuery(
      name,
      query({
        input: t.object({ orgId: t.uuid }),
        policy: can('feed:read'),
        sql: ({ orgId }) => source(orgId),
      }),
    );

  beforeEach(() => {
    resetRegistry();
    configureCursorSigning('test-secret');
    live = [...posts];
  });

  const paths = [
    { name: 'pushdown', label: 'pushed into the source', source: ordered },
    { name: 'fallback', label: 'sliced after execution', source: withoutPushdown },
  ] as const;

  for (const path of paths) {
    test(`${path.label}: deleting the row a cursor points at does not restart the listing`, async () => {
      const feed = feedOver(`deleteFeed_${path.name}`, path.source);
      const first = await paginate(feed, { orgId: ORG }, { first: 2, ctx });
      expect(first.rows.map((row) => row.id)).toEqual(['a', 'b']);

      // The boundary row is gone by the time page two is asked for — the ordinary case in any
      // app with a delete button. A cursor names a position, so the position survives the row.
      live = live.filter((row) => row.id !== 'b');
      const second = await paginate(
        feed,
        { orgId: ORG },
        { first: 2, ctx, after: cursorOf(first) },
      );
      expect(second.rows.map((row) => row.id)).toEqual(['c', 'd']);
    });

    test(`${path.label}: a row inserted behind the cursor neither duplicates nor skips`, async () => {
      const feed = feedOver(`insertFeed_${path.name}`, path.source);
      const first = await paginate(feed, { orgId: ORG }, { first: 2, ctx });

      // Under OFFSET this insert shifts every later page by one: `b` comes back twice and `c` is
      // never returned. The keyset cursor is indifferent to what happened before its position.
      live = [{ id: 'z', orgId: ORG, createdAt: 5 }, ...live];
      const second = await paginate(
        feed,
        { orgId: ORG },
        { first: 2, ctx, after: cursorOf(first) },
      );

      const seen = [...first.rows, ...second.rows].map((row) => row.id);
      expect(seen).toEqual(['a', 'b', 'c', 'd']);
      expect(new Set(seen).size).toBe(seen.length);
    });
  }
});

/**
 * The generated SQL is what an agent reads to self-correct, so it has to say what the source
 * actually does. A mixed `desc, asc` ordering has no single row-value form — the predicate is
 * spelled out per key, the way `@ultimat3/entity`'s driver spells it.
 */
describe('the keyset predicate', () => {
  const seek = { key: [20, 'b'], id: 'b' };

  test('a mixed ordering compiles to a real predicate, not the id tiebreak alone', () => {
    const { sql, params } = from<Post>('posts', posts)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'asc')
      .seek(seek, 2)
      .toSQL();

    // `"id" > $1` alone returns rows the descending order was already past.
    expect(sql).toContain('(("createdAt" < $1) or ("createdAt" = $2 and "id" > $3))');
    expect(params).toEqual([20, 20, 'b']);
  });

  test('the SQL and the in-memory execution agree on which rows are after a position', async () => {
    const descending = from<Post>('posts', posts).orderBy('createdAt', 'desc').orderBy('id', 'asc');
    const rows = await descending.seek({ key: [30, 'c'], id: 'c' }, 10).execute();
    // Strictly after `c` in `createdAt desc` order: `b`, then `a`. Nothing before it, no repeats.
    expect(rows.map((row) => row.id)).toEqual(['b', 'a']);
  });
});
