import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { MemoryIdempotencyStore } from './idempotency';
import { invoke } from './invoke';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, runs: t.number });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const ctx = createContext({ actor: editorActor });

function defineCounter() {
  let runs = 0;
  const target = action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    idempotent: true,
    async handle({ input }) {
      runs += 1;
      return { id: input.postId, runs };
    },
  }).named('publishPost');
  return { target, runs: () => runs };
}

describe('idempotency', () => {
  test('a replayed key returns the first response and does not re-run', async () => {
    const { target, runs } = defineCounter();
    const store = new MemoryIdempotencyStore();
    const options = { ctx, store, idempotencyKey: 'key-1' } as const;

    const first = await invoke(target, { postId: POST_ID }, options);
    const second = await invoke(target, { postId: POST_ID }, options);

    expect(second).toEqual(first);
    expect(runs()).toBe(1);
  });

  test('the same key with a different payload is X_IDEMPOTENCY_CONFLICT', async () => {
    const { target } = defineCounter();
    const store = new MemoryIdempotencyStore();
    await invoke(target, { postId: POST_ID }, { ctx, store, idempotencyKey: 'key-1' });

    const other = '00000000-0000-4000-8000-0000000000bb';
    const failure = await invoke(
      target,
      { postId: other },
      {
        ctx,
        store,
        idempotencyKey: 'key-1',
      },
    ).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe('X_IDEMPOTENCY_CONFLICT');
  });

  test('a concurrent duplicate is refused rather than run twice', async () => {
    const { target, runs } = defineCounter();
    const store = new MemoryIdempotencyStore();
    const options = { ctx, store, idempotencyKey: 'key-1' } as const;

    const [a, b] = await Promise.allSettled([
      invoke(target, { postId: POST_ID }, options),
      invoke(target, { postId: POST_ID }, options),
    ]);

    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    expect(runs()).toBe(1);
  });

  test('without a key an idempotent action still runs every time', async () => {
    const { target, runs } = defineCounter();
    await invoke(target, { postId: POST_ID }, { ctx });
    await invoke(target, { postId: POST_ID }, { ctx });
    expect(runs()).toBe(2);
  });
});
