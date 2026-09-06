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
import type { AdvisoryLock } from './replicator';
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

/**
 * Two `start()` calls that overlap. The guard `if (running) return true` is a check, and the very
 * next line awaits `lock.tryAcquire()` — so both callers passed it, both were told they held the
 * lock (a real `PgAdvisoryLock` answers `true` to a holder), and BOTH called `feed.start()`. One
 * replication slot with two pumps means every change published twice, under two `seq` generations
 * from one producer id: `SeqGapDetector` on every sync node then reads a gap where there is none,
 * marks every window stale and re-snapshots the fleet, on every change, forever. Reachable from
 * `/readyz` polling a supervisor's start beside the takeover loop's own retry.
 */
describe('start is memoised while it is in flight', () => {
  /** The shape a real `PgAdvisoryLock` has: an await between being asked and answering. */
  const awaitingLock = (): AdvisoryLock & {
    readonly calls: () => number;
    readonly releases: () => number;
  } => {
    let calls = 0;
    let releases = 0;
    return {
      key: 'x:replicator:awaiting',
      tryAcquire: async () => {
        calls += 1;
        await Promise.resolve();
        return true;
      },
      release: async () => {
        releases += 1;
      },
      calls: () => calls,
      releases: () => releases,
    };
  };

  const countingFeed = (): ChangeFeed & {
    readonly starts: () => number;
    readonly stops: () => number;
  } => {
    let starts = 0;
    let stops = 0;
    return {
      source: 'counting',
      start: async () => {
        starts += 1;
      },
      stop: async () => {
        stops += 1;
      },
      lastLsn: () => null,
      starts: () => starts,
      stops: () => stops,
    };
  };

  test('two concurrent starts run ONE feed and take ONE acquisition', async () => {
    const feed = countingFeed();
    const lock = awaitingLock();
    const replicator = createReplicator({ feed, lock, transport: new InProcessTransport() });

    expect(await Promise.all([replicator.start(), replicator.start()])).toEqual([true, true]);
    expect(feed.starts()).toBe(1);
    expect(lock.calls()).toBe(1);
    expect(replicator.running).toBe(true);
  });

  test('a stop racing a start waits it out, and stops the feed that start began', async () => {
    // `running` is false for the whole of the acquisition, so an unguarded `stop()` answers "not
    // running, nothing to do" and returns — leaving a feed pumping into a replicator nothing
    // intends to stop, with the advisory lock still held by a process that already shut down.
    const feed = countingFeed();
    const lock = awaitingLock();
    const replicator = createReplicator({ feed, lock, transport: new InProcessTransport() });

    const starting = replicator.start();
    const stopping = replicator.stop();
    expect(await starting).toBe(true);
    await stopping;

    expect(feed.starts()).toBe(1);
    expect(feed.stops()).toBe(1);
    expect(lock.releases()).toBe(1);
    expect(replicator.running).toBe(false);
  });

  test('a feed that fails to start hands the lock BACK, and this node is not running', async () => {
    // `running = true` sat before `await feed.start()`, so a feed that rejected left this node
    // holding the advisory lock, claiming to run and pumping nothing: the takeover loop's next
    // `start()` was answered `true` by the `if (running)` guard without ever calling `begin`, and
    // every standby stayed a standby of a slot whose holder was not replicating.
    const lock = awaitingLock();
    const failing: ChangeFeed = {
      source: 'failing',
      start: () => Promise.reject(new Error('replication slot is in use')),
      stop: async () => undefined,
      lastLsn: () => null,
    };
    const replicator = createReplicator({
      feed: failing,
      lock,
      transport: new InProcessTransport(),
    });

    await expect(replicator.start()).rejects.toThrow(/replication slot is in use/);
    expect(replicator.running).toBe(false);
    expect(lock.releases()).toBe(1);

    // And the retry is a real one: `begin` runs again rather than being answered by a memo over a
    // feed that never pumped.
    const feed = countingFeed();
    const retried = createReplicator({ feed, lock, transport: new InProcessTransport() });
    expect(await retried.start()).toBe(true);
    expect(feed.starts()).toBe(1);
    expect(lock.calls()).toBe(2);
    await retried.stop();
  });

  test('a stop after a failed start is a no-op — the lock is not released twice', async () => {
    const lock = awaitingLock();
    const replicator = createReplicator({
      feed: {
        source: 'failing',
        start: () => Promise.reject(new Error('slot busy')),
        stop: async () => undefined,
        lastLsn: () => null,
      },
      lock,
      transport: new InProcessTransport(),
    });

    await expect(replicator.start()).rejects.toThrow(/slot busy/);
    await replicator.stop();
    expect(lock.releases()).toBe(1);
  });

  test('a start that never acquired can be tried again — the memo does not stick', async () => {
    const key = freshKey();
    const holder = rig(key);
    const standby = rig(key);
    await holder.replicator.start();

    expect(await standby.replicator.start()).toBe(false);
    await holder.replicator.stop();
    expect(await standby.replicator.start()).toBe(true);
    await standby.replicator.stop();
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
