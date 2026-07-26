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
  titleKey: 'dev.panel.cache',
  question: 'what invalidated what — and why is this still stale?',
  async data(sources): Promise<CachePanelData> {
    const graph = await sources.cacheGraph();
    // The invalidation log needs a running process that has served a write; the graph alone
    // is still worth showing.
    const invalidations = await sources
      .invalidations()
      .catch((): readonly InvalidationFact[] => []);

    const busted = new Set(invalidations.flatMap((event) => event.busted));
    const byKind: Record<string, number> = {};
    for (const edge of graph) {
      for (const dep of edge.dependents) byKind[dep.kind] = (byKind[dep.kind] ?? 0) + 1;
    }

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
