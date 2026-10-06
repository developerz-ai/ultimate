// The replicator's interleavings, each driven through the injected seams — a stub lock, a gated
// feed and a manual scheduler — so the order of events is the test's and never the runtime's.

import { describe, expect, test } from 'bun:test';
import type { AdvisoryLock } from './advisory-lock';
import type { ChangeEvent, ChangeFeed, ChangeFeedStartOptions } from './changefeed';
import { formatLsn } from './changefeed';
import type { Transport } from './fanout';
import { InProcessTransport } from './fanout';
import { createReplicator, STOP_DEADLINE_MS } from './replicator';
import type { Scheduler } from './thundering-herd';

const turns = async (count = 100): Promise<void> => {
  for (let tick = 0; tick < count; tick += 1) await Promise.resolve();
};

const NEVER = new Promise<void>(() => undefined);

const stubLock = () => {
  const listeners = new Set<(reason: string) => void>();
  const lock = {
    key: 'x:replicator:races',
    held: false,
    acquired: 0,
    released: 0,
    abandoned: 0,
    /** What `release()` waits on. `NEVER` is a session whose unlock is never answered. */
    releasing: Promise.resolve() as Promise<void>,
    tryAcquire: async (): Promise<boolean> => {
      lock.acquired += 1;
      lock.held = true;
      return true;
    },
    release: async (): Promise<void> => {
      lock.released += 1;
      await lock.releasing;
      lock.held = false;
    },
    abandon: (): void => {
      lock.abandoned += 1;
      lock.held = false;
    },
    onLost: (listener: (reason: string) => void): (() => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    lose: (reason: string): void => {
      lock.held = false;
      for (const listener of [...listeners]) listener(reason);
    },
  };
  return lock satisfies AdvisoryLock;
};

const gatedFeed = () => {
  const feed = {
    source: 'gated',
    starts: 0,
    stops: 0,
    abandons: 0,
    /** Who was abandoned, in order — the feed must be silent before the lock is given up. */
    order: [] as string[],
    pumping: false,
    froms: [] as (string | undefined)[],
    handlers: undefined as ChangeFeedStartOptions | undefined,
    /** What `start()` waits on before it reports the stream live. */
    dialling: Promise.resolve() as Promise<void>,
    stopping: Promise.resolve() as Promise<void>,
    start: async (options: ChangeFeedStartOptions): Promise<void> => {
      feed.starts += 1;
      feed.froms.push(options.from);
      await feed.dialling;
      feed.handlers = options;
      feed.pumping = true;
    },
    stop: async (): Promise<void> => {
      feed.stops += 1;
      await feed.stopping;
      feed.pumping = false;
    },
    abandon: (): void => {
      feed.abandons += 1;
      feed.order.push('feed.abandon');
      feed.pumping = false;
    },
    lastLsn: (): string | null => null,
    /** Deliver one change the way a pump does: a handler that rejects ends the stream. */
    deliver: async (change: ChangeEvent): Promise<void> => {
      const handlers = feed.handlers;
      if (handlers === undefined || !feed.pumping) return;
      try {
        await handlers.onChange(change);
      } catch (error) {
        feed.pumping = false;
        handlers.onEnd?.(error instanceof Error ? error.message : String(error));
      }
    },
    end: (reason: string): void => {
      feed.pumping = false;
      feed.handlers?.onEnd?.(reason);
    },
  };
  return feed satisfies ChangeFeed;
};

const manual = () => {
  const pending: { fn: () => void; ms: number }[] = [];
  const delays: number[] = [];
  const schedule: Scheduler = (fn, ms) => {
    const entry = { fn, ms };
    // The unlock deadline rides the same seam; `delays` is the RESTART waits alone.
    if (ms !== STOP_DEADLINE_MS) delays.push(ms);
    pending.push(entry);
    return () => {
      const at = pending.indexOf(entry);
      if (at >= 0) pending.splice(at, 1);
    };
  };
  return {
    schedule,
    delays,
    pending,
    fire: (): void => {
      for (const entry of pending.splice(0)) entry.fn();
    },
  };
};

const change = (position: number): ChangeEvent => ({
  entity: 'posts',
  op: 'insert',
  before: null,
  after: { id: `p${position}` },
  lsn: formatLsn(position),
  txid: String(position),
  orgId: 'o1',
  at: 0,
  write: null,
});

const rig = (transport: Transport = new InProcessTransport()) => {
  const lock = stubLock();
  const feed = gatedFeed();
  const abandonLock = lock.abandon;
  lock.abandon = (): void => {
    feed.order.push('lock.abandon');
    abandonLock();
  };
  const timers = manual();
  const replicator = createReplicator({
    feed,
    lock,
    transport,
    schedule: timers.schedule,
    backoff: { baseMs: 100, maxMs: 10_000, factor: 2, jitter: 'none' },
  });
  return { lock, feed, timers, replicator };
};

/** A bus that refuses every publish — a change over the payload limit refuses every time. */
const refusing = (): Transport & { published: string[]; refuse: boolean } => {
  const inner = new InProcessTransport();
  const bus = {
    name: 'refusing',
    shared: inner.shared,
    published: [] as string[],
    refuse: true,
    subscribe: inner.subscribe.bind(inner),
    close: () => inner.close(),
    onReconnect: () => inner.onReconnect(),
    publish: async (_subject: string, payload: string): Promise<void> => {
      if (bus.refuse) throw new TypeError('payload exceeds max_payload');
      bus.published.push(payload);
    },
  };
  return bus;
};

describe('a lock lost while the feed is still dialling', () => {
  test('fails the start and stops the feed: nothing streams without the lock', async () => {
    const { lock, feed, timers, replicator } = rig();
    let dialled = (): void => undefined;
    feed.dialling = new Promise((resolve) => {
      dialled = resolve;
    });
    const starting = replicator.start();
    await turns();
    expect(feed.starts).toBe(1);

    // The lock session dies now, and says so exactly once.
    lock.lose('the server closed the connection');
    dialled();
    const outcome = await starting.then(
      (started) => started,
      (error: unknown) => error,
    );

    expect((outcome as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect((outcome as { cause?: string }).cause).toContain('advisory lock');
    expect(replicator.running).toBe(false);
    expect(feed.pumping).toBe(false);
    expect(lock.held).toBe(false);
    expect(timers.delays).toEqual([]);
  });
});

describe('a lock session that never answers', () => {
  test('a dead stream does not ask it: the takeover loop starts anyway', async () => {
    const { lock, feed, timers, replicator } = rig();
    await replicator.start();
    lock.releasing = NEVER;

    feed.end('the walsender ended the copy stream');
    await turns();

    expect(lock.released).toBe(0);
    expect(lock.abandoned).toBe(1);
    expect(timers.delays).toEqual([100]);
    lock.releasing = Promise.resolve();
    await replicator.stop();
  });

  test('stop() gives the unlock a deadline, then drops the session', async () => {
    const { lock, feed, timers, replicator } = rig();
    await replicator.start();
    lock.releasing = NEVER;

    let stopped = false;
    const stopping = replicator.stop().then(() => {
      stopped = true;
    });
    await turns();
    expect(feed.stops).toBe(1);
    expect(stopped).toBe(false);

    timers.fire();
    await stopping;
    expect(lock.abandoned).toBe(1);
    expect(lock.held).toBe(false);
  });

  test('an unlock that answers in time arms no leftover timer', async () => {
    const { lock, timers, replicator } = rig();
    await replicator.start();
    await replicator.stop();
    expect(lock.released).toBe(1);
    expect(lock.abandoned).toBe(0);
    expect(timers.pending).toHaveLength(0);
  });
});

describe('a stream that starts and then dies, again and again', () => {
  test('backs off until a change is PUBLISHED, and says which change keeps failing', async () => {
    const bus = refusing();
    const { feed, timers, replicator } = rig(bus);
    await replicator.start();

    for (let round = 0; round < 4; round += 1) {
      await feed.deliver(change(7));
      await turns();
      // Started, and still not replicating: the change it owes has not gone out.
      expect(replicator.running).toBe(false);
      timers.fire();
      await turns();
    }
    expect(timers.delays).toEqual([100, 200, 400, 800]);
    expect(replicator.running).toBe(false);
    const failure = replicator.stats().failure ?? '';
    expect(failure).toContain(formatLsn(7));
    expect(failure).toContain('posts');
    expect(failure).toContain('payload exceeds max_payload');

    // The bus takes it at last: published, running, and the next death waits the base again.
    bus.refuse = false;
    await feed.deliver(change(7));
    await turns();
    expect(bus.published).toHaveLength(1);
    expect(replicator.running).toBe(true);
    expect(replicator.stats().failure).toBeNull();

    feed.end('the walsender ended the copy stream');
    await turns();
    expect(timers.delays).toEqual([100, 200, 400, 800, 100]);
    await replicator.stop();
  });
});

describe('a start right after a loss', () => {
  // The teardown used to be asynchronous: parked in `feed.stop()` with the lock still held, so a
  // `start()` was told it held the lock and answered `true` over a feed about to be stopped.
  test('finds nothing held and begins a run of its own', async () => {
    const { lock, feed, timers, replicator } = rig();
    await replicator.start();
    feed.stopping = NEVER;
    feed.end('the walsender ended the copy stream');

    // No turn of the event loop in between: the loss has already let everything go.
    expect(lock.held).toBe(false);
    expect(await replicator.start()).toBe(true);
    expect(lock.acquired).toBe(2);
    expect(feed.starts).toBe(2);
    expect(feed.pumping).toBe(true);
    expect(replicator.running).toBe(true);

    // The timer the loss armed finds a running replicator and does nothing.
    timers.fire();
    await turns();
    expect(feed.starts).toBe(2);
    feed.stopping = Promise.resolve();
    await replicator.stop();
  });
});

describe('stop() when the feed refuses to stop', () => {
  test('still releases the lock, and reports the feed failure', async () => {
    const { lock, feed, replicator } = rig();
    await replicator.start();
    feed.stop = async (): Promise<void> => {
      feed.stops += 1;
      throw new TypeError('socket close failed');
    };

    await expect(replicator.stop()).rejects.toThrow(/socket close failed/);
    expect(lock.released).toBe(1);
    expect(lock.held).toBe(false);
  });
});

describe('a feed whose stop() never settles', () => {
  // A black-holed walsender socket is what PRODUCES a lost stream, and it is also a socket whose
  // polite goodbye is never answered. Asked to stop, the recovery waited on it forever.
  test('on the lost path it is not asked: the feed is abandoned and the takeover loop starts', async () => {
    const { lock, feed, timers, replicator } = rig();
    await replicator.start();
    feed.stopping = NEVER;

    feed.end('the walsender ended the copy stream');
    await turns();

    expect(feed.stops).toBe(0);
    expect(feed.abandons).toBe(1);
    expect(feed.pumping).toBe(false);
    // The feed first, then the lock: silent before the grant is given up.
    expect(feed.order).toEqual(['feed.abandon', 'lock.abandon']);
    expect(lock.held).toBe(false);
    expect(timers.delays).toEqual([100]);
  });

  test('stop() gives the goodbye a deadline, then abandons the feed and still lets the lock go', async () => {
    const { lock, feed, timers, replicator } = rig();
    await replicator.start();
    feed.stopping = NEVER;

    let stopped = false;
    const stopping = replicator.stop().then(() => {
      stopped = true;
    });
    await turns();
    expect(feed.stops).toBe(1);
    expect(stopped).toBe(false);

    timers.fire();
    await stopping;
    expect(feed.abandons).toBe(1);
    expect(feed.pumping).toBe(false);
    expect(lock.held).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });
});

describe('changes still buffered when the lock is lost', () => {
  test('are not published by a run that no longer holds it', async () => {
    const published: string[] = [];
    const transport = new InProcessTransport();
    await transport.subscribe('x.change.>', (payload) => void published.push(payload));
    const { lock, feed, replicator } = rig(transport);
    await replicator.start();
    const stale = feed.handlers;
    await feed.deliver(change(1));
    expect(published).toHaveLength(1);

    // The feed has not been told to stop yet: its socket still holds two more changes.
    feed.stopping = NEVER;
    lock.lose('the server closed the connection');
    await turns();
    const refused = await Promise.resolve(stale?.onChange(change(2))).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(published).toHaveLength(1);
    // Refused, not swallowed: a handler that returned would let the stream confirm the change.
    expect((refused as { code?: string } | undefined)?.code).toBe('X_REPLICATION_FAILED');
    expect(replicator.stats().published).toBe(1);
  });
});
