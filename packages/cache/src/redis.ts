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
 * Read the tag sets out. It deletes nothing at all, and both halves of that are deliberate.
 *
 * A script may only touch keys it was handed in `KEYS`, and the members of a tag set are not
 * among them: they are value keys hashing to slots this node may not even own. `DEL`ing them from
 * inside the script therefore raised "attempted to access a non-local key in a cluster node" on
 * Redis Cluster and in Dragonfly's strict mode — swallowed into `report.errors`, so a bust read
 * as "partial", the write that triggered it still succeeded, and stale rows served until TTL.
 *
 * The buckets themselves used to go, atomically with the `SMEMBERS` that read them. That made one
 * failure permanent: a refused `DEL` in the client-side batch left its member with no bucket to
 * be found in again, so the retry the error asks for answered `keys: []` and those rows served
 * until their own TTL. The tier now `SREM`s exactly the members it managed to delete, which is
 * strictly more precise — a member added by a concurrent write between the two halves is not in
 * that list, so it keeps its membership instead of being silently orphaned by the bust.
 *
 * That is HALF the cluster story. The other half is `KEYS` itself: one `EVAL` carrying every tag's
 * buckets is rejected with `CROSSSLOT` before the script runs, because `<ns>:t:post` and
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
 * What `PTTL` said about a key the `GET` beside it just answered for. `-1` and `-2` are sentinels,
 * not durations — and they mean different things here: `-1` is a key with no lease (one written
 * outside this tier), `-2` is no key at all, which for a value the `GET` returned means it expired
 * BETWEEN the two commands. A driver may hand either back as a string, so the parse is `Number`.
 */
type Lease = { readonly kind: 'reaped' } | { readonly kind: 'none' } | { readonly ms: number };

function leaseFrom(reply: unknown): Lease {
  const pttl = Number(reply);
  if (!Number.isFinite(pttl)) return { kind: 'none' };
  if (pttl === -2) return { kind: 'reaped' };
  return pttl > 0 ? { ms: pttl } : { kind: 'none' };
}

/**
 * `SISMEMBER` answered a literal `0`, and nothing else counts. A reply this cannot read is not
 * evidence: treating one as "gone" deletes every value the tier writes, which is a cache that
 * never caches.
 */
function saysAbsent(reply: unknown): boolean {
  if (typeof reply === 'number') return reply === 0;
  if (typeof reply === 'string') return Number(reply) === 0;
  return false;
}

/**
 * The first refusal, verbatim when it is one — `fanOut` renders `message` into `report.errors`, so
 * the operator sees which key the store refused rather than a count.
 *
 * The `fix:` is the call, not a command: there is no `x cache` in this build, and the retry is one
 * line of the app's own code. It is safe to repeat because every key the store refused kept its
 * tag membership — the bust `SREM`s only what it deleted.
 */
function raiseSweepFailure(failures: readonly unknown[], attempted: number): never {
  const first = failures[0];
  if (first instanceof Error) throw first;
  throw new CacheDriverUnavailableError({
    driver: 'redis',
    cause: `${String(failures.length)} of ${String(attempted)} value keys could not be deleted`,
    fix: "await invalidateTags(tags) again once redis answers — from '@ultimat3/cache', with the same tags; every key it refused kept its bucket membership, so the retry reaches it",
  });
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
  // Every key carrying ANY tag of this entity — `LruCache`'s `entityIndex`, on the wire. A SECOND
  // bucket rather than a reuse of `tagKey({ entity })`, and that is the whole fix: one key serving
  // both roles is what made a row bust over-reach.
  const entityKey = (entity: string): string => `${ns}:e:{${entity}}`;

  // A write joins the bucket of the tag it declared, plus its entity's index — so a collection
  // bust reaches a row-tagged key without that row's tag having to live in the collection's bucket.
  const writeBucketsFor = (owned: CacheTag): string[] => [tagKey(owned), entityKey(owned.entity)];

  /**
   * `tagMatches` expressed in keys, which is the point: the LRU and the request memo both answer a
   * bust through that predicate and this tier did not.
   *
   * A COLLECTION bust matches every tag of the entity, so it reads the entity index. A ROW bust
   * matches its own tag and the bare collection tag ONLY — `post:2` survives a bust of `post:1` —
   * so it reads the row's bucket and the collection tag's, never the index. Reusing the collection
   * bucket as the index meant `invalidateTags([tag('post', '1')])` returned every post-tagged key
   * in the store and deleted them: one row write emptied the shared tier for that whole entity,
   * while the in-process tier one rung closer kept exactly the row that had changed.
   *
   * A collection bust also reads `tagKey(owned)`, a strict subset of the index in this layout. That
   * extra `SMEMBERS` is bought deliberately: a deployment pinned to `buildId: null` upgrades into
   * this layout with the old two-role buckets still leased, and reading them keeps a collection
   * bust from MISSING those keys. Over-reading a subset costs a round trip; under-reading is stale.
   */
  const bustBucketsFor = (owned: CacheTag): string[] =>
    owned.id === undefined
      ? [entityKey(owned.entity), tagKey(owned)]
      : [tagKey(owned), tagKey({ entity: owned.entity })];

  /**
   * The buckets a bust CLEANS UP, which is not the set it reads — and the asymmetry is the point.
   *
   * A row bust must not READ the entity index: it holds every key of the entity, so the bust would
   * delete them all. It must still SREM from it. `set` joins the index on every write, so a row
   * bust that deletes a value key and leaves its membership there leaves a corpse no later bust
   * can reach — while `TAG_MEMBER_SCRIPT` renews that index's lease on every write, which is the
   * unbounded `SMEMBERS` the lease exists to prevent, rebuilt out of dead keys. Removing a member
   * cannot over-reach the way reading one can: only what this bust actually deleted leaves.
   */
  const sweepBucketsFor = (owned: CacheTag): string[] =>
    owned.id === undefined ? [] : [entityKey(owned.entity)];

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
      const lease = leaseFrom(pttl);
      // Expired between the two commands. Reported as a hit it would be a hit with no `expiresAt`,
      // which the stack promotes into the LRU on the CALLER's ttl — a row one millisecond from
      // death handed a fresh five minutes, one tier closer to the request.
      if ('kind' in lease && lease.kind === 'reaped') return undefined;
      try {
        const parsed = JSON.parse(raw) as StoredEntry;
        return {
          value: parsed.v as T,
          tags: parsed.t.map(parseTag),
          ...('ms' in lease ? { expiresAt: nowMs(clock) + lease.ms } : {}),
        };
      } catch {
        // A poisoned value is a miss, never a 500. Redis TTL will reap it.
        logger.warn('cache.redis.corrupt-entry', { key });
        return undefined;
      }
    },

    /**
     * The value key gets a lease and so does every bucket it joins — see `TAG_MEMBER_SCRIPT`.
     *
     * The buckets are joined FIRST and the membership is re-checked LAST, because this write and
     * a bust of the same tag are two clients with no lock between them. Writing the value first
     * left a window where the bust's `SMEMBERS` found an empty bucket and the value it should
     * have cleared survived its own invalidation for the full TTL. Joining first moves the window
     * somewhere observable: `invalidateTags` removes a member only when it deleted that member's
     * value key, so a membership gone by the time the `SET` lands means this write was busted
     * while it was in the air — and the value goes with it, because a row nothing can reach by
     * tag is one no later bust can clear either.
     */
    async set<T>(key: string, value: T, setOptions?: CacheSetOptions): Promise<void> {
      const tags = setOptions?.tags ?? [];
      const ttlMs = assertTtl(key, setOptions?.ttlMs ?? defaultTtlMs, 'redis', jitter);
      const payload: StoredEntry = { v: value, t: tags.map(serializeTag) };
      const stored = valueKey(key);
      // `PX`, not `EX`: the value's lease is spent in the milliseconds it was validated and
      // jittered in. `Math.ceil(ttlMs / 1000)` honoured a 1,001ms lease as 2s — rounding toward
      // STALENESS, the opposite of what the jitter beside it protects, and a disagreement with
      // the LRU tier about when the same entry dies. The BUCKET keeps whole seconds and keeps
      // rounding up: a tag set has to outlive every member it holds.
      const bucketTtlSeconds = String(Math.max(1, Math.ceil(ttlMs / 1000)) + TAG_TTL_GRACE_SECONDS);
      // Deduped: two tags of one entity share the entity index, and joining it twice is a round
      // trip that changes nothing. Issued together — one key each, so still slot-local.
      const buckets = [...new Set(tags.flatMap(writeBucketsFor))];
      await Promise.all(
        buckets.map((bucket) =>
          conn().send('EVAL', [TAG_MEMBER_SCRIPT, '1', bucket, stored, bucketTtlSeconds]),
        ),
      );
      await conn().send('SET', [stored, JSON.stringify(payload), 'PX', String(Math.ceil(ttlMs))]);
      if (buckets.length === 0) return;
      const membership = await Promise.all(
        buckets.map((bucket) => conn().send('SISMEMBER', [bucket, stored])),
      );
      if (membership.some(saysAbsent)) await conn().send('DEL', [stored]);
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
      const perTag: { read: string[]; sweep: string[] }[] = [];
      for (const owned of tags) {
        // A bucket already claimed by an earlier tag is dropped rather than re-sent: a collection
        // tag and one of its rows overlap, and the second call would read the same members.
        const read = bustBucketsFor(owned).filter((bucket) => !claimed.has(bucket));
        for (const bucket of read) claimed.add(bucket);
        if (read.length > 0) perTag.push({ read, sweep: [...read, ...sweepBucketsFor(owned)] });
      }
      if (perTag.length === 0) return { tier: 'redis', keys: [] };
      const replies = await Promise.all(
        perTag.map(({ read }) =>
          conn().send('EVAL', [INVALIDATE_SCRIPT, String(read.length), ...read]),
        ),
      );
      // A member may sit in two tag sets; deleting it twice is harmless but reporting it twice
      // makes the `/_x` panel overstate what cleared.
      const members = [...new Set(replies.flatMap(toStrings))];
      const deleted = new Set<string>();
      const failures: unknown[] = [];
      for (let start = 0; start < members.length; start += DELETE_BATCH) {
        // One key per DEL — always slot-local. Issued together so the batch costs one round trip.
        // `allSettled`, because which ones died decides what leaves the buckets below.
        const batch = members.slice(start, start + DELETE_BATCH);
        const settled = await Promise.allSettled(
          batch.map((member) => conn().send('DEL', [member])),
        );
        settled.forEach((result, index) => {
          const member = batch[index];
          if (member === undefined) return;
          if (result.status === 'fulfilled') deleted.add(member);
          else failures.push(result.reason);
        });
      }

      // Only what actually died leaves its bucket. A member the store refused to delete keeps its
      // membership, so the retry `report.errors` asks for still finds it; the script no longer
      // drops the bucket, which is what made that failure permanent.
      for (let i = 0; i < perTag.length; i += 1) {
        const gone = [...new Set(toStrings(replies[i]))].filter((member) => deleted.has(member));
        for (const bucket of perTag[i]?.sweep ?? []) {
          for (let start = 0; start < gone.length; start += DELETE_BATCH) {
            await conn().send('SREM', [bucket, ...gone.slice(start, start + DELETE_BATCH)]);
          }
        }
      }

      if (failures.length > 0) raiseSweepFailure(failures, members.length);
      const stripped = [...deleted].map((key) => key.slice(`${ns}:c:`.length));
      return { tier: 'redis', keys: stripped };
    },
  };
}

export const REDIS_INVALIDATE_SCRIPT = INVALIDATE_SCRIPT;
export const REDIS_TAG_MEMBER_SCRIPT = TAG_MEMBER_SCRIPT;
