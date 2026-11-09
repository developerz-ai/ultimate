// The replicator on its own: what it counts, what it does with a fanout that throws, and that
// stopping it puts back the observer it replaced.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetInstrumentation, subscribe } from '@ultimat3/core';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { startLiveReplicator } from './live-replicator';

const ONE = '00000000-0000-4000-8000-000000000001';

const memos = entity('replicated_memos', {
  columns: { id: uuid().primaryKey(), label: text({ max: 40 }) },
});

/** Only the two members the replicator reaches for; the rest of the registry is not its business. */
const fakeRegistry = (deliver: () => Promise<number>) =>
  ({ deliver, invalidate: () => 0 }) as never;

afterEach(() => {
  resetInstrumentation();
  clearRegistry();
});

describe('the in-process replicator', () => {
  test('counts the frames a fanout reported sending', async () => {
    const replicator = await startLiveReplicator({
      registry: fakeRegistry(() => Promise.resolve(2)),
    });
    const db = database({ memos }, { driver: memoryDriver() });
    await db.memos.insert({ id: ONE, label: 'one' });
    await replicator.settled();
    expect(replicator.delivered).toBe(2);
    replicator.stop();
  });

  // `x dev`'s only change feed under the embedded database: a channel it skipped never carried a
  // write to another tab, while the live-query half stayed green.
  test('feeds the declared channels the same change, even when the live-query fanout fails', async () => {
    const changes: unknown[] = [];
    const replicator = await startLiveReplicator({
      registry: fakeRegistry(() => Promise.reject(new Error('lane failed'))),
      channels: { deliverChange: (change) => changes.push(change), invalidate: () => 0 },
      onError: () => undefined,
    });
    const db = database({ memos }, { driver: memoryDriver() });
    await db.memos.insert({ id: ONE, label: 'one' });
    await replicator.settled();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      table: 'replicated_memos',
      op: 'insert',
      after: { id: ONE },
    });
    replicator.stop();
  });

  /**
   * One failed fanout must not silence every change behind it, and a rejection with nobody left to
   * hand it to ends the Bun process — so the chain catches and reports rather than rethrows.
   */
  test('a fanout that throws is reported, and the next change still lands', async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const replicator = await startLiveReplicator({
      registry: fakeRegistry(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('lane failed')) : Promise.resolve(1);
      }),
      onError: (error) => seen.push(error),
    });
    const db = database({ memos }, { driver: memoryDriver() });
    await db.memos.insert({ id: ONE, label: 'one' });
    await db.memos.insert({ id: '00000000-0000-4000-8000-000000000002', label: 'two' });
    await replicator.settled();

    expect(seen).toHaveLength(1);
    expect(replicator.delivered).toBe(1);
    replicator.stop();
  });

  // `bun test` shares one process across files, so an inner harness must never take an outer
  // one's subscription with it — the slot this replaced did exactly that (v31).
  test('stopping releases only its own subscription, and reports nothing after', async () => {
    const outer: string[] = [];
    const offOuter = subscribe('entity.row', (event) => outer.push(event.payload.entity));
    const replicator = await startLiveReplicator({
      registry: fakeRegistry(() => Promise.resolve(1)),
    });
    replicator.stop();

    const db = database({ memos }, { driver: memoryDriver() });
    await db.memos.insert({ id: ONE, label: 'one' });
    await replicator.settled();
    expect(replicator.delivered).toBe(0);
    expect(outer).toEqual(['replicated_memos']);
    offOuter();
  });

  test('two replicators both hear a write: the bus fans out, a slot replaced', async () => {
    const first = await startLiveReplicator({ registry: fakeRegistry(() => Promise.resolve(1)) });
    const second = await startLiveReplicator({ registry: fakeRegistry(() => Promise.resolve(1)) });

    const db = database({ memos }, { driver: memoryDriver() });
    await db.memos.insert({ id: ONE, label: 'one' });
    await first.settled();
    await second.settled();
    expect([first.delivered, second.delivered]).toEqual([1, 1]);
    first.stop();
    second.stop();
  });
});
