// A write to an action pinned to its own URL and verb (`http: { path, method }`) leaves the page
// THERE — from `useMutation`, and from the outbox's replay of a write the network refused — with
// each `:param` filled from the input and dropped from the body, as `action.client()` sends it.
// The mutator names only the action: the pin is the one the SERVER stamped into the document.

import { afterEach, describe, expect, test } from 'bun:test';
import { CLIENT_PINS_META, encodeClientPins, isUltimateError } from '@ultimat3/core';
import { pageHarness, resetPage } from './hooks-fixture';
import { memoryLocalStore } from './local-store-idb';
import { OUTBOX_KEY, type OutboxEntry, type OutboxHandle } from './outbox-slot';
import { localOutbox } from './page-outbox';
import type { LocalTx } from './record-tx';
import { type MutatorLike, useMutation } from './use-mutation';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, 'document');
  resetPage();
});

const PIN = { path: '/orders/:id/refund', method: 'PUT' } as const;

/** The document a server pinning `refundOrder` renders. */
function stamped(): void {
  const content = encodeClientPins({ actions: { refundOrder: PIN }, queries: {} });
  Reflect.set(globalThis, 'document', {
    querySelector: (selector: string) =>
      selector === `meta[name="${CLIENT_PINS_META}"]` ? { content } : null,
  });
}

interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function answering(): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return sent;
}

const REFUND: MutatorLike = {
  name: 'refundOrder',
  local(tx: LocalTx, input: { readonly id: string }) {
    tx['orders']?.update(input.id, () => ({ refunded: true }));
  },
};

describe('a pinned write from the page', () => {
  test('useMutation sends the pinned verb to the filled URL, the param out of the body', async () => {
    pageHarness();
    stamped();
    const sent = answering();
    await useMutation(REFUND)({ id: 'a/b', reason: 'late' });
    expect(sent).toEqual([
      { url: '/orders/a%2Fb/refund', method: 'PUT', body: { reason: 'late' } },
    ]);
  });

  test('an input with no value for a :param is refused by code, unsent, its overlay taken back', async () => {
    const { page } = pageHarness();
    stamped();
    const sent = answering();
    page.store.adopt('orders', { o1: { id: 'o1', refunded: false } });
    let caught: unknown;
    try {
      await useMutation(REFUND)({ reason: 'late' });
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) && caught.code).toBe('X_MUTATION_PATH_UNFILLED');
    expect(isUltimateError(caught) && caught.cause).toContain(':id');
    expect(sent).toEqual([]);
    expect(page.store.pending()).toEqual([]);
  });

  test('a write the network refused is queued WITH the pin it was resolved against', async () => {
    pageHarness();
    stamped();
    globalThis.fetch = (() =>
      Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const queued: OutboxEntry[] = [];
    const handle: OutboxHandle = {
      enqueue: async (entry) => {
        queued.push(entry);
      },
      replay: async () => undefined,
      pending: () => [],
      size: 0,
      subscribe: () => () => undefined,
      refresh: async () => undefined,
      ready: Promise.resolve(),
    };
    Object.defineProperty(globalThis, OUTBOX_KEY, { value: handle, configurable: true });
    await useMutation(REFUND)({ id: 'o1', reason: 'late' });
    expect(queued.map((entry) => entry.http)).toEqual([PIN]);
  });

  test("the outbox replays a pinned entry at its pin's URL and verb", async () => {
    const sent = answering();
    const outbox = localOutbox({
      local: memoryLocalStore(),
      principal: () => 'u1',
      overlays: () => undefined,
    });
    await outbox.enqueue({
      key: 'refundOrder:1',
      name: 'refundOrder',
      input: { id: 'o1', reason: 'late' },
      http: { path: '/orders/:id/refund', method: 'PUT' },
    });
    await outbox.replay();
    expect(sent).toEqual([{ url: '/orders/o1/refund', method: 'PUT', body: { reason: 'late' } }]);
  });

  test('an action the server did not pin still POSTs its whole input to the derived URL', async () => {
    pageHarness();
    stamped();
    const sent = answering();
    await useMutation({ name: 'likePost' })({ postId: 'p1' });
    expect(sent).toEqual([{ url: '/api/posts/like', method: 'POST', body: { postId: 'p1' } }]);
  });
});
