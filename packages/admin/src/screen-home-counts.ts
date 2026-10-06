// The `/admin` home's figures: how many rows of each resource this actor could open. One
// `AdminRepo.count` per resource that declared `count: true`, over its row scope and nothing else
// — `rowWhere`, the predicate every list read starts from — so a tile never counts a hidden row.

import type { AdminActor } from './authz';
import { rowWhere } from './list-scope';
import type { AdminResource } from './resource';

export interface ResourceCount {
  readonly resource: AdminResource;
  readonly count: number;
}

/**
 * The count of every resource handed in that declared `count: true`, in the order handed in. The caller hands in only what the
 * actor may LIST (`canOperate(…, 'list', …)`): a size is a fact about a table, and a resource the
 * actor may not open must not leak one. A repo with no `count()` — a hand-written one may leave it
 * out — has no figure, so it is left out rather than shown as a zero it never measured.
 *
 * In parallel: these are independent reads, and the home page is the front door. A count the
 * store refuses — a tenant-scoped table asked by an actor with no org is `X_TENANCY_UNSCOPED` —
 * costs that resource its figure and nothing else, the way search lists a resource whose repo threw
 * as skipped rather than answering 500 for the rest. The list behind the tile still reports it.
 */
export async function resourceCounts(
  resources: readonly AdminResource[],
  actor: AdminActor,
): Promise<readonly ResourceCount[]> {
  const countable = resources.flatMap((resource) => {
    // Only a resource that asked: a home visit is otherwise one full count per table, every time.
    if (!resource.count) return [];
    const count = resource.repo?.count;
    return count === undefined ? [] : [{ resource, count: count.bind(resource.repo) }];
  });
  const totals = await Promise.allSettled(
    countable.map(({ resource, count }) => count(rowWhere(resource, actor))),
  );
  return countable.flatMap(({ resource }, index) => {
    const total = totals[index];
    return total?.status === 'fulfilled' ? [{ resource, count: total.value }] : [];
  });
}
