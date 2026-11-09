// Tier 2: shared cache over core's `redisClient()` (no client dependency — the runtime ships one).
// A tag -> keys bucket is maintained alongside every write (`redis-buckets.ts`), so a bust reads
// what it must delete instead of scanning with KEYS — O(n) over the whole server, an outage
// shipped as the invalidation path.

import type { Clock } from '@ultimat3/core';
import { appVersion, logger, systemClock } from '@ultimat3/core';
import type { DeadlineTimer } from '@ultimat3/core/outbound';
import { redisClient } from '@ultimat3/core/redis';
import { CacheDriverUnavailableError, CacheTooLargeError } from './errors';
import type { FenceScope } from './fence';
import {
  bucketLayout,
  joinBuckets,
  lostMembership,
  readBucket,
  sweepBuckets,
  unlinkAll,
} from './redis-buckets';
import type { DeadlinedRedis } from './redis-deadline';
import { DEFAULT_REDIS_COMMAND_TIMEOUT_MS, withinDeadline } from './redis-deadline';
import { bumpGenerations, sampleGenerations } from './redis-fence';
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
import { assertFiniteCapacity, assertFiniteDurationMs, assertTtl, nowMs } from './tiers';
import { decodeCacheValue, encodeCacheValue } from './value-codec';

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
  /**
   * Injected in tests and for a second server; production takes `redisClient()` from
   * `@ultimat3/core/redis` (`REDIS_URL`, else `VALKEY_URL`; the CLI boot hands in a lazy one). A client handed in keeps its own reconnect behaviour and
   * still gets the deadline.
   */
  readonly client?: RedisLike;
  /**
   * How long one value-path command may take, in ms. Default `DEFAULT_REDIS_COMMAND_TIMEOUT_MS`
   * (150). A miss is `X_CACHE_DRIVER_UNAVAILABLE` in `recentTierFailures()`, read as a cache miss,
   * and parks the value path for `REDIS_PARK_MS`. A bust has its own, longer, unparked deadline.
   */
  readonly commandTimeoutMs?: number;
  /** Injected so a test fires the deadline instead of waiting for it. */
  readonly timer?: DeadlineTimer;
  /** Turns `PTTL`'s remaining life into the absolute `expiresAt` a hit reports. */
  readonly clock?: Clock;
  /** TTL spread, in `[0, 1)`. Default `DEFAULT_TTL_JITTER_FRACTION`; `0` disables it. */
  readonly jitterFraction?: number;
  /** Injected so a jittered `PX` is deterministic; `() => 0` is the full lease. */
  readonly rng?: Rng;
  /**
   * The largest encoded value one `set` may write, in UTF-8 bytes. Default
   * `DEFAULT_REDIS_MAX_VALUE_BYTES` (1 MiB). Over it is `X_CACHE_TOO_LARGE`, as the LRU's
   * `maxBytes` is: a multi-megabyte value blocks the shared server for every replica.
   */
  readonly maxValueBytes?: number;
}

/** 1 MiB. A value past it costs the shared server more than the load it saves. */
export const DEFAULT_REDIS_MAX_VALUE_BYTES = 1_048_576;

const utf8 = new TextEncoder();

/** Refuse a value over the tier's budget. Cheap when it is far under: bytes <= 3 × UTF-16 length. */
function assertWithinBudget(key: string, text: string, maxBytes: number): void {
  if (text.length * 3 <= maxBytes) return;
  const bytes = utf8.encode(text).byteLength;
  if (bytes > maxBytes) throw new CacheTooLargeError({ key, bytes, maxBytes, tier: 'redis' });
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
 * The first refusal, verbatim when it is one — `fanOut` renders `message` into `report.errors`, so
 * the operator sees which key the store refused rather than a count.
 *
 * The `fix:` is the call, not a command: there is no `x cache` in this build, and the retry is one
 * line of the app's own code. It is safe to repeat because every key the store refused kept its
 * tag membership — the bust `ZREM`s only what it deleted.
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

export function redisTier(options: RedisTierOptions = {}): CacheTier {
  const ns = namespaceFor(options.prefix ?? 'x', options.buildId);
  const defaultTtlMs = assertFiniteDurationMs(
    'redis',
    'defaultTtlMs',
    options.defaultTtlMs ?? 300_000,
  );
  const clock = options.clock ?? systemClock;
  const maxValueBytes = assertFiniteCapacity(
    'redis',
    'maxValueBytes',
    options.maxValueBytes ?? DEFAULT_REDIS_MAX_VALUE_BYTES,
  );
  const jitter: TtlJitter = {
    ...(options.jitterFraction === undefined ? {} : { jitterFraction: options.jitterFraction }),
    ...(options.rng === undefined ? {} : { rng: options.rng }),
  };
  const commandTimeoutMs = assertFiniteDurationMs(
    'redis',
    'commandTimeoutMs',
    options.commandTimeoutMs ?? DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  );
  // Built at the first command, never at construction: a tier selected in config dials nothing
  // until it is used.
  let bounded: DeadlinedRedis | undefined;
  const views = (): DeadlinedRedis => {
    bounded ??= withinDeadline(options.client ?? redisClient(), {
      commandTimeoutMs,
      clock,
      ...(options.timer === undefined ? {} : { timer: options.timer }),
    });
    return bounded;
  };
  // A read, a fill and a fence sample: parked after a missed deadline, so a stalled store costs
  // one deadline per `REDIS_PARK_MS`, not five per read.
  const conn = (): RedisLike => views().value;
  // A bust skips the park: skipped for a stall, it leaves stale rows serving until TTL.
  const bustConn = (): RedisLike => views().bust;

  const { valueKey, writeBucketsFor, bustBucketsFor, sweepBucketsFor } = bucketLayout(ns);

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
        // `decodeCacheValue`, not `JSON.parse`: the LRU decodes with the same codec, so a `Date`
        // promoted out of here is a `Date` there too. Plain JSON written before the codec reads as-is.
        const parsed = decodeCacheValue(raw) as StoredEntry;
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
     * The value key gets a lease, and every bucket it joins is pruned and re-leased
     * (`joinBuckets`).
     *
     * The buckets are joined FIRST and the membership is re-checked LAST, because this write and
     * a bust of the same tag are two clients with no lock between them. Writing the value first
     * left a window where the bust's read found an empty bucket and the value it should have
     * cleared survived its own invalidation for the full TTL. Joining first moves the window
     * somewhere observable: `invalidateTags` removes a member only when it deleted that member's
     * value key, so a membership gone by the time the `SET` lands means this write was busted
     * while it was in the air — and the value goes with it, because a row nothing can reach by
     * tag is one no later bust can clear either.
     */
    async set<T>(key: string, value: T, setOptions?: CacheSetOptions): Promise<void> {
      const tags = setOptions?.tags ?? [];
      const ttlMs = assertTtl(key, setOptions?.ttlMs ?? defaultTtlMs, 'redis', jitter);
      const payload: StoredEntry = { v: value, t: tags.map(serializeTag) };
      // Before any bucket is joined: an unencodable or oversized value is refused with nothing
      // left behind.
      const text = encodeCacheValue(payload, { key, tier: 'redis' });
      assertWithinBudget(key, text, maxValueBytes);
      const stored = valueKey(key);
      // Deduped: two tags of one entity share the entity index, and joining it twice is a round
      // trip that changes nothing.
      const buckets = [...new Set(tags.flatMap(writeBucketsFor))];
      await joinBuckets(conn(), buckets, stored, nowMs(clock), ttlMs);
      // `PX`, not `EX`: the value's lease is spent in the milliseconds it was validated and
      // jittered in. A whole-second `EX` honoured a 1,001ms lease as 2s — rounding toward
      // staleness, and a disagreement with the LRU tier about when the same entry dies.
      await conn().send('SET', [stored, text, 'PX', String(Math.ceil(ttlMs))]);
      if (buckets.length === 0) return;
      if (await lostMembership(conn(), buckets, stored)) await conn().send('DEL', [stored]);
    },

    async del(key: string): Promise<void> {
      await conn().send('DEL', [valueKey(key)]);
    },

    /** The fleet-wide half of the fill fence: generations other replicas' busts move. */
    fence: (scope: FenceScope) => sampleGenerations(conn(), ns, clock, scope),

    /**
     * Read every bucket the tags match, a page per round trip and the buckets concurrently;
     * `UNLINK` what they held, one key per command; then `ZREM` exactly what died. Every command
     * names one key, so a bust is slot-local on Redis Cluster whatever tags it carries.
     */
    async invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
      const claimed = new Set<string>();
      const perTag: { read: string[]; sweep: string[] }[] = [];
      for (const owned of tags) {
        // A bucket already claimed by an earlier tag is not read twice: a collection tag and one
        // of its rows overlap.
        const read = bustBucketsFor(owned).filter((bucket) => !claimed.has(bucket));
        for (const bucket of read) claimed.add(bucket);
        if (read.length > 0) perTag.push({ read, sweep: sweepBucketsFor(owned) });
      }
      if (perTag.length === 0) return { tier: 'redis', keys: [] };
      // Before the buckets are read, and awaited: see `bumpGenerations` for why the order is the
      // guarantee. A refusal here rejects the bust into `report.errors` with nothing deleted, so
      // the retry it asks for repeats the whole thing.
      await bumpGenerations(bustConn(), ns, tags);
      const buckets = [...claimed];
      const pages = await Promise.all(buckets.map((bucket) => readBucket(bustConn(), bucket)));
      const held = new Map(buckets.map((bucket, i) => [bucket, pages[i] ?? []]));
      // A member may sit in two buckets; deleting it twice is harmless but reporting it twice
      // makes the `/_x` panel overstate what cleared.
      const members = [...new Set(pages.flat())];
      const { deleted, failures } = await unlinkAll(bustConn(), members);

      // Only what actually died leaves its buckets. A member the store refused to delete keeps its
      // membership, so the retry `report.errors` asks for still finds it.
      const gone = new Map<string, Set<string>>();
      for (const { read, sweep } of perTag) {
        const died = read.flatMap((bucket) => held.get(bucket) ?? []).filter((m) => deleted.has(m));
        if (died.length === 0) continue;
        for (const bucket of sweep) {
          const into = gone.get(bucket) ?? new Set<string>();
          for (const member of died) into.add(member);
          gone.set(bucket, into);
        }
      }
      await sweepBuckets(bustConn(), gone);

      if (failures.length > 0) raiseSweepFailure(failures, members.length);
      const stripped = [...deleted].map((key) => key.slice(valueKey('').length));
      return { tier: 'redis', keys: stripped };
    },
  };
}
