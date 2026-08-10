import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { invoke } from './invoke';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const member = createContext({ actor: editorActor });

const publishPost = action({
  input: Input,
  output: Output,
  policy: can('post:publish'),
  mcp: { expose: true, description: 'Publish a draft post' },
  async handle({ input }) {
    return { id: input.postId, published: true };
  },
}).named('publishPost');

describe('action', () => {
  test('is callable server-side and returns the handler output', async () => {
    const result = await invoke(publishPost, { postId: POST_ID }, { ctx: member });
    expect(result).toEqual({ id: POST_ID, published: true });
  });

  test('rejects garbage input with X_INPUT_INVALID before the handler runs', async () => {
    let ran = false;
    const guarded = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      async handle({ input }) {
        ran = true;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    const failure = await invoke(guarded, { postId: 'not-a-uuid' }, { ctx: member }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_INPUT_INVALID');
    expect(ran).toBe(false);
  });

  test('describe() is the single source for every projection', () => {
    const described = publishPost.describe();
    expect(described.name).toBe('publishPost');
    expect(described.path).toBe('/api/posts/publish');
    expect(described.method).toBe('POST');
    expect(described.mcp.tool).toBe('publish_post');
    expect(described.idempotent).toBe(false);
    // Reported, not inferred downstream: `mutator.test.ts` holds the `true` half.
    expect(described.mutator).toBe(false);
  });

  test('an unregistered action refuses to be projected', () => {
    const orphan = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: () => ({ id: POST_ID, published: true }),
    });
    expect(() => orphan.describe()).toThrow();
  });
});
