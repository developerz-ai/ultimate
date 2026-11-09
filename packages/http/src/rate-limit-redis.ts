// The shared rate-limit store over Redis: one Lua token bucket per take, so the refill, the spend
// and the expiry are one atomic step on the server. Beside Postgres, not instead of it: a hot key
// (one NAT, a tenant bucket) serialises every request on one row lock there, and Redis runs a
// script per key without one. The bucket expires once refilled, so it bounds itself — no purge.

import type { Scheduler } from '@ultimat3/core';
import { stringField } from '@ultimat3/core';
import { httpCountInvalid } from './errors';
import type { RateLimitDecision, RateLimitScope, RateLimitStore } from './rate-limit';
import { rateLimitDecision } from './rate-limit';
import { degradedFallback, isRateLimitStoreUnreachable } from './rate-limit-degrade';
import { rateLimitStoreUnavailable } from './rate-limit-errors';
import { rateLimitPeek, refilledTokens } from './rate-limit-peek';
import { storeDeadline } from './rate-limit-store-deadline';

/** The slice of Bun's `RedisClient` (core's `redisClient()`) this store sends through. */
export interface RedisRateLimitClient {
  send(command: string, args: string[]): Promise<unknown>;
}

/**
 * `KEYS[1]` the bucket; `ARGV` capacity, refill per second, cost, the caller's `nowMs`. The same
 * arithmetic as the memory store and `SQL_RATE_LIMIT_TAKE`: refill capped at capacity, elapsed
 * never negative, `l` only ever moves forward (two replicas share no clock). Tokens go back as a
 * STRING — Redis truncates a Lua number reply to an integer, and 0.5 left is not 0. The key
 * expires when it would be full again — the memory store's `forgetAt` — which answers exactly as a
 * missing one. A week's window is a week's key: capping it would hand back a fresh allowance. A
 * refill of 0 never reaches the script (`take` refuses it), so no key is held forever.
 */
export const REDIS_RATE_LIMIT_TAKE = `
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local held = redis.call('HMGET', KEYS[1], 't', 'l')
local tokens = cap
local last = now
if held[1] then
  tokens = tonumber(held[1])
  last = tonumber(held[2])
end
tokens = math.min(cap, tokens + math.max(0, now - last) / 1000 * rate)
local allowed = tokens >= cost
if allowed then tokens = tokens - cost end
redis.call('HSET', KEYS[1], 't', string.format('%.17g', tokens), 'l', string.format('%d', math.max(last, now)))
redis.call('PEXPIRE', KEYS[1], math.max(1, math.ceil((cap - tokens) / rate * 1000)))
return { string.format('%.17g', tokens), allowed and 1 or 0 }
`;

const TAKE_SHA = new Bun.CryptoHasher('sha1').update(REDIS_RATE_LIMIT_TAKE).digest('hex');

export interface RedisRateLimitStoreOptions {
  /** Core's `redisClient()` (`@ultimat3/core/redis`), or anything with its `send`. */
  readonly client: RedisRateLimitClient;
  /** Key namespace, so two apps can share one Redis. Default `x`; keys are `<prefix>:rl:<key>`. */
  readonly prefix?: string | undefined;
  /** One round trip's budget before the decision degrades to this pod's memory. Default 250 ms. */
  readonly deadlineMs?: number | undefined;
  /** Injection seam for that deadline; production passes none. */
  readonly schedule?: Scheduler | undefined;
}

/** Bun's code for a command refused for want of a connection — the store is down, not wrong. */
const CONNECTION_CLOSED = 'ERR_REDIS_CONNECTION_CLOSED';

const unreachable = (error: unknown): boolean =>
  isRateLimitStoreUnreachable(error) || stringField(error, 'code') === CONNECTION_CLOSED;

/** A reply list's member as a finite number, or `null` for anything else. */
const numberAt = (reply: unknown, index: number): number | null => {
  if (!Array.isArray(reply)) return null;
  const value: unknown = reply[index];
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * **Name it in `apps/<app>/runtime.ts`**, the one place a store is chosen:
 *
 * ```ts
 * import { redisClient } from '@ultimat3/core/redis';
 * export const runtime = { rateLimitStore: redisRateLimitStore({ client: redisClient() }) };
 * ```
 *
 * `scope: 'shared'`, so it satisfies `rateLimit: { scope: 'shared' }`. A Redis that is down or
 * past `deadlineMs` degrades to this pod's memory, logged — the same rule and the same fallback
 * as `postgresRateLimitStore` (`rate-limit-degrade.ts`); an error REPLY (a script the server
 * refuses) still throws.
 */
export function redisRateLimitStore(options: RedisRateLimitStoreOptions): RedisRateLimitStore {
  const { client } = options;
  const prefix = options.prefix ?? 'x';
  const keyOf = (key: string): string => `${prefix}:rl:${key}`;
  const deadline = storeDeadline(options.deadlineMs, options.schedule, 'redisRateLimitStore');
  const fallback = degradedFallback('redisRateLimitStore');
  const degrade = <T>(error: unknown, nowMs: number, decide: () => Promise<T>): Promise<T> => {
    if (!unreachable(error)) throw error;
    fallback.note(error, nowMs);
    return decide();
  };
  // EVALSHA first: the script is sent once per server, not per request. A server that has not
  // seen it (a restart, a failover) answers NOSCRIPT, and EVAL both runs and caches it.
  const runTake = async (args: string[]): Promise<unknown> => {
    try {
      return await client.send('EVALSHA', [TAKE_SHA, '1', ...args]);
    } catch (error) {
      if (!(stringField(error, 'message') ?? '').includes('NOSCRIPT')) throw error;
      return client.send('EVAL', [REDIS_RATE_LIMIT_TAKE, '1', ...args]);
    }
  };

  return {
    scope: 'shared',

    async take(key, bucket, cost, nowMs): Promise<RateLimitDecision> {
      // Config resolution refuses it first; this is the store's own guard for a bucket handed in
      // directly, because a key whose bucket never refills would never expire.
      if (!Number.isFinite(bucket.refillPerSecond) || bucket.refillPerSecond <= 0) {
        throw httpCountInvalid(
          'rateLimit bucket refillPerSecond',
          bucket.refillPerSecond,
          'a finite number of tokens per second above 0',
          'rateLimit: { buckets: { default: { capacity: 120, refillPerSecond: 2 } } }',
        );
      }
      let reply: unknown;
      try {
        reply = await deadline.bound(
          'take',
          runTake([
            keyOf(key),
            String(bucket.capacity),
            String(bucket.refillPerSecond),
            String(cost),
            String(Math.floor(nowMs)),
          ]),
        );
      } catch (error) {
        return degrade(error, nowMs, () => fallback.store.take(key, bucket, cost, nowMs));
      }
      const tokens = numberAt(reply, 0);
      const allowed = numberAt(reply, 1);
      // The script always answers both; anything else is not this script running, and inventing
      // "allowed" would be the limiter silently switched off.
      if (tokens === null || allowed === null) throw rateLimitStoreUnavailable('take');
      return rateLimitDecision(bucket, tokens, cost, allowed === 1, nowMs);
    },

    async peek(key, bucket, nowMs) {
      let reply: unknown;
      try {
        reply = await deadline.bound('peek', client.send('HMGET', [keyOf(key), 't', 'l']));
      } catch (error) {
        return degrade(error, nowMs, () => fallback.store.peek(key, bucket, nowMs));
      }
      const stored = numberAt(reply, 0);
      const lastMs = numberAt(reply, 1);
      const tokens =
        stored === null || lastMs === null
          ? bucket.capacity
          : refilledTokens(bucket, stored, lastMs, Math.floor(nowMs));
      return rateLimitPeek(bucket, tokens);
    },

    async reset(key): Promise<void> {
      // Both places a decision can come from, the fallback first — the Postgres store's order.
      await fallback.store.reset(key);
      await client.send('DEL', [keyOf(key)]);
    },
  };
}

export interface RedisRateLimitStore extends RateLimitStore {
  readonly scope: RateLimitScope;
}
