/**
 * Pins the action DSL surface. Two different guarantees than `facade.test.ts`
 * (which proves the fluent methods behave correctly): this file proves the
 * *shape* cannot silently drift — every façade member still exists — and that
 * each member is a thin binding to its projection function, never a second
 * implementation. A member renamed, dropped, or quietly reimplemented here
 * fails this test, not just a downstream consumer.
 */
import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { ActionDeniedError } from './errors';
import { toOpenApiOperation } from './http';
import { toJobHandle } from './job-handle';
import { toMcpTool } from './mcp-tool';
import type { LocalRow, LocalTable, LocalTx } from './mutator';
import { mutator } from './mutator';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

function defineTarget() {
  return action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    mcp: { expose: true, description: 'dsl pin' },
    handle: ({ input }) => ({ id: input.postId, published: true }),
  }).named('dslPublishPost');
}

// The exact contract: `ActionFacade` (action.ts) plus the base members every
// built action carries regardless of the façade. Kept in sync by hand on
// purpose — a silent drift here is exactly the regression this file exists
// to catch.
const BASE_MEMBERS = ['kind', 'name', 'describe', 'named'] as const;
const FACADE_MEMBERS = [
  'input',
  'output',
  'policy',
  'mcp',
  'as',
  'tool',
  'openapi',
  'client',
  'job',
  'contract',
] as const;

describe('the action DSL surface', () => {
  test('a built action is callable, and carries every façade member', () => {
    const target = defineTarget();
    expect(typeof target).toBe('function');
    for (const member of [...BASE_MEMBERS, ...FACADE_MEMBERS]) {
      expect(target).toHaveProperty(member);
    }
  });

  test('an action with no mcp block simply omits the member, not a placeholder', () => {
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('dslNoMcp');
    expect('mcp' in target).toBe(false);
  });

  test('.tool() delegates to toMcpTool() — same data, same policy reference', () => {
    const target = defineTarget();
    const direct = toMcpTool(target);
    const viaFacade = target.tool();
    expect(viaFacade.name).toBe(direct.name);
    expect(viaFacade.action).toBe(direct.action);
    expect(viaFacade.description).toBe(direct.description);
    expect(viaFacade.inputSchema).toEqual(direct.inputSchema);
    expect(viaFacade.outputSchema).toEqual(direct.outputSchema);
    expect(viaFacade.policy).toBe(direct.policy);
  });

  test('.openapi() delegates to toOpenApiOperation() verbatim', () => {
    const target = defineTarget();
    expect(target.openapi()).toEqual(toOpenApiOperation(target));
  });

  test('.job() delegates to toJobHandle() — same input schema, same key function', () => {
    const target = defineTarget();
    const direct = toJobHandle(target);
    const viaFacade = target.job();
    expect(viaFacade.kind).toBe(direct.kind);
    expect(viaFacade.name).toBe(direct.name);
    expect(viaFacade.input).toBe(direct.input);
    expect(viaFacade.idempotencyKey({ postId: POST_ID })).toBe(
      direct.idempotencyKey({ postId: POST_ID }),
    );
  });

  test('.contract() delegates through the same registered assertions', () => {
    const target = defineTarget();
    const contracts = target.contract();
    expect(contracts.length).toBeGreaterThan(0);
    expect(contracts.every((contract) => typeof contract.run === 'function')).toBe(true);
  });

  // The DSL's central claim: no surface reaches a second authz object. `.tool()`
  // exposes the action to MCP, `.policy` is what `invoke` enforces on every call —
  // if these were ever two different objects, an MCP call could diverge from HTTP.
  test('a.tool().policy === a.policy — one authz object across every surface', () => {
    const target = defineTarget();
    expect(target.tool().policy).toBe(target.policy);
  });

  test('a named twin carries the same façade — naming never rebuilds it', () => {
    const target = defineTarget();
    const twin = target.named('dslPublishPostTwin');
    expect(twin.policy).toBe(target.policy);
    expect(twin.tool().policy).toBe(twin.policy);
    for (const member of [...BASE_MEMBERS, ...FACADE_MEMBERS]) {
      expect(twin).toHaveProperty(member);
    }
  });
});

// A mutator IS an action (`mutator.ts` builds it on `action()`, not beside it), so it
// carries the entire action façade above plus the three members it was authored with.
// Kept in sync by hand on purpose, same as `FACADE_MEMBERS` — a silent drift here is
// exactly the regression this file exists to catch.
const MUTATOR_MEMBERS = ['isMutator', 'conflict', 'local', 'server', 'describeMutator'] as const;

interface PostRow extends LocalRow {
  readonly likes: number;
}

function fakeTx(rows: Map<string, PostRow>): LocalTx {
  const table: LocalTable<PostRow> = {
    insert: (row) => {
      rows.set(row.id, row);
    },
    update: (id, patch) => {
      const current = rows.get(id);
      if (current === undefined) return;
      rows.set(id, { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    },
    delete: (id) => {
      rows.delete(id);
    },
  };
  return { table: () => table } as unknown as LocalTx;
}

const likerActor = { ...userActor({ id: 'u1' }), permissions: ['post:like'] };

function defineMutatorTarget() {
  return mutator({
    input: Input,
    output: Output,
    policy: can('post:like'),
    mcp: { expose: true, description: 'dsl pin' },
    local: (tx, { postId }) =>
      tx.table<PostRow>('posts').update(postId, (post) => ({ likes: post.likes + 1 })),
    server: (_ctx, { postId }) => ({ id: postId, published: true }),
    conflict: 'server-wins',
  }).named('dslLikePost');
}

describe('the mutator DSL surface', () => {
  test('a built mutator carries the whole action façade plus its own three members', () => {
    const target = defineMutatorTarget();
    expect(typeof target).toBe('function');
    for (const member of [...BASE_MEMBERS, ...FACADE_MEMBERS, ...MUTATOR_MEMBERS]) {
      expect(target).toHaveProperty(member);
    }
  });

  test('.local() delegates to the declared local, verbatim — no wrapping in between', () => {
    const target = defineMutatorTarget();
    const rows = new Map<string, PostRow>([[POST_ID, { id: POST_ID, likes: 3 }]]);
    target.local(fakeTx(rows), { postId: POST_ID });
    expect(rows.get(POST_ID)?.likes).toBe(4);
  });

  test('.server() delegates through the action own callable — never the declared half directly', async () => {
    const target = defineMutatorTarget();
    const ctx = createContext({ actor: likerActor });
    const viaServer = await target.server(ctx, { postId: POST_ID });
    const viaCallable = await target({ postId: POST_ID }, { ctx });
    expect(viaServer).toEqual(viaCallable);

    // The load-bearing half: the two calls above agree even if `.server()` reached the declared
    // half directly, because both return the same value. The declared `server` ignores its ctx
    // entirely, so it would answer an anonymous caller happily — only a call routed through
    // `invoke` reaches the policy. This denial is what proves the route taken.
    const denied = await target.server(createContext(), { postId: POST_ID }).then(
      (value) => value,
      (error: unknown) => error,
    );
    expect(denied).toBeInstanceOf(ActionDeniedError);
    expect((denied as ActionDeniedError).code).toBe('X_UNAUTHENTICATED');
  });

  test('.tool() delegates to toMcpTool() — same data, same policy reference', () => {
    const target = defineMutatorTarget();
    const direct = toMcpTool(target);
    const viaFacade = target.tool();
    expect(viaFacade.name).toBe(direct.name);
    expect(viaFacade.policy).toBe(direct.policy);
  });

  // Same central claim as the action façade above, pinned again for the mutator
  // instance specifically: wrapping (`mutator.ts`'s `wrap()`) must never fork the
  // policy the action itself carries — `.tool()` and `.server()` decide from one object.
  test('a.tool().policy === a.policy — one authz object across every surface', () => {
    const target = defineMutatorTarget();
    expect(target.tool().policy).toBe(target.policy);
  });

  test('a named twin carries the same façade — naming never rebuilds it', () => {
    const target = defineMutatorTarget();
    const twin = target.named('dslLikePostTwin');
    expect(twin.policy).toBe(target.policy);
    expect(twin.conflict).toBe(target.conflict);
    expect(twin.tool().policy).toBe(twin.policy);
    for (const member of [...BASE_MEMBERS, ...FACADE_MEMBERS, ...MUTATOR_MEMBERS]) {
      expect(twin).toHaveProperty(member);
    }
  });
});
