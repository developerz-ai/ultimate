// Tier 2: shared cache over `Bun.redis` (no client dependency — the runtime ships one).
// A tag -> keys SET is maintained alongside every write so `invalidateTags` is ONE round
// trip via a server-side script, not a KEYS scan. KEYS is O(n) and blocks the server; a
// framework that ships it as the invalidation path is shipping an outage.

import type { Clock } from '@ultimat3/core';
import { logger, systemClock } from '@ultimat3/core';
import { CacheDriverUnavailableError } from './errors';
import type { CacheTag } from './tags';
import { parseTag, serializeTag } from './tags';
import type { CacheEntry, CacheSetOptions, CacheTier, TierInvalidation } from './tiers';
import { assertTtl, nowMs } from './tiers';

/** The slice of Bun's Redis client this tier uses. Narrow on purpose: easy to fake in tests. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  send(command: string, args: string[]): Promise<unknown>;
}

export interface RedisTierOptions {
  /** Key namespace, so two apps can share one Redis without colliding. Default `x`. */
  readonly prefix?: string;
  readonly defaultTtlMs?: number;
  /** Injected in tests; production reads `Bun.redis`. */
  readonly client?: RedisLike;
  /** Turns `PTTL`'s remaining life into the absolute `expiresAt` a hit reports. */
  readonly clock?: Clock;
}

interface StoredEntry {
  readonly v: unknown;
  readonly t: readonly string[];
}

/**
 * Read the tag sets out and drop the tag sets themselves — and nothing else.
 *
 * A script may only touch keys it was handed in `KEYS`, and the members of a tag set are not
 * among them: they are value keys hashing to slots this node may not even own. `DEL`ing them from
 * inside the script therefore raised "attempted to access a non-local key in a cluster node" on
 * Redis Cluster and in Dragonfly's strict mode — swallowed into `report.errors`, so a bust read
 * as "partial", the write that triggered it still succeeded, and stale rows served until TTL.
 *
 * The value keys come back to the client instead, which drops them one `DEL` at a time: a single
 * key is always slot-local, whatever the topology. Only the SMEMBERS + tag-set `DEL` stay atomic,
 * and that is the pair that needed to be — a value key re-added by a concurrent write between the
 * two halves is at worst a cache miss, never a stale read.
 */
const INVALIDATE_SCRIPT = `
local removed = {}
for i, tagKey in ipairs(KEYS) do
  local members = redis.call('SMEMBERS', tagKey)
  for _, key in ipairs(members) do
    table.insert(removed, key)
  end
  redis.call('DEL', tagKey)
end
return removed
`.trim();

/** Concurrent `DEL`s per flush. Bun pipelines them, so this bounds memory, not round trips. */
const DELETE_BATCH = 128;

function resolveClient(injected: RedisLike | undefined): RedisLike {
  if (injected !== undefined) return injected;
  const candidate = (Bun as unknown as { redis?: RedisLike }).redis;
  if (candidate === undefined || typeof candidate.send !== 'function') {
    throw new CacheDriverUnavailableError({
      driver: 'redis',
      cause: 'Bun.redis is not available (needs bun >= 1.3 and REDIS_URL)',
      fix: 'set REDIS_URL in .env, or drop the redis tier from cache.tiers in app.config.ts',
    });
  }
  return candidate;
}

const toStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item)) : [];

/**
 * `PTTL`'s answer as milliseconds of remaining life, or `undefined` for the two sentinels it
 * answers with instead of a duration: `-1` (key exists, no expiry) and `-2` (no such key).
 * A driver may hand either back as a string, so the parse goes through `Number`.
 */
function remainingMs(reply: unknown): number | undefined {
  const pttl = Number(reply);
  return Number.isFinite(pttl) && pttl > 0 ? pttl : undefined;
}

export function createRedisTier(options: RedisTierOptions = {}): CacheTier {
  const prefix = options.prefix ?? 'x';
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
  const clock = options.clock ?? systemClock;
  let client: RedisLike | undefined;

  const conn = (): RedisLike => {
    client ??= resolveClient(options.client);
    return client;
  };

  const valueKey = (key: string): string => `${prefix}:c:${key}`;
  const tagKey = (wire: string): string => `${prefix}:t:${wire}`;
  // A row write must also appear in the collection's tag set, or list caches survive it.
  const tagKeysFor = (owned: CacheTag): string[] =>
    owned.id === undefined
      ? [tagKey(owned.entity)]
      : [tagKey(serializeTag(owned)), tagKey(owned.entity)];

  return {
    name: 'redis',

    /**
     * The value AND what is left of its lease. `set` always applies a finite `EX`, so an entry
     * read back without its remaining life is an entry the stack can only promote on the
     * CALLER's ttl — re-leasing a row one second from expiry for a fresh five minutes into the
     * LRU on every read, which is a hot key that never goes stale enough to be refetched.
     *
     * `PTTL` rather than an `expiresAt` written into the payload: the server owns the clock, so
     * this survives skew between the node that wrote and the node that reads, and no stored
     * shape changes under a running deployment. Issued alongside the `GET` rather than after
     * it — Bun pipelines the pair, so the expiry costs no extra round trip.
     */
    async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
      const stored = valueKey(key);
      const [raw, pttl] = await Promise.all([
        conn().get(stored),
        conn().send('PTTL', [stored]) as Promise<unknown>,
      ]);
      if (raw === null) return undefined;
      const remaining = remainingMs(pttl);
      try {
        const parsed = JSON.parse(raw) as StoredEntry;
        return {
          value: parsed.v as T,
          tags: parsed.t.map(parseTag),
          ...(remaining === undefined ? {} : { expiresAt: nowMs(clock) + remaining }),
        };
      } catch {
        // A poisoned value is a miss, never a 500. Redis TTL will reap it.
        logger.warn('cache.redis.corrupt-entry', { key });
        return undefined;
      }
    },

    async set<T>(key: string, value: T, setOptions?: CacheSetOptions): Promise<void> {
      const tags = setOptions?.tags ?? [];
      const ttlMs = assertTtl(key, setOptions?.ttlMs ?? defaultTtlMs, 'redis');
      const payload: StoredEntry = { v: value, t: tags.map(serializeTag) };
      const stored = valueKey(key);
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      await conn().send('SET', [stored, JSON.stringify(payload), 'EX', String(ttlSeconds)]);
      for (const owned of tags) {
        for (const bucket of tagKeysFor(owned)) {
          await conn().send('SADD', [bucket, stored]);
        }
      }
    },

    async del(key: string): Promise<void> {
      await conn().send('DEL', [valueKey(key)]);
    },

    async invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
      const buckets = [...new Set(tags.flatMap(tagKeysFor))];
      if (buckets.length === 0) return { tier: 'redis', keys: [] };
      const result = await conn().send('EVAL', [
        INVALIDATE_SCRIPT,
        String(buckets.length),
        ...buckets,
      ]);
      // A member may sit in two tag sets; deleting it twice is harmless but reporting it twice
      // makes the `/_x` panel overstate what cleared.
      const members = [...new Set(toStrings(result))];
      for (let start = 0; start < members.length; start += DELETE_BATCH) {
        // One key per DEL — always slot-local. Issued together so the batch costs one round trip.
        await Promise.all(
          members.slice(start, start + DELETE_BATCH).map((member) => conn().send('DEL', [member])),
        );
      }
      const stripped = members.map((key) => key.slice(`${prefix}:c:`.length));
      return { tier: 'redis', keys: stripped };
    },
  };
}

export const REDIS_INVALIDATE_SCRIPT = INVALIDATE_SCRIPT;
