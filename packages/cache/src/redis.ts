// Tier 2: shared cache over `Bun.redis` (no client dependency — the runtime ships one).
// A tag -> keys SET is maintained alongside every write so `invalidateTags` is ONE round
// trip via a server-side script, not a KEYS scan. KEYS is O(n) and blocks the server; a
// framework that ships it as the invalidation path is shipping an outage.

import type { Clock } from '@ultimat3/core';
import { appVersion, logger, systemClock } from '@ultimat3/core';
import { CacheDriverUnavailableError } from './errors';
import type { CacheTag } from './tags';
import { parseTag, serializeTag } from './tags';
import type {
  CacheEntry,
  CacheSetOptions,
  CacheTier,
  Rng,
  TierInvalidation,
  TtlJitter,
} from './tiers';
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
  /**
   * The build the keys belong to. Defaults to `appVersion()` (`APP_VERSION`, else `dev`), so two
   * builds sharing one Redis never read each other's payloads. Pass `null` to opt out — see
   * `namespaceFor`.
   */
  readonly buildId?: string | null;
  readonly defaultTtlMs?: number;
  /** Injected in tests; production reads `Bun.redis`. */
  readonly client?: RedisLike;
  /** Turns `PTTL`'s remaining life into the absolute `expiresAt` a hit reports. */
  readonly clock?: Clock;
  /** TTL spread, in `[0, 1)`. Default `DEFAULT_TTL_JITTER_FRACTION`; `0` disables it. */
  readonly jitterFraction?: number;
  /** Injected so a jittered `EX` is deterministic; `() => 0` is the full lease. */
  readonly rng?: Rng;
}

/**
 * `<prefix>:<buildId>`, and `<prefix>` alone when the build id is opted out of.
 *
 * A shape change is why the build id is in the key by default. Rename `PostView.author` to
 * `PostView.authorId` and deploy: old and new pods share one Redis, `JSON.parse` does not
 * validate, and the old pod hands `parsed.v as T` to a renderer expecting `author` — an undefined
 * author on every cached post, on half the fleet, for the length of the rolling deploy. The cost
 * of the default is a cold shared tier per deploy, which is the cheaper of the two.
 *
 * `null` (or `''`) opts out, for a team that versions its own payloads.
 */
export function namespaceFor(prefix: string, buildId: string | null | undefined): string {
  const resolved = buildId === undefined ? appVersion() : buildId;
  return resolved === null || resolved === '' ? prefix : `${prefix}:${resolved}`;
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
 *
 * That fixed HALF the cluster story. The other half is `KEYS` itself: one `EVAL` carrying every
 * tag's buckets is rejected with `CROSSSLOT` before the script runs, because `<ns>:t:post` and
 * `<ns>:t:user` hash to different slots. So the buckets carry a `{entity}` hash tag and the tier
 * issues ONE call per tag — every key of a call then hashes on the same entity, by construction.
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

/**
 * Join a value key to one tag set, and never let that set outlive its members by more than the
 * grace — one key in `KEYS`, so it is slot-local under every topology.
 *
 * A tag set with no expiry is unbounded. Value keys die after five minutes; their membership never
 * did, so after a month `SMEMBERS <ns>:t:{post}` returned several million dead keys — hundreds of
 * milliseconds of blocked event loop, a multi-megabyte reply, and millions of client-side `DEL`s.
 * One publish became a Redis outage, and the set itself was unbounded memory in the shared store.
 *
 * The TTL only ever GROWS, which is the half that has to be atomic: a 60s member must not shorten
 * a bucket a 1h member is in, or that value key becomes unreachable by tag and serves stale until
 * its own lease runs out. `EXPIRE ... GT` says exactly this in one command but treats a key with
 * no TTL as infinite — so a FRESH bucket would keep no expiry at all, which is the bug being
 * fixed. Read-then-set inside the script covers both cases, and needs no Redis 7.
 */
const TAG_MEMBER_SCRIPT = `
redis.call('SADD', KEYS[1], ARGV[1])
local ttl = tonumber(ARGV[2])
local current = redis.call('TTL', KEYS[1])
if current < 0 or current < ttl then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return 1
`.trim();

/** Concurrent `DEL`s per flush. Bun pipelines them, so this bounds memory, not round trips. */
const DELETE_BATCH = 128;

/** Seconds a tag set outlives its newest member. See `TAG_MEMBER_SCRIPT`. */
const TAG_TTL_GRACE_SECONDS = 60;

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
  const ns = namespaceFor(options.prefix ?? 'x', options.buildId);
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
  const clock = options.clock ?? systemClock;
  const jitter: TtlJitter = {
    ...(options.jitterFraction === undefined ? {} : { jitterFraction: options.jitterFraction }),
    ...(options.rng === undefined ? {} : { rng: options.rng }),
  };
  let client: RedisLike | undefined;

  const conn = (): RedisLike => {
    client ??= resolveClient(options.client);
    return client;
  };

  const valueKey = (key: string): string => `${ns}:c:${key}`;
  // `{entity}` is a Redis Cluster hash tag, not decoration: it is what makes a row's bucket and
  // its collection's bucket hash to ONE slot, so a script may take both in `KEYS`.
  const tagKey = (owned: CacheTag): string =>
    owned.id === undefined ? `${ns}:t:{${owned.entity}}` : `${ns}:t:{${owned.entity}}:${owned.id}`;
  // A row write must also appear in the collection's tag set, or list caches survive it.
  const tagKeysFor = (owned: CacheTag): string[] =>
    owned.id === undefined ? [tagKey(owned)] : [tagKey(owned), tagKey({ entity: owned.entity })];

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

    /** The value key gets a lease and so does every bucket it joins — see `TAG_MEMBER_SCRIPT`. */
    async set<T>(key: string, value: T, setOptions?: CacheSetOptions): Promise<void> {
      const tags = setOptions?.tags ?? [];
      const ttlMs = assertTtl(key, setOptions?.ttlMs ?? defaultTtlMs, 'redis', jitter);
      const payload: StoredEntry = { v: value, t: tags.map(serializeTag) };
      const stored = valueKey(key);
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      const bucketTtlSeconds = String(ttlSeconds + TAG_TTL_GRACE_SECONDS);
      await conn().send('SET', [stored, JSON.stringify(payload), 'EX', String(ttlSeconds)]);
      for (const owned of tags) {
        for (const bucket of tagKeysFor(owned)) {
          await conn().send('EVAL', [TAG_MEMBER_SCRIPT, '1', bucket, stored, bucketTtlSeconds]);
        }
      }
    },

    async del(key: string): Promise<void> {
      await conn().send('DEL', [valueKey(key)]);
    },

    /**
     * ONE script call per tag, never one for the batch. Every key a call is handed comes from a
     * single tag and therefore carries the same `{entity}` hash tag, so it is one slot on Redis
     * Cluster; the batched form was rejected with `CROSSSLOT` before the script ever ran, which
     * landed in `report.errors` as a partial bust with stale rows serving until TTL.
     */
    async invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
      const claimed = new Set<string>();
      const perTag: string[][] = [];
      for (const owned of tags) {
        // A bucket already claimed by an earlier tag is dropped rather than re-sent: two tags of
        // one entity share the collection bucket, and the second call would find it gone anyway.
        const buckets = tagKeysFor(owned).filter((bucket) => !claimed.has(bucket));
        for (const bucket of buckets) claimed.add(bucket);
        if (buckets.length > 0) perTag.push(buckets);
      }
      if (perTag.length === 0) return { tier: 'redis', keys: [] };
      const replies = await Promise.all(
        perTag.map((buckets) =>
          conn().send('EVAL', [INVALIDATE_SCRIPT, String(buckets.length), ...buckets]),
        ),
      );
      // A member may sit in two tag sets; deleting it twice is harmless but reporting it twice
      // makes the `/_x` panel overstate what cleared.
      const members = [...new Set(replies.flatMap(toStrings))];
      for (let start = 0; start < members.length; start += DELETE_BATCH) {
        // One key per DEL — always slot-local. Issued together so the batch costs one round trip.
        await Promise.all(
          members.slice(start, start + DELETE_BATCH).map((member) => conn().send('DEL', [member])),
        );
      }
      const stripped = members.map((key) => key.slice(`${ns}:c:`.length));
      return { tier: 'redis', keys: stripped };
    },
  };
}

export const REDIS_INVALIDATE_SCRIPT = INVALIDATE_SCRIPT;
export const REDIS_TAG_MEMBER_SCRIPT = TAG_MEMBER_SCRIPT;
