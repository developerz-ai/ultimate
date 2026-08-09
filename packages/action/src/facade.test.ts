import { describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { FetchLike } from './client';
import { resetRegistry } from './registry';

const Input = t.object({ postId: t.uuid, notify: t.boolean.default(true) });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const readerActor = userActor({ id: 'u2' });

function definePublish() {
  const seen: { actor: string | null; requestId: string | null } = { actor: null, requestId: null };
  const target = action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    mcp: { expose: true, description: 'Publish a draft post' },
    handle: ({ input, ctx }) => {
      seen.actor = ctx.actor.id;
      seen.requestId = ctx.requestId;
      return { id: input.postId, published: input.notify };
    },
  }).named('publishPost');
  return { target, seen };
}

describe('the fluent surface', () => {
  test('lifts the declaration so nothing reaches through .def', () => {
    const { target } = definePublish();
    expect(target.input).toBe(Input);
    expect(target.output).toBe(Output);
    expect(target.policy).toBe(target.tool().policy);
    expect(target.mcp).toEqual({ expose: true, description: 'Publish a draft post' });
  });

  test('an action with no mcp block has no mcp field', () => {
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishPost');
    expect(target.mcp).toBeUndefined();
  });

  test('.as() runs as that actor and applies the schema default', async () => {
    const { target, seen } = definePublish();
    const result = await target.as(editorActor, { postId: POST_ID });
    expect(result).toEqual({ id: POST_ID, published: true });
    expect(seen.actor).toBe('u1');
  });

  test('.as() evaluates the policy against the actor it was given', async () => {
    const { target, seen } = definePublish();
    const denial = await target.as(readerActor, { postId: POST_ID }).catch((e: unknown) => e);
    expect((denial as { code?: string }).code).toBe('X_FORBIDDEN');
    expect(seen.actor).toBeNull();

    const anonymous = await target.as(null, { postId: POST_ID }).catch((e: unknown) => e);
    expect((anonymous as { code?: string }).code).toBe('X_UNAUTHENTICATED');
  });

  test('.as() keeps the surrounding context and swaps only the actor', async () => {
    const { target, seen } = definePublish();
    const ambient = createContext({ actor: readerActor });
    await runWithContext(ambient, () => target.as(editorActor, { postId: POST_ID }));
    // Same request, a different actor: impersonation, not a second context.
    expect(seen.requestId).toBe(ambient.requestId);
    expect(seen.actor).toBe('u1');
  });

  test('.tool() and .openapi() project the one declaration', () => {
    const { target } = definePublish();
    const tool = target.tool();
    // The same policy object on both surfaces — an MCP call cannot reach a second authz path.
    expect(tool.policy).toBe(target.policy);
    expect(tool.name).toBe('publish_post');
    expect(tool.description).toBe('Publish a draft post');
    expect(target.openapi().operationId).toBe('publishPost');
    expect(target.openapi().summary).toBe('Publish a draft post');
  });

  test('.job() is the durable-work shape, keyed off the payload', async () => {
    const { target } = definePublish();
    const handle = target.job();
    expect(handle.kind).toBe('action-job');
    expect(handle.name).toBe('action:publishPost');
    expect(handle.input).toBe(target.input);
    expect(handle.idempotencyKey({ postId: POST_ID })).toBe(
      handle.idempotencyKey({ postId: POST_ID }),
    );
    const ran = await handle.invoke({ postId: POST_ID }, createContext({ actor: editorActor }));
    expect(ran).toEqual({ id: POST_ID, published: true });
  });

  test('.client() calls the derived path, same as createClient', async () => {
    const { target } = definePublish();
    let url: string | null = null;
    const fetchStub: FetchLike = async (input, init) => {
      url = input;
      expect(String(init.body)).toBe(JSON.stringify({ postId: POST_ID }));
      return Response.json({ id: POST_ID, published: true });
    };

    const call = target.client({ baseUrl: 'https://app.test/', fetch: fetchStub });
    expect(await call({ postId: POST_ID })).toEqual({ id: POST_ID, published: true });
    expect(url).toBe('https://app.test/api/posts/publish');
  });

  test('.contract() emits the three assertions and they hold', async () => {
    resetRegistry();
    const { target } = definePublish();
    const contracts = target.contract();
    expect(contracts.map((contract) => contract.name)).toEqual([
      'publishPost: input schema rejects garbage',
      'publishPost: policy denies an anonymous actor',
      'publishPost: OpenAPI document contains its operation',
    ]);
    for (const contract of contracts) await contract.run();
  });

  test('a named twin carries the façade, not just the name', async () => {
    const orphan = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    });
    const named = orphan.named('publishPost');
    expect(named.policy).toBe(orphan.policy);
    expect(named.tool().action).toBe('publishPost');
    expect(await named.as(editorActor, { postId: POST_ID })).toEqual({
      id: POST_ID,
      published: true,
    });
  });
});
