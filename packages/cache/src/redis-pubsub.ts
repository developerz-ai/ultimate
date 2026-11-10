// Single responsibility: the hop that carries cache invalidations between replicas over Redis
// pub/sub — what a fleet with `REDIS_URL` and no NATS publishes its busts on. The CLI boot picks
// it (`packages/cli/src/runtime-cache-bus.ts`); this file only speaks the protocol.

import { logger, renderThrowable } from '@ultimat3/core';
import { REDIS_CLIENT_OPTIONS } from '@ultimat3/core/redis';
import type { RedisClient } from 'bun';

export type PubSubListener = (message: string, channel: string) => void;

/** The part of a connection in subscriber mode this hop drives — structurally `Bun.RedisClient`. */
export interface RedisSubscriberLike {
  subscribe(channel: string, listener: PubSubListener): Promise<number>;
  unsubscribe(channel: string): Promise<void>;
  /** Fired on EVERY connect, the first included. The only reconnect signal Bun gives. */
  onconnect: ((this: RedisClient) => void) | null;
  close(): void;
}

/**
 * The publishing connection — a dedicated one, never core's shared client: its `onconnect` is how
 * the hop hears the publisher is back, and a shared client's one slot is every holder's.
 */
export interface RedisPublisherLike {
  publish(channel: string, message: string): Promise<number>;
  readonly connected: boolean;
  /** Resolves once connected; against a server that is down, Bun's never settles. */
  connect(): Promise<void>;
  /** Fired on EVERY connect, the first included. */
  onconnect: ((this: RedisClient) => void) | null;
  close(): void;
}

/**
 * How long a publish waits for a publisher that is not connected — ONCE per outage, never per
 * publish: the client dials in the background with no offline queue, so a bust in a process's
 * first milliseconds was refused (measured: a replica that booted and wrote at once told no peer),
 * and a bust just after a restart likewise. Past this a publish refuses at once and the hop defers
 * it; the publisher's `onconnect` then announces the return, and the deferred busts are sent.
 */
export const PUBLISHER_CONNECT_WAIT_MS = 1_000;

export interface InvalidationSubscription {
  unsubscribe(): void;
}

/**
 * The shape the CLI's invalidation hop reads off a bus: `@ultimat3/realtime`'s `Transport` has it
 * too, which is how one hop runs over either (realtime is tier 3; this package cannot name it).
 */
export interface InvalidationBus {
  readonly name: string;
  publish(subject: string, payload: string): Promise<void>;
  subscribe(subject: string, handler: (payload: string) => void): Promise<InvalidationSubscription>;
  onReconnect(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface RedisPubSubOptions {
  readonly publisher: RedisPublisherLike;
  /**
   * A connection of its own: one in subscriber mode refuses every other command, so handing it
   * the shared client would refuse every cache read in the process.
   */
  readonly subscriber: RedisSubscriberLike;
}

/**
 * Pub/sub over two connections. What Bun 1.4.4 does on a dropped connection, measured on Redis 7
 * (`CLIENT KILL TYPE pubsub`): it reconnects and fires `onconnect`, the SERVER has forgotten the
 * subscription (`PUBSUB NUMSUB` 0), and the CLIENT still holds the old listener — so a bare
 * re-`SUBSCRIBE` delivers every message twice. Each reconnect therefore unsubscribes, subscribes
 * afresh, and only then tells `onReconnect` — whose listener drops what this process holds,
 * because whatever was published while it was away is gone (pub/sub keeps nothing). The first
 * connect is announced as well, and so is every connect of the PUBLISHER: each is when a bust
 * refused while it was away can be published (Redis restarted, the subscriber came back first,
 * the settle was refused by a publisher still down — and nothing else would say it was back).
 *
 * Every SUBSCRIBE/UNSUBSCRIBE runs in one lane: two resubscribes that overlapped (a flapping
 * connection), or a `subscribe` beside one, registered `dispatch` twice and delivered every bust
 * twice.
 */
export function redisPubSub(options: RedisPubSubOptions): InvalidationBus {
  const { publisher, subscriber } = options;
  const handlers = new Map<string, Set<(payload: string) => void>>();
  const listeners = new Set<() => void>();
  let closed = false;
  /** This outage's one bounded wait for the publisher; cleared when it connects. */
  let waiting: Promise<unknown> | undefined;
  let lane: Promise<unknown> = Promise.resolve();
  /** Runs `step` after every subscriber command queued before it, success or not. */
  const inLane = <T>(step: () => Promise<T>): Promise<T> => {
    const run = lane.then(step, step);
    lane = run.catch(() => undefined);
    return run;
  };
  const announce = (): void => {
    for (const listener of listeners) listener();
  };

  const dispatch: PubSubListener = (message, channel) => {
    for (const handler of handlers.get(channel) ?? []) handler(message);
  };

  /**
   * Bun 1.4.4 THROWS, synchronously, `ERR_REDIS_INVALID_STATE` from `unsubscribe` on a client that
   * holds no listener (measured) — a `.catch()` on its result never sees it, and the first
   * subscribe of a fresh connection failed forever. Nothing to drop is the answer here.
   */
  const unsubscribeQuietly = async (channel: string): Promise<void> => {
    try {
      await subscriber.unsubscribe(channel);
    } catch {
      // Not subscribed, or the connection is away: either way no listener is left to double.
    }
  };

  /**
   * `channel` held by exactly one `dispatch`: UNSUBSCRIBE first, because Bun keeps a listener the
   * server forgot. In the lane this is idempotent, so a `subscribe` queued behind a resubscribe
   * that already covered its channel registers nothing twice.
   */
  const subscribeOnce = async (channel: string): Promise<void> => {
    await unsubscribeQuietly(channel);
    await subscriber.subscribe(channel, dispatch);
  };

  const resubscribe = async (): Promise<void> => {
    try {
      for (const channel of [...handlers.keys()]) await subscribeOnce(channel);
    } catch (error) {
      // The connection went again before the subscribe landed; its next `onconnect` retries.
      logger.warn('cache.broadcast.resubscribe-failed', { error: renderThrowable(error) });
      return;
    }
    announce();
  };

  // The first connect too: whatever the hop could not publish or subscribe before it is owed now.
  subscriber.onconnect = () => {
    if (!closed) void inLane(resubscribe);
  };
  publisher.onconnect = () => {
    waiting = undefined;
    if (!closed) announce();
  };

  return {
    name: 'redis',
    async publish(subject, payload) {
      if (!publisher.connected) {
        waiting ??= Promise.race([
          publisher.connect().catch(() => undefined),
          Bun.sleep(PUBLISHER_CONNECT_WAIT_MS),
        ]);
        await waiting;
      }
      await publisher.publish(subject, payload);
    },
    async subscribe(subject, handler) {
      const held = handlers.get(subject) ?? new Set();
      const first = held.size === 0;
      held.add(handler);
      handlers.set(subject, held);
      if (first) {
        try {
          await inLane(() => subscribeOnce(subject));
        } catch (error) {
          held.delete(handler);
          if (held.size === 0) handlers.delete(subject);
          throw error;
        }
      }
      return {
        unsubscribe(): void {
          held.delete(handler);
          if (held.size > 0 || handlers.get(subject) !== held) return;
          handlers.delete(subject);
          if (!closed) void inLane(() => unsubscribeQuietly(subject));
        },
      };
    },
    onReconnect(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      listeners.clear();
      handlers.clear();
      subscriber.onconnect = null;
      publisher.onconnect = null;
      subscriber.close();
      publisher.close();
    },
  };
}

/**
 * The bus for `url`: two connections of its own, each built with core's options
 * (`REDIS_CLIENT_OPTIONS` — no offline queue, never give up reconnecting). Two sockets per process
 * on top of core's shared client: the price of a subscriber that takes no other command and a
 * publisher whose return the hop can hear. `close()` closes both.
 */
export function redisPubSubAt(url: string): InvalidationBus {
  const subscriber = new Bun.RedisClient(url, { ...REDIS_CLIENT_OPTIONS });
  const publisher = new Bun.RedisClient(url, { ...REDIS_CLIENT_OPTIONS });
  const bus = redisPubSub({ publisher, subscriber });
  // why: refused while the server is away like every command; the subscribe retry and the deferred
  // publish are where the caller learns of it. Unhandled, it would kill a process booting before
  // its Redis.
  subscriber.connect().catch(() => undefined);
  publisher.connect().catch(() => undefined);
  return bus;
}
