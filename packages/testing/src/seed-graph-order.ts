// Insert order for a seed graph: every parent before its children, over the foreign keys the
// entities themselves resolve (`$references()`, the record `relationsOf` is built from). A cycle is
// broken at a NULLABLE edge — inserted null, set by an update once its target exists; a cycle with
// no nullable edge is refused, because no insert order can satisfy it. The break prefers a table
// that takes updates: an `appendOnly` one refuses every UPDATE, so its key would stay null.

import type { ReferenceDescription } from '@ultimat3/entity';
import { seedGraphUnsatisfied } from './seed-graph-error';

export interface OrderInput {
  readonly name: string;
  readonly references: readonly ReferenceDescription[];
  /** False for a table whose rows are never updated (`appendOnly`). Default true. */
  readonly updatable?: boolean;
}

export interface InsertOrder {
  readonly order: readonly string[];
  /** `<entity>.<property>` for every key inserted null and set afterwards. */
  readonly deferred: ReadonlySet<string>;
}

export const edgeKey = (entity: string, property: string): string => `${entity}.${property}`;

/** Whether `to` reaches `from` over the live edges, i.e. whether `from -> to` closes a cycle. */
const reaches = (
  edges: ReadonlyMap<string, readonly ReferenceDescription[]>,
  live: (from: string, reference: ReferenceDescription) => boolean,
  start: string,
  goal: string,
): boolean => {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === goal) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const reference of edges.get(node) ?? []) {
      if (live(node, reference)) stack.push(reference.targetEntity);
    }
  }
  return false;
};

/** Kahn's algorithm in name order, so the same entity set always inserts in the same order. */
export function insertOrder(entities: readonly OrderInput[]): InsertOrder {
  const names = new Set(entities.map((entity) => entity.name));
  const edges = new Map(entities.map((entity) => [entity.name, entity.references]));
  const frozen = new Set(entities.filter((e) => e.updatable === false).map((e) => e.name));
  const deferred = new Set<string>();
  // A self-reference never orders anything: the row's own table is already being written.
  const live = (from: string, reference: ReferenceDescription): boolean =>
    names.has(reference.targetEntity) &&
    reference.targetEntity !== from &&
    !deferred.has(edgeKey(from, reference.property));
  const order: string[] = [];
  const placed = new Set<string>();
  const sorted = [...names].sort();
  while (order.length < sorted.length) {
    const ready = sorted.find(
      (name) =>
        !placed.has(name) &&
        (edges.get(name) ?? []).every(
          (reference) => !live(name, reference) || placed.has(reference.targetEntity),
        ),
    );
    if (ready !== undefined) {
      order.push(ready);
      placed.add(ready);
      continue;
    }
    const stuck = sorted.filter((name) => !placed.has(name));
    const breakable = stuck.flatMap((name) =>
      (edges.get(name) ?? [])
        .filter(
          (reference) =>
            reference.nullable &&
            live(name, reference) &&
            !placed.has(reference.targetEntity) &&
            reaches(edges, live, reference.targetEntity, name),
        )
        .map((reference) => [name, edgeKey(name, reference.property)] as const),
    );
    // Name order still decides between equals, so the same set always breaks at the same edge.
    const edge = (breakable.find(([name]) => !frozen.has(name)) ?? breakable[0])?.[1];
    if (edge === undefined) {
      const cyclic = stuck.filter((name) =>
        (edges.get(name) ?? []).some(
          (reference) =>
            live(name, reference) && reaches(edges, live, reference.targetEntity, name),
        ),
      );
      throw seedGraphUnsatisfied({
        entity: cyclic[0] ?? stuck[0] ?? '',
        what: `a cycle of non-nullable foreign keys joins ${cyclic.join(', ')} — no insert order satisfies it; make one key .nullable(), or seed these tables yourself`,
        columns: [],
      });
    }
    deferred.add(edge);
  }
  return { order, deferred };
}
