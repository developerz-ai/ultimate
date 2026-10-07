// The outbox's count, as something a UI can follow: `subscribe` tells a listener every time the
// number of writes still to send may have moved. The reference app counted its own island's queued
// writes by hand off `useMutation`'s `undefined` and cleared on `online` (owner decision 19).

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope, UltimateError } from '@ultimat3/core';
import { memoryLocalStore } from './local-store-idb';
import type { OutboxEntry } from './page-outbox';
import { localOutbox } from './page-outbox';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

const like = (n: number): OutboxEntry => ({ key: `like:${n}`, name: 'likePost', input: { n } });

function setup(answer: (entry: OutboxEntry) => Promise<unknown>) {
  const outbox = localOutbox({
    local: memoryLocalStore(),
    principal: () => 'u1',
    send: (entry) => answer(entry),
    overlays: () => undefined,
  });
  const seen: number[] = [];
  const release = outbox.subscribe(() => seen.push(outbox.size));
  return { outbox, seen, release };
}

describe('the outbox tells its listeners when its count moves', () => {
  test('each queued write is heard, with the size already moved', async () => {
    const { outbox, seen } = setup(async () => ({ ok: true }));
    await outbox.ready;
    seen.length = 0;
    await outbox.enqueue(like(1));
    await outbox.enqueue(like(2));
    expect(seen).toEqual([1, 2]);
  });

  test('a replay is heard write by write, down to an empty outbox', async () => {
    const { outbox, seen } = setup(async () => ({ ok: true }));
    await outbox.enqueue(like(1));
    await outbox.enqueue(like(2));
    seen.length = 0;
    await outbox.replay();
    expect(outbox.size).toBe(0);
    // The re-read under the drain lock first (another tab's writes count too), then each ack.
    expect(seen).toEqual([2, 1, 0]);
  });

  test('a write the server refuses leaves the count, and is heard leaving', async () => {
    const { outbox, seen } = setup(async () => {
      throw new UltimateError({ code: 'X_FORBIDDEN', cause: 'no', fix: 'ask for access' });
    });
    await outbox.enqueue(like(1));
    seen.length = 0;
    await outbox.replay();
    expect(outbox.size).toBe(0);
    expect(seen).toContain(0);
  });

  test('a principal change is heard at once: the next principal has nothing queued', async () => {
    rescope('u1');
    const { outbox, seen } = setup(async () => ({ ok: true }));
    await outbox.enqueue(like(1));
    seen.length = 0;
    rescope('u2');
    expect(seen).toEqual([0]);
  });

  test('a released listener hears nothing more', async () => {
    const { outbox, seen, release } = setup(async () => ({ ok: true }));
    await outbox.ready;
    release();
    seen.length = 0;
    await outbox.enqueue(like(1));
    expect(seen).toEqual([]);
  });
});
