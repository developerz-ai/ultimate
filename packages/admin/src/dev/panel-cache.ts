// Panel: Cache.
// Kills: "why is this page still stale?" — the tag graph, and the invalidation log showing
// what busted what.

import type { CacheEdgeFact, InvalidationFact } from './facts';
import type { DevPanel } from './panel';

export interface CachePanelData {
  readonly graph: readonly CacheEdgeFact[];
  readonly invalidations: readonly InvalidationFact[];
  /** Tags nothing depends on: an `invalidates: [tag.x]` that can never bust anything. */
  readonly orphanTags: readonly string[];
  /** Dependents per kind — cache keys vs ISR routes vs CDN paths vs live queries. */
  readonly byKind: Readonly<Record<string, number>>;
  /** Dependents the log shows actually being busted. The rest are still holding. */
  readonly bustedRecently: readonly string[];
  readonly note: string | null;
}

export const cachePanel: DevPanel<CachePanelData> = {
  key: 'cache',
  titleKey: 'dev.panel.cache.title',
  questionKey: 'dev.panel.cache.question',
  async data(sources): Promise<CachePanelData> {
    const graph = await sources.cacheGraph();
    // The invalidation log needs a running process that has served a write; the graph alone
    // is still worth showing.
    const invalidations = await sources
      .invalidations()
      .catch((): readonly InvalidationFact[] => []);

    const busted = new Set(invalidations.flatMap((event) => event.busted));
    // A `Map`, then `Object.fromEntries` — never `count[key] = (count[key] ?? 0) + 1` on a plain
    // object. `dep.kind` is a plain `string` in the fact type, so `__proto__` reaches it: the read
    // answers `Object.prototype` (so `?? 0` never fires) and the write runs the setter, which
    // re-prototypes the record instead of adding a key and drops the row from the panel. A `Map`
    // has no prototype chain to consult, and `fromEntries` DEFINES each key rather than assigning.
    const counts = new Map<string, number>();
    for (const edge of graph) {
      for (const dep of edge.dependents) counts.set(dep.kind, (counts.get(dep.kind) ?? 0) + 1);
    }
    const byKind = Object.fromEntries(counts);

    return {
      graph,
      invalidations,
      orphanTags: graph.filter((edge) => edge.dependents.length === 0).map((edge) => edge.tag),
      byKind,
      bustedRecently: [...busted].sort(),
      note: invalidations.length === 0 ? 'dev.cache.no-invalidations-yet' : null,
    };
  },
};
