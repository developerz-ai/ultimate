// The `/admin` home's figures: how many rows of each resource this actor could open. One
// `AdminRepo.count` per resource that declared `count: true`, over its row scope and nothing else
// — `rowWhere`, the predicate every list read starts from — so a tile never counts a hidden row.
// `count: 'estimate'` reads the planner's figure instead, where that is still the same question.

import type { AdminActor } from './authz';
import { rowWhere } from './list-scope';
import type { AdminFilter } from './registry';
import type { AdminResource } from './resource';

/**
 * Below this many rows an exact `COUNT(*)` is cheap and the planner's figure is at its least
 * reliable (a table analysed when it was empty), so the exact count is the one shown.
 */
export const ESTIMATE_COUNT_FLOOR = 10_000;

export interface ResourceCount {
  readonly resource: AdminResource;
  readonly count: number;
  /** The planner's estimate (`count: 'estimate'`), drawn `~`. Absent or `false`: exact. */
  readonly approximate?: boolean;
}

type Counted = { readonly count: number; readonly approximate: boolean };

/**
 * The estimate is a WHOLE-TABLE figure, so it answers the tile's question only when the row scope
 * adds no predicate; `null` (never analysed), a refusal (a tenant-scoped table) or a small table
 * all fall through to the exact count — never a guess shown as a number.
 */
async function countOne(
  resource: AdminResource,
  count: (where: readonly AdminFilter[]) => Promise<number>,
  actor: AdminActor,
): Promise<Counted> {
  const where = rowWhere(resource, actor);
  const estimate = resource.repo?.approximateCount;
  if (resource.countEstimate === true && where.length === 0 && estimate !== undefined) {
    const figure = await estimate.call(resource.repo).catch(() => null);
    if (figure !== null && figure >= ESTIMATE_COUNT_FLOOR) {
      return { count: figure, approximate: true };
    }
  }
  return { count: await count(where), approximate: false };
}

/**
 * The count of every resource handed in that declared `count: true` (or `'estimate'`), in the order
 * handed in. The caller hands in only what the actor may LIST (`canOperate(…, 'list', …)`): a size
 * is a fact about a table, and a resource the actor may not open must not leak one. A repo with no `count()` — a hand-written one may leave it
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
    countable.map(({ resource, count }) => countOne(resource, count, actor)),
  );
  return countable.flatMap(({ resource }, index) => {
    const total = totals[index];
    return total?.status === 'fulfilled' ? [{ resource, ...total.value }] : [];
  });
}
