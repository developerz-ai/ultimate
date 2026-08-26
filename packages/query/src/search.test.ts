import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureCursorSigning, createContext, UltimateError, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { paginate } from './pagination';
import { describeQuery, isQuery } from './query';
import { runQuery } from './read';
import { registerQuery, resetRegistry } from './registry';
import type { SearchChain } from './search';
import { search } from './search';

interface Post {
  readonly id: string;
  readonly title: string;
}

const ROWS: readonly Post[] = [
  { id: 'a', title: 'cats and dogs' },
  { id: 'b', title: 'running a database' },
  { id: 'c', title: 'quiet mornings' },
];

/** What the entity chain does, recorded — this test is about the FACTORY, not about Postgres. */
interface Recorded {
  term: string | null;
  limit: number | null;
}

/**
 * A relevance ordering, which is what a real `.searchable()` chain serves and what no key in this
 * layer's `QueryShape` can name. Deliberately NOT id-ascending: `ROWS` is `a, b, c`, so a wrapper
 * that re-sorts by the id tiebreak is invisible against it — the shape that let `.page()` ship
 * returning different rows from `runQuery` for the same window.
 */
const RANKED: readonly Post[] = [
  { id: 'z', title: 'cats, mostly' },
  { id: 'm', title: 'cats and dogs' },
  { id: 'a', title: 'a passing mention of cats' },
];

const chainFor = (recorded: Recorded, rows: readonly Post[] = ROWS): SearchChain<Post> => {
  const chain: SearchChain<Post> = {
    search: (term) => {
      recorded.term = term;
      return chain;
    },
    limit: (count) => {
      recorded.limit = count;
      return chain;
    },
    // The fixture HONOURS `limit`, because a real chain does and `.page()`'s "there is no next
    // page" rests on it: `search()` caps the read at `limit` rows, so a window that covers
    // `limit` covers everything. A fixture that ignored the contract it stands in for would let
    // the wart back in under a green test.
    all: async () => rows.slice(0, recorded.limit ?? rows.length),
    plan: () => ({ entity: 'posts' }),
  };
  return chain;
};

const reader = { ...userActor({ id: 'u1' }), permissions: ['search:read'] };
const ctx = createContext({ actor: reader });

beforeEach(() => {
  resetRegistry();
  configureCursorSigning('test-secret');
});

afterEach(() => {
  resetRegistry();
});

describe('search()', () => {
  test('returns a query — never a ninth primitive', () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
    });
    registerQuery('searchPosts', searchPosts);
    expect(isQuery(searchPosts)).toBe(true);
    const described = describeQuery(searchPosts);
    expect(described.kind).toBe('query');
    expect(described.live).toBe(false);
  });

  test('hands the term to the chain and never interprets it', async () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
    });
    registerQuery('searchPosts', searchPosts);
    const rows = await runQuery(searchPosts, { q: 'cats & dogs' }, { ctx });
    expect(recorded.term).toBe('cats & dogs');
    expect(recorded.limit).toBe(20);
    expect(rows).toHaveLength(3);
  });

  test('bounds the page in the input schema, so an unbounded one cannot be asked for', async () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
      page: { max: 25, default: 5 },
    });
    registerQuery('searchPosts', searchPosts);
    await runQuery(searchPosts, { q: 'x' }, { ctx });
    expect(recorded.limit).toBe(5);
    await expect(runQuery(searchPosts, { q: 'x', limit: 26 }, { ctx })).rejects.toBeInstanceOf(
      UltimateError,
    );
  });

  test('a blank term is refused where it is written, never sent as a match nothing can use', async () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
    });
    registerQuery('searchPosts', searchPosts);
    await expect(runQuery(searchPosts, { q: '   ' }, { ctx })).rejects.toBeInstanceOf(
      UltimateError,
    );
    expect(recorded.term).toBeNull();
  });

  test('the app keys ride beside q, and reach the chain', async () => {
    const recorded: Recorded = { term: null, limit: null };
    const seen: { org: string | null } = { org: null };
    const searchPosts = search({
      input: { orgId: t.string },
      policy: can('search:read'),
      in: ({ input }) => {
        seen.org = input.orgId;
        return chainFor(recorded);
      },
    });
    registerQuery('searchPosts', searchPosts);
    await runQuery(searchPosts, { q: 'cats', orgId: 'org-1' }, { ctx });
    expect(seen.org).toBe('org-1');
  });

  test('a window narrower than the read is served, not refused — page one is answerable', async () => {
    // `first` is client-supplied on essentially every cursor API (`{ first: query.pageSize }`) and
    // `limit` defaults to 20, so a screen demanding `first >= limit` refuses the framework's OWN
    // default pair: 500 at page ONE for a window this read answers completely. The read fetched 3
    // rows, the caller asked for 10, and everything the read holds is on this page.
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
    });
    registerQuery('searchPosts', searchPosts);
    const page = await paginate(searchPosts, { q: 'cats' }, { first: 10, ctx });
    expect(page.rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    // Nothing was cut, so there is no next page to advertise and no cursor a second call throws on.
    expect(page.hasNextPage).toBe(false);
  });

  test('a window the read OVERFLOWS is refused — the rest would be on no page at all', async () => {
    // The read answered 3 rows and the caller asked for 2. There is no page two to carry the
    // third, so serving this page would put it on no page at all — the defect 12.0.0 spent a
    // release removing from the timestamp seek, arriving through a different door.
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
    });
    registerQuery('searchPosts', searchPosts);
    const refused = paginate(searchPosts, { q: 'cats' }, { first: 2, ctx });
    await expect(refused).rejects.toBeInstanceOf(UltimateError);
    const caught = await refused.catch((thrown: unknown) => thrown);
    // Both edits, spelled out — widen the window, or narrow the read's own page.
    const instruction = caught instanceof UltimateError ? caught.fix : '';
    expect(instruction).toContain('first: 20');
    expect(instruction).toContain('limit: 2');
    expect(caught instanceof UltimateError ? caught.code : '').toBe('X_INVARIANT');
  });

  test('a window that COVERS the read page serves it whole and advertises no next page', async () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
    });
    registerQuery('searchPosts', searchPosts);
    const page = await paginate(searchPosts, { q: 'cats', limit: 3 }, { first: 3, ctx });
    expect(page.rows).toHaveLength(3);
    // The pair that invited a call this read refuses. `hasNextPage` can only be false on a search
    // page now, so a cursor client stops here instead of being handed a cursor page two throws on.
    expect(page.hasNextPage).toBe(false);
    expect(page.endCursor).not.toBeNull();
  });

  test('a cursor handed back is still refused — one page, and no second', async () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
    });
    registerQuery('searchPosts', searchPosts);
    const page = await paginate(searchPosts, { q: 'cats', limit: 3 }, { first: 3, ctx });
    const second = paginate(
      searchPosts,
      { q: 'cats', limit: 3 },
      { first: 3, after: page.endCursor ?? '', ctx },
    );
    await expect(second).rejects.toBeInstanceOf(UltimateError);
    // The CURSOR is what is refused, and the assertion says so: this window fits, so a bare
    // `rejects` here would pass just as happily on the overflow refusal beside it and stop pinning
    // the property it was written for.
    const caught = await second.catch((thrown: unknown) => thrown);
    expect(caught instanceof UltimateError ? caught.cause : '').toContain(
      'no cursor this layer can carry',
    );
  });

  test('a window the read exactly FILLS is served — the refusal is on the cut, not on the numbers', async () => {
    // Two rows, a window of two, and a `limit` of 20 the caller never touched. Nothing is cut, so
    // there is nothing to refuse — a screen comparing `first` against `limit` refuses this.
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded, ROWS.slice(0, 2)),
    });
    registerQuery('searchPosts', searchPosts);
    const page = await paginate(searchPosts, { q: 'cats' }, { first: 2, ctx });
    expect(page.rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(page.hasNextPage).toBe(false);
  });

  test(".page() serves the chain's own order — the top row is never sorted off page one", async () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded, RANKED),
    });
    registerQuery('searchPosts', searchPosts);

    const served = await runQuery(searchPosts, { q: 'cats', limit: 2 }, { ctx });
    expect(served.map((row) => row.id)).toEqual(['z', 'm']);

    const page = await paginate(searchPosts, { q: 'cats', limit: 2 }, { first: 2, ctx });
    // The rows `runQuery` answers, in that order — not a different two in a different order.
    expect(page.rows.map((row) => row.id)).toEqual(['z', 'm']);
    expect(page.rows.map((row) => row.id)).toEqual(served.map((row) => row.id));
    expect(page.hasNextPage).toBe(false);
  });

  test('.page() serves every row when the chain returns fewer than the window', async () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded, RANKED),
    });
    registerQuery('searchPosts', searchPosts);
    const page = await paginate(searchPosts, { q: 'cats', limit: 3 }, { first: 5, ctx });
    expect(page.rows.map((row) => row.id)).toEqual(['z', 'm', 'a']);
    expect(page.hasNextPage).toBe(false);
  });
});
