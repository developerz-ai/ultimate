import { beforeEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { QueryDef } from './query';
import { isQuery, query, runQuery, sourceFor } from './query';
import { describeQueries, registerQueries, registerQuery, resetRegistry } from './registry';
import { from } from './source';
import { explain } from './sql';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: number;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const Input = t.object({ orgId: t.uuid });
const readerActor = { ...userActor({ id: 'u1' }), permissions: ['feed:read'] };
const member = createContext({ actor: readerActor });
const anonymous = createContext({});

const posts: readonly Post[] = [
  { id: 'a', orgId: ORG, createdAt: 10 },
  { id: 'b', orgId: '00000000-0000-4000-8000-000000000002', createdAt: 20 },
];

const defineFeed = () =>
  query({
    input: Input,
    policy: can('feed:read'),
    live: true,
    sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }).orderBy('createdAt').limit(50),
  });

describe('query', () => {
  beforeEach(() => {
    resetRegistry();
  });

  test('the declaration is lifted onto the query and `sql` is not reachable', () => {
    const feed = registerQuery('orgFeed', defineFeed());
    expect('def' in feed).toBe(false);
    expect(feed.input).toBe(Input);
    expect(feed.isLive).toBe(true);
    expect(feed.policy.label).toBe('feed:read');
  });

  test('registration names the query in place, so the module export projects', () => {
    // The bug this pins: handing back a differently-named twin leaves
    // `import { liveFeed } from './live'` unnamed, so every projection on it throws
    // X_QUERY_UNREGISTERED after boot while the registry's copy works fine.
    const declared = defineFeed();
    const registered = registerQuery('orgFeed', declared);
    expect(registered).toBe(declared);
    expect(declared.name).toBe('orgFeed');
    expect(declared.tool().query).toBe('orgFeed');
  });

  test('naming an already-named query twins it instead of renaming in place', () => {
    const declared = registerQuery('orgFeed', defineFeed());
    const twin = registerQuery('archiveFeed', declared);
    expect(twin).not.toBe(declared);
    expect(declared.name).toBe('orgFeed');
    expect(twin.name).toBe('archiveFeed');
  });

  test('a look-alike is not a query, so it never reaches the registry', () => {
    // Only `query()` stashes a declaration, so only `query()` can produce something with a
    // `sql` to run. An object that merely says `kind: 'query'` has none.
    const impostor = Object.assign(() => Promise.resolve([]), { kind: 'query' as const });
    expect(isQuery(impostor)).toBe(false);
    expect(registerQueries({ impostor })).toEqual([]);
  });

  test('returns rows and infers the row type from the source', async () => {
    const feed = registerQuery('orgFeed', defineFeed());
    const rows = await runQuery(feed, { orgId: ORG }, { ctx: member });
    expect(rows.map((row) => row.id)).toEqual(['a']);
  });

  test('an anonymous actor is denied before any SQL runs', async () => {
    const feed = registerQuery('orgFeed', defineFeed());
    const failure = await runQuery(feed, { orgId: ORG }, { ctx: anonymous }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
  });

  test('garbage input is X_INPUT_INVALID', async () => {
    const feed = registerQuery('orgFeed', defineFeed());
    const failure = await runQuery(feed, { orgId: 'nope' }, { ctx: member }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_INPUT_INVALID');
  });

  test('a duplicate name is X_QUERY_DUPLICATE', () => {
    registerQuery('orgFeed', defineFeed());
    let code: unknown;
    try {
      registerQuery('orgFeed', defineFeed());
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_QUERY_DUPLICATE');
  });

  test('a query without a policy fails at registration', () => {
    const unguarded = query({
      input: Input,
      sql: () => from<Post>('posts', posts),
    } as unknown as QueryDef<typeof Input, Post>);
    let code: unknown;
    try {
      registerQuery('orgFeed', unguarded);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_QUERY_POLICY_MISSING');
  });

  test('the manifest lists queries name-sorted with their live flag', () => {
    registerQueries({ orgFeed: defineFeed(), archiveFeed: defineFeed() });
    expect(describeQueries().map((entry) => entry.name)).toEqual(['archiveFeed', 'orgFeed']);
    expect(describeQueries()[0]?.live).toBe(true);
  });

  test('enforce:false skips the policy and nothing else — the shape `x g query` emits', async () => {
    const feed = defineFeed().named('orgFeed');
    const source = await sourceFor(feed, { orgId: ORG }, { ctx: anonymous, enforce: false });
    expect(source.toSQL().sql).toContain('order by');

    // The input is still parsed: a scaffolded test that passes garbage must go red.
    const failure = await sourceFor(
      feed,
      { orgId: 'nope' },
      {
        ctx: anonymous,
        enforce: false,
      },
    ).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe('X_INPUT_INVALID');
  });

  test('explain exposes the generated SQL so an agent can self-correct', async () => {
    const feed = registerQuery('orgFeed', defineFeed());
    const explained = await explain(feed, { orgId: ORG }, member);
    expect(explained.sql).toBe(
      'select * from "posts" where "orgId" = $1 order by "createdAt" asc limit 50',
    );
    expect(explained.params).toEqual([ORG]);
  });
});
