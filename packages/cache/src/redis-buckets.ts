// The shared tier's tag -> keys layout and every command that reads or writes it. A bucket is a
// sorted set scored by when its member may be forgotten, so every write prunes the dead and a
// bucket holds live keys only; a bust reads it in pages. One key per command, always: slot-local
// on Redis Cluster and Dragonfly by construction, and plain commands the recording fake can hold.

import { CacheDriverUnavailableError } from './errors';
import type { RedisLike } from './redis';
import type { CacheTag } from './tags';

/**
 * How long a member outlives its value key, in ms. The score is the WRITER's clock and the prune
 * is the next writer's: a pod running ahead would forget a member whose value key still lives, and
 * that key would serve stale with no tag left to reach it. Skew under the grace cannot do that.
 */
export const TAG_GRACE_MS = 60_000;

/** The `COUNT` hint of one `ZSCAN`. A whole bucket in one reply blocks the shared server. */
export const BUST_PAGE_SIZE = 1_000;

/** Value keys `UNLINK`ed per pipelined burst. Bounds client memory, not round trips. */
const UNLINK_BATCH = 1_024;

/** Members per `ZREM`, and how many of those are in flight at once. */
const SWEEP_CHUNK = 1_000;
const SWEEP_CONCURRENCY = 8;

/**
 * The bucket's own lease, which only ever GROWS: a 60s member must not shorten a bucket a 1h member
 * is in, or that value key becomes unreachable by tag. `EXPIRE … GT` treats a key with no TTL as
 * infinite, so a fresh bucket would keep none — read-then-set inside a script covers both, with no
 * Redis 7. The prune bounds a bucket that is written; this lease removes one that is not.
 */
export const REDIS_TAG_LEASE_SCRIPT = `
local ttl = tonumber(ARGV[1])
local current = redis.call('TTL', KEYS[1])
if current < 0 or current < ttl then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return 1
`.trim();

/**
 * The key layout. `t2:` is a TAG's bucket and `e2:` its ENTITY's index — one key is never both, or a
 * row bust over-reaches. The `2` is the sorted-set generation: a v30 pod's `t:`/`e:` plain sets
 * never collide with these on a shared server, and expire on their own lease.
 *
 * `{entity}` is a Redis Cluster hash tag, not decoration: a row's bucket and its collection's
 * hash to one slot.
 */
export function bucketLayout(ns: string) {
  const tagKey = (owned: CacheTag): string =>
    owned.id === undefined
      ? `${ns}:t2:{${owned.entity}}`
      : `${ns}:t2:{${owned.entity}}:${owned.id}`;
  const entityKey = (entity: string): string => `${ns}:e2:{${entity}}`;
  return {
    valueKey: (key: string): string => `${ns}:c:${key}`,
    /** A write joins its tag's bucket plus its entity's index. */
    writeBucketsFor: (owned: CacheTag): string[] => [tagKey(owned), entityKey(owned.entity)],
    /**
     * `tagMatches` in keys. A COLLECTION bust reads the entity index, which holds every key of the
     * entity. A ROW bust reads its own bucket and the bare collection tag's — never the index, or
     * `post:2` dies with `post:1`.
     */
    bustBucketsFor: (owned: CacheTag): string[] =>
      owned.id === undefined
        ? [entityKey(owned.entity)]
        : [tagKey(owned), tagKey({ entity: owned.entity })],
    /**
     * The buckets a bust CLEANS, a superset of what it reads. A row bust never reads the index but
     * must still `ZREM` what it deleted from it; a collection bust cleans the collection tag's
     * bucket it skipped reading. Removing can never over-reach: only what this bust deleted leaves.
     */
    sweepBucketsFor: (owned: CacheTag): string[] =>
      owned.id === undefined
        ? [entityKey(owned.entity), tagKey({ entity: owned.entity })]
        : [tagKey(owned), tagKey({ entity: owned.entity }), entityKey(owned.entity)],
  };
}

/**
 * Join `member` to every bucket, prune the dead, and extend the lease — three commands per bucket,
 * issued together, so one pipelined round trip. The order within a bucket is irrelevant: the prune
 * removes only members whose score is already past, and this member's lies `ttl + grace` ahead.
 */
export async function joinBuckets(
  client: RedisLike,
  buckets: readonly string[],
  member: string,
  now: number,
  ttlMs: number,
): Promise<void> {
  const score = String(Math.ceil(now + ttlMs) + TAG_GRACE_MS);
  const leaseSeconds = String(Math.ceil((ttlMs + TAG_GRACE_MS) / 1_000));
  await Promise.all(
    buckets.flatMap((bucket) => [
      client.send('ZADD', [bucket, score, member]),
      client.send('ZREMRANGEBYSCORE', [bucket, '-inf', `(${String(now)}`]),
      client.send('EVAL', [REDIS_TAG_LEASE_SCRIPT, '1', bucket, leaseSeconds]),
    ]),
  );
}

/**
 * `ZSCORE` answered nil for some bucket: a bust removed this member while its write was in the
 * air. Only a literal `null` counts — a reply this cannot read is not evidence, and reading one as
 * "gone" deletes every value the tier writes.
 */
export async function lostMembership(
  client: RedisLike,
  buckets: readonly string[],
  member: string,
): Promise<boolean> {
  const scores = await Promise.all(
    buckets.map((bucket) => client.send('ZSCORE', [bucket, member])),
  );
  return scores.some((reply) => reply === null);
}

/** `[cursor, [member, score, …]]` — flat in RESP2 and RESP3 alike; `[member, score]` pairs read too. */
function scanPage(reply: unknown, bucket: string): { readonly cursor: string; members: string[] } {
  if (!Array.isArray(reply) || reply.length !== 2 || !Array.isArray(reply[1])) {
    throw unreadable(bucket);
  }
  const [cursor, entries] = reply as [unknown, unknown[]];
  if (typeof cursor !== 'string' && typeof cursor !== 'number') throw unreadable(bucket);
  const members = entries.every(Array.isArray)
    ? (entries as unknown[][]).map(([member]) => member)
    : entries.filter((_, i) => i % 2 === 0);
  if (!members.every((member) => typeof member === 'string')) throw unreadable(bucket);
  return { cursor: String(cursor), members: members as string[] };
}

const unreadable = (bucket: string): CacheDriverUnavailableError =>
  new CacheDriverUnavailableError({
    driver: 'redis',
    cause: `ZSCAN on "${bucket}" answered a reply that is not a cursor and a member list`,
    fix: 'redis-cli -u "$REDIS_URL" HELLO — the tier needs a Redis or Valkey server speaking RESP2 or RESP3; point REDIS_URL at one',
  });

/**
 * Every member of one bucket, `ZSCAN … COUNT BUST_PAGE_SIZE` per round trip. `ZSCAN`, never a
 * score cursor: Redis guarantees a scan returns every member present from its first call to its
 * last, whatever is added, removed or re-scored meanwhile. A `(score, offset)` cursor broke on
 * exactly those — a concurrent prune of a read page of tied dead members, or a re-write moving a
 * read tie member up, shifted the offset past live keys, which served stale until TTL. A scan
 * may return a member twice; the set dedupes.
 */
export async function readBucket(client: RedisLike, bucket: string): Promise<string[]> {
  const members = new Set<string>();
  let cursor = '0';
  do {
    const reply = await client.send('ZSCAN', [bucket, cursor, 'COUNT', String(BUST_PAGE_SIZE)]);
    const page = scanPage(reply, bucket);
    for (const member of page.members) members.add(member);
    cursor = page.cursor;
  } while (cursor !== '0');
  return [...members];
}

/** `UNLINK` each key on its own (slot-local), pipelined per batch; which ones died is the answer. */
export async function unlinkAll(
  client: RedisLike,
  keys: readonly string[],
): Promise<{ readonly deleted: Set<string>; readonly failures: unknown[] }> {
  const deleted = new Set<string>();
  const failures: unknown[] = [];
  for (let start = 0; start < keys.length; start += UNLINK_BATCH) {
    const batch = keys.slice(start, start + UNLINK_BATCH);
    const settled = await Promise.allSettled(batch.map((key) => client.send('UNLINK', [key])));
    settled.forEach((result, index) => {
      const key = batch[index];
      if (key === undefined) return;
      if (result.status === 'fulfilled') deleted.add(key);
      else failures.push(result.reason);
    });
  }
  return { deleted, failures };
}

/** `ZREM` what died from every bucket that held it, `SWEEP_CONCURRENCY` commands in flight. */
export async function sweepBuckets(
  client: RedisLike,
  gone: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<void> {
  const work: (() => Promise<unknown>)[] = [];
  for (const [bucket, members] of gone) {
    const list = [...members];
    for (let start = 0; start < list.length; start += SWEEP_CHUNK) {
      const chunk = list.slice(start, start + SWEEP_CHUNK);
      work.push(() => client.send('ZREM', [bucket, ...chunk]));
    }
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < work.length) {
      const task = work[next];
      next += 1;
      if (task !== undefined) await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, work.length) }, worker));
}
