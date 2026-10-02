// The fence, held in Redis. `fence.ts` is module state: it cannot see a bust another replica ran
// until the broadcast arrives, and a lost broadcast means never. A per-tag generation in the
// shared store is the one thing both replicas read. Plain `SET`/`GET` — no script — so the fake
// that cannot run Lua still proves every interleaving (`redis-fence.test.ts`).

import type { Clock } from '@ultimat3/core';
import type { FenceScope } from './fence';
import type { CacheTag } from './tags';
import type { FenceVerdict, TierFence } from './tier-fence';
import { nowMs } from './tiers';

/** The slice of the client a generation needs. `RedisLike` satisfies it. */
export interface GenerationClient {
  get(key: string): Promise<string | null>;
  send(command: string, args: string[]): Promise<unknown>;
}

/** How long a generation outlives the bust that wrote it. Bounds the keys a write-heavy app holds. */
export const GENERATION_LEASE_MS = 120_000;

/**
 * How long a fence can vouch for its sample — half the lease. A generation EXPIRES: sampled
 * absent, written by a bust, expired again reads as "nothing happened". A bust after the sample
 * is still on the server for the whole window, so inside it an unchanged reading is a proof; past
 * it nothing is, and the fence says so instead of guessing.
 */
export const FENCE_PROOF_WINDOW_MS = GENERATION_LEASE_MS / 2;

/**
 * `tagMatches` in keys, the way `redis.ts`'s buckets are. Three generations per entity:
 * `r:<id>` moves on a bust of that row, `c` on a collection bust, `a` on ANY bust of the entity.
 * A row fill is hit by its own row and by the collection; a collection fill by anything. One
 * counter per entity would decline every row fill while any OTHER row was being written.
 * `{entity}` is the Cluster hash tag the buckets already carry.
 */
function generationKeys(ns: string) {
  const row = (owned: CacheTag): string => `${ns}:g:{${owned.entity}}:r:${owned.id ?? ''}`;
  const collection = (entity: string): string => `${ns}:g:{${entity}}:c`;
  const any = (entity: string): string => `${ns}:g:{${entity}}:a`;
  return {
    bumpedBy: (bust: CacheTag): string[] =>
      bust.id === undefined
        ? [collection(bust.entity), any(bust.entity)]
        : [row(bust), any(bust.entity)],
    watchedBy: (owned: CacheTag): string[] =>
      owned.id === undefined ? [any(owned.entity)] : [row(owned), collection(owned.entity)],
  };
}

const unique = (keys: readonly string[]): string[] => [...new Set(keys)];

/**
 * The write half, run by a bust BEFORE it reads its buckets. That order is the whole argument: a
 * fill re-checks after its own `SET`, so either it sees this generation and withdraws, or it
 * wrote early enough that the bucket read that follows finds its key and deletes it.
 *
 * A fresh token rather than `INCR`: a counter that expired restarts at 1 and can repeat a value
 * a fence already sampled.
 */
export async function bumpGenerations(
  client: GenerationClient,
  ns: string,
  tags: readonly CacheTag[],
): Promise<void> {
  const keys = unique(tags.flatMap(generationKeys(ns).bumpedBy));
  if (keys.length === 0) return;
  const token = crypto.randomUUID();
  const lease = String(GENERATION_LEASE_MS);
  // One key per command, so each is slot-local; issued together, so the bust pays one round trip.
  await Promise.all(keys.map((key) => client.send('SET', [key, token, 'PX', lease])));
}

/** The read half: sample now, and answer later whether anything covered moved in between. */
export async function sampleGenerations(
  client: GenerationClient,
  ns: string,
  clock: Clock,
  scope: FenceScope,
): Promise<TierFence> {
  const keysFor = (tags: readonly CacheTag[] | undefined): string[] =>
    unique((tags ?? []).flatMap(generationKeys(ns).watchedBy));
  const sampledAt = nowMs(clock);
  const sampled = new Map<string, string | null>();
  await Promise.all(
    keysFor(scope.tags).map(async (key) => {
      sampled.set(key, await client.get(key));
    }),
  );
  let coveredUnsampled = false;

  return {
    cover(next: FenceScope): void {
      // Unlike the in-process ring there is no history to reach back into: a tag that arrives
      // after the sample was never read, so nothing can be said about it.
      if (keysFor(next.tags).some((key) => !sampled.has(key))) coveredUnsampled = true;
    },

    async verdict(): Promise<FenceVerdict> {
      if (coveredUnsampled) return 'unprovable';
      const elapsed = nowMs(clock) - sampledAt;
      // A clock that ran backwards measured nothing; that is not a proof either.
      if (!(elapsed >= 0 && elapsed < FENCE_PROOF_WINDOW_MS)) return 'unprovable';
      const current = await Promise.all(
        [...sampled].map(async ([key, before]) => (await client.get(key)) === before),
      );
      return current.every(Boolean) ? 'valid' : 'busted';
    },
  };
}
