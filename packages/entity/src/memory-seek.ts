// Single responsibility: where a cursor's next page starts among the memory driver's sorted rows.
// Split from `memory-repo.ts` for its line ceiling.

import { kindOf, seekFrom, valueAt } from './cursor';
import type { EntityCore } from './entity';
import { compareByKind } from './memory-match';
import type { QueryPlan } from './tenancy';

/** Lexicographic over the sort keys, direction applied. `> 0` means "after the cursor". */
const compareToSeek = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  row: unknown,
  seek: readonly unknown[],
): number => {
  for (const [index, entry] of plan.orderBy.entries()) {
    // The COLUMN's kind, not the value's: the seek was revived from the same kind (`cursor.ts`),
    // so a `bigint` column compares its stored decimal string against a revived `BigInt` as one
    // number instead of as two pieces of text.
    const order = compareByKind(
      kindOf(entity, entry.column),
      valueAt(row, entry.column),
      seek[index],
    );
    if (order !== 0) return entry.direction === 'desc' ? -order : order;
  }
  return 0;
};

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
  const start = found.findIndex((row) => compareToSeek(entity, plan, row, seek) > 0);
  return start === -1 ? found.length : start;
};
