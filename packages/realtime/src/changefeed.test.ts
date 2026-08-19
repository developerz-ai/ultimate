// `InMemoryChangeFeed`'s one guarantee is ORDER, and the promise chain that enforces it is the
// thing that can end delivery for the life of the process. A handler that throws must take its own
// push down with it and nothing else — the rule `window-lock.ts` states for the same shape.

import { describe, expect, test } from 'bun:test';
import { formatLsn, InMemoryChangeFeed, parseLsn } from './changefeed';
import { InProcessTransport } from './fanout';
import type { Row } from './json';

const row: Row = { id: 'p1', title: 'first' };

/** A deferred, so two pushes can be in flight at once without a timer deciding the order. */
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
};

describe('lsn', () => {
  test('a postgres lsn orders the same as a string', () => {
    expect(parseLsn('0/16B3748')).toBe(formatLsn(0x16b3748));
    expect(parseLsn('1/0') > parseLsn('0/FFFFFFFF')).toBe(true);
    expect(formatLsn(2) > formatLsn(1)).toBe(true);
  });
});

describe('InMemoryChangeFeed', () => {
  /**
   * The failure this suite exists for. `#deliver` chained the next delivery on the LIVE tail, so
   * one rejected link poisoned every link after it: later changes rejected with the FIRST error,
   * the handler was never called again, and `lastLsn()` froze — silently, on a healthy process.
   * Reachable under `x dev` and any single-node deployment, because `createReplicator`'s `onChange`
   * awaits `transport.publish(...)` and a closed `InProcessTransport` refuses with
   * `X_TRANSPORT_UNAVAILABLE`. One transient publish failure ended change delivery for good.
   */
  test('a handler that throws takes down its own push and no later one', async () => {
    const closed = new InProcessTransport();
    await closed.close();
    const seen: string[] = [];
    const feed = new InMemoryChangeFeed();
    await feed.start({
      onChange: async (event) => {
        seen.push(event.lsn);
        // The real refusal, not a stand-in: this is what the replicator's own handler does.
        if (event.lsn === formatLsn(1)) await closed.publish('changes', '{}');
      },
    });

    await expect(feed.push('posts', 'insert', { after: row })).rejects.toThrow(
      /X_TRANSPORT_UNAVAILABLE/,
    );
    await feed.push('posts', 'insert', { after: row });
    await feed.push('posts', 'insert', { after: row });

    expect(seen).toEqual([formatLsn(1), formatLsn(2), formatLsn(3)]);
    expect(feed.lastLsn()).toBe(formatLsn(3));
  });

  test('stop() reports the teardown, never a handler failure it already handed to a caller', async () => {
    const feed = new InMemoryChangeFeed();
    await feed.start({
      onChange: () => {
        throw new RangeError('handler exploded');
      },
    });

    await expect(feed.push('posts', 'insert', { after: row })).rejects.toThrow('handler exploded');

    await expect(feed.stop()).resolves.toBeUndefined();
  });

  /** The guarantee the chain exists for, and the one the fix must not spend to get the other. */
  test('two pushes in flight at once are delivered in order, one at a time', async () => {
    const gate = deferred();
    const order: string[] = [];
    const feed = new InMemoryChangeFeed();
    await feed.start({
      onChange: async (event) => {
        order.push(`in:${event.lsn}`);
        if (event.lsn === formatLsn(1)) await gate.promise;
        order.push(`out:${event.lsn}`);
      },
    });

    const first = feed.push('posts', 'insert', { after: row });
    const second = feed.push('posts', 'update', { before: row, after: row });
    // The second handler must not have started while the first is parked.
    await Promise.resolve();
    expect(order).toEqual([`in:${formatLsn(1)}`]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual([
      `in:${formatLsn(1)}`,
      `out:${formatLsn(1)}`,
      `in:${formatLsn(2)}`,
      `out:${formatLsn(2)}`,
    ]);
    expect(feed.lastLsn()).toBe(formatLsn(2));
  });

  test('a throw in one delivery does not rewind the lsn a later one recorded', async () => {
    const feed = new InMemoryChangeFeed();
    let fail = true;
    await feed.start({
      onChange: () => {
        if (!fail) return;
        fail = false;
        throw new RangeError('first only');
      },
    });

    await expect(feed.push('posts', 'insert', { after: row })).rejects.toThrow('first only');
    await feed.push('posts', 'insert', { after: row });

    // The failed delivery never reached its checkpoint, so lsn 1 is not recorded; lsn 2 is.
    expect(feed.lastLsn()).toBe(formatLsn(2));
  });
});
