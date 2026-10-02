// Single responsibility: the non-partial unique constraints an entity declares, beside its primary
// key — ONE list, read by the upsert's conflict-target check (`bulk-write.ts`) and by the in-memory
// driver's own enforcement (`memory-unique.ts`), so a unique the one accepts as a target is a
// unique the other refuses a duplicate under.

import { constraintNameFor } from '@ultimat3/db';
import type { EntityCore } from './entity';

export interface UniqueConstraint {
  /** Physical column names, in declaration order. */
  readonly columns: readonly string[];
  /** The constraint's name in the database — asked for only once a collision is being reported. */
  name(): string;
}

/**
 * Two sources, because this framework has two ways to declare a unique index beside the key and a
 * rule honoured for one of them only sends its author to declare the constraint a second time:
 * `unique()` / `indexes: [{ unique: true }]` (both land in `$indexes`), and
 * `invariant(name, c.unique([…]))`, which emits its `create unique index` out of `$invariants`.
 *
 * A PARTIAL unique is excluded from both: its predicate is SQL the memory driver cannot evaluate
 * and an `on conflict` clause here does not spell. `bindInvariant` stamps that `where` on a
 * soft-deleting entity, so the one rule covers both lists.
 */
export const uniqueConstraints = <Row>(entity: EntityCore<Row>): readonly UniqueConstraint[] => [
  ...entity.$indexes
    .filter((index) => index.unique && index.where === undefined)
    .map((index) => ({ columns: index.columns, name: () => index.name })),
  ...entity.$invariants
    .filter((rule) => rule.kind === 'unique' && rule.where === undefined)
    .map((rule) => ({
      columns: rule.columns,
      // `@ultimat3/db` names it, as it does in the DDL: `<table>_<name>_key`.
      name: () =>
        constraintNameFor(entity.$table, {
          name: rule.name,
          kind: 'unique',
          message: rule.message,
          sql: rule.sql,
          where: null,
        }),
    })),
];
