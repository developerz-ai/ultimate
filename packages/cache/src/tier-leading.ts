// Which load holds each key in a read-through flight, and whether a bust has overtaken it. A read
// asks this before joining, and the stampede guard's arrivals are the callers: every one of ~1,600
// joiners asking the fence walks the marks since its sample, so this asks only when something moved.

import type { CacheFence } from './fence';
import { fenceGeneration } from './fence';
import type { CacheTag } from './tags';
import { serializeTag } from './tags';

interface Leading {
  readonly fence: CacheFence;
  /** Wire forms already on the fence, so a joiner's repeat of a tag adds no scope to walk. */
  readonly covered: Set<string>;
  /** The fence generation it last answered valid at. */
  checkedAt: number;
}

export interface LeadingLoads {
  /** Call as the fence is sampled, in the same tick, so `checkedAt` is the fence's own sample. */
  lead(key: string, fence: CacheFence, tags: readonly CacheTag[] | undefined): void;
  /** Has anything this reader needs to see landed since the load holding `key` began? */
  overtaken(key: string, tags: readonly CacheTag[] | undefined): boolean;
  /** The flight's `released`: an entry exists exactly while the flight holds the key. */
  release(key: string): void;
  /** Keys tracked right now. A number that does not fall back to `0` is a leak. */
  readonly size: number;
}

export function leadingLoads(): LeadingLoads {
  const loads = new Map<string, Leading>();
  return {
    lead(key, fence, tags): void {
      const covered = new Set((tags ?? []).map(serializeTag));
      loads.set(key, { fence, covered, checkedAt: fenceGeneration() });
    },

    overtaken(key, tags): boolean {
      const held = loads.get(key);
      if (held === undefined) return false;
      const unseen: CacheTag[] = [];
      for (const owned of tags ?? []) {
        const wire = serializeTag(owned);
        if (held.covered.has(wire)) continue;
        held.covered.add(wire);
        unseen.push(owned);
      }
      // Covering reaches back to the sample, so a tag new to this load must be asked about even
      // when nothing has moved since the last answer.
      if (unseen.length > 0) held.fence.cover({ tags: unseen });
      const generation = fenceGeneration();
      if (unseen.length === 0 && held.checkedAt === generation) return false;
      held.checkedAt = generation;
      return !held.fence.isValid();
    },

    release(key): void {
      loads.delete(key);
    },

    get size(): number {
      return loads.size;
    },
  };
}
