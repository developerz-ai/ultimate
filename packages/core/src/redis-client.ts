// Single responsibility: the framework's one Redis client — `@ultimat3/core/redis`, never the
// barrel (core is in every bundle graph and this reads `Bun.RedisClient`). `Bun.redis`'s defaults
// turn an outage into a hang and a restart into a dead tier; each option below is why it is not.
// Measured 2026-11-02 on Redis 7, Bun 1.4.4 (plan 101, `29-data-redis-outage.md`).

import type { RedisClient, RedisOptions } from 'bun';

/** The local server Bun itself falls back to, so an unset environment dials the same place. */
const LOCAL_REDIS_URL = 'redis://localhost:6379';

export const REDIS_CLIENT_OPTIONS: Readonly<
  Required<Pick<RedisOptions, 'enableOfflineQueue' | 'maxRetries' | 'connectionTimeout'>>
> = Object.freeze({
  /**
   * why: with the offline queue on, a command issued while disconnected WAITS for a connection —
   * the first read against a stopped server took 30,916 ms. Off, it refuses at once, and a refused
   * cache read is a miss.
   */
  enableOfflineQueue: false,
  /**
   * why: the default 20 attempts are spent in ~31 s, then the client stays closed — a server
   * back 37 s later still answered `ERR_REDIS_CONNECTION_CLOSED` on every pod until it restarted.
   * The largest 32-bit count is "never give up"; with it the same restart recovered within 4 s.
   */
  maxRetries: 2_147_483_647,
  /** why: the default 10 s connect is 10 s every reconnect attempt sits on an unanswering host. */
  connectionTimeout: 1_000,
});

/** One client per process per URL: a second one is a second socket and a second reconnect loop. */
const clients = new Map<string, RedisClient>();

type RedisEnv = Readonly<Record<string, string | undefined>>;

/** The variable that supplied a Redis URL, and the URL. */
export interface RedisUrlSource {
  readonly key: 'REDIS_URL' | 'VALKEY_URL';
  readonly url: string;
}

/**
 * `REDIS_URL`, the variable the CLI's tier selection reads; then `VALKEY_URL`, which `Bun.redis`
 * also honours. An empty or blank value is unset; `undefined` when neither is set — the one
 * precedence, for a caller that must tell an unset Redis from the local default.
 */
export function redisUrlSource(
  env: RedisEnv = process.env as Record<string, string | undefined>,
): RedisUrlSource | undefined {
  for (const key of ['REDIS_URL', 'VALKEY_URL'] as const) {
    const url = env[key]?.trim();
    if (url !== undefined && url !== '') return { key, url };
  }
  return undefined;
}

/** `redisUrlSource`'s URL, else the local default. */
export function redisUrl(
  env: RedisEnv = process.env as Record<string, string | undefined>,
): string {
  return redisUrlSource(env)?.url ?? LOCAL_REDIS_URL;
}

/**
 * The client for `url` (default `redisUrl()`), built once and connecting in the background: the
 * caller never waits on a connect, and a command before the first connect is refused like any
 * other command while down. `close()` on it closes it for every holder.
 */
export function redisClient(url: string = redisUrl()): RedisClient {
  const held = clients.get(url);
  if (held !== undefined) return held;
  const client = new Bun.RedisClient(url, { ...REDIS_CLIENT_OPTIONS });
  clients.set(url, client);
  // why: the rejection is not lost — every command while unconnected is refused with
  // `ERR_REDIS_CONNECTION_CLOSED`, which is where a caller learns of it. Unhandled, it would kill
  // the process on a cold start against a server that is still coming up.
  client.connect().catch(() => undefined);
  return client;
}
