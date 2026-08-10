// Registration is reached twice for one declaration — `defineApi({ queries })` at boot, and the
// framework's module scan importing the same file directly. These pin which of those two is a
// collision and which is the same registration seen twice.

import { beforeEach, describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import {
  describeQueries,
  getQuery,
  registerQueries,
  registerQuery,
  resetRegistry,
} from './registry';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: number;
}

const Input = t.object({ orgId: t.uuid });

const defineFeed = () =>
  query({
    input: Input,
    policy: can('feed:read'),
    live: true,
    sql: ({ orgId }) => from<Post>('posts', []).where({ orgId }).orderBy('createdAt').limit(50),
  });

describe('query registry', () => {
  beforeEach(() => {
    resetRegistry();
  });

  test('registering the same query twice under the same name is one registration', () => {
    const liveFeed = defineFeed();
    expect(registerQuery('liveFeed', liveFeed)).toBe(liveFeed);
    expect(registerQuery('liveFeed', liveFeed)).toBe(liveFeed);
    expect(getQuery('liveFeed')).toBe(liveFeed);
    expect(describeQueries()).toHaveLength(1);
  });

  test('re-registering a whole module is a no-op, not a collision', () => {
    const module = { liveFeed: defineFeed(), orgFeed: defineFeed() };
    registerQueries(module);
    registerQueries(module);
    expect(describeQueries().map((entry) => entry.name)).toEqual(['liveFeed', 'orgFeed']);
  });

  test('a DIFFERENT query under a taken name is still X_QUERY_DUPLICATE', () => {
    // The idempotence above must not become a licence to overwrite: two features exporting one
    // name have to collide, or the last import silently wins and a surface serves the wrong read.
    registerQuery('liveFeed', defineFeed());
    const other = defineFeed();
    let code: unknown;
    try {
      registerQuery('liveFeed', other);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_QUERY_DUPLICATE');
    expect(getQuery('liveFeed')).not.toBe(other);
  });

  test('a query without a policy still fails at registration', () => {
    const unguarded = { kind: 'query', name: '', policy: null } as unknown as ReturnType<
      typeof defineFeed
    >;
    let code: unknown;
    try {
      registerQuery('liveFeed', unguarded);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('X_QUERY_POLICY_MISSING');
    expect(getQuery('liveFeed')).toBeUndefined();
  });
});
