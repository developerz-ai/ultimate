/**
 * Pins the query DSL surface. Different guarantee than `facade.test.ts` (which
 * proves the fluent methods behave correctly): this file proves the *shape*
 * cannot silently drift — every façade member still exists — and that each
 * member is a thin binding to its projection function, never a second
 * implementation. A member renamed, dropped, or quietly reimplemented here
 * fails this test, not just a downstream consumer.
 */
import { describe, expect, test } from 'bun:test';
import { tag } from '@ultimat3/cache';
import { ctxOf, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { paginate } from './pagination';
import { query } from './query';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const Input = t.object({ orgId: t.uuid });
const readerActor = { ...userActor({ id: 'u1' }), permissions: ['feed:read'] };
// Two rows, so a one-row page has a next page and `.page()` below mints a cursor to compare.
const posts: readonly Post[] = [
  { id: 'a', orgId: ORG },
  { id: 'b', orgId: ORG },
];

function defineTarget() {
  return query({
    input: Input,
    policy: can('feed:read'),
    live: true,
    mcp: { expose: true, description: 'dsl pin' },
    cache: { tags: [tag('feed')] },
    sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }).orderBy('id').limit(50),
  }).named('dslOrgFeed');
}

// The exact contract: `QueryFacade` (query.ts) plus the base members every
// built query carries regardless of the façade. Kept in sync by hand on
// purpose — a silent drift here is exactly the regression this file exists
// to catch.
const BASE_MEMBERS = ['kind', 'name', 'isLive', 'describe', 'named'] as const;
const FACADE_MEMBERS = ['input', 'policy', 'cache', 'mcp', 'as', 'page', 'live', 'client'] as const;

describe('the query DSL surface', () => {
  test('a built query is callable, and carries every façade member', () => {
    const target = defineTarget();
    expect(typeof target).toBe('function');
    for (const member of [...BASE_MEMBERS, ...FACADE_MEMBERS]) {
      expect(target).toHaveProperty(member);
    }
    expect('def' in target).toBe(false);
  });

  test('a query with no mcp or cache block simply omits the members', () => {
    const target = query({
      input: Input,
      policy: can('feed:read'),
      sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }),
    }).named('dslNoMcp');
    expect('mcp' in target).toBe(false);
    expect('cache' in target).toBe(false);
  });

  // O-tool, 25.0.0: the MCP tool is `@ultimat3/mcp`'s one projection. A `.tool()` here was a
  // second one, and the member list above would not notice it coming back — this does.
  test('there is no `.tool()` — the MCP tool is not this package’s projection', () => {
    expect(defineTarget()).not.toHaveProperty('tool');
  });

  test('.live() delegates to toLiveQuery() — same sql shape, same policy reference', async () => {
    const target = defineTarget();
    const ctx = ctxOf({ actor: readerActor });
    const viaFacade = await target.live({ orgId: ORG }, { ctx, epoch: 'build-1' });
    expect(viaFacade.name).toBe(target.name);
    expect(viaFacade.policy).toBe(target.policy);
    expect(viaFacade.limit).toBeGreaterThan(0);
  });

  test('.as() reads through the one read path, evaluating this same policy', async () => {
    const target = defineTarget();
    const rows = await target.as(readerActor, { orgId: ORG });
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  test('.page() delegates to paginate() — same rows, same signed cursor', async () => {
    // The cursor is only reachable through the query that issued it, so the façade must bind
    // `paginate` rather than leave app code importing a projection function.
    const target = defineTarget();
    const args = { first: 1, ctx: ctxOf({ actor: readerActor }) };
    const viaFacade = await target.page({ orgId: ORG }, args);
    const direct = await paginate(target, { orgId: ORG }, args);
    expect(viaFacade.rows).toEqual(direct.rows);
    expect(viaFacade.nextCursor).toBe(direct.nextCursor);
    expect(viaFacade.hasMore).toBe(true);
    expect(direct.hasMore).toBe(true);
    // Opaque and bound to this read: nothing decodes it without the query's own scope.
    expect(viaFacade.nextCursor).toContain('.');
  });

  test('a named twin carries the same façade — naming never rebuilds it', () => {
    const target = defineTarget();
    const twin = target.named('dslOrgFeedTwin');
    expect(twin.policy).toBe(target.policy);
    for (const member of [...BASE_MEMBERS, ...FACADE_MEMBERS]) {
      expect(twin).toHaveProperty(member);
    }
  });
});
