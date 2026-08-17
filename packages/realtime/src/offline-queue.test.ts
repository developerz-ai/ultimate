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
    // p1 reached the socket, so nothing will send it again — but it is NOT acknowledged, so it
    // stays in the queue until the server says so. `remaining` is what a later drain would send.
    expect(queue.pending().map((mutation) => mutation.key)).toEqual([
      'like:p1',
      'like:p2',
      'like:p3',
    ]);
    expect(report.remaining).toBe(2);
    expect(queue.find('like:p2')?.attempts).toBe(1);
  });

  // A `send` that resolves proves the frame was handed to the socket and NOTHING else. A browser
  // `WebSocket.send` on a CLOSING socket discards the bytes and returns normally, so treating that
  // return as an acknowledgement dropped every in-flight mutation on a socket death — the exact
  // event the durable queue exists for — and left the entry `acked`, where only a server ack that
  // can never arrive would have removed it.
  test('a sent mutation stays in the queue until the server acknowledges it', async () => {
    const { queue } = await seeded();
    await queue.drain(async () => {});

    expect(queue.find('like:p1')?.status).toBe('inflight');
    expect(queue.pending()).toHaveLength(3);

    await queue.ack('like:p1');
    expect(queue.find('like:p1')).toBeUndefined();
    expect(queue.pending()).toHaveLength(2);
  });

  test('a second drain does not resend what the first one already put on the wire', async () => {
    const { queue } = await seeded();
    const sent: string[] = [];
    const send = async (mutation: QueuedMutation): Promise<void> => {
      sent.push(mutation.key);
    };

    await queue.drain(send);
    await queue.drain(send);

    expect(sent).toEqual(['like:p1', 'like:p2', 'like:p3']);
  });

  test('a lost connection returns every unacknowledged mutation to the queue', async () => {
    const { queue } = await seeded();
    const sent: string[] = [];
    const send = async (mutation: QueuedMutation): Promise<void> => {
      sent.push(mutation.key);
    };
    await queue.drain(send);

    expect(await queue.requeueInflight()).toBe(3);
    expect(queue.find('like:p1')?.status).toBe('pending');

    await queue.drain(send);
    // At least once, in order: the socket that was carrying them is gone, so they go again.
    expect(sent).toEqual(['like:p1', 'like:p2', 'like:p3', 'like:p1', 'like:p2', 'like:p3']);
  });

  // Two `mutate()` calls landing together put FOUR frames on the socket — same keys, same seqs —
  // because both passes read the same entry as sendable. The node dedupes nothing.
  test('two overlapping drains never put one key on the wire twice', async () => {
    const { queue } = await seeded();
    const sent: string[] = [];
    let release: (() => void) | undefined;
    // A deferred promise the test resolves by hand: an ordering driven by sleeps is an ordering
    // that holds on this machine only.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = async (mutation: QueuedMutation): Promise<void> => {
      sent.push(mutation.key);
      if (mutation.key === 'like:p1') await gate;
    };

    const first = queue.drain(send);
    const second = queue.drain(send);
    release?.();
    await Promise.all([first, second]);

    expect(sent).toEqual(['like:p1', 'like:p2', 'like:p3']);
  });

  test('a mutation enqueued during a drain is still sent by the pass behind it', async () => {
    const { queue } = await seeded();
    const sent: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = async (mutation: QueuedMutation): Promise<void> => {
      sent.push(mutation.key);
      if (mutation.key === 'like:p1') await gate;
    };

    const first = queue.drain(send);
    await queue.enqueue({ key: 'like:p4', name: 'likePost', input: { postId: 'p4' } });
    const second = queue.drain(send);
    release?.();
    await Promise.all([first, second]);

    // Behind, never joined: a caller that awaited its own drain must have had its mutation sent.
    expect(sent).toEqual(['like:p1', 'like:p2', 'like:p3', 'like:p4']);
  });

  test('an explicit idempotency key can be re-issued after a terminal failure', async () => {
    const { queue } = await seeded();
    await queue.fail('like:p2', { code: 'X_FORBIDDEN', cause: 'denied', fix: 'x doctor' });

    await queue.enqueue({ key: 'like:p2', name: 'likePost', input: { postId: 'p2' } });

    // A denial is a decision about the intent, not a slot the key is stuck in forever: re-issuing
    // is a new intent, so it takes a new sequence at the back rather than collapsing onto the
    // failed entry, which nothing would ever retry.
    const reissued = queue.find('like:p2');
    expect(reissued?.status).toBe('pending');
    expect(reissued?.seq).toBe(4);
    expect(queue.all().filter((mutation) => mutation.key === 'like:p2')).toHaveLength(1);
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
