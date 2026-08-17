// A read-through fill writes what `load()` read, and `load()` read it in the past. An
// invalidation that lands in between finds nothing to clear and the fill then republishes the
// pre-write rows for a full TTL — invisibly, with `errors: []`. The fence is the identity check
// `single-flight.ts` does on a promise, done on time: sample before the load, ask before the write.

import type { CacheTag } from './tags';
import { tagMatches } from './tags';

/**
 * What a fill is about to publish, in invalidation terms. Both halves are optional and both are
 * checked: `key` catches a `drop`/`write` of that exact key, `tags` catch a tag bust.
 */
export interface FenceScope {
  readonly key?: string;
  readonly tags?: readonly CacheTag[];
}

export interface CacheFence {
  /** `false` once anything this fence covers was invalidated after the sample. Never throws. */
  isValid(): boolean;
  /**
   * Widen what this fence covers — retroactively, back to the sample. A joiner arriving mid-load
   * declares tags the leader never sampled, and those tags are unfenced for exactly the window
   * they were absent unless covering reaches back.
   */
  cover(scope: FenceScope): void;
}

/**
 * How many recent invalidations stay inspectable. A fill window is milliseconds and this is
 * process-wide, so the ring is only ever short of an answer under a bust storm — where the
 * conservative answer costs one refetch and the optimistic one serves a stale row until TTL.
 */
export const FENCE_MEMORY = 1024;

interface Mark {
  /** The generation this mark was recorded at; marks are pushed in generation order. */
  readonly at: number;
  readonly key?: string;
  readonly tag?: CacheTag;
}

const marks: Mark[] = [];
let generation = 0;
/** The highest generation the ring has forgotten. A fence older than this cannot be proven. */
let forgottenThrough = 0;

/**
 * Record an invalidation. `invalidateTags` already calls this for every fan-out, inbound
 * broadcasts included, and `CacheStack` calls it for `drop`/`write` — a caller only needs it when
 * it clears a cache key by some path of its own.
 *
 * Unlike every other process-global registry in this package this one needs no `isolate*()` seam
 * and has no reset: a fence samples the CURRENT generation, which is always at or above
 * `forgottenThrough`, so marks left behind by another test file can never invalidate a fence
 * sampled after them.
 */
export function markInvalidated(scope: FenceScope): void {
  const key = scope.key;
  const tags = scope.tags ?? [];
  if (key === undefined && tags.length === 0) return;

  generation += 1;
  if (key !== undefined) marks.push({ at: generation, key });
  for (const owned of tags) marks.push({ at: generation, tag: owned });

  while (marks.length > FENCE_MEMORY) {
    const dropped = marks.shift();
    if (dropped !== undefined) forgottenThrough = dropped.at;
  }
}

function hits(mark: Mark, scope: FenceScope): boolean {
  if (mark.key !== undefined) return scope.key !== undefined && mark.key === scope.key;
  const owned = mark.tag;
  if (owned === undefined) return false;
  // `tagMatches` is symmetric on the wildcard: a collection bust hits a row fence and a row bust
  // hits a collection fence, which is the same asymmetry-tolerance every tier invalidates with.
  return (scope.tags ?? []).some((wanted) => tagMatches(wanted, owned));
}

/**
 * Take a fence before `load()`; ask it before the write:
 *
 *   const fence = sampleFence({ key, tags });
 *   const value = await load();
 *   if (fence.isValid()) await tier.set(key, value, { tags });
 */
export function sampleFence(scope: FenceScope): CacheFence {
  const sampledAt = generation;
  const covered: FenceScope[] = [scope];

  return {
    cover(next: FenceScope): void {
      covered.push(next);
    },

    isValid(): boolean {
      // Older than the ring remembers: unprovable, so refused. One refetch, not a stale TTL.
      if (sampledAt < forgottenThrough) return false;
      for (let i = marks.length - 1; i >= 0; i -= 1) {
        const mark = marks[i];
        // Marks are pushed in generation order, so the first one at or below the sample ends it.
        if (mark === undefined || mark.at <= sampledAt) break;
        if (covered.some((scoped) => hits(mark, scoped))) return false;
      }
      return true;
    },
  };
}
