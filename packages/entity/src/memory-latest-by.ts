// Single responsibility: the in-memory driver's `latestBy` — the plan `latest-by.ts` builds, read
// through the driver's own `select` (scope, tenancy, soft delete, the plan's order) and folded to
// the first rows of each group by the same function the paged fallback uses. Never a second meaning.

import { projectRow } from './driver-rows';
import type { EntityCore } from './entity';
import {
  assertGroupBound,
  firstPerGroup,
  groupOf,
  groupsIn,
  type LatestBySpec,
  latestArgs,
  latestPlanOf,
} from './latest-by';
import type { MemorySelect } from './memory-aggregates';
import type { LatestByRead } from './pg-latest-by';

export const memoryLatestBy = <Row>(
  entity: EntityCore<Row>,
  select: MemorySelect<Row>,
): LatestByRead<Row> => ({
  async latestBy(spec: LatestBySpec, args = {}) {
    const op = 'latestBy';
    // Judged by the function the Postgres driver calls, before a row is read: a refusal there is
    // the same refusal here.
    const plan = latestPlanOf(entity, spec, args, op);
    const { found } = select(latestArgs(entity, spec, args), op);
    const group = groupOf(entity, spec);
    const kept = firstPerGroup(found, group, spec.perGroup);
    assertGroupBound(entity, spec, groupsIn(kept, group));
    return kept.map((row) => projectRow(entity, plan, row));
  },
});
