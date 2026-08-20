// The replicator on its own: what it counts, what it does with a fanout that throws, and that
// stopping it puts back the observer it replaced.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  database,
  entity,
  memoryDriver,
  setRowObserver,
  text,
  uuid,
} from '@ultimat3/entity';
import { startLiveReplicator } from './live-replicator';

const ONE = '00000000-0000-4000-8000-000000000001';

const memos = entity('replicated_memos', {
  columns: { id: uuid().primaryKey(), label: text({ max: 40 }) },
});

/** Only the two members the replicator reaches for; the rest of the registry is not its business. */
const fakeRegistry = (deliver: () => Promise<number>) =>
  ({ deliver, invalidate: () => 0 }) as never;

afterEach(() => {
  setRowObserver(null);
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

  // `bun test` shares one process across files, so an inner harness that cleared unconditionally
  // would take an outer one's observer with it.
  test('stopping restores the observer it replaced, and reports nothing after', async () => {
    const outer = { onChange: () => undefined };
    setRowObserver(outer);
    const replicator = await startLiveReplicator({
      registry: fakeRegistry(() => Promise.resolve(1)),
    });
    replicator.stop();

    const db = database({ memos }, { driver: memoryDriver() });
    await db.memos.insert({ id: ONE, label: 'one' });
    await replicator.settled();
    expect(replicator.delivered).toBe(0);
    expect(setRowObserver(null)).toBe(outer);
  });
});
