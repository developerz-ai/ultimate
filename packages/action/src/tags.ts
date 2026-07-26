/**
 * Cache tags stay opaque to actions — we hand them back to @ultimat3/cache
 * untouched. The only thing this package needs is the wire string per tag, for
 * manifests, OpenAPI metadata and the invalidation graph in `/_x`.
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
