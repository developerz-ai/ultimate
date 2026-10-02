/**
 * A live read may not FILTER or ORDER on a sealed column, refused at subscribe. The matcher places
 * a change from the row the change feed carries, and that row names no sealed column — the log
 * holds the stored string, which `@ultimat3/realtime` drops rather than forwards. So a window keyed
 * on one could be read once and never patched: every later change would miss the filter or land
 * at no position, silently.
 */

import { entityForTable, sealedFields } from '@ultimat3/entity';
import { MatcherUnsupportedError } from './errors';
import type { QueryShape } from './shape';

export function assertNoSealedKey(name: string, shape: QueryShape): void {
  // A relation no entity declares has no sealed column to name: `from('report', rows)` over a
  // projection is common, and it is not this rule's to refuse.
  const entity = entityForTable(shape.entity);
  if (entity === undefined) return;
  const sealed = new Set(sealedFields(entity).map((field) => field.property));
  if (sealed.size === 0) return;
  const keyed = [...shape.filters, ...shape.orderBy].find((key) => sealed.has(key.column));
  if (keyed === undefined) return;
  // The column's NAME, never the filter's value: that value is the secret being matched on.
  throw new MatcherUnsupportedError(
    name,
    `the sealed column "${keyed.column}" in a filter or an order — a change row carries no sealed column`,
  );
}
