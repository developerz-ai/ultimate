/**
 * `toJobHandle` is the fourth surface: an action projected as durable work must
 * namespace its name, derive a stable idempotency key from the payload alone,
 * and run through the exact same `invoke` core — authz included — as HTTP does.
 */

import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { ActionDeniedError } from './errors';
import { toJobHandle } from './job-handle';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ID = '00000000-0000-4000-8000-0000000000bb';

const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const editor = createContext({ actor: editorActor });
const anonymous = createContext({});

const publishPost = () =>
  action({
    input: Input,
    output: Output,
    policy: can('post:publish'),
    handle: ({ input }) => ({ id: input.postId, published: true }),
  }).named('publishPost');

describe('toJobHandle', () => {
  test('namespaces the name so an action-backed job never collides with a hand-written one', () => {
    const handle = toJobHandle(publishPost());

    expect(handle.kind).toBe('action-job');
    expect(handle.name).toBe('action:publishPost');
  });

  test('exposes the action input schema unchanged, for the job payload to validate against', () => {
    const target = publishPost();
    const handle = toJobHandle(target);

    expect(handle.input).toBe(target.input);
  });

  test('idempotencyKey is stable for the same payload', () => {
    const handle = toJobHandle(publishPost());

    const first = handle.idempotencyKey({ postId: POST_ID });
    const second = handle.idempotencyKey({ postId: POST_ID });

    expect(first).toBe(second);
    expect(first).toContain('action:publishPost:');
  });

  test('idempotencyKey differs for a different payload', () => {
    const handle = toJobHandle(publishPost());

    const first = handle.idempotencyKey({ postId: POST_ID });
    const second = handle.idempotencyKey({ postId: OTHER_ID });

    expect(first).not.toBe(second);
  });

  test('invoke runs the handler and returns its output, through the job surface', async () => {
    const handle = toJobHandle(publishPost());

    const result = await handle.invoke({ postId: POST_ID }, editor);

    expect(result).toEqual({ id: POST_ID, published: true });
  });

  test('invoke reaches the same policy an HTTP call would — an anonymous actor is denied', async () => {
    const handle = toJobHandle(publishPost());

    const failure = await handle
      .invoke({ postId: POST_ID }, anonymous)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActionDeniedError);
  });

  test('invoke still validates input before the handler runs', async () => {
    let ran = false;
    const guarded = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => {
        ran = true;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');
    const handle = toJobHandle(guarded);

    const failure = await handle
      .invoke({ postId: 'not-a-uuid' }, editor)
      .catch((error: unknown) => error);

    expect((failure as { code?: string }).code).toBe('X_INPUT_INVALID');
    expect(ran).toBe(false);
  });
});
