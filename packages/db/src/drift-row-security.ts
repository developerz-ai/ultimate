// Single responsibility: `X_DB_ROW_SECURITY_DRIFT` — a tenant table and `database.rowSecurity`
// disagreeing about its policy, read two ways. Against the migrations (no database: the gate's
// `drift` step) and against the live catalog (`checkDrift`, after `x db migrate`).

import type { DriftDifference } from './drift-findings';
import type { EntityDescriptionLike } from './entity-shape';
import { DbError } from './errors';
import { type RowSecurityOption, rowSecurityInput } from './generate-row-security';
import type { SchemaDescription, TableDescription } from './introspect';
import { ROW_SECURITY_POLICY } from './row-security';
import { rowSecurityAfter } from './row-security-plan';
import { shellInertIdentifier } from './sql';

export const ROW_SECURITY_DRIFT_CODE = 'X_DB_ROW_SECURITY_DRIFT';

/** `missing`: the flag wants a policy nothing put there. `stray`: one is there the flag does not want. */
export interface RowSecurityDifference {
  readonly table: string;
  readonly direction: 'missing' | 'stray';
}

/**
 * The flag and the tenant columns against what the newest snapshot recorded — the same input
 * `x db gen` plans from, so the gate never expects a policy the generator would not write.
 */
export function rowSecurityDifferences(
  entities: readonly EntityDescriptionLike[],
  recorded: SchemaDescription,
  option: RowSecurityOption,
): readonly RowSecurityDifference[] {
  const input = rowSecurityInput(entities, recorded, option);
  const wanted = rowSecurityAfter(input);
  return [
    ...[...wanted]
      .filter((table) => !input.recorded.has(table))
      .map((table) => ({ table, direction: 'missing' as const })),
    ...[...input.recorded]
      .filter((table) => !wanted.has(table))
      .map((table) => ({ table, direction: 'stray' as const })),
  ].sort((a, b) => (a.table < b.table ? -1 : 1));
}

/** The migrations' reading as an error. The repair is the generation the flag is waiting on. */
export const rowSecurityDrift = (difference: RowSecurityDifference): DbError =>
  new DbError({
    code: ROW_SECURITY_DRIFT_CODE,
    cause:
      difference.direction === 'missing'
        ? `database.rowSecurity is on and no migration gave tenant table "${difference.table}" its policy: a raw sql read of it still sees every tenant's rows`
        : `database.rowSecurity is off and a migration left tenant table "${difference.table}" its policy: every read without a tenant set sees no rows`,
    fix: 'x db gen "row security"',
    meta: { table: difference.table, direction: difference.direction },
  });

/** Where the statements are, as a command that prints them: the ledger already holds the migration. */
const statementsOf = (table: string): string => {
  const name = shellInertIdentifier(table);
  const pattern = name === null ? ROW_SECURITY_POLICY : `on ${name}`;
  return `grep -n '${pattern}' packages/db/migrations/*.sql`;
};

/**
 * The catalog's reading, judged only where both halves were asked (`compareAppendOnly`'s rule):
 * a snapshot that predates the field, or a description nobody introspected, says nothing.
 * `policyNames` holds only an enabled AND forced table's policies, so a disabled or unforced
 * table reads as missing — an owner or nobody would be bound by it.
 */
export function compareRowSecurity(
  live: TableDescription,
  expected: TableDescription,
): DriftDifference[] {
  if (live.policyNames === undefined) return [];
  const present = live.policyNames.includes(ROW_SECURITY_POLICY);
  const wanted = expected.rowSecurity === true;
  if (present === wanted) return [];
  const table = live.name;
  return [
    {
      kind: wanted ? 'missing-row-security' : 'unexpected-row-security',
      table,
      column: null,
      cause: wanted
        ? `table "${table}" should carry the forced tenant policy ${ROW_SECURITY_POLICY} and does not, or its row security is disabled or not forced: raw sql sees every tenant's rows`
        : `table "${table}" carries the tenant policy ${ROW_SECURITY_POLICY} no migration recorded`,
      fix: `${statementsOf(table)}   # run the row-security statements it prints against this database with psql "$DATABASE_URL", then x db migrate, which re-checks`,
    },
  ];
}
