// A shared live read never runs IN the sync node's own context. That context lives as long as the
// process, and per-request state hangs off the context object (the request memo is a WeakMap on
// it): a tenant-less read run straight in it memoised into a store that never died.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type Ctx, ctxOf, tryUseContext } from '@ultimat3/core';
import { from, type QueryPolicy, query, registerQuery, resetQueries, t } from '@ultimat3/query';
import type { JsonValue, Row } from './json';
import { liveQueryDefinition } from './live-definition';

const allowAll: QueryPolicy = {
  kind: 'allow',
  label: 'post:read',
  permissions: [],
  children: [],
  run: () => ({ allowed: true }),
};

const INPUT: JsonValue = { orgId: 'o1' };

describe('a live snapshot read', () => {
  beforeEach(() => resetQueries());

  test.each([
    ['with no tenant', null],
    ['for a tenant', 'o1'],
  ])('%s runs in a fresh child context, never the node’s own', async (_label, tenant) => {
    const seen: (Ctx | undefined)[] = [];
    const target = registerQuery(
      'ctxFeed',
      query({
        input: t.object({ orgId: t.string }),
        policy: allowAll,
        live: true,
        sql: ({ orgId }) =>
          from<Row & { readonly orgId: string }>('posts', async () => {
            seen.push(tryUseContext());
            return [{ id: 'p1', orgId }];
          })
            .where({ orgId })
            .orderBy('id')
            .limit(50),
      }),
    );
    const node = ctxOf({ role: 'sync', buildId: 'build-1' });
    const definition = liveQueryDefinition(target, { ctx: node });
    await definition.snapshot({ input: INPUT, tenant });
    await definition.snapshot({ input: INPUT, tenant });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).not.toBe(node);
    expect(seen[1]).not.toBe(node);
    // One context per read: nothing one read keys off its context reaches the next.
    expect(seen[0]).not.toBe(seen[1]);
  });
});
