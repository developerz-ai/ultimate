// What a long offline session costs the queue (finding R7, plan 101 `13-realtime.md`). A key is
// found by a lookup, never a scan, and the queue is HELD in sequence order, so reading it in that
// order sorts nothing — the queue a UI renders as "unsynced" on every change.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { OfflineQueue, type QueueChange, type QueueState, type QueueStore } from './offline-queue';

/** A store whose own cost is constant per call, so what is timed is the queue and nothing else. */
class FlatStore implements QueueStore {
  #nextSeq = 1;
  async load(): Promise<QueueState> {
    return { mutations: [], nextSeq: this.#nextSeq };
  }
  async write(change: QueueChange): Promise<void> {
    this.#nextSeq = Math.max(this.#nextSeq, change.nextSeq);
  }
}

async function filled(count: number): Promise<OfflineQueue> {
  const queue = await OfflineQueue.open(new FlatStore());
  for (let i = 0; i < count; i += 1) {
    await queue.enqueue({ key: `k${String(i)}`, name: 'likePost', input: { i } });
  }
  return queue;
}

/** Settling every entry by key, best of three: the median-free floor is the stable number. */
async function ackAll(count: number): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round += 1) {
    const queue = await filled(count);
    const started = performance.now();
    // Newest first: a scan from the front pays the whole queue for every one of these.
    for (let i = count - 1; i >= 0; i -= 1) await queue.ack(`k${String(i)}`);
    best = Math.min(best, performance.now() - started);
    expect(queue.size).toBe(0);
  }
  return best;
}

let sorts: ReturnType<typeof spyOn<unknown[], 'sort'>> | null = null;
afterEach(() => {
  sorts?.mockRestore();
  sorts = null;
});

describe('offline queue at scale', () => {
  test('settling by key grows linearly with the queue, not with its square', async () => {
    const small = await ackAll(1_000);
    const large = await ackAll(16_000);
    // 16× the entries: linear is ~16×, a scan per ack is ~256×. The bound sits between with room
    // for a noisy runner either way.
    expect(large / Math.max(small, 0.05)).toBeLessThan(64);
  });

  test('reading the queue in sequence order sorts nothing: it is held in that order', async () => {
    const queue = await filled(50);
    await queue.ack('k10');
    await queue.fail('k20', { code: 'X_POLICY_DENIED', cause: 'denied', fix: 'none' });
    // A failed key re-issued is a new intent at the BACK, with a new sequence number.
    await queue.enqueue({ key: 'k20', name: 'likePost', input: { again: true } });
    sorts = spyOn(Array.prototype, 'sort');
    const pending = queue.pending().map((mutation) => mutation.seq);
    const all = queue.all().map((mutation) => mutation.seq);
    expect(sorts).toHaveBeenCalledTimes(0);
    expect(pending).toEqual([...pending].sort((a, b) => a - b));
    expect(all).toEqual(pending);
    expect(queue.find('k20')?.seq).toBe(51);
    expect(queue.find('k10')).toBeUndefined();
  });
});
