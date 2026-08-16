import { describe, expect, test } from 'bun:test';
import { MemoryQueueStore, OfflineQueue, type QueuedMutation } from './offline-queue';

async function seeded(): Promise<{ queue: OfflineQueue; store: MemoryQueueStore }> {
  const store = new MemoryQueueStore();
  const queue = await OfflineQueue.open(store);
  await queue.enqueue({ key: 'like:p1', name: 'likePost', input: { postId: 'p1' } });
  await queue.enqueue({ key: 'like:p2', name: 'likePost', input: { postId: 'p2' } });
  await queue.enqueue({ key: 'like:p3', name: 'likePost', input: { postId: 'p3' } });
  return { queue, store };
}

describe('offline queue', () => {
  test('drains in client sequence order with duplicate keys collapsed', async () => {
    const { queue } = await seeded();
    // The same intent, re-enqueued: a double click, or a replay after a reload.
    await queue.enqueue({ key: 'like:p2', name: 'likePost', input: { postId: 'p2' } });

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
    await queue.enqueue({ key: 'like:p2', name: 'likePost', input: { postId: 'p2-changed' } });
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

// `drain` stops at the first failure and records it — the queue's whole ordering guarantee. The
// failure it records is whatever the sender threw, which is app code, so rendering it with
// `String()` ran that value's own `toString`: the throw escaped `drain` itself, the mutation was
// left `inflight` and the caller got no `DrainReport` to decide a retry from.
describe('a sender that throws a value the queue cannot render', () => {
  const hostile = (): ReadonlyMap<string, unknown> =>
    new Map<string, unknown>([
      [
        'a hostile toString',
        {
          toString: () => {
            throw new Error('gotcha');
          },
        },
      ],
      ['a null-prototype object', Object.create(null)],
    ]);

  for (const [label, value] of hostile()) {
    test(`still stops at the failing mutation for ${label}`, async () => {
      const { queue } = await seeded();
      const report = await queue.drain(async (mutation: QueuedMutation) => {
        if (mutation.key === 'like:p2') throw value;
      });
      expect(report.sent).toBe(1);
      expect(report.stoppedAt).toBe('like:p2');
      const failed = queue.find('like:p2');
      expect(failed?.status).toBe('pending');
      expect(failed?.error?.code).toBe('X_TRANSPORT_UNAVAILABLE');
      expect(failed?.error?.cause.length).toBeGreaterThan(0);
    });
  }

  test('a thrown error carrying the contract keeps the code it named', async () => {
    const { queue } = await seeded();
    await queue.drain(async () => {
      throw { code: 'X_POLICY_DENIED', cause: 'not yours', fix: 'ask an owner' };
    });
    expect(queue.find('like:p1')?.error).toEqual({
      code: 'X_POLICY_DENIED',
      cause: 'not yours',
      fix: 'ask an owner',
    });
  });
});
