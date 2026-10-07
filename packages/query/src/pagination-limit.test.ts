// A declared `.limit()` is the size of the LISTING, and paging cannot widen it: `first` used to
// replace it outright, so `?_first=10000` walked a "top 3" to the end of the table. The bound has
// to hold on page one, on every later page, and on a source that cannot push the seek down.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CursorInvalidError,
  configureCursorSigning,
  ctxOf,
  encodeCursor,
  userActor,
} from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { Page } from './pagination';
import { paginate } from './pagination';
import type { Query } from './query';
import { query, queryHash } from './query';
import { registerQuery, resetQueries } from './registry';
import type { SqlSource } from './source';
import { from } from './source';

interface Score {
  readonly id: string;
  readonly points: number;
}

const ctx = ctxOf({
  actor: { ...userActor({ id: 'u1' }), permissions: ['score:read'] },
});

/** Ten rows, best first: `j` (100) down to `a` (10). */
const scores: readonly Score[] = 'abcdefghij'
  .split('')
  .map((id, index) => ({ id, points: (index + 1) * 10 }));

const Input = t.object({ top: t.number.int().optional() });

const leaderboard = () =>
  query({
    input: Input,
    policy: can('score:read'),
    sql: ({ top }) => {
      const ranked = from<Score>('scores', scores).orderBy('points', 'desc');
      return top === undefined ? ranked : ranked.limit(top);
    },
  });

/** The same read with no `seek()`: `paginate` slices it after execution. */
const foreignLeaderboard = () =>
  query({
    input: Input,
    policy: can('score:read'),
    sql: ({ top }): SqlSource<Score> => {
      const built = from<Score>('scores', scores)
        .orderBy('points', 'desc')
        .limit(top ?? 10);
      return {
        toSQL: () => built.toSQL(),
        shape: () => built.shape(),
        execute: () => built.execute(),
      };
    },
  });

const ids = (page: Page<Score>): string => page.rows.map((row) => row.id).join('');

/** Every page of a listing, following `nextCursor` until the read says it is over. */
async function walk(
  target: Query<typeof Input, Score, boolean>,
  input: unknown,
  first: number,
): Promise<string[]> {
  const pages: string[] = [];
  let after: string | undefined;
  for (let turn = 0; turn < 12; turn += 1) {
    const page = await paginate(target, input, {
      first,
      ctx,
      ...(after === undefined ? {} : { after }),
    });
    pages.push(ids(page));
    if (page.nextCursor === null) return pages;
    after = page.nextCursor;
  }
  return pages;
}

describe('a declared limit bounds the listing a page is cut from', () => {
  beforeEach(() => {
    resetQueries();
    configureCursorSigning('test-secret');
  });

  test('a page wider than the limit serves the limit, and says nothing follows', async () => {
    const target = leaderboard();
    registerQuery('leaderboard', target);
    const page = await paginate(target, { top: 3 }, { first: 5, ctx });
    expect(ids(page)).toBe('jih');
    expect(page.hasMore).toBe(false);
  });

  test('the largest page a route accepts still serves only the limit', async () => {
    const target = leaderboard();
    registerQuery('leaderboard', target);
    const page = await paginate(target, { top: 3 }, { first: 10_000, ctx });
    expect(ids(page)).toBe('jih');
  });

  test('a page exactly the limit wide has no next page and no cursor; a spent one reads nothing', async () => {
    const target = leaderboard();
    registerQuery('leaderboard', target);
    const page = await paginate(target, { top: 3 }, { first: 3, ctx });
    expect(ids(page)).toBe('jih');
    expect(page.hasMore).toBe(false);
    // 25.0.0: the last page hands back no cursor. One that says the whole limit is spent — kept
    // from an earlier build, which minted it here — still answers an empty last page.
    expect(page.nextCursor).toBeNull();
    const spent = encodeCursor({
      scope: queryHash('leaderboard', { top: 3 }),
      key: [80, 'h', 3],
      id: 'h',
    });
    const next = await paginate(target, { top: 3 }, { first: 3, after: spent, ctx });
    expect(next.rows).toEqual([]);
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeNull();
  });

  test('small pages walk the limit and stop at it — a cursor cannot page past the top N', async () => {
    const target = leaderboard();
    registerQuery('leaderboard', target);
    // `hasMore` is about the LISTING: after `ji` one row of the top three is left.
    const one = await paginate(target, { top: 3 }, { first: 2, ctx });
    expect(ids(one)).toBe('ji');
    expect(one.hasMore).toBe(true);
    const two = await paginate(target, { top: 3 }, { first: 2, after: one.nextCursor ?? '', ctx });
    expect(ids(two)).toBe('h');
    expect(two.hasMore).toBe(false);
    // The walk stops ON the last page: no empty page is fetched to learn the listing ended.
    expect(await walk(target, { top: 3 }, 2)).toEqual(['ji', 'h']);
    expect(await walk(target, { top: 5 }, 1)).toEqual(['j', 'i', 'h', 'g', 'f']);
  });

  test('Builder.seek() takes the smaller of the two limits, in the SQL and in the rows', async () => {
    const top = from<Score>('scores', scores).orderBy('points', 'desc').limit(3);
    expect(top.seek(null, 10).toSQL().sql).toEndWith(' limit 3');
    expect(await top.seek(null, 10).execute()).toHaveLength(3);
    expect(top.seek(null, 2).toSQL().sql).toEndWith(' limit 2');
    expect(await top.seek(null, 2).execute()).toHaveLength(2);
  });

  test('a source with no seek() is bounded the same way', async () => {
    const target = foreignLeaderboard();
    registerQuery('foreignLeaderboard', target);
    expect(await walk(target, { top: 3 }, 2)).toEqual(['ji', 'h']);
    const wide = await paginate(target, { top: 3 }, { first: 9, ctx });
    expect(ids(wide)).toBe('jih');
    expect(wide.hasMore).toBe(false);
  });

  test('a read with no limit pages to the end of its rows, as it always has', async () => {
    const target = leaderboard();
    registerQuery('leaderboard', target);
    expect(await walk(target, {}, 4)).toEqual(['jihg', 'fedc', 'ba']);
  });

  test('a cursor that does not say how much of the limit is spent is X_CURSOR_INVALID', async () => {
    // The shape a cursor had before the limit bounded a listing: sort key, then the typed id.
    // Honouring it would hand its bearer a fresh top three starting below the real one.
    const target = leaderboard();
    registerQuery('leaderboard', target);
    const stale = encodeCursor({
      scope: queryHash('leaderboard', { top: 3 }),
      key: [80, 'h'],
      id: 'h',
    });
    const refused = paginate(target, { top: 3 }, { first: 3, after: stale, ctx });
    await expect(refused).rejects.toBeInstanceOf(CursorInvalidError);
  });
});
