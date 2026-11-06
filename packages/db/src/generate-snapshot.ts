// Single responsibility: the snapshot a migration records — what the entities declare, in the
// vocabulary `introspect.ts` reads, plus the one-time facts a parameter decides (replica identity,
// row security). Split from `generate.ts`, which diffs against it; re-exported there.

import { declaredChecks } from './check-ddl';
import { defaultExpression } from './column-default';
import type { EntityDescriptionLike } from './entity-shape';
import { foreignKeysOf } from './foreign-key-plan';
import { splitViews, viewDescriptionOf } from './generate-view';
import type { ColumnDescription, SchemaDescription, TableDescription } from './introspect';
import { declaredIndexes } from './invariant-ddl';
import { withSameTenantIndexes } from './same-tenant';
import { sqlType } from './sql-type';

/** No table named, which is what every caller outside `generateMigration` describes. */
const NONE: ReadonlySet<string> = new Set();

export function snapshotOf(
  entities: readonly EntityDescriptionLike[],
  replicaIdentityFull: ReadonlySet<string> = NONE,
  rowSecurity: ReadonlySet<string> = NONE,
): SchemaDescription {
  // A view is recorded as its statements (`generate-view.ts`), never as a table it is not.
  const split = splitViews(entities);
  const tables = [...withSameTenantIndexes(split.tables)]
    .sort((a, b) => (a.table < b.table ? -1 : 1))
    .map((entity): TableDescription => {
      const columns: ColumnDescription[] = [...entity.columns]
        .sort((a, b) => (a.column < b.column ? -1 : 1))
        .map((column, index) => ({
          name: column.column,
          dataType: sqlType(column.kind),
          nullable: !column.notNull,
          default: defaultExpression(column),
          position: index + 1,
          // Only when one was declared — absent stays absent, so no snapshot written before this
          // field existed gains a key and no app's sidecar regenerates over a fact already true.
          ...(column.generated === undefined ? {} : { generated: column.generated }),
        }));
      const checks = declaredChecks(entity);
      return {
        schema: 'public',
        name: entity.table,
        columns,
        primaryKey: [...entity.primaryKey],
        // Whole, never partly: a snapshot that recorded the name and dropped the predicate made
        // the next generation blind to a `where` or an `order` changing, and a partial index
        // silently kept as a total one is a constraint the entity no longer declares.
        //
        // `declaredIndexes`, so a `unique` invariant's index is recorded exactly like an entity's
        // own — a statement emitted and not recorded is `42P07` on the very next `x db gen`.
        indexes: declaredIndexes(entity).map((index) => ({
          name: index.name,
          columns: [...index.columns],
          unique: index.unique,
          primary: false,
          where: index.where,
          order: index.order,
          // Only when one was declared. Writing `using: 'btree'` out for every index would rewrite
          // every sidecar in every app on the next `x db gen` — a diff on every file for a fact
          // that was already true, which `indexMethodOf` reads out of the absence anyway.
          ...(index.using === undefined ? {} : { using: index.using }),
        })),
        foreignKeys: foreignKeysOf(entity),
        // Absent, never `[]`, on a table declaring none: a sidecar that predates this field must
        // read as "nothing recorded" so the next generation adds the constraints the database is
        // genuinely missing — the rule `using` and `generated` already state one field up.
        ...(checks.length === 0 ? {} : { checks }),
        // The same rule once more: `true` or absent, never `false`. This is what makes the ALTER
        // beside it a one-time statement rather than a line every `x db gen` writes again.
        ...(replicaIdentityFull.has(entity.table) ? { replicaIdentityFull: true as const } : {}),
        // `true` or absent once more — the record that makes the trigger a one-time statement.
        ...(entity.appendOnly === true ? { appendOnly: true as const } : {}),
        // And again: the record that makes the tenant policy a one-time statement.
        ...(rowSecurity.has(entity.table) ? { rowSecurity: true as const } : {}),
      };
    });
  // `views` absent when none is declared, so no snapshot written before views existed moves.
  return split.views.length === 0
    ? { tables }
    : { tables, views: split.views.map(viewDescriptionOf) };
}
