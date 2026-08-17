import { describe, expect, test } from 'bun:test';
import {
  MemoryQueueStore,
  type MutationStatus,
  OfflineQueue,
  type QueuedMutation,
  type QueueStore,
} from './offline-queue';

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

/** A promise the test resolves by hand. Never a sleep: a lost connection is not a duration. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// A connection dies while a pass is parked inside `send`. `requeueInflight` hands back everything
// that was on the dead socket, but it cannot reach into the parked pass — which resumes and claims
// the mutations behind it for a socket that is gone. `#sendable` excludes `inflight`, so nothing
// ever sends them again and no ack ever settles them: the loss the third invariant exists to stop.
describe('a connection lost while a drain pass is parked', () => {
  test('leaves nothing inflight, so the next connection can still send it', async () => {
    const { queue } = await seeded();
    const parked = deferred();
    const sent: string[] = [];

    const pass = queue.drain(async (mutation) => {
      sent.push(mutation.key);
      // The first frame reached a socket that dies before it answers; the rest never leave.
      if (mutation.key === 'like:p1') await parked.promise;
    });

    await Promise.resolve();
    expect(await queue.requeueInflight()).toBe(1);
    parked.resolve();
    await pass;

    expect(sent).toEqual(['like:p1']);
    expect(queue.all().map((mutation) => mutation.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  test('and the pass the next connection arms resends all of them, in order', async () => {
    const { queue } = await seeded();
    const parked = deferred();

    const first = queue.drain(async (mutation) => {
      if (mutation.key === 'like:p1') await parked.promise;
    });
    await Promise.resolve();
    await queue.requeueInflight();
    parked.resolve();
    await first;

    const resent: string[] = [];
    const report = await queue.drain(async (mutation) => {
      resent.push(mutation.key);
    });

    expect(resent).toEqual(['like:p1', 'like:p2', 'like:p3']);
    expect(report.sent).toBe(3);
  });
});

// A durable store may await before it reads. Handed the live entry array, one that resolves after
// the next pass has moved on persists statuses that were never true together — and `inflight` is
// the one a reload can never recover from, because `#sendable` skips it.
describe('what a durable store is handed', () => {
  test('is a snapshot of the queue as it was, not the array the next pass mutates', async () => {
    const store = new MemoryQueueStore();
    const slow = deferred();
    // The one write that is held open — `enqueue`'s, made with the entry still `pending`. What it
    // reads when it finally resumes is what lands on disk.
    const held: Record<'atCall' | 'afterAwait', MutationStatus[]> = { atCall: [], afterAwait: [] };
    let first = true;
    const observing: QueueStore = {
      load: () => store.load(),
      save: async (state) => {
        if (first) {
          first = false;
          held.atCall = state.mutations.map((mutation) => mutation.status);
          await slow.promise;
          held.afterAwait = state.mutations.map((mutation) => mutation.status);
        }
        await store.save(state);
      },
    };

    const queue = await OfflineQueue.open(observing);
    const enqueued = queue.enqueue({ key: 'like:p1', name: 'likePost', input: { postId: 'p1' } });
    await Promise.resolve();
    // A pass runs and marks the entry `inflight` while that write is still suspended inside `save`.
    const drained = queue.drain(async () => undefined);
    await Promise.resolve();
    slow.resolve();
    await Promise.all([enqueued, drained]);

    expect(held.atCall).toEqual(['pending']);
    expect(held.afterAwait).toEqual(held.atCall);
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
