// Single responsibility: a `from(entity, fn)` provider is HANDED the window it is asked for —
// `{ after, limit, order, filters }` — so a provider that reads a window (a repository's top N)
// can push the cursor down instead of serving the same N rows on every page. Before it was
// called with nothing: rows past its window were unreachable and page two came back short.

import { beforeEach, describe, expect, test } from 'bun:test';
import { configureCursorSigning, ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { paginate } from './pagination';
import { query } from './query';
import { resetQueries } from './registry';
import type { RowWindow } from './source';
import { from, isAfterKey } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly rank: number;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const ctx = ctxOf({ actor: userActor({ id: 'u1' }) });
const ALL: readonly Post[] = Array.from({ length: 100 }, (_, index) => ({
  id: `p${String(index).padStart(3, '0')}`,
  orgId: ORG,
  rank: index,
}));

/** A repository-shaped provider: never more than `cap` rows, the window it was asked for. */
const windowed =
  (cap: number, seen: RowWindow[]) =>
  (window: RowWindow): readonly Post[] => {
    seen.push(window);
    const after = window.after;
    const past =
      after === null
        ? ALL
        : ALL.filter((row) => isAfterKey(row, after, window.order, () => undefined));
    return past.slice(0, Math.min(cap, window.limit ?? cap));
  };

const feedOver = (provider: (window: RowWindow) => readonly Post[]) =>
  query({
    input: t.object({ orgId: t.uuid }),
    policy: allow(),
    sql: ({ orgId }) => from<Post>('posts', provider).where({ orgId }).orderBy('rank'),
  }).named('windowFeed');

describe('a windowed RowProvider under paginate', () => {
  beforeEach(() => {
    resetQueries();
    configureCursorSigning('test-secret');
  });

  test('a window-honouring top-20 provider walks all 100 rows over 10 pages', async () => {
    const feed = feedOver(windowed(20, []));
    const served: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await paginate(
        feed,
        { orgId: ORG },
        { first: 10, ctx, ...(after === undefined ? {} : { after }) },
      );
      served.push(...page.rows.map((row) => row.id));
      after = page.nextCursor ?? undefined;
      pages += 1;
    } while (after !== undefined && pages < 20);

    expect(pages).toBe(10);
    expect(served).toEqual(ALL.map((row) => row.id));
  });

  test('page two hands the provider the cursor, the window and the served order', async () => {
    const seen: RowWindow[] = [];
    const feed = feedOver(windowed(20, seen));
    const first = await paginate(feed, { orgId: ORG }, { first: 10, ctx });
    await paginate(feed, { orgId: ORG }, { first: 10, ctx, after: first.nextCursor ?? '' });

    const second = seen[1];
    expect(second?.after).toEqual({ key: [9], id: 'p009' });
    expect(second?.limit).toBe(11);
    expect(second?.order).toEqual([
      { column: 'rank', direction: 'asc' },
      { column: 'id', direction: 'asc' },
    ]);
    expect(second?.filters).toEqual([{ column: 'orgId', op: '=', value: ORG }]);
  });

  test('a provider that ignores the window still pages as it always did', async () => {
    const feed = feedOver(() => ALL.slice(0, 20));
    const first = await paginate(feed, { orgId: ORG }, { first: 10, ctx });
    const second = await paginate(
      feed,
      { orgId: ORG },
      { first: 10, ctx, after: first.nextCursor ?? '' },
    );

    expect(second.rows.map((row) => row.id)).toEqual(ALL.slice(10, 20).map((row) => row.id));
    expect(second.nextCursor).toBeNull();
  });
});
