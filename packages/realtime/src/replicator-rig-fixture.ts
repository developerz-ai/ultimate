// Single responsibility: the replicator's interleaving rig — a stub lock, a gated feed and a manual
// scheduler — so the order of events is a test's and never the runtime's. Shared by the suites that
// drive `changeFeedReplicator` through its seams; kept out of them so neither outgrows its ceiling.
// Not part of the public API — `index.ts` deliberately does not re-export it.

import type { AdvisoryLock } from './advisory-lock';
import type { ChangeEvent, ChangeFeed, ChangeFeedStartOptions } from './changefeed';
import { formatLsn } from './changefeed';
import type { Transport } from './fanout';
import { InProcessTransport } from './fanout';
import { changeFeedReplicator, STOP_DEADLINE_MS } from './replicator';
import type { Scheduler } from './thundering-herd';

export const turns = async (count = 100): Promise<void> => {
  for (let tick = 0; tick < count; tick += 1) await Promise.resolve();
};

export const NEVER = new Promise<void>(() => undefined);

export const stubLock = () => {
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

export const gatedFeed = () => {
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

export const manual = () => {
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

export const change = (position: number): ChangeEvent => ({
  table: 'posts',
  op: 'insert',
  before: null,
  after: { id: `p${position}` },
  lsn: formatLsn(position),
  txid: String(position),
  orgId: 'o1',
  at: 0,
  write: null,
});

export const rig = (transport: Transport = new InProcessTransport()) => {
  const lock = stubLock();
  const feed = gatedFeed();
  const abandonLock = lock.abandon;
  lock.abandon = (): void => {
    feed.order.push('lock.abandon');
    abandonLock();
  };
  const timers = manual();
  const replicator = changeFeedReplicator({
    feed,
    lock,
    transport,
    schedule: timers.schedule,
    backoff: { baseMs: 100, maxMs: 10_000, factor: 2, jitter: 'none' },
  });
  return { lock, feed, timers, replicator };
};
