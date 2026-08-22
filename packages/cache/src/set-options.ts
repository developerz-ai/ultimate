// How two callers' `CacheSetOptions` become one write, and how a `null` load picks its TTL. Both
// belong to the stack rather than to a tier — a tier sees one caller and one value, and neither
// decision is answerable from there.

import type { CacheTag } from './tags';
import { serializeTag } from './tags';
import type { CacheSetOptions } from './tiers';

/**
 * `negativeTtlMs` selected when the value IS the absence of one. A lookup for a row that has not
 * replicated yet answers `null` 40ms before it lands; holding that for the positive TTL serves
 * "does not exist" for five minutes.
 */
export function ttlOptionsFor<T>(value: T, options?: CacheSetOptions): CacheSetOptions | undefined {
  const negative = options?.negativeTtlMs;
  if (negative === undefined) return options;
  if (value !== null && value !== undefined) return options;
  return { ...options, ttlMs: negative };
}

/** First-seen order, deduped on the wire form — the same identity every tier indexes by. */
function mergeTags(
  current: readonly CacheTag[] | undefined,
  joining: readonly CacheTag[] | undefined,
): readonly CacheTag[] | undefined {
  if (current === undefined) return joining;
  if (joining === undefined) return current;
  const seen = new Set(current.map(serializeTag));
  const merged = [...current];
  for (const owned of joining) {
    const wire = serializeTag(owned);
    if (seen.has(wire)) continue;
    seen.add(wire);
    merged.push(owned);
  }
  return merged;
}

/** The SHORTEST lease wins: an entry held longer than a caller asked for is that caller's bug. */
function shortest(current: number | undefined, joining: number | undefined): number | undefined {
  if (current === undefined) return joining;
  if (joining === undefined) return current;
  return Math.min(current, joining);
}

/**
 * Fold a joiner's options into the single-flight leader's.
 *
 * A joiner that shares a load also shares its WRITE, so options it declared and the leader did not
 * are silently dropped without this: the entry lands carrying only the leader's tags, and the
 * joiner's invalidation — the whole point of declaring a tag — never reaches it again.
 */
export function mergeSetOptions(
  current: CacheSetOptions,
  joining: CacheSetOptions,
): CacheSetOptions {
  const tags = mergeTags(current.tags, joining.tags);
  const ttlMs = shortest(current.ttlMs, joining.ttlMs);
  const negativeTtlMs = shortest(current.negativeTtlMs, joining.negativeTtlMs);
  return {
    ...(tags === undefined ? {} : { tags }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(negativeTtlMs === undefined ? {} : { negativeTtlMs }),
  };
}

/**
 * Did `latest` gain a tag `written` does not carry?
 *
 * Compared on the wire form — the identity every tier indexes by and the one `mergeTags` above
 * dedupes on — so "already written" means the same thing to both, and a re-fill is asked for
 * exactly when a joiner brought something new.
 */
export function tagsAddedSince(
  written: CacheSetOptions | undefined,
  latest: CacheSetOptions | undefined,
): boolean {
  const added = latest?.tags;
  if (added === undefined || added.length === 0) return false;
  const seen = new Set((written?.tags ?? []).map(serializeTag));
  return added.some((owned) => !seen.has(serializeTag(owned)));
}
