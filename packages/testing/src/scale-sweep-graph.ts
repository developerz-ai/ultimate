// One tenant's rows at a chosen size, written beside the pass's graph in the same database. Its rows
// of no tenant (`plans`) are NOT written again — a second copy collides on their unique keys — so
// every reference to one is pointed at the pass's own row in the same position. Pure.

import { seedGraph } from './seed-graph';
import type { SeedGraph } from './seed-graph-plan';
import type { SeedEntity } from './seed-graph-shape';

export interface ScaleGraph {
  /** The one tenant the sized rows belong to. */
  readonly tenant: string;
  /** What to write: the sized tenant's rows, references to rows of no tenant rewritten. */
  readonly write: SeedGraph;
  /** What an id lookup reads: the written rows and the pass's rows of no tenant they point at. */
  readonly lookup: SeedGraph;
}

/**
 * `seedGraph` at `perTable` rows for one tenant, rows of no tenant swapped for `main`'s. The i-th
 * such row of an entity becomes `main`'s (i mod n)-th: a reference keeps pointing at a row that
 * exists, and two rows that pointed at one row still do.
 */
export function scaleGraph(
  main: SeedGraph,
  entities: readonly SeedEntity[],
  options: { readonly perTable: number; readonly seed: number },
): ScaleGraph {
  const sized = seedGraph(Object.fromEntries(entities.map((entity) => [entity.$name, entity])), {
    tenants: 1,
    perTable: options.perTable,
    seed: options.seed,
  });
  const shared = (graph: SeedGraph) => graph.inserts.filter((insert) => insert.tenant === null);
  const theirs = shared(main);
  // (entity, property, value in the sized graph) → the pass's value at the same position.
  const swap = new Map<string, unknown>();
  const key = (entity: string, property: string, value: unknown) =>
    `${entity}\u0000${property}\u0000${JSON.stringify(value)}`;
  const seen = new Map<string, number>();
  for (const insert of shared(sized)) {
    const pool = theirs.filter((row) => row.entity === insert.entity);
    const at = seen.get(insert.entity) ?? 0;
    seen.set(insert.entity, at + 1);
    const target = pool[at % Math.max(1, pool.length)];
    if (target === undefined) continue;
    for (const [property, value] of Object.entries(insert.row)) {
      swap.set(key(insert.entity, property, value), target.row[property]);
    }
  }
  const references = new Map(
    entities.map((entity) => [
      entity.$name,
      entity
        .$references()
        .map((ref) => [ref.property, ref.targetEntity, ref.targetProperty] as const),
    ]),
  );
  const rewrite = (entity: string, row: Readonly<Record<string, unknown>>) => {
    const out: Record<string, unknown> = { ...row };
    for (const [property, target, targetProperty] of references.get(entity) ?? []) {
      const swapped = key(target, targetProperty, row[property]);
      if (property in row && swap.has(swapped)) out[property] = swap.get(swapped);
    }
    return out;
  };
  const kept = sized.inserts.flatMap((insert, i) =>
    insert.tenant === null ? [] : [[insert, sized.canaries[i]] as const],
  );
  const write: SeedGraph = {
    ...sized,
    inserts: kept.map(([insert]) => ({ ...insert, row: rewrite(insert.entity, insert.row) })),
    canaries: kept.flatMap(([, canary]) => (canary === undefined ? [] : [canary])),
    updates: sized.updates
      .filter((update) => update.tenant !== null)
      .map((update) => ({ ...update, patch: rewrite(update.entity, update.patch) })),
  };
  return {
    tenant: sized.tenants[0] as string,
    write,
    lookup: { ...write, inserts: [...theirs, ...write.inserts] },
  };
}
