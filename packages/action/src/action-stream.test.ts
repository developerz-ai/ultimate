// `chunksRead()`: a stream-declaring handler learns whether anyone reads its chunks — `true` only
// for the declaration a `text/event-stream` request opened, `false` drained and for a nested action.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import { chunksRead } from './action-stream';
import { toRoute } from './http';

const Out = t.object({ read: t.boolean, inner: t.boolean });
const Chunk = t.object({ read: t.boolean });

const inner = action({
  input: t.object({}),
  output: t.object({ read: t.boolean }),
  stream: Chunk,
  policy: allow('probe:inner'),
  async *handle() {
    // Awaited first: the answer must survive a resume, not only the synchronous start.
    await Promise.resolve();
    yield { read: chunksRead() };
    return { read: chunksRead() };
  },
}).named('innerProbe');

const outer = action({
  input: t.object({}),
  output: Out,
  stream: Chunk,
  policy: allow('probe:outer'),
  http: { method: 'POST', path: '/api/probe' },
  async *handle() {
    await Promise.resolve();
    yield { read: chunksRead() };
    const nested = await inner({});
    return { read: chunksRead(), inner: nested.read };
  },
}).named('outerProbe');

function post(target: AnyAction, accept: string): Promise<Response> {
  const server = httpServer({
    routes: [toRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => userActor({ id: 'u1' }) },
  });
  return server.fetch(
    new Request('http://dev.test/api/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://dev.test', accept },
      body: '{}',
    }),
  );
}

describe('chunksRead', () => {
  test('true for the streamed declaration, false for the action it calls', async () => {
    const body = await (await post(outer, 'text/event-stream')).text();
    expect(body).toBe(
      'event: chunk\ndata: {"read":true}\n\n' +
        'event: done\ndata: {"read":true,"inner":false}\n\n',
    );
  });

  test('false when the call is drained to its output', async () => {
    expect(await (await post(outer, 'application/json')).json()).toEqual({
      read: false,
      inner: false,
    });
    const direct = await runWithContext(ctxOf({ actor: userActor({ id: 'u1' }) }), () => outer({}));
    expect(direct).toEqual({ read: false, inner: false });
  });

  test('false outside any handler', () => {
    expect(chunksRead()).toBe(false);
  });
});
