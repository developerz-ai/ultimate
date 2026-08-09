import { afterEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action, describeAction, isAction } from './action';
import { MemoryIdempotencyStore } from './idempotency';
import { invoke } from './invoke';
import type { Surface } from './policy-gate';
import { listActions, registerActions, resetRegistry } from './registry';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const readerActor = userActor({ id: 'u2' });
const editor = createContext({ actor: editorActor });
const SURFACES: readonly Surface[] = ['server', 'http', 'mcp', 'job'];

afterEach(() => {
  resetRegistry();
});

describe('the invocation core', () => {
  test('parses the output and drops fields the schema never declared', async () => {
    const leaky = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      // A handler that hands back the whole row is the common shape of a data leak.
      handle: ({ input }) => ({ id: input.postId, published: true, passwordHash: 'secret' }),
    }).named('publishPost');

    const result = await invoke(leaky, { postId: POST_ID }, { ctx: editor });

    expect(result).toEqual({ id: POST_ID, published: true });
    expect(Object.keys(result as object)).not.toContain('passwordHash');
  });

  test('a handler that drifts from its output schema fails with X_OUTPUT_INVALID', async () => {
    const drifted = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => ({ id: input.postId, published: 'yes' }),
    }).named('publishPost');

    const failure = await invoke(drifted, { postId: POST_ID }, { ctx: editor }).catch(
      (error: unknown) => error,
    );

    expect((failure as { code?: string }).code).toBe('X_OUTPUT_INVALID');
    expect((failure as { cause?: string }).cause).toContain('published');
  });

  test('every surface parses, authorizes and runs through the same core', async () => {
    let runs = 0;
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => {
        runs += 1;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    const reader = createContext({ actor: readerActor });
    for (const surface of SURFACES) {
      expect(await invoke(target, { postId: POST_ID }, { ctx: editor, surface })).toEqual({
        id: POST_ID,
        published: true,
      });
      const bad = await invoke(target, { postId: 'nope' }, { ctx: editor, surface }).catch(
        (error: unknown) => error,
      );
      expect((bad as { code?: string }).code).toBe('X_INPUT_INVALID');
      const denied = await invoke(target, { postId: POST_ID }, { ctx: reader, surface }).catch(
        (error: unknown) => error,
      );
      expect((denied as { code?: string }).code).toBe('X_FORBIDDEN');
    }
    // One run per surface: neither the denial nor the bad input ever reached the handler.
    expect(runs).toBe(SURFACES.length);
  });

  test('`actor` swaps who is asking and keeps the rest of the context', async () => {
    const seen: { actor: string | null; requestId: string | null } = {
      actor: null,
      requestId: null,
    };
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input, ctx }) => {
        seen.actor = ctx.actor.id;
        seen.requestId = ctx.requestId;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    await invoke(target, { postId: POST_ID }, { ctx: editor, actor: editorActor });

    expect(seen.actor).toBe('u1');
    expect(seen.requestId).toBe(editor.requestId);
  });

  test('a replayed idempotent response is the parsed value too', async () => {
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      idempotent: true,
      handle: ({ input }) => ({ id: input.postId, published: true, passwordHash: 'secret' }),
    }).named('publishPost');
    const options = { ctx: editor, store: new MemoryIdempotencyStore(), idempotencyKey: 'k1' };

    const first = await invoke(target, { postId: POST_ID }, options);
    const replay = await invoke(target, { postId: POST_ID }, options);

    expect(replay).toEqual(first);
    expect(replay).toEqual({ id: POST_ID, published: true });
  });

  test('the declaration is unreachable — an action carries no def', () => {
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishPost');

    expect('def' in target).toBe(false);
    expect('handle' in target).toBe(false);
    expect(Object.keys(target)).not.toContain('def');
  });

  test('a look-alike is not an action: it never registers and never projects', () => {
    const impostor = Object.assign(() => Promise.resolve(null), { kind: 'action' as const });
    Object.defineProperty(impostor, 'name', { value: 'publishPost', configurable: true });

    expect(isAction(impostor)).toBe(false);
    expect(registerActions({ impostor })).toEqual([]);
    expect(listActions()).toEqual([]);

    const failure = (() => {
      try {
        describeAction(impostor as unknown as AnyAction);
      } catch (error: unknown) {
        return error;
      }
      return null;
    })();
    expect((failure as { code?: string }).code).toBe('X_ACTION_FOREIGN');
  });
});
