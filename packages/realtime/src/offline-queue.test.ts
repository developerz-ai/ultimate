import { describe, expect, test } from 'bun:test';
import { MemoryQueueStore, OfflineQueue, type QueuedMutation } from './offline-queue';

async function seeded(): Promise<{ queue: OfflineQueue; store: MemoryQueueStore }> {
  const store = new MemoryQueueStore();
  const queue = await OfflineQueue.open(store);
  await queue.enqueue({ key: 'like:p1', name: 'toggleLike', input: { postId: 'p1' } });
  await queue.enqueue({ key: 'like:p2', name: 'toggleLike', input: { postId: 'p2' } });
  await queue.enqueue({ key: 'like:p3', name: 'toggleLike', input: { postId: 'p3' } });
  return { queue, store };
}

describe('offline queue', () => {
  test('drains in client sequence order with duplicate keys collapsed', async () => {
    const { queue } = await seeded();
    // The same intent, re-enqueued: a double click, or a replay after a reload.
    await queue.enqueue({ key: 'like:p2', name: 'toggleLike', input: { postId: 'p2' } });

    expect(queue.size).toBe(3);
    expect(queue.collapsed).toBe(1);
    expect(queue.pending().map((mutation) => mutation.seq)).toEqual([1, 2, 3]);

    const drained: string[] = [];
    const report = await queue.drain(async (mutation: QueuedMutation) => {
      drained.push(mutation.key);
    });

    expect(drained).toEqual(['like:p1', 'like:p2', 'like:p3']);
    expect(report.sent).toBe(3);
    expect(report.stoppedAt).toBeNull();
  });

  test('a collapsed key keeps the original sequence number', async () => {
    const { queue } = await seeded();
    const first = queue.find('like:p2');
    await queue.enqueue({ key: 'like:p2', name: 'toggleLike', input: { postId: 'p2-changed' } });
    expect(queue.find('like:p2')?.seq).toBe(first?.seq ?? -1);
    expect(queue.nextSeq).toBe(4);
  });

  test('a failure stops the drain rather than reordering the user intent', async () => {
    const { queue } = await seeded();
    const drained: string[] = [];

    const report = await queue.drain(async (mutation) => {
      if (mutation.key === 'like:p2') throw new Error('offline');
      drained.push(mutation.key);
    });

    expect(drained).toEqual(['like:p1']);
    expect(report.sent).toBe(1);
    expect(report.stoppedAt).toBe('like:p2');
    // p1 was accepted, so it is no longer pending; the rest keep their order.
    expect(queue.pending().map((mutation) => mutation.key)).toEqual(['like:p2', 'like:p3']);
    expect(queue.find('like:p2')?.attempts).toBe(1);
  });

  test('the queue survives a reload with its sequence intact', async () => {
    const { queue, store } = await seeded();
    await queue.drain(async (mutation) => {
      if (mutation.key !== 'like:p1') throw new Error('offline');
    });
    await queue.ack('like:p1');

    const reopened = await OfflineQueue.open(store);
    expect(reopened.pending().map((mutation) => mutation.key)).toEqual(['like:p2', 'like:p3']);
    expect(reopened.nextSeq).toBe(4);
  });
});
