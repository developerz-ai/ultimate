// The pin of the Known-Gaps row on a queued write's principal: the request a replay sends names no
// principal, so the server runs it under whichever session the cookie holds by then. The page's own
// fence is `page-outbox-delivery.test.ts`; binding the write on the wire changes this header list.

import { afterEach, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core';
import { memoryLocalStore } from './local-store-idb';
import { localOutbox } from './page-outbox';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.outbox-locks'));
});

test('a replayed write names no principal: it runs under the session the cookie holds by then', async () => {
  rescope('u1');
  const sent: { readonly headers: readonly string[]; readonly body: unknown }[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    sent.push({ headers: [...new Headers(init.headers).keys()].sort(), body: init.body });
    return Promise.resolve(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  }) as typeof fetch;
  const outbox = localOutbox({ local: memoryLocalStore(), overlays: () => undefined });

  await outbox.enqueue({ key: 'like:1', name: 'likePost', input: { n: 1 } });
  await outbox.replay();

  expect(sent).toEqual([
    {
      headers: ['accept', 'content-type', 'idempotency-key'],
      body: JSON.stringify({ n: 1 }),
    },
  ]);
});
