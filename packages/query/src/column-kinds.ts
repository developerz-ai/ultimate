// Single responsibility: the DECLARED kind of each column of the relation a read names. Postgres
// compares two values by their column's type, so every comparison this package makes asks here
// first and hands the answer to `@ultimat3/entity`'s comparator — never `typeof` the value.

import type { ColumnKind } from '@ultimat3/entity';
import { entityForTable } from '@ultimat3/entity';

/** A column's declared kind, or `undefined` when nothing declares one. */
export type KindOf = (column: string) => ColumnKind | undefined;

const UNDECLARED: KindOf = () => undefined;

/**
 * The kinds of `QueryShape.entity`'s columns. Resolved once per read, sort or change event — the
 * registry is a scan — and never per comparison.
 *
 * A relation no entity declares (`from('report', rows)` over a projection) has no kinds: its
 * values compare as `@ultimat3/entity` compares an undeclared column, by what they are. `money` is
 * two physical columns behind one property, so the property alone names no single value to order.
 */
export function kindsOf(relation: string): KindOf {
  const columns = entityForTable(relation)?.$columns;
  if (columns === undefined) return UNDECLARED;
  return (column) => {
    const kind = Object.hasOwn(columns, column) ? columns[column]?.$meta.kind : undefined;
    return kind === 'money' ? undefined : kind;
  };
}
