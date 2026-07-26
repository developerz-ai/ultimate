/**
 * Cache tags stay opaque here — they belong to @ultimat3/cache. This package only
 * needs the wire string per tag so a read's key can be found by the invalidation
 * graph an action's `invalidates` drives.
 */

import type { CacheTag } from '@ultimat3/cache';
import { serializeTag } from '@ultimat3/cache';

export function tagKey(value: CacheTag): string {
  return serializeTag(value);
}

/** Sorted + de-duplicated: descriptor output must not depend on declaration order. */
export function tagKeys(tags: readonly CacheTag[]): readonly string[] {
  return [...new Set(tags.map(tagKey))].sort();
}
