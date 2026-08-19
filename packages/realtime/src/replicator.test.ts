/**
 * The replicator's lifecycle and its counters: who holds the advisory lock, what `/readyz` reads,
 * and the three numbers that tell a standby node apart from a broken one.
 *
 * `InMemoryAdvisoryLock` keys a PROCESS-global set, so every test here mints its own key — sharing
 * one would make the second test's `start()` depend on the first having run and released.
 */

import { describe, expect, test } from 'bun:test';
import type { ChangeEvent, ChangeFeed } from './changefeed';
import { formatLsn, InMemoryChangeFeed } from './changefeed';
import { InProcessTransport } from './fanout';
import { createReplicator, InMemoryAdvisoryLock } from './replicator';
import { defaultBackoff } from './thundering-herd';

let keyCounter = 0;
const freshKey = (): string => {
  keyCounter += 1;
  return `x:replicator:lifecycle:${keyCounter}`;
};

const rig = (key: string) => {
  const feed = new InMemoryChangeFeed();
  const transport = new InProcessTransport();
  const lock = new InMemoryAdvisoryLock(key);
  return {
    feed,
    transport,
    lock,
    replicator: createReplicator({
      feed,
      transport,
      lock,
      backoff: { ...defaultBackoff, jitter: 'none' },
    }),
  };
};

const event = (over: Partial<ChangeEvent>): ChangeEvent => ({
  entity: 'posts',
  op: 'insert',
  before: null,
  after: { id: 'p1' },
  lsn: formatLsn(1),
  txid: '1',
  orgId: 'o1',
  at: 0,
  ...over,
});

describe('the advisory lock decides which node replicates', () => {
  test('running is false until start acquires the lock, and false again after stop', async () => {
    const key = freshKey();
    const { replicator } = rig(key);
    expect(replicator.running).toBe(false);

    expect(await replicator.start()).toBe(true);
    expect(replicator.running).toBe(true);

    await replicator.stop();
    expect(replicator.running).toBe(false);
  });

  test('a standby answers false and stays not-running, so /readyz cannot go green', async () => {
    const key = freshKey();
    const primary = rig(key);
    const standby = rig(key);

    expect(await primary.replicator.start()).toBe(true);
    expect(await standby.replicator.start()).toBe(false);
    expect(standby.replicator.running).toBe(false);

    await primary.replicator.stop();
  });

  test('stop releases the lock, which is what lets a standby take over', async () => {
    const key = freshKey();
    const primary = rig(key);
    const standby = rig(key);

    await primary.replicator.start();
    expect(await standby.replicator.start()).toBe(false);

    await primary.replicator.stop();
    expect(await standby.replicator.start()).toBe(true);
    expect(standby.replicator.running).toBe(true);

    await standby.replicator.stop();
  });

  test('stop on a replicator that never started does not release a lock it does not hold', async () => {
    const key = freshKey();
    const holder = rig(key);
    const other = rig(key);
    await holder.replicator.start();

    // `other` never acquired it — its stop must be a no-op, not a way to steal the lock.
    await other.replicator.stop();
    expect(await other.replicator.start()).toBe(false);
    expect(holder.replicator.running).toBe(true);

    await holder.replicator.stop();
  });

  test('start is idempotent while running, and does not re-acquire', async () => {
    const key = freshKey();
    const { replicator } = rig(key);
    expect(await replicator.start()).toBe(true);
    expect(await replicator.start()).toBe(true);
    expect(replicator.running).toBe(true);
    await replicator.stop();
  });
});

describe('lastLsn', () => {
  /** A feed that already knows where it left off — the shape a resumed pg replication slot has. */
  const resumedFeed = (at: string | null): ChangeFeed => ({
    source: 'resumed',
    start: async () => undefined,
    stop: async () => undefined,
    lastLsn: () => at,
  });

  test("is the FEED's position until this run publishes something of its own", async () => {
    const feed = resumedFeed(formatLsn(4_096));
    const replicator = createReplicator({
      feed,
      transport: new InProcessTransport(),
      lock: new InMemoryAdvisoryLock(freshKey()),
    });

    // A replicator that just took the lock has published nothing, and answering `null` here is
    // what makes the next `start({ from })` replay the whole retained window.
    expect(replicator.lastLsn()).toBe(formatLsn(4_096));
    await replicator.start();
    expect(replicator.lastLsn()).toBe(formatLsn(4_096));
    await replicator.stop();
  });

  test('a feed with no position at all is null, not an empty string', async () => {
    const replicator = createReplicator({
      feed: resumedFeed(null),
      transport: new InProcessTransport(),
      lock: new InMemoryAdvisoryLock(freshKey()),
    });
    expect(replicator.lastLsn()).toBe(null);
  });

  test('is the lsn of the last change this replicator actually published', async () => {
    const key = freshKey();
    const { replicator, feed } = rig(key);
    await replicator.start();

    const first = await feed.push('posts', 'insert', { after: { id: 'p1' }, orgId: 'o1' });
    expect(replicator.lastLsn()).toBe(first.lsn);
    const second = await feed.push('posts', 'insert', { after: { id: 'p2' }, orgId: 'o1' });
    expect(replicator.lastLsn()).toBe(second.lsn);
    expect(second.lsn > first.lsn).toBe(true);

    await replicator.stop();
  });
});

describe('stats separate "nothing to send" from "already sent" from "sent"', () => {
  test('counts published, skipped and out-of-order apart', async () => {
    const key = freshKey();
    const { replicator, feed } = rig(key);
    expect(replicator.stats()).toEqual({ published: 0, skipped: 0, outOfOrder: 0 });
    await replicator.start();

    await feed.emit(event({ lsn: formatLsn(10) }));
    expect(replicator.stats()).toEqual({ published: 1, skipped: 0, outOfOrder: 0 });

    // No row at all: nothing to fan out, and not a failure either.
    await feed.emit(event({ lsn: formatLsn(11), before: null, after: null }));
    expect(replicator.stats()).toEqual({ published: 1, skipped: 1, outOfOrder: 0 });

    // At-least-once delivery: the feed repeating an lsn it already sent is expected.
    await feed.emit(event({ lsn: formatLsn(10) }));
    await feed.emit(event({ lsn: formatLsn(9) }));
    expect(replicator.stats()).toEqual({ published: 1, skipped: 1, outOfOrder: 2 });

    // And the stream continues past the repeat rather than being wedged by it.
    await feed.emit(event({ lsn: formatLsn(12) }));
    expect(replicator.stats()).toEqual({ published: 2, skipped: 1, outOfOrder: 2 });

    await replicator.stop();
  });

  test('the counters are a snapshot, not the live object', async () => {
    const key = freshKey();
    const { replicator, feed } = rig(key);
    await replicator.start();
    await feed.emit(event({ lsn: formatLsn(10) }));
    const before = replicator.stats();
    await feed.emit(event({ lsn: formatLsn(11) }));

    expect(before.published).toBe(1);
    expect(replicator.stats().published).toBe(2);

    await replicator.stop();
  });
});

describe('retryDelayMs', () => {
  test('grows with the attempt and is capped, so N standbys do not poll a held lock forever', () => {
    const { replicator } = rig(freshKey());
    expect(replicator.retryDelayMs(0)).toBe(defaultBackoff.baseMs);
    expect(replicator.retryDelayMs(1)).toBe(defaultBackoff.baseMs * defaultBackoff.factor);
    expect(replicator.retryDelayMs(99)).toBe(defaultBackoff.maxMs);
  });

  test('the injected rng is what jitters it, so a takeover storm is spread', () => {
    const feed = new InMemoryChangeFeed();
    const spread = createReplicator({
      feed,
      transport: new InProcessTransport(),
      lock: new InMemoryAdvisoryLock(freshKey()),
      backoff: { ...defaultBackoff, jitter: 'full' },
      rng: () => 0.25,
    });
    // Full jitter over the same ceiling: a quarter of it, not the whole wait.
    expect(spread.retryDelayMs(1)).toBe(
      Math.round(defaultBackoff.baseMs * defaultBackoff.factor * 0.25),
    );
  });
});
