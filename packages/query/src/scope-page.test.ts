// Single responsibility: a rule STRICTER than its scope never strands a row past the page — the
// cursor and `hasMore` come from the rows the source read, and a dropped row is refilled, bounded.

import { beforeEach, describe, expect, test } from 'bun:test';
import { configureCursorSigning, ctxOf, userActor } from '@ultimat3/core';
import type { Actor as PolicyActor, ScopeCondition } from '@ultimat3/policy';
import { can, scoped } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { RULE_REFILL_WINDOWS } from './page-window';
import type { Page } from './pagination';
import { paginate } from './pagination';
import { query } from './query';
import { runQuery } from './read';
import { resetQueries } from './registry';
import { matchesFilters } from './shape';
import type { RowWindow } from './source';
import { from, isAfterKey } from './source';

interface Row {
  readonly id: string;
  readonly orgId: string;
  readonly rank: number;
  readonly hidden: boolean;
}

const pad = (n: number): string => String(n).padStart(3, '0');
/** Twenty org-b rows first, then twenty org-a rows, `r025` hidden. */
const ALL: readonly Row[] = Array.from({ length: 40 }, (_, index) => ({
  id: `r${pad(index)}`,
  orgId: index < 20 ? 'org-b' : 'org-a',
  rank: index,
  hidden: index === 25,
}));
const VISIBLE_A = ALL.filter((row) => row.orgId === 'org-a' && !row.hidden).map((row) => row.id);

const reader = (orgId: string): PolicyActor => ({
  ...userActor({ id: `u-${orgId}`, orgId }),
  permissions: ['post:read'],
});
const ctxFor = (orgId: string) => ctxOf({ actor: reader(orgId) });

const rule = can<unknown, Row>(
  'post:read',
  ({ actor, row }) => row === null || (row.orgId === actor?.orgId && !row.hidden),
);
/** Narrower than nothing, wider than the rule: the hidden row reaches the rule, which drops it. */
const orgOnly = scoped(rule, (actor): readonly ScopeCondition<Row>[] => [
  { column: 'orgId', op: 'eq', value: actor?.orgId },
]);
/** No narrowing at all: every org-b row reaches an org-a reader's rule. */
const wide = scoped(rule, (): readonly ScopeCondition<Row>[] => []);

const provider =
  (seen: RowWindow[] = []) =>
  (window: RowWindow): readonly Row[] => {
    seen.push(window);
    const after = window.after;
    return ALL.filter((row) => matchesFilters(row, window.filters, () => undefined))
      .filter((row) => after === null || isAfterKey(row, after, window.order, () => undefined))
      .slice(0, window.limit ?? ALL.length);
  };

const feed = (policy: typeof orgOnly, seen: RowWindow[] = [], limit?: number) =>
  query({
    input: t.object({}),
    policy,
    sql: () => {
      const base = from<Row>('scoped_rows', provider(seen)).orderBy('rank');
      return limit === undefined ? base : base.limit(limit);
    },
  }).named('scopePage');

/** Every page to the end, the pages themselves kept: reachability is the whole question. */
async function walk(target: ReturnType<typeof feed>, first: number): Promise<Page<Row>[]> {
  const pages: Page<Row>[] = [];
  let after: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await paginate(
      target,
      {},
      {
        first,
        ctx: ctxFor('org-a'),
        ...(after === undefined ? {} : { after }),
      },
    );
    pages.push(page);
    if (page.nextCursor === null) return pages;
    after = page.nextCursor;
  }
  return expect.unreachable('the listing never ended');
}

const ids = (pages: readonly Page<Row>[]): string[] =>
  pages.flatMap((page) => page.rows.map((row) => row.id));

beforeEach(() => {
  resetQueries();
  configureCursorSigning('test-secret');
});

describe('a rule stricter than its scope', () => {
  test('the dropped probe row does not end the listing', async () => {
    const page = await paginate(
      feed(orgOnly),
      {},
      {
        first: 5,
        ctx: ctxFor('org-a'),
      },
    );

    expect(page.rows.map((row) => row.id)).toEqual(['r020', 'r021', 'r022', 'r023', 'r024']);
    expect(page.nextCursor).not.toBeNull();
  });

  test('every visible row is reachable, once, in order', async () => {
    expect(ids(await walk(feed(orgOnly), 5))).toEqual(VISIBLE_A);
    expect(ids(await walk(feed(orgOnly), 1))).toEqual(VISIBLE_A);
  });

  test('rows the rule drops are refilled from further windows to a full page', async () => {
    const seen: RowWindow[] = [];
    // Windows of sixteen: the first is all org-b, the second and third hold org-a's rows.
    const page = await paginate(
      feed(wide, seen),
      {},
      {
        first: 15,
        ctx: ctxFor('org-a'),
      },
    );

    expect(page.rows.map((row) => row.id)).toEqual(VISIBLE_A.slice(0, 15));
    expect(page.nextCursor).not.toBeNull();
    expect(seen.length).toBe(3);
  });

  test('a page the bounded refill cannot fill is short, never final', async () => {
    const seen: RowWindow[] = [];
    // Windows of three rows, every one org-b until r020: the refill gives up before org-a starts.
    const page = await paginate(
      feed(wide, seen),
      {},
      {
        first: 2,
        ctx: ctxFor('org-a'),
      },
    );

    expect(page.rows).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
    expect(seen.length).toBe(RULE_REFILL_WINDOWS + 1);
    expect(ids(await walk(feed(wide), 2))).toEqual(VISIBLE_A);
  });

  test('a declared limit counts the rows the source read, as the whole read does', async () => {
    const whole = await runQuery(feed(orgOnly, [], 10), {}, { ctx: ctxFor('org-a') });
    const paged = ids(await walk(feed(orgOnly, [], 10), 3));

    expect(paged).toEqual(whole.map((row) => (row as Row).id));
    expect(paged).toEqual(VISIBLE_A.slice(0, 9));
  });
});
