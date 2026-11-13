// The static tag graph `x cache graph` prints: per declared tag, the actions whose `invalidates`
// name it, the queries cached under it and the ISR routes revalidated by it — read off the app's
// manifest, the one description of what each primitive declared. Pure: manifest in, rows out.

import { parseTag } from '@ultimat3/cache';

/** What the graph reads of a `Manifest` — the whole manifest satisfies it, so does a fixture. */
export interface CacheGraphSource {
  readonly actions: readonly {
    readonly name: string;
    readonly cacheInvalidates: readonly string[];
  }[];
  readonly queries: readonly { readonly name: string; readonly cacheTags: readonly string[] }[];
  readonly routes: readonly { readonly url: string; readonly revalidateTags?: readonly string[] }[];
}

export interface CacheGraphRow {
  /** The entity half of the tag: `post` for both `post` and `post:42`. */
  readonly tag: string;
  /** Actions whose `invalidates` names it — the writes that evict. */
  readonly writers: readonly string[];
  /** Queries cached under it — the reads that are evicted. */
  readonly readers: readonly string[];
  /** Routes whose `revalidate: { tags }` names it. */
  readonly routes: readonly string[];
}

/** A tag read and never written: its entries are fresh only until their TTL. */
export const neverEvicted = (row: CacheGraphRow): boolean =>
  row.writers.length === 0 && (row.readers.length > 0 || row.routes.length > 0);

interface Builder {
  readonly writers: Set<string>;
  readonly readers: Set<string>;
  readonly routes: Set<string>;
}

export function cacheGraph(manifest: CacheGraphSource): readonly CacheGraphRow[] {
  // A `Map`, never a record keyed by tag: a tag is the app's string, and `__proto__` is one.
  const rows = new Map<string, Builder>();
  const row = (wire: string): Builder => {
    const tag = parseTag(wire).entity;
    const found = rows.get(tag);
    if (found !== undefined) return found;
    const fresh: Builder = { writers: new Set(), readers: new Set(), routes: new Set() };
    rows.set(tag, fresh);
    return fresh;
  };
  for (const action of manifest.actions) {
    for (const wire of action.cacheInvalidates) row(wire).writers.add(action.name);
  }
  for (const query of manifest.queries) {
    for (const wire of query.cacheTags) row(wire).readers.add(query.name);
  }
  for (const route of manifest.routes) {
    for (const wire of route.revalidateTags ?? []) row(wire).routes.add(route.url);
  }
  const sorted = (set: ReadonlySet<string>): readonly string[] => [...set].sort();
  return [...rows.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tag, built]) => ({
      tag,
      writers: sorted(built.writers),
      readers: sorted(built.readers),
      routes: sorted(built.routes),
    }));
}
