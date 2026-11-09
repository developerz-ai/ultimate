// Single responsibility: a row's identity as one string — the key the memory driver stores a row
// under and the id both drivers hand `cursorFor`. One definition, so the two cannot drift.

import { keyOf } from './batch-read';
import { kindOf, valueAt } from './cursor';
import type { EntityCore } from './entity';

/**
 * Each primary-key value spelled as `keyOf` spells it (a `uuid` lower-cased, a number by value),
 * so `findById(UPPER)` finds the row Postgres finds. A single key is that spelling alone; a
 * composite one is a JSON array of them — joined with `''`, `('a', 'bc')` and `('ab', 'c')` were
 * one key, and the memory driver stored the second row over the first.
 */
export const rowKey = <Row>(entity: EntityCore<Row>, row: unknown): string => {
  const keys = entity.$primaryKey.map((property) =>
    keyOf(kindOf(entity, property) ?? '', valueAt(row, property)),
  );
  return keys.length === 1 ? (keys[0] ?? '') : JSON.stringify(keys);
};
