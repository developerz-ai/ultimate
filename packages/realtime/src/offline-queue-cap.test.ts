// An optional ceiling on the offline queue (plan 101 R7): past it a NEW write is refused, coded, to
// the caller that made it — never a queued write dropped to make room, which would lose an intent
// the user was shown as saved. A key the queue already holds is no new write: it collapses.

import { expect, test } from 'bun:test';
import type { UltimateError } from '@ultimat3/core';
import { memoryQueueStore, OfflineQueue } from './offline-queue';

const refusal = (pending: Promise<unknown>): Promise<string> =>
  pending.then(
    () => 'accepted',
    (error: UltimateError) => error.code,
  );

test('a full queue refuses a new key, and keeps every write it holds', async () => {
  const store = memoryQueueStore();
  const queue = await OfflineQueue.open(store, { maxQueued: 2 });
  await queue.enqueue({ key: 'k1', name: 'likePost', input: 1 });
  await queue.enqueue({ key: 'k2', name: 'likePost', input: 2 });

  expect(await refusal(queue.enqueue({ key: 'k3', name: 'likePost', input: 3 }))).toBe(
    'X_OFFLINE_QUEUE_FULL',
  );
  expect(queue.size).toBe(2);
  expect((await store.load()).mutations.map((mutation) => mutation.key)).toEqual(['k1', 'k2']);

  // A double click on a write already queued is the same intent: no room needed.
  expect(await refusal(queue.enqueue({ key: 'k1', name: 'likePost', input: 1 }))).toBe('accepted');

  // The server settling one makes room again.
  await queue.ack('k1');
  expect(await refusal(queue.enqueue({ key: 'k3', name: 'likePost', input: 3 }))).toBe('accepted');
  expect(queue.size).toBe(2);
});

test('a refused write held under its key is re-issued in place, at the ceiling', async () => {
  const queue = await OfflineQueue.open(memoryQueueStore(), { maxQueued: 1 });
  await queue.enqueue({ key: 'k1', name: 'likePost', input: 1 });
  await queue.fail('k1', { code: 'X_POLICY_DENIED', cause: 'no', fix: 'none' });
  expect(await refusal(queue.enqueue({ key: 'k1', name: 'likePost', input: 1 }))).toBe('accepted');
  expect(queue.size).toBe(1);
});

test('no ceiling unless one is asked for, and a ceiling that counts nothing is refused', async () => {
  const open = await OfflineQueue.open(memoryQueueStore());
  for (let at = 0; at < 50; at += 1) await open.enqueue({ key: `k${at}`, name: 'n', input: at });
  expect(open.size).toBe(50);

  for (const maxQueued of [0, 1.5, Number.NaN]) {
    expect(await refusal(OfflineQueue.open(memoryQueueStore(), { maxQueued }))).toBe('X_INVARIANT');
  }
});

// Failed entries are kept for the UI and never drain: counted, they filled the queue for good —
// `X_OFFLINE_QUEUE_FULL` on every write, across reloads. The ceiling counts what is still to send.
test('refused writes kept for the UI do not count against the ceiling, across a reload', async () => {
  const store = memoryQueueStore();
  const first = await OfflineQueue.open(store, { maxQueued: 2 });
  await first.enqueue({ key: 'a', name: 'likePost', input: 1 });
  await first.enqueue({ key: 'b', name: 'likePost', input: 2 });
  await first.fail('a', { code: 'X_POLICY_DENIED', cause: 'no', fix: 'none' });
  await first.fail('b', { code: 'X_POLICY_DENIED', cause: 'no', fix: 'none' });

  const reopened = await OfflineQueue.open(store, { maxQueued: 2 });
  expect(await refusal(reopened.enqueue({ key: 'c', name: 'likePost', input: 3 }))).toBe(
    'accepted',
  );
});
