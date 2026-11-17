// Single responsibility: a column BECOMING NOT NULL as `x db gen` writes it — the online contract in
// the non-transactional step, and the snapshot each file records about that column.
//
// It replaced a `-- backfill "c", then: … set not null;` comment whose file still recorded NOT NULL:
// every database that ran it, a fresh one included, failed `x db migrate` with `X_DB_DRIFT`, and the
// next `x db gen` found nothing to write, because the snapshot already claimed the contract.

import type { ConcurrentPlan } from './concurrent-plan';
import { validateConstraint } from './foreign-key';
import type { SchemaDescription } from './introspect';
import { identifier, MAX_IDENTIFIER_BYTES } from './sql';

/** One column the follow-up step makes NOT NULL: until that step runs, it is nullable. */
export interface ContractedColumn {
  readonly table: string;
  readonly column: string;
}

/** What `generateMigration` threads through its arms: the step, and what the step contracts. */
export interface NotNullContracts {
  readonly concurrent: ConcurrentPlan;
  readonly columns: ContractedColumn[];
}

/**
 * The transient CHECK's name. `_not_null_check`, never `_not_null`: Postgres 18 names a NOT NULL
 * constraint `<table>_<column>_not_null` itself. Past 63 bytes the server would truncate it in
 * silence, so a long pair takes a stable hashed name instead — the constraint lives for one step.
 */
export function notNullCheckName(table: string, column: string): string {
  const spelled = `${table}_${column}_not_null_check`;
  if (new TextEncoder().encode(spelled).length <= MAX_IDENTIFIER_BYTES) return spelled;
  return `not_null_check_${Bun.hash(`${table}.${column}`).toString(16)}`;
}

/**
 * `set not null` without a full-scan lock, in the deferred step's phases (`stepStatements`): the
 * CHECK added `not valid` (`keys`), its scan (`validate`), then `set not null` — which Postgres 12+
 * proves from the validated CHECK — and the CHECK dropped (`contract`). The form
 * `X_MIGRATION_LOCK_HEAVY` asks for. Every statement is safe to re-run, so a step stopped by a NULL
 * row is finished by the next `x db migrate` once the rows are backfilled.
 */
export function contractNotNull(table: string, column: string, contracts: NotNullContracts): void {
  const { concurrent } = contracts;
  const name = notNullCheckName(table, column);
  const relation = identifier(table).text;
  const attribute = identifier(column).text;
  const check = identifier(name).text;
  const dropCheck = `alter table ${relation} drop constraint if exists ${check};`;
  concurrent.keys.push(
    dropCheck,
    `alter table ${relation} add constraint ${check} check (${attribute} is not null) not valid;`,
  );
  concurrent.keysDown.push(dropCheck);
  concurrent.validate.push(
    `-- a row holding NULL in ${attribute} fails this validate: backfill those rows, then x db migrate re-runs this step`,
    validateConstraint(table, name),
  );
  concurrent.contract.push(
    `alter table ${relation} alter column ${attribute} set not null;`,
    dropCheck,
  );
  concurrent.contractDown.push(`alter table ${relation} alter column ${attribute} drop not null;`);
  contracts.columns.push({ table, column });
}

/** The schema with every contracted column nullable — what a file ahead of the contract leaves. */
export function beforeContract(
  snapshot: SchemaDescription,
  columns: readonly ContractedColumn[],
): SchemaDescription {
  if (columns.length === 0) return snapshot;
  return {
    ...snapshot,
    tables: snapshot.tables.map((table) => {
      const owed = new Set(
        columns.filter((each) => each.table === table.name).map((c) => c.column),
      );
      if (owed.size === 0) return table;
      return {
        ...table,
        columns: table.columns.map((each) =>
          owed.has(each.name) ? { ...each, nullable: true } : each,
        ),
      };
    }),
  };
}
