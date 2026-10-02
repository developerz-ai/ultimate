// The queue against a sender that settles a write ITSELF, and against its principal leaving: a
// pass parked in `send` when the principal changes sends nothing more and writes nothing back; one
// key enqueued twice at once is one entry; a write refused inside `send` keeps its error.

import { describe, expect, test } from 'bun:test';
import {
  MemoryQueueStore,
  OfflineQueue,
  type QueueChange,
  type QueueState,
  type QueueStore,
} from './offline-queue';

const like = (n: number) => ({ key: `like:p${n}`, name: 'likePost', input: { postId: `p${n}` } });

/** A send the test releases by hand — no clock, no sleep. */
function gate(): { readonly entered: Promise<void>; open(): void; wait(): Promise<void> } {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    open: () => release(),
    wait: () => {
      enter();
      return released;
    },
  };
}

/** A store that counts what is written to it. */
class CountingStore implements QueueStore {
  readonly inner = new MemoryQueueStore();
  readonly writes: QueueChange[] = [];
  load(): Promise<QueueState> {
    return this.inner.load();
  }
  write(change: QueueChange): Promise<void> {
    this.writes.push(change);
    return this.inner.write(change);
  }
}

describe('a queue whose principal is gone', () => {
  test('a pass parked in send sends nothing after abandon(), and writes nothing back', async () => {
    const store = new CountingStore();
    const queue = await OfflineQueue.open(store);
    for (const n of [1, 2, 3]) await queue.enqueue(like(n));
    const first = gate();
    const sent: string[] = [];
    const pass = queue.drain(async (mutation) => {
      sent.push(mutation.key);
      if (mutation.key === 'like:p1') await first.wait();
    });
    await first.entered;
    const before = store.writes.length;

    queue.abandon();
    first.open();
    const report = await pass;

    // p2 and p3 would have left under whoever is signed in NOW.
    expect(sent).toEqual(['like:p1']);
    expect(report.stoppedAt).toBe('like:p2');
    // The principal's store was wiped; a write-back here would put its queue on disk again.
    expect(store.writes.length).toBe(before);
    expect(queue.abandoned).toBe(true);
  });

  test('a pass that STARTS after abandon() sends nothing either', async () => {
    const store = new CountingStore();
    const queue = await OfflineQueue.open(store);
    await queue.enqueue(like(1));
    const before = store.writes.length;
    queue.abandon();
    const sent: string[] = [];
    await queue.reload();
    const report = await queue.drain(async (mutation) => {
      sent.push(mutation.key);
    });
    expect(sent).toEqual([]);
    expect(report.sent).toBe(0);
    // Settling what the dead pass had on the wire is memory only.
    await queue.ack('like:p1');
    expect(store.writes.length).toBe(before);
  });
});

describe('a write queued on a queue whose principal is gone', () => {
  test('is REFUSED by name — never held in memory where nothing will send it', async () => {
    const store = new CountingStore();
    const queue = await OfflineQueue.open(store);
    queue.abandon();
    const before = store.writes.length;
    try {
      await queue.enqueue(like(1));
      expect.unreachable('a write was accepted by a queue nothing drains');
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_OFFLINE_QUEUE_ABANDONED' });
      expect(String((error as { cause?: unknown }).cause)).toContain('"likePost"');
    }
    expect(queue.size).toBe(0);
    expect(store.writes.length).toBe(before);
  });

  test('and so is one whose queue is abandoned WHILE it reads the store', async () => {
    const inner = new MemoryQueueStore();
    let abandon: () => void = () => undefined;
    const queue = await OfflineQueue.open({
      load: async () => {
        const state = await inner.load();
        abandon();
        return state;
      },
      write: (change) => inner.write(change),
    });
    abandon = () => queue.abandon();
    try {
      await queue.enqueue(like(1));
      expect.unreachable('a write was accepted by a queue nothing drains');
    } catch (error) {
      expect(error).toMatchObject({ code: 'X_OFFLINE_QUEUE_ABANDONED' });
    }
    expect(queue.size).toBe(0);
    expect((await inner.load()).mutations).toEqual([]);
  });
});

describe('one key, enqueued twice at once', () => {
  test('is ONE entry under one sequence number', async () => {
    const queue = await OfflineQueue.open(new MemoryQueueStore());
    const [a, b] = await Promise.all([queue.enqueue(like(1)), queue.enqueue(like(1))]);
    expect(queue.size).toBe(1);
    expect(a).toBe(b);
    expect(queue.collapsed).toBe(1);
    expect(queue.nextSeq).toBe(2);
  });

  test('and two different keys at once still take two sequence numbers', async () => {
    const queue = await OfflineQueue.open(new MemoryQueueStore());
    await Promise.all([queue.enqueue(like(1)), queue.enqueue(like(2))]);
    expect(queue.all().map((mutation) => mutation.seq)).toEqual([1, 2]);
  });
});

describe('a sender that settles the write itself', () => {
  const refusal = { code: 'X_FORBIDDEN', cause: 'no', fix: 'x policy list --json' };

  test('a write REFUSED inside send keeps its error and is not counted as sent', async () => {
    const store = new MemoryQueueStore();
    const queue = await OfflineQueue.open(store);
    await queue.enqueue(like(1));
    await queue.enqueue(like(2));
    const report = await queue.drain(async (mutation) => {
      if (mutation.key === 'like:p1') await queue.fail(mutation.key, refusal);
      else await queue.ack(mutation.key);
    });
    expect(report.sent).toBe(1);
    expect(report.stoppedAt).toBeNull();
    expect(queue.find('like:p1')).toMatchObject({ status: 'failed', error: refusal });
    // On disk too: the pass's own save must not write the error away.
    const onDisk = (await store.load()).mutations;
    expect(onDisk.map(({ key, status, error }) => ({ key, status, error }))).toEqual([
      { key: 'like:p1', status: 'failed', error: refusal },
    ]);
  });

  test('a write ACKED inside send is counted, and is gone', async () => {
    const queue = await OfflineQueue.open(new MemoryQueueStore());
    await queue.enqueue(like(1));
    const report = await queue.drain((mutation) => queue.ack(mutation.key));
    expect(report.sent).toBe(1);
    expect(queue.size).toBe(0);
  });
});
