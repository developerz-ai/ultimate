// ONE invalidation graph, not three. Memoized values, LRU keys, Redis keys, ISR routes and
// CDN paths all register their tag dependencies here — so `invalidates: [tag.post]` reaches
// every one of them in a single hop. There is deliberately no exported constructor: a
// second graph would be a second source of truth, which is how "the page is still stale"
// bugs are born. Register into this one or you are not in the framework.

import type { CacheTag } from './tags';
import { parseTag, serializeTag, serializeTags } from './tags';

export type DependentKind = 'cache-key' | 'isr-route' | 'cdn-path' | 'live-query';

/** A thing that goes stale when a tag changes. `id` is a cache key, route path, or URL. */
export interface CacheDependent {
  readonly kind: DependentKind;
  readonly id: string;
}

const byTag = new Map<string, Set<string>>();
// The mirror of `LruCache`'s `entityIndex`: entity name -> every dependent registered under ANY tag
// of that entity, row tags included. Without it a collection bust reached only the dependents
// registered on the bare collection tag, so `invalidateTags([tag.post])` cleared the cached detail
// page and left its ISR route, its CDN path and its live query untouched — reported as clean.
const byEntity = new Map<string, Set<string>>();
const dependents = new Map<string, CacheDependent>();
const tagsByDependent = new Map<string, Set<string>>();

const dependentId = (dep: CacheDependent): string => `${dep.kind}\u0000${dep.id}`;

function addTo(index: Map<string, Set<string>>, bucket: string, key: string): void {
  let set = index.get(bucket);
  if (set === undefined) {
    set = new Set();
    index.set(bucket, set);
  }
  set.add(key);
}

function removeFrom(index: Map<string, Set<string>>, bucket: string, key: string): void {
  const set = index.get(bucket);
  if (set === undefined) return;
  set.delete(key);
  if (set.size === 0) index.delete(bucket);
}

function link(wireTag: string, dep: CacheDependent): void {
  const key = dependentId(dep);
  dependents.set(key, dep);

  addTo(byTag, wireTag, key);
  addTo(byEntity, parseTag(wireTag).entity, key);
  addTo(tagsByDependent, key, wireTag);
}

/** Record that `dep` is stale whenever any of `tags` changes. Idempotent. */
export function registerDependent(tags: readonly CacheTag[], dep: CacheDependent): void {
  for (const wire of serializeTags(tags)) link(wire, dep);
}

export function unregisterDependent(dep: CacheDependent): void {
  const key = dependentId(dep);
  const owned = tagsByDependent.get(key);
  if (owned !== undefined) {
    for (const wire of owned) {
      removeFrom(byTag, wire, key);
      removeFrom(byEntity, parseTag(wire).entity, key);
    }
  }
  tagsByDependent.delete(key);
  dependents.delete(key);
}

/**
 * Everything that must be busted for `tags`, expanded in BOTH directions exactly as `tagMatches`
 * answers and as `LruCache.invalidateTags` clears: a row tag (`post:1`) also matches the collection
 * tag (`post`) it belongs to, and a collection tag matches every row of that entity.
 */
export function dependentsOf(tags: readonly CacheTag[]): readonly CacheDependent[] {
  const seen = new Set<string>();
  const out: CacheDependent[] = [];

  const collect = (keys: Iterable<string> | undefined): void => {
    for (const key of keys ?? []) {
      if (seen.has(key)) continue;
      seen.add(key);
      const dep = dependents.get(key);
      if (dep !== undefined) out.push(dep);
    }
  };

  for (const value of tags) {
    if (value.id === undefined) {
      collect(byEntity.get(value.entity));
      continue;
    }
    collect(byTag.get(serializeTag(value)));
    collect(byTag.get(value.entity));
  }
  return out;
}

export function dependentsOfKind(
  tags: readonly CacheTag[],
  kind: DependentKind,
): readonly string[] {
  return dependentsOf(tags)
    .filter((dep) => dep.kind === kind)
    .map((dep) => dep.id);
}

/** `--json` shape for the `/_x` cache panel: tag -> dependents. */
export function graphSnapshot(): { tag: string; dependents: CacheDependent[] }[] {
  return [...byTag.entries()]
    .map(([wire, keys]) => ({
      tag: wire,
      dependents: [...keys]
        .map((key) => dependents.get(key))
        .filter((dep): dep is CacheDependent => dep !== undefined),
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export function graphSize(): { tags: number; dependents: number } {
  return { tags: byTag.size, dependents: dependents.size };
}

/** Tests and `x dev` hot reload only. Production code never drops the graph. */
export function resetGraph(): void {
  byTag.clear();
  byEntity.clear();
  dependents.clear();
  tagsByDependent.clear();
}

/**
 * `isolateDeclaredTags()`'s contract over the graph — `tags.ts` carries the why. Captures all three
 * indexes and puts back exactly what it found, so a suite whose subject is an empty graph keeps
 * `resetGraph()` per test and still hands the process back the edges it was given:
 *
 *   const restoreGraph = isolateGraph();
 *   afterAll(restoreGraph);
 *
 * Copies on both halves: the returned function restores the same baseline however often it runs,
 * and a later `registerDependent()` cannot reach into what was captured.
 */
export function isolateGraph(): () => void {
  const capturedByTag = new Map([...byTag].map(([wire, keys]) => [wire, [...keys]] as const));
  const capturedDependents = new Map(dependents);
  const capturedOwned = new Map(
    [...tagsByDependent].map(([key, wires]) => [key, [...wires]] as const),
  );

  return () => {
    resetGraph();
    for (const [wire, keys] of capturedByTag) byTag.set(wire, new Set(keys));
    for (const [key, dep] of capturedDependents) dependents.set(key, dep);
    // `byEntity` is derived, so it is rebuilt from the captured wire tags rather than captured
    // separately — one fewer index a future edit can forget to put back.
    for (const [key, wires] of capturedOwned) {
      tagsByDependent.set(key, new Set(wires));
      for (const wire of wires) addTo(byEntity, parseTag(wire).entity, key);
    }
  };
}
