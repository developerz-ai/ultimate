import { beforeEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { QueryDef } from './query';
import { query, runQuery } from './query';
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

  test('explain exposes the generated SQL so an agent can self-correct', async () => {
    const feed = registerQuery('orgFeed', defineFeed());
    const explained = await explain(feed, { orgId: ORG }, member);
    expect(explained.sql).toBe(
      'select * from "posts" where "orgId" = $1 order by "createdAt" asc limit 50',
    );
    expect(explained.params).toEqual([ORG]);
  });
});
