import { describe, expect, test } from 'bun:test';
import { createContext, runWithContext, useContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { FetchLike } from './client';
import { query } from './query';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly createdAt: number;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const Input = t.object({ orgId: t.uuid });

const readerActor = { ...userActor({ id: 'u1' }), permissions: ['feed:read'] };
const strangerActor = userActor({ id: 'u2' });
const member = createContext({ actor: readerActor });

const posts: readonly Post[] = [
  { id: 'a', orgId: ORG, createdAt: 10 },
  { id: 'b', orgId: '00000000-0000-4000-8000-000000000002', createdAt: 20 },
];

/** `named` stands in for registration: a projection needs a name, nothing more. */
function defineFeed() {
  const seen: { actor: string | null; requestId: string | null } = { actor: null, requestId: null };
  const target = query({
    input: Input,
    policy: can('feed:read'),
    live: true,
    mcp: { expose: true, description: 'The org feed' },
    sql: ({ orgId }, ctx) => {
      seen.actor = ctx.actor.id;
      seen.requestId = ctx.requestId;
      return from<Post>('posts', posts).where({ orgId }).orderBy('createdAt').limit(50);
    },
  }).named('orgFeed');
  return { target, seen };
}

describe('the fluent surface', () => {
  test('lifts the declaration so nothing reaches through .def', () => {
    const { target } = defineFeed();
    expect('def' in target).toBe(false);
    expect(target.input).toBe(Input);
    expect(target.policy).toBe(target.tool().policy);
    expect(target.isLive).toBe(true);
    expect(target.mcp).toEqual({ expose: true, description: 'The org feed' });
  });

  test('a query with no mcp block has no mcp field', () => {
    const target = query({
      input: Input,
      policy: can('feed:read'),
      sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }),
    }).named('orgFeed');
    expect(target.mcp).toBeUndefined();
    expect(target.cache).toBeUndefined();
    expect(target.isLive).toBe(false);
  });

  test('.as() reads as that actor and returns its rows', async () => {
    const { target, seen } = defineFeed();
    const rows = await target.as(readerActor, { orgId: ORG });
    expect(rows.map((row) => row.id)).toEqual(['a']);
    expect(seen.actor).toBe('u1');
  });

  test('.as() keeps the surrounding context and swaps only the actor', async () => {
    const { target, seen } = defineFeed();
    const ambient = createContext({ actor: strangerActor });
    const after = await runWithContext(ambient, async () => {
      await target.as(readerActor, { orgId: ORG });
      return useContext();
    });

    // Same request, a different actor: impersonation, not a second context.
    expect(seen.requestId).toBe(ambient.requestId);
    expect(seen.actor).toBe('u1');
    // And the ambient context is untouched once the read has settled.
    expect(after.actor.id).toBe('u2');
    expect(after.requestId).toBe(ambient.requestId);
  });

  test('.as(null) is the signed-out caller and never reaches the sql', async () => {
    const { target, seen } = defineFeed();
    const denial = await target.as(null, { orgId: ORG }).catch((error: unknown) => error);
    expect((denial as { code?: string }).code).toBe('X_UNAUTHENTICATED');
    expect(seen.actor).toBeNull();

    const forbidden = await target
      .as(strangerActor, { orgId: ORG })
      .catch((error: unknown) => error);
    expect((forbidden as { code?: string }).code).toBe('X_FORBIDDEN');
  });

  test('.live() subscribes against the same policy object, not a copy', async () => {
    const { target } = defineFeed();
    const live = await target.live({ orgId: ORG }, { ctx: member, epoch: 'build-1' });

    expect(live.policy).toBe(target.policy);
    expect(live.name).toBe('orgFeed');
    expect(live.limit).toBe(50);
    expect(live.sqlText).toContain('order by "createdAt" asc');
  });

  test('.tool() projects the one declaration and reads through the one path', async () => {
    const { target } = defineFeed();
    const tool = target.tool();

    // The same policy object on both surfaces — an MCP call cannot reach a second authz path.
    expect(tool.policy).toBe(target.policy);
    // One name: what the descriptor advertises is what `tools/call` accepts.
    expect(tool.name).toBe('orgFeed');
    expect(tool.query).toBe('orgFeed');
    expect(tool.description).toBe('The org feed');
    expect(tool.mutates).toBe(false);
    expect(tool.inputSchema['type']).toBe('object');

    const rows = await tool.read({ orgId: ORG }, { ctx: member });
    expect(rows).toEqual([posts[0] as object]);

    const denial = await tool
      .read({ orgId: ORG }, { actor: null })
      .catch((error: unknown) => error);
    expect((denial as { code?: string }).code).toBe('X_UNAUTHENTICATED');
  });

  test('.client() issues a GET against the derived path', async () => {
    const { target } = defineFeed();
    let url: string | null = null;
    const fetchStub: FetchLike = async (input, init) => {
      url = input;
      expect(init.method).toBe('GET');
      return Response.json([{ id: 'a', orgId: ORG, createdAt: 10 }]);
    };

    const call = target.client({ baseUrl: 'https://app.test/', fetch: fetchStub });
    const rows = await call({ orgId: ORG });

    expect(url).toBe(`https://app.test/_x/query/org-feed?orgId=${ORG}`);
    expect(rows).toEqual([{ id: 'a', orgId: ORG, createdAt: 10 }]);
  });

  test('.client() re-throws the server problem+json verbatim', async () => {
    const { target } = defineFeed();
    const fetchStub: FetchLike = async () =>
      Response.json(
        {
          code: 'X_INPUT_INVALID',
          cause: 'orgId is not a uuid',
          fix: 'x queries describe orgFeed --json',
        },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );

    const call = target.client({ baseUrl: 'https://app.test', fetch: fetchStub });
    const failure = await call({ orgId: 'nope' }).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe('X_INPUT_INVALID');
    expect((failure as { fix?: string }).fix).toBe('x queries describe orgFeed --json');
  });

  test('a gateway answering instead of the app is X_RPC_FAILED', async () => {
    const { target } = defineFeed();
    const fetchStub: FetchLike = async () => new Response('<html>502</html>', { status: 502 });

    const call = target.client({ baseUrl: 'https://app.test', fetch: fetchStub });
    const failure = await call({ orgId: ORG }).catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe('X_RPC_FAILED');
  });

  test('a named twin carries the façade, not just the name', async () => {
    const { target } = defineFeed();
    const twin = target.named('archiveFeed');

    expect(twin.policy).toBe(target.policy);
    expect(twin.tool().query).toBe('archiveFeed');
    expect((await twin.as(readerActor, { orgId: ORG })).map((row) => row.id)).toEqual(['a']);
  });
});
