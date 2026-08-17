/**
 * One name per query, on every surface. A descriptor that spells the tool
 * differently from the name `tools/call` accepts is a tool nothing can reach.
 */

import { describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryTool, toQueryTools } from './mcp-tool';
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
