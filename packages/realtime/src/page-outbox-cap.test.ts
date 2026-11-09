// The outbox's ceiling, set where the outbox is built and carried to every queue it opens — one per
// principal, and the memory one a refused disk falls back to. Past it a new write is refused,
// coded, to the mutation that made it; nothing queued is dropped.

import { afterEach, expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import type { LocalStore } from './local-store-idb';
import { memoryLocalStore } from './local-store-idb';
import type { OutboxEntry } from './page-outbox';
import { localOutbox } from './page-outbox';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

const like = (n: number): OutboxEntry => ({ key: `like:${n}`, name: 'likePost', input: { n } });
const outcome = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'queued',
    (error: UltimateError) => error.code,
  );

const offline = (local: LocalStore | Promise<LocalStore>, maxQueued: number) =>
  localOutbox({
    local,
    principal: () => 'u1',
    send: () => Promise.reject(new TypeError('offline')),
    overlays: () => undefined,
    warn: () => undefined,
    maxQueued,
  });

test('a full outbox refuses a new write and keeps the ones it holds', async () => {
  const outbox = offline(memoryLocalStore(), 2);
  expect(await outcome(outbox.enqueue(like(1)))).toBe('queued');
  expect(await outcome(outbox.enqueue(like(2)))).toBe('queued');
  expect(await outcome(outbox.enqueue(like(3)))).toBe('X_OFFLINE_QUEUE_FULL');
  expect(outbox.pending().map((entry) => entry.key)).toEqual(['like:1', 'like:2']);
});

test('the memory queue a refused disk falls back to carries the same ceiling', async () => {
  const outbox = offline(Promise.reject(new TypeError('disk refused')), 1);
  expect(await outcome(outbox.enqueue(like(1)))).toBe('queued');
  expect(await outcome(outbox.enqueue(like(2)))).toBe('X_OFFLINE_QUEUE_FULL');
});

test('a ceiling that counts nothing is refused where the outbox is built', () => {
  expect(() => offline(memoryLocalStore(), 0)).toThrow(
    expect.objectContaining({ code: 'X_INVARIANT' }),
  );
});
