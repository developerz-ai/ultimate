// The typed client's `.stream(input)` over the real HTTP projection: a chunk reaches the caller
// while the handler is still holding the rest (fails if anything buffers), the generator returns
// the action's output, a refusal is the action-named error, and only a streaming method has it.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import type { FetchLike } from './client';
import { rpc } from './client';
import { RemoteActionError } from './errors';
import { toRoute } from './http';

const Chunk = t.object({ text: t.string });
const Out = t.object({ total: t.number });

function gate(): { readonly opened: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function fetchOf(targets: readonly AnyAction[], actor: Actor | null): FetchLike {
  const server = httpServer({
    routes: targets.map((target) => toRoute(target)),
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor },
  });
  return (url, init) =>
    server.fetch(
      new Request(url, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), origin: 'http://dev.test' },
      }),
    );
}

describe('client .stream()', () => {
  test('a chunk arrives while the handler still holds the rest; the return is the output', async () => {
    const held = gate();
    const sayWords = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: allow('words:say'),
      async *handle({ input }) {
        yield { text: 'first' };
        // Nothing past this line runs until the test has READ the first chunk.
        await held.opened;
        yield { text: 'second' };
        return { total: input.n };
      },
    }).named('sayWords');
    const api = rpc<{ sayWords: typeof sayWords }>({
      baseUrl: 'http://dev.test',
      fetch: fetchOf([sayWords], userActor({ id: 'u1' })),
    });

    const stream = api.sayWords.stream({ n: 2 });
    const first = await stream.next();
    expect(first).toEqual({ done: false, value: { text: 'first' } });
    held.open();
    expect(await stream.next()).toEqual({ done: false, value: { text: 'second' } });
    expect(await stream.next()).toEqual({ done: true, value: { total: 2 } });
  });

  test('a refused caller is the action-named error before any chunk', async () => {
    const guarded = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: can('words:say'),
      async *handle() {
        yield { text: 'never' };
        return { total: 0 };
      },
    }).named('guardedWords');
    const method = guarded.client({ baseUrl: 'http://dev.test', fetch: fetchOf([guarded], null) });
    const failure = await method
      .stream({ n: 1 })
      .next()
      .then(
        () => expect.unreachable('a refused stream must not yield'),
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(RemoteActionError);
    expect((failure as RemoteActionError).code).toBe('X_UNAUTHENTICATED');
  });

  test('an input the wire cannot carry refuses on the first pull, not at the call', async () => {
    const pinned = action({
      input: t.object({ postId: t.string }),
      output: Out,
      stream: Chunk,
      policy: allow('words:say'),
      http: { method: 'POST', path: '/api/posts/:postId/words' },
      async *handle() {
        yield { text: 'never' };
        return { total: 0 };
      },
    }).named('pinnedWords');
    const method = pinned.client({ baseUrl: 'http://dev.test', fetch: fetchOf([pinned], null) });
    const stream = method.stream({ postId: '' });
    const failure = await stream.next().then(
      () => expect.unreachable('a missing path value must refuse'),
      (error: unknown) => error,
    );
    expect((failure as { code?: unknown }).code).toBe('X_ACTION_HTTP_PATH_INVALID');
  });

  test('only a stream-declaring method carries .stream in its type', () => {
    const plain = action({
      input: t.object({ n: t.number }),
      output: Out,
      policy: allow('words:say'),
      handle: () => ({ total: 1 }),
    }).named('plainWords');
    const api = rpc<{ plainWords: typeof plain }>({ baseUrl: 'http://dev.test' });
    // @ts-expect-error — no `stream` on a method whose action declares none.
    const absent: unknown = api.plainWords.stream;
    // The proxy cannot see a declaration; the TYPE is the gate, the runtime answer is harmless.
    expect(typeof absent).toBe('function');
  });
});
