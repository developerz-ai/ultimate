// A `single: true` read over `tools/call` answers what it answers over HTTP and through
// `tool().read()`: the one row, or `X_NOT_FOUND`. The projection built its own read and handed an
// agent `[]` for a missing id — "found, and empty" — where the route said 404.

import { afterEach, describe, expect, test } from 'bun:test';
import { agentActor } from '@ultimat3/core';
import { clearRegistry, entity, text } from '@ultimat3/entity';
import { allow } from '@ultimat3/policy';
import { from, query, registerQuery, resetRegistry as resetQueries } from '@ultimat3/query';
import { t } from '@ultimat3/schema';
import { primitiveFromQuery } from './projectable';

interface Post {
  readonly id: string;
  readonly title: string;
}

const POSTS: readonly Post[] = [{ id: 'p1', title: 'hello' }];
const actor = agentActor({ id: 'agent-1' });

const input = t.object({ id: t.string });
const sql = ({ id }: { readonly id: string }) =>
  from<Post>('mcp_single_posts', POSTS).where({ id }).limit(1);
const declarePosts = () =>
  entity('mcp_single_posts', {
    columns: { id: text({ max: 20 }).primaryKey(), title: text({ max: 40 }) },
  });

/** Written out four times rather than spread: `single` and `rows` are part of the query's TYPE. */
const single = () =>
  registerQuery(
    'postById',
    query({ input, policy: allow('public'), mcp: { expose: true }, single: true, sql }),
  );
const singleWithRows = () =>
  registerQuery(
    'postById',
    query({
      input,
      policy: allow('public'),
      mcp: { expose: true },
      single: true,
      rows: declarePosts().$schema,
      sql,
    }),
  );
const listWithRows = () =>
  registerQuery(
    'postById',
    query({
      input,
      policy: allow('public'),
      mcp: { expose: true },
      rows: declarePosts().$schema,
      sql,
    }),
  );

afterEach(() => {
  resetQueries();
  clearRegistry();
});

describe('a single: true query as a served tool', () => {
  test('answers the ROW itself, never a one-row array', async () => {
    const tool = primitiveFromQuery(single());
    expect(await tool.run({ input: { id: 'p1' }, actor })).toEqual(POSTS[0]);
  });

  test('no row is X_NOT_FOUND, never an empty array', async () => {
    const tool = primitiveFromQuery(single());
    await expect(tool.run({ input: { id: 'missing' }, actor })).rejects.toBeUltimateError(
      'X_NOT_FOUND',
    );
  });

  test('its outputSchema is the row, with no `rows` wrapper to put one object under', () => {
    const tool = primitiveFromQuery(singleWithRows());
    expect(tool.outputWrap).toBeUndefined();
    expect(tool.outputJsonSchema?.['type']).toBe('object');
    expect(Object.keys(tool.outputJsonSchema?.['properties'] ?? {}).sort()).toEqual([
      'id',
      'title',
    ]);
  });

  test('a list read is unchanged: rows, `[]` for none, and the `rows` wrapper', async () => {
    const tool = primitiveFromQuery(listWithRows());
    expect(await tool.run({ input: { id: 'p1' }, actor })).toEqual([POSTS[0]]);
    expect(await tool.run({ input: { id: 'missing' }, actor })).toEqual([]);
    expect(tool.outputWrap).toBe('rows');
  });
});
