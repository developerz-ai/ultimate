// Single responsibility: a `scoped()` policy's predicate is composed into the read BEFORE the page
// is cut, so a viewer with hidden rows ahead of their visible ones still gets a full page — and the
// JS rule, the authority, still runs on every row the source returns.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { isolateTiers, lruTier, registerTier, resetTiers } from '@ultimat3/cache';
import { configureCursorSigning, ctxOf, userActor } from '@ultimat3/core';
import type { Actor as PolicyActor, ScopeCondition } from '@ultimat3/policy';
import { can, scoped } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { paginate } from './pagination';
import { query } from './query';
import { runQuery, sourceFor } from './read';
import { resetQueries } from './registry';
import { matchesFilters } from './shape';
import type { RowWindow, SqlSource } from './source';
import { from, isAfterKey } from './source';

interface Row {
  readonly id: string;
  readonly orgId: string;
  readonly rank: number;
  readonly hidden: boolean;
}

const pad = (n: number): string => String(n).padStart(3, '0');
/** Twenty org-b rows FIRST in the order, then twenty org-a rows: the over-fetch worst case. */
const ALL: readonly Row[] = Array.from({ length: 40 }, (_, index) => ({
  id: `r${pad(index)}`,
  orgId: index < 20 ? 'org-b' : 'org-a',
  rank: index,
  hidden: index === 25,
}));

const reader = (orgId: string): PolicyActor => ({
  ...userActor({ id: `u-${orgId}`, orgId }),
  permissions: ['post:read'],
});
const ctxFor = (orgId: string) => ctxOf({ actor: reader(orgId) });

/** The rule: the row's org is the reader's, and a hidden row is nobody's. Row-less: the gate. */
const rule = can<unknown, Row>(
  'post:read',
  ({ actor, row }) => row === null || (row.orgId === actor?.orgId && !row.hidden),
);
/** The rule's exact projection: the reader's org, never a hidden row. */
const byOrg = scoped(rule, (actor): readonly ScopeCondition<Row>[] => [
  { column: 'hidden', op: 'eq', value: false },
  { column: 'orgId', op: 'eq', value: actor?.orgId },
]);

/** A repository-shaped provider: pushes the filters, the cursor and the window down. */
const pushedDown =
  (seen: RowWindow[] = []) =>
  (window: RowWindow): readonly Row[] => {
    seen.push(window);
    const after = window.after;
    return ALL.filter((row) => matchesFilters(row, window.filters, () => undefined))
      .filter((row) => after === null || isAfterKey(row, after, window.order, () => undefined))
      .slice(0, window.limit ?? ALL.length);
  };

const feed = (policy = byOrg, provider = pushedDown()) =>
  query({
    input: t.object({}),
    policy,
    sql: () => from<Row>('scoped_rows', provider).orderBy('rank'),
  }).named('scopedFeed');

let restoreTiers: (() => void) | undefined;

beforeEach(() => {
  resetQueries();
  configureCursorSigning('test-secret');
  restoreTiers?.();
  restoreTiers = isolateTiers();
  resetTiers();
  registerTier(lruTier());
});

afterAll(() => {
  restoreTiers?.();
});

describe('a scoped policy composed into the read', () => {
  test('a full page when hidden rows precede the visible ones', async () => {
    const page = await paginate(feed(), {}, { first: 10, ctx: ctxFor('org-a') });

    expect(page.rows.map((row) => row.id)).toEqual([
      'r020',
      'r021',
      'r022',
      'r023',
      'r024',
      'r026',
      'r027',
      'r028',
      'r029',
      'r030',
    ]);
    expect(page.nextCursor).not.toBeNull();
  });

  test('the provider is handed the scope as a filter', async () => {
    const seen: RowWindow[] = [];
    await paginate(feed(byOrg, pushedDown(seen)), {}, { first: 5, ctx: ctxFor('org-b') });

    expect(seen[0]?.filters).toEqual([
      { column: 'hidden', op: '=', value: false },
      { column: 'orgId', op: '=', value: 'org-b' },
    ]);
  });

  test('the rule still runs on every returned row', async () => {
    // A scope WIDER than its rule — every row of the org, hidden or not: the rule drops `r025`.
    const orgOnly = scoped(rule, (actor): readonly ScopeCondition<Row>[] => [
      { column: 'orgId', op: 'eq', value: actor?.orgId },
    ]);
    const rows = await runQuery(feed(orgOnly), {}, { ctx: ctxFor('org-a') });

    expect(rows.map((row) => (row as Row).id)).not.toContain('r025');
    expect(rows.length).toBe(19);
  });

  test('a scope that admits a row the rule refuses still never serves it', async () => {
    const wide = scoped(rule, (): readonly ScopeCondition<Row>[] => []);
    const rows = await runQuery(feed(wide), {}, { ctx: ctxFor('org-b') });

    expect(rows.every((row) => (row as Row).orgId === 'org-b')).toBe(true);
    expect(rows.length).toBe(20);
  });

  test('a cache shared across actors is keyed per actor once a scope decides the rows', async () => {
    const target = query({
      input: t.object({}),
      policy: byOrg,
      cache: { tags: [{ entity: 'scoped_rows' }], scope: 'global', ttlMs: 60_000 },
      sql: () => from<Row>('scoped_rows', pushedDown()).orderBy('rank'),
    }).named('scopedCached');

    const a = await runQuery(target, {}, { ctx: ctxFor('org-a') });
    const b = await runQuery(target, {}, { ctx: ctxFor('org-b') });

    expect(a.every((row) => (row as Row).orgId === 'org-a')).toBe(true);
    expect(b.every((row) => (row as Row).orgId === 'org-b')).toBe(true);
  });

  test('an unenforced build composes no scope: it has no subject to scope by', async () => {
    const source = await sourceFor(
      feed(),
      {},
      { ctx: ctxFor('org-a'), unenforced: 'explain prints the shape' },
    );

    expect(source.toSQL().sql).toBe('select * from "scoped_rows" order by "rank" asc nulls last');
  });

  test('a scope over a source that cannot take a predicate is refused, not dropped', async () => {
    const opaque: SqlSource<Row> = {
      toSQL: () => ({ sql: 'select 1', params: [] }),
      execute: async () => ALL,
      shape: () => ({
        entity: 'scoped_rows',
        filters: [],
        orderBy: [],
        limit: null,
        unsupported: [],
      }),
    };
    const target = query({ input: t.object({}), policy: byOrg, sql: () => opaque }).named(
      'scopedOpaque',
    );

    try {
      await runQuery(target, {}, { ctx: ctxFor('org-a') });
      expect.unreachable('a scope the source cannot take must refuse the read');
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe('X_QUERY_SCOPE_UNCOMPOSABLE');
    }
  });
});
