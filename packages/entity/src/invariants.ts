// A domain invariant is written once and enforced twice: in the app on every write,
// and in Postgres as a CHECK or UNIQUE constraint emitted into the migration. The
// database can therefore never disagree with the code — a bulk import, a psql
// session or a second service all hit the same rule.
import { invariantViolated } from './errors';

export type InvariantKind = 'check' | 'unique';

export interface Invariant<T> {
  /** Becomes the constraint name: `<table>_<name>_check`. Keep it snake_case. */
  readonly name: string;
  readonly kind: InvariantKind;
  /** Safe to log and useful to an agent: says what was expected, not what leaked. */
  readonly message: string;
  /** SQL predicate for `check`, or the column list for `unique`. */
  readonly sql: string;
  readonly columns: readonly string[];
  /** Partial-constraint predicate, e.g. `deleted_at is null`. */
  readonly where?: string;
  readonly holds: (row: T) => boolean;
}

export interface CheckInit<T> {
  readonly message: string;
  /** Postgres predicate over physical column names. */
  readonly sql: string;
  readonly holds: (row: T) => boolean;
  readonly columns?: readonly string[];
  readonly where?: string;
}

/** `invariant('price_positive', { sql: 'price_minor > 0', holds: (p) => p.priceMinor > 0n })` */
export const invariant = <T>(name: string, init: CheckInit<T>): Invariant<T> => ({
  name,
  kind: 'check',
  message: init.message,
  sql: init.sql,
  columns: init.columns ?? [],
  ...(init.where === undefined ? {} : { where: init.where }),
  holds: init.holds,
});

export interface UniqueInit<T> {
  readonly message: string;
  readonly columns: readonly string[];
  /** In-app duplicate detection needs the store, so the app check defaults to true. */
  readonly holds?: (row: T) => boolean;
  readonly where?: string;
}

/**
 * Uniqueness cannot be decided from a single row, so the app-side check is a no-op
 * by default and the database is the authority. The unique index is still declared
 * here so it lives next to the rule it implements.
 */
export const unique = <T>(name: string, init: UniqueInit<T>): Invariant<T> => ({
  name,
  kind: 'unique',
  message: init.message,
  sql: init.columns.join(', '),
  columns: init.columns,
  ...(init.where === undefined ? {} : { where: init.where }),
  holds: init.holds ?? (() => true),
});

export const constraintName = (
  table: string,
  inv: { readonly name: string; readonly kind: InvariantKind },
): string => `${table}_${inv.name}_${inv.kind === 'check' ? 'check' : 'key'}`;

/** The DDL the migration emits. One statement, terminated, ready to diff. */
export const toSql = <T>(table: string, inv: Invariant<T>): string => {
  const name = constraintName(table, inv);
  if (inv.kind === 'check') {
    return `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${inv.sql});`;
  }
  const where = inv.where === undefined ? '' : ` WHERE ${inv.where}`;
  const columns = inv.columns.map((column) => `"${column}"`).join(', ');
  return `CREATE UNIQUE INDEX "${name}" ON "${table}" (${columns})${where};`;
};

export const invariantsToSql = <T>(table: string, invariants: readonly Invariant<T>[]): string =>
  invariants.map((inv) => toSql(table, inv)).join('\n');

/** Runs on every write. Reports every violation at once so one round trip fixes all. */
export const assertInvariants = <T>(
  entityName: string,
  invariants: readonly Invariant<T>[],
  row: T,
): void => {
  const failed = invariants.filter((inv) => !inv.holds(row));
  if (failed.length === 0) return;
  const first = failed[0];
  if (first === undefined) return;
  throw invariantViolated(entityName, first.name, failed.map((inv) => inv.message).join('; '));
};
