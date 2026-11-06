// A deadline on every command the shared tier sends, and a park after one is missed. A paused
// Redis accepts a command and never answers it: unbounded, `stack.read` hung 45 s and a bust 20 s
// on an action's commit path. Bounded, a stalled store is a slow miss, then a free one.

import type { Clock } from '@ultimat3/core';
import type { DeadlineTimer } from '@ultimat3/core/outbound';
import { platformDeadlineTimer } from '@ultimat3/core/outbound';
import { CacheDriverUnavailableError } from './errors';
import type { RedisLike } from './redis';

/** A value-path command's budget. A healthy shared tier answers in single milliseconds. */
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 150;

/**
 * A bust's budget, and it is longer on purpose: a bust skipped for a stall leaves stale rows
 * serving until TTL, where a skipped read only costs a load.
 */
export const DEFAULT_REDIS_BUST_TIMEOUT_MS = 1_000;

/**
 * How long one missed deadline parks the value path. A read is five commands; at 150 ms each a
 * paused server cost 757 ms per read. Parked, the next reads refuse without sending anything.
 */
export const REDIS_PARK_MS = 5_000;

export interface DeadlineOptions {
  /** Already screened by the caller (`redisTier`'s `assertFiniteDurationMs`). */
  readonly commandTimeoutMs: number;
  /** `monotonic()` is the park's one clock read. */
  readonly clock: Clock;
  readonly timer?: DeadlineTimer;
}

/** One client, two views: `value` honours the park, `bust` never does. */
export interface DeadlinedRedis {
  readonly value: RedisLike;
  readonly bust: RedisLike;
}

const FIX =
  'redis-cli -u "$REDIS_URL" --latency — while the store stalls every read is a miss and Postgres answers; raise redisTier({ commandTimeoutMs }) only if that latency is its normal';

export function withinDeadline(client: RedisLike, options: DeadlineOptions): DeadlinedRedis {
  const { clock, commandTimeoutMs } = options;
  const timer = options.timer ?? platformDeadlineTimer;
  // One number, no state machine: a missed deadline moves it forward, time moves past it.
  let parkedUntil = Number.NEGATIVE_INFINITY;

  const bounded = <T>(command: string, ms: number, run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const handle = timer.set(() => {
        // Any missed deadline is evidence the store is stalled, a bust's included.
        parkedUntil = clock.monotonic() + REDIS_PARK_MS;
        reject(
          new CacheDriverUnavailableError({
            driver: 'redis',
            cause: `${command} did not answer within ${String(ms)} ms; reads skip the shared tier for ${String(REDIS_PARK_MS)} ms`,
            fix: FIX,
          }),
        );
      }, ms);
      const settle = (): void => timer.clear(handle);
      // Sent now, not a microtask later, so a pipelined pair stays one round trip. A synchronous
      // throw is a refusal like any other. A late answer lands after the refusal and changes
      // nothing: a promise settles once.
      let sent: Promise<T>;
      try {
        sent = run();
      } catch (error) {
        sent = Promise.reject(error);
      }
      sent.then(
        (answer) => {
          settle();
          resolve(answer);
        },
        (error: unknown) => {
          settle();
          reject(error);
        },
      );
    });

  const parked = <T>(command: string, run: () => Promise<T>): Promise<T> => {
    const left = parkedUntil - clock.monotonic();
    if (left > 0) {
      return Promise.reject(
        new CacheDriverUnavailableError({
          driver: 'redis',
          cause: `parked for another ${String(Math.ceil(left))} ms after a command missed its ${String(commandTimeoutMs)} ms deadline; ${command} was not sent`,
          fix: FIX,
        }),
      );
    }
    return bounded(command, commandTimeoutMs, run);
  };

  return {
    value: {
      get: (key) => parked('GET', () => client.get(key)),
      set: (key, text) => parked('SET', () => client.set(key, text)),
      send: (command, args) => parked(command, () => client.send(command, args)),
    },
    bust: {
      get: (key) => bounded('GET', DEFAULT_REDIS_BUST_TIMEOUT_MS, () => client.get(key)),
      set: (key, text) =>
        bounded('SET', DEFAULT_REDIS_BUST_TIMEOUT_MS, () => client.set(key, text)),
      send: (command, args) =>
        bounded(command, DEFAULT_REDIS_BUST_TIMEOUT_MS, () => client.send(command, args)),
    },
  };
}
