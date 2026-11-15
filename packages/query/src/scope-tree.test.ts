// Single responsibility: a scoped policy's TREE (`or` groups, `via` hops) composed into a read. The
// provider is handed the nodes and pushes them into one entity statement; the builder re-applies
// what a row can answer; and where nothing can take the tree — a live read, a list of rows under a
// hop — the read is refused rather than served unscoped.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureCursorSigning, ctxOf, isUltimateError, userActor } from '@ultimat3/core';
import { recordingClient, setDbClient } from '@ultimat3/db';
import { clearRegistry, database, entity, postgresDriver, text, uuid } from '@ultimat3/entity';
import type { Actor as PolicyActor, ScopeNode } from '@ultimat3/policy';
import { can, scoped } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { runQuery, sourceFor } from './read';
import { resetQueries } from './registry';
import type { RowWindow } from './source';
import { from } from './source';

interface Row {
  readonly id: string;
  readonly authorId: string;
  readonly audience: string;
}

const ME = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';
const ROWS: readonly Row[] = [
  { id: 'r1', authorId: ME, audience: 'private' },
  { id: 'r2', authorId: OTHER, audience: 'private' },
  { id: 'r3', authorId: OTHER, audience: 'public' },
];

const reader: PolicyActor = {
  ...userActor({ id: ME, orgId: 'org-a' }),
  permissions: ['post:read'],
};
const ctx = () => ctxOf({ actor: reader });
const rule = can<unknown, Row>('post:read');

const mineOrPublic = scoped(rule, (actor): readonly ScopeNode<Row>[] => [
  {
    or: [
      { column: 'authorId', op: 'eq', value: actor?.id },
      { column: 'audience', op: 'eq', value: 'public' },
    ],
  },
]);
const friendsOnly = scoped(rule, (actor): readonly ScopeNode<Row>[] => [
  {
    via: { column: 'authorId', entity: 'scope_tree_friends', target: 'friendId' },
    where: [{ column: 'userId', op: 'eq', value: actor?.id }],
  },
]);

const read = (policy: typeof mineOrPublic, sql: () => ReturnType<typeof from<Row>>, name: string) =>
  query({ input: t.object({}), policy, sql }).named(name);

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : `uncoded: ${String(error)}`;
  }
};

beforeEach(() => {
  resetQueries();
  configureCursorSigning('test-secret');
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

describe('an or scope', () => {
  test('a list of rows is narrowed in memory by the group', async () => {
    const rows = await runQuery(
      read(mineOrPublic, () => from<Row>('t', ROWS), 'orList'),
      {},
      {
        ctx: ctx(),
      },
    );
    expect(rows.map((row) => (row as Row).id)).toEqual(['r1', 'r3']);
  });

  test('a provider is handed the group on window.nodes, and its answer is re-checked', async () => {
    const seen: RowWindow[] = [];
    const provider = (window: RowWindow) => {
      seen.push(window);
      return ROWS;
    };
    const rows = await runQuery(
      read(mineOrPublic, () => from<Row>('t', provider), 'orFn'),
      {},
      {
        ctx: ctx(),
      },
    );
    // `ScopedNode` is branded; the tree compared is the plain one the policy declared.
    const handed: unknown = seen[0]?.nodes;
    expect(handed).toEqual([
      {
        or: [
          { column: 'authorId', op: 'eq', value: ME },
          { column: 'audience', op: 'eq', value: 'public' },
        ],
      },
    ]);
    expect(rows.map((row) => (row as Row).id)).toEqual(['r1', 'r3']);
  });

  test('the SQL text names the group, so explain prints what the provider is asked', async () => {
    const source = await sourceFor(
      read(mineOrPublic, () => from<Row>('t', ROWS), 'orSql'),
      {},
      {
        ctx: ctx(),
      },
    );
    expect(source.toSQL().sql).toBe('select * from "t" where ("authorId" = $1 or "audience" = $2)');
  });

  test('a live read over a tree is refused — the matcher patches a flat shape', async () => {
    const target = read(mineOrPublic, () => from<Row>('t', ROWS), 'orLive');
    expect(await codeOf(() => sourceFor(target, {}, { ctx: ctx(), surface: 'live' }))).toBe(
      'X_QUERY_SCOPE_UNCOMPOSABLE',
    );
  });
});

describe('an and scope', () => {
  test('is a conjunction, not a tree: flattened into filters, so a live read takes it', async () => {
    const both = scoped(rule, (actor): readonly ScopeNode<Row>[] => [
      {
        and: [
          { column: 'authorId', op: 'eq', value: actor?.id },
          { and: [{ column: 'audience', op: 'eq', value: 'private' }] },
        ],
      },
    ]);
    const target = read(both, () => from<Row>('t', ROWS), 'andLive');
    const source = await sourceFor(target, {}, { ctx: ctx(), surface: 'live' });
    expect(source.shape().filters).toEqual([
      { column: 'authorId', op: '=', value: ME },
      { column: 'audience', op: '=', value: 'private' },
    ]);
    expect(source.shape().unsupported).toEqual([]);
  });
});

describe('a via scope', () => {
  test('over a list of rows it is refused: there is no statement to run the hop in', async () => {
    const target = read(friendsOnly, () => from<Row>('t', ROWS), 'viaList');
    expect(await codeOf(() => runQuery(target, {}, { ctx: ctx() }))).toBe(
      'X_QUERY_SCOPE_UNCOMPOSABLE',
    );
  });

  test('pushed into the entity chain it is ONE statement, the hop a subselect', async () => {
    const posts = entity('scope_tree_posts', {
      columns: { id: uuid().primaryKey(), authorId: uuid(), audience: text({ max: 10 }) },
    });
    entity('scope_tree_friends', {
      columns: { id: uuid().primaryKey(), userId: uuid(), friendId: uuid() },
    });
    const client = recordingClient();
    setDbClient(client);
    const db = database({ posts }, { driver: postgresDriver() });
    const provider = async (window: RowWindow): Promise<readonly Row[]> => {
      let chain = db.posts.orderBy('id').limit(window.limit ?? 50);
      for (const node of window.nodes ?? []) chain = chain.andWhereNode(node);
      return chain.all();
    };
    await runQuery(
      read(friendsOnly, () => from<Row>('scope_tree_posts', provider), 'viaDb'),
      {},
      {
        ctx: ctx(),
      },
    );
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]?.text).toContain(
      '"author_id" in (select "friend_id" from "scope_tree_friends" where "user_id" = $1)',
    );
  });
});
