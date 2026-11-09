// Single responsibility: where a cursor's next page starts among the memory driver's sorted rows.
// Split from `memory-repo.ts` for its line ceiling.

import { seekFrom } from './cursor';
import { afterSeek } from './driver-rows';
import type { EntityCore } from './entity';
import type { QueryPlan } from './tenancy';

/**
 * Where the next page starts. By sort position, not by the previous row's id: that row may have
 * been deleted between the two requests, and an id that is no longer there would restart
 * pagination at the top instead of continuing it.
 */
export const afterCursor = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  found: readonly Row[],
): number => {
  const seek = seekFrom(entity, plan);
  if (seek === undefined) return 0;
  // Binary search: `found` is sorted by the very keys `afterSeek` reads, so "after the cursor"
  // is a suffix. A linear `findIndex` made walking a table page by page quadratic.
  let low = 0;
  let high = found.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (afterSeek(entity, plan, found[middle], seek)) high = middle;
    else low = middle + 1;
  }
  return low;
};
