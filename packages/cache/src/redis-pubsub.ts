// Single responsibility: the hop that carries cache invalidations between replicas over Redis
// pub/sub — what a fleet with `REDIS_URL` and no NATS publishes its busts on. The CLI boot picks
// it (`packages/cli/src/runtime-cache-bus.ts`); this file only speaks the protocol.

import { backoffDelay, logger, renderThrowable, type Scheduler } from '@ultimat3/core';
import { REDIS_CLIENT_OPTIONS } from '@ultimat3/core/redis';
import type { RedisClient } from 'bun';
import { CacheDriverUnavailableError } from './errors';

export type PubSubListener = (message: string, channel: string) => void;

/** The part of a connection in subscriber mode this hop drives — structurally `Bun.RedisClient`. */
export interface RedisSubscriberLike {
  subscribe(channel: string, listener: PubSubListener): Promise<number>;
  unsubscribe(channel: string): Promise<void>;
  /** How `connectionName` is sent (`CLIENT SETNAME`). Absent, the connection stays anonymous. */
  send?(command: string, args: string[]): Promise<unknown>;
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

/**
 * How long one SUBSCRIBE or UNSUBSCRIBE may hold the lane. A command sent on a socket that died
 * under it never answers, and unbounded it stalled every resubscribe queued behind it: a replica
 * that never dropped what it held. A healthy server answers in single milliseconds.
 */
export const PUBSUB_COMMAND_TIMEOUT_MS = 1_000;

/** 250 ms doubling to 10 s, full jitter: a refused resubscribe is asked again, never in lockstep. */
const defaultResubscribeRetryMs = (attempt: number): number =>
  backoffDelay({ attempt, base: 250, max: 10_000, jitter: 'full' });

const timeoutSchedule: Scheduler = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

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
  /**
   * Arms each command's deadline, each resubscribe retry and the publisher's connect wait. Injected
   * so none of them waits in a test.
   */
  readonly schedule?: Scheduler;
  /** The wait before resubscribe `attempt` (1-based) after a refusal with the connection up. */
  readonly resubscribeRetryMs?: (attempt: number) => number;
  /**
   * `CLIENT SETNAME` for the subscriber, sent on EVERY connect: a reconnect is a new server-side
   * connection with no name. `redisPubSubAt` passes `cacheBusConnectionName()`.
   */
  readonly connectionName?: string;
}

/**
 * The subscriber's name in `CLIENT LIST`: which process a pub/sub connection is, so an operator —
 * and the live suite — can ask the server whether THIS replica is subscribed, not whether anyone is.
 */
export const cacheBusConnectionName = (): string => `x-cache-bus:${String(process.pid)}`;

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
 * twice. Each command in it is bounded (`PUBSUB_COMMAND_TIMEOUT_MS`), and a resubscribe refused
 * while the connection stays UP is retried on a backoff: measured after `CLIENT KILL`, no second
 * `onconnect` came, and the one logged refusal left the replica deaf to every peer bust.
 */
export function redisPubSub(options: RedisPubSubOptions): InvalidationBus {
  const { publisher, subscriber } = options;
  const schedule = options.schedule ?? timeoutSchedule;
  const retryMs = options.resubscribeRetryMs ?? defaultResubscribeRetryMs;
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
  /** `command` answered, or refused once its deadline passes; a late answer changes nothing. */
  const bounded = <T>(command: string, run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const cancel = schedule(() => {
        reject(
          new CacheDriverUnavailableError({
            driver: 'redis',
            cause: `${command} on the pub/sub connection did not answer within ${String(PUBSUB_COMMAND_TIMEOUT_MS)} ms; the next subscriber command was sent`,
            fix: 'redis-cli -u "$REDIS_URL" CLIENT LIST TYPE pubsub — a resubscribe is retried on its own once the server answers',
          }),
        );
      }, PUBSUB_COMMAND_TIMEOUT_MS);
      let sent: Promise<T>;
      try {
        sent = run();
      } catch (error) {
        sent = Promise.reject(error);
      }
      sent.then(
        (answer) => {
          cancel();
          resolve(answer);
        },
        (error: unknown) => {
          cancel();
          reject(error);
        },
      );
    });
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
      await bounded('UNSUBSCRIBE', () => subscriber.unsubscribe(channel));
    } catch {
      // Not subscribed, or the connection is away: either way no listener is left to double.
    }
  };

  /**
   * The channels THIS connection is subscribed to, replaced on every connect: a new connection
   * holds none, whatever the client still keeps. A set only the lane writes.
   */
  let onConnection = new Set<string>();

  /**
   * `channel` held by exactly one `dispatch`: UNSUBSCRIBE first, because Bun keeps a listener the
   * server forgot. A channel this connection already holds is left alone: a boot `subscribe` queued
   * behind the first connect's resubscribe (woken by the publisher's connect) used to UNSUBSCRIBE
   * and SUBSCRIBE it again, and a bust published between the two reached no one (measured: 184 of
   * 300 boots, and `CLIENT LIST TYPE pubsub` no longer listed the replica in that gap).
   */
  const subscribeOnce = async (channel: string): Promise<void> => {
    const on = onConnection;
    if (on.has(channel)) return;
    await unsubscribeQuietly(channel);
    await bounded('SUBSCRIBE', () => subscriber.subscribe(channel, dispatch));
    // A connect mid-SUBSCRIBE replaced `onConnection`: that answer was the dead connection's.
    on.add(channel);
  };

  /** The pending retry's canceller; a reconnect or `close` drops it. */
  let cancelRetry: (() => void) | undefined;
  const resubscribe = async (attempt: number): Promise<void> => {
    try {
      const { connectionName } = options;
      const send = subscriber.send?.bind(subscriber);
      if (connectionName !== undefined && send !== undefined) {
        await bounded('CLIENT SETNAME', () => send('CLIENT', ['SETNAME', connectionName]));
      }
      for (const channel of [...handlers.keys()]) await subscribeOnce(channel);
    } catch (error) {
      // The connection may well stay up (measured after `CLIENT KILL`): no `onconnect` would come,
      // so asking again is this hop's job. A real drop's `onconnect` supersedes the retry.
      logger.warn('cache.broadcast.resubscribe-failed', { error: renderThrowable(error), attempt });
      if (!closed) {
        cancelRetry = schedule(() => {
          cancelRetry = undefined;
          if (!closed) void inLane(() => resubscribe(attempt + 1));
        }, retryMs(attempt));
      }
      return;
    }
    // A retry an older refusal armed has nothing left to restore.
    cancelRetry?.();
    cancelRetry = undefined;
    announce();
  };

  // The first connect too: whatever the hop could not publish or subscribe before it is owed now.
  subscriber.onconnect = () => {
    onConnection = new Set();
    cancelRetry?.();
    cancelRetry = undefined;
    if (!closed) void inLane(() => resubscribe(1));
  };
  publisher.onconnect = () => {
    waiting = undefined;
    if (!closed) announce();
  };

  return {
    name: 'redis',
    async publish(subject, payload) {
      if (!publisher.connected) {
        // The connect or the bound, whichever is first; the other changes nothing.
        waiting ??= new Promise<undefined>((resolve) => {
          const cancel = schedule(() => resolve(undefined), PUBLISHER_CONNECT_WAIT_MS);
          const connected = (): void => {
            cancel();
            resolve(undefined);
          };
          publisher.connect().then(connected, connected);
        });
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
          if (!closed) {
            void inLane(() => {
              onConnection.delete(subject);
              return unsubscribeQuietly(subject);
            });
          }
        },
      };
    },
    onReconnect(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      cancelRetry?.();
      cancelRetry = undefined;
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
 * publisher whose return the hop can hear. `close()` closes both. `connectionName` defaults to
 * `cacheBusConnectionName()`; a suite running two buses in one process names each its own.
 */
export function redisPubSubAt(
  url: string,
  options: { readonly connectionName?: string } = {},
): InvalidationBus {
  const subscriber = new Bun.RedisClient(url, { ...REDIS_CLIENT_OPTIONS });
  const publisher = new Bun.RedisClient(url, { ...REDIS_CLIENT_OPTIONS });
  const bus = redisPubSub({
    publisher,
    subscriber,
    connectionName: options.connectionName ?? cacheBusConnectionName(),
  });
  // why: refused while the server is away like every command; the subscribe retry and the deferred
  // publish are where the caller learns of it. Unhandled, it would kill a process booting before
  // its Redis.
  subscriber.connect().catch(() => undefined);
  publisher.connect().catch(() => undefined);
  return bus;
}
