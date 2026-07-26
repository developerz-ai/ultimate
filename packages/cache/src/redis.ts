// Tier 2: shared cache over `Bun.redis` (no client dependency — the runtime ships one).
// A tag -> keys SET is maintained alongside every write so `invalidateTags` is ONE round
// trip via a server-side script, not a KEYS scan. KEYS is O(n) and blocks the server; a
// framework that ships it as the invalidation path is shipping an outage.

import { logger } from '@ultimat3/core';
import { CacheDriverUnavailableError } from './errors';
import type { CacheTag } from './tags';
import { parseTag, serializeTag } from './tags';
import type { CacheEntry, CacheSetOptions, CacheTier, TierInvalidation } from './tiers';

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
}

interface StoredEntry {
  readonly v: unknown;
  readonly t: readonly string[];
}

/**
 * Drop the value keys, then drop the tag sets themselves. `SMEMBERS` + `DEL` in one EVAL is
 * atomic and single-trip; doing it client-side would race a concurrent write.
 */
const INVALIDATE_SCRIPT = `
local removed = {}
for i, tagKey in ipairs(KEYS) do
  local members = redis.call('SMEMBERS', tagKey)
  for _, key in ipairs(members) do
    redis.call('DEL', key)
    table.insert(removed, key)
  end
  redis.call('DEL', tagKey)
end
return removed
`.trim();

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

export function createRedisTier(options: RedisTierOptions = {}): CacheTier {
  const prefix = options.prefix ?? 'x';
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
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

    async get<T>(key: string): Promise<CacheEntry<T> | undefined> {
      const raw = await conn().get(valueKey(key));
      if (raw === null) return undefined;
      try {
        const parsed = JSON.parse(raw) as StoredEntry;
        return { value: parsed.v as T, tags: parsed.t.map(parseTag) };
      } catch {
        // A poisoned value is a miss, never a 500. Redis TTL will reap it.
        logger.warn('cache.redis.corrupt-entry', { key });
        return undefined;
      }
    },

    async set<T>(key: string, value: T, setOptions?: CacheSetOptions): Promise<void> {
      const tags = setOptions?.tags ?? [];
      const ttlMs = setOptions?.ttlMs ?? defaultTtlMs;
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
      const stripped = toStrings(result).map((key) => key.slice(`${prefix}:c:`.length));
      return { tier: 'redis', keys: stripped };
    },
  };
}

export const REDIS_INVALIDATE_SCRIPT = INVALIDATE_SCRIPT;
