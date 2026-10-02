/**
 * One name per query, on every surface. A descriptor that spells the tool
 * differently from the name `tools/call` accepts is a tool nothing can reach.
 */

import { describe, expect, test } from 'bun:test';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryTool, toQueryTools } from './mcp-tool';
import type { Query } from './query';
import { query } from './query';
import { queryName } from './read';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
}

const Input = t.object({ orgId: t.uuid });
const posts: readonly Post[] = [{ id: 'a', orgId: '00000000-0000-4000-8000-000000000001' }];

/** `named` stands in for registration: a projection needs a name, nothing more. */
function defineRead(name: string) {
  return query({
    input: Input,
    policy: can('feed:read'),
    mcp: { expose: true },
    sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }),
  }).named(name);
}

describe('the MCP read descriptor', () => {
  test('the tool name is the export name VERBATIM, never a second spelling', () => {
    // `@ultimat3/mcp` serves a query under `queryName(target)` and answers `tools/call` for
    // nothing else, so anything reading the name off this descriptor must get the same string.
    // A snake_cased descriptor named a tool the server has never heard of.
    const target = defineRead('liveFeed');
    expect(toQueryTool(target).name).toBe('liveFeed');
    expect(toQueryTool(target).name).toBe(queryName(target));
  });

  test('`name` and `query` are the one name, not two derivations of it', () => {
    const target = defineRead('publicPostSlugs');
    const tool = toQueryTool(target);
    expect(tool.name).toBe(tool.query);
    expect(tool.name).toBe('publicPostSlugs');
  });

  test('a single-word read is untouched, and the description falls back to the name', () => {
    const tool = toQueryTool(defineRead('feed'));
    expect(tool.name).toBe('feed');
    expect(tool.description).toBe('feed');
    expect(tool.mutates).toBe(false);
  });

  test('the catalog is sorted by the served name', () => {
    const tools = toQueryTools([defineRead('publicPostSlugs'), defineRead('liveFeed')]);
    expect(tools.map((tool) => tool.name)).toEqual(['liveFeed', 'publicPostSlugs']);
  });
});

describe('a single: true read as a tool', () => {
  const input = t.object({ id: t.string });
  const sql = ({ id }: { readonly id: string }) =>
    from<Post>('posts', posts).where({ id }).limit(1);
  /** Two declarations, not one with a spread: `single` is part of the query's TYPE. */
  function byId(single: true): Query<typeof input, Post, true>;
  function byId(single: false): Query<typeof input, Post, false>;
  function byId(single: boolean) {
    return single
      ? query({ input, policy: allow('public'), mcp: { expose: true }, single: true, sql }).named(
          'postById',
        )
      : query({ input, policy: allow('public'), mcp: { expose: true }, sql }).named('postById');
  }

  test('answers the ROW, as the route does — never a one-row array', async () => {
    const answer = await toQueryTool(byId(true)).read({ id: 'a' }, { actor: null });
    expect(answer).toEqual(posts[0] as object);
  });

  test('no row is X_NOT_FOUND, as the route answers 404 — never an empty array', async () => {
    const miss = toQueryTool(byId(true)).read({ id: 'missing' }, { actor: null });
    await expect(miss).rejects.toBeUltimateError('X_NOT_FOUND');
  });

  test('the answer is TYPED by the declaration: a list read is an array, a single read is not', async () => {
    // Checked by `scripts/test-typecheck-gate.ts`, which compiles this file: a known list read
    // typed as `rows | row` made `.map` on its own tool's answer a compile error.
    const rows = await toQueryTool(byId(false)).read({ id: 'a' }, { actor: null });
    expect(rows.map((row) => row)).toHaveLength(1);
    const viaFacade = await byId(false).tool().read({ id: 'a' }, { actor: null });
    expect(viaFacade.map((row) => row)).toHaveLength(1);

    const row = await toQueryTool(byId(true)).read({ id: 'a' }, { actor: null });
    // @ts-expect-error — one row is not a list
    expect(row.map).toBeUndefined();
  });

  test('a list read still answers its rows, and an empty one answers []', async () => {
    expect(await toQueryTool(byId(false)).read({ id: 'a' }, { actor: null })).toEqual([
      posts[0] as object,
    ]);
    expect(await toQueryTool(byId(false)).read({ id: 'missing' }, { actor: null })).toEqual([]);
  });
});
