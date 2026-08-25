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

const chainFor = (recorded: Recorded): SearchChain<Post> => {
  const chain: SearchChain<Post> = {
    search: (term) => {
      recorded.term = term;
      return chain;
    },
    limit: (rows) => {
      recorded.limit = rows;
      return chain;
    },
    all: async () => ROWS,
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

  test('page one is served, and page TWO is refused rather than silently truncated', async () => {
    const recorded: Recorded = { term: null, limit: null };
    const searchPosts = search<Post>({
      policy: can('search:read'),
      in: () => chainFor(recorded),
    });
    registerQuery('searchPosts', searchPosts);
    const first = await paginate(searchPosts, { q: 'cats' }, { first: 2, ctx });
    expect(first.rows).toHaveLength(2);
    expect(first.endCursor).not.toBeNull();
    await expect(
      paginate(searchPosts, { q: 'cats' }, { first: 2, after: first.endCursor ?? '', ctx }),
    ).rejects.toBeInstanceOf(UltimateError);
  });
});
