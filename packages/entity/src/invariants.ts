// A domain invariant is written once and enforced twice: in the app on every write, and in
// Postgres as a CHECK or a unique index emitted into the migration. The database can therefore
// never disagree with the code — a bulk import, a psql session or a second service all hit the
// same rule.
//
// `invariant()` names an already-built expression: `entity()` hands the whole `invariants:`
// callback the typed column proxy once, so a rule is written against property keys (`c.likeCount`)
// and `entity()` alone resolves them to physical names. A physical name is never typed twice.

import { invariantViolated } from './errors';
import type { Expr, Resolve, Row } from './expr';

/** `assert` is a rule only the app can run — a JS predicate with no SQL translation. */
export type InvariantKind = 'check' | 'unique' | 'assert';

export interface Invariant<T> {
  /** Becomes the constraint name: `<table>_<name>_check`. Keep it snake_case. */
  readonly name: string;
  readonly kind: InvariantKind;
  /** Safe to log and useful to an agent: says what was expected, not what leaked. */
  readonly message: string;
  /** SQL predicate for `check`, the column list for `unique`, `null` for `assert`. */
  readonly sql: string | null;
  /** Physical column names the rule reads. */
  readonly columns: readonly string[];
  /** Partial-constraint predicate, e.g. `deleted_at is null`. */
  readonly where?: string;
  /**
   * A method, not a `readonly holds: (row: T) => boolean` property, and the difference is
   * load-bearing: a function-typed property is checked contravariantly, which made `Invariant<Post>`
   * unassignable to `Invariant<unknown>` and so made every real entity fail `EntitySet`. Every
   * `database({ posts, … })` call then degraded to `Table<unknown>` and cascaded — 275 errors in
   * the reference app from this one position. Method syntax is bivariant, which is what
   * `EntityCore.$assert` beside it already relies on. Pinned by `database.variance.test.ts`.
   */
  holds(row: T): boolean;
}

/** What `invariant()` returns: a named rule that does not yet know its physical column names. */
export interface InvariantDef {
  readonly name: string;
  readonly expr: Expr;
}

/** `invariants: (c) => [invariant('post_like_count_non_negative', c.likeCount.atLeast(0))]` */
export const invariant = (name: string, expr: Expr): InvariantDef => ({ name, expr });

const asRow = (value: unknown): Row =>
  typeof value === 'object' && value !== null ? (value as Row) : {};

/** Called by `entity()`: resolves property paths to physical names and freezes the rule. */
export const bindInvariant = <T>(
  def: InvariantDef,
  resolve: Resolve,
  partialWhere: string | undefined,
): Invariant<T> => {
  const expr = def.expr;
  const sql = expr.toSql(resolve);
  const kind: InvariantKind = expr.kind === 'unique' ? 'unique' : sql === null ? 'assert' : 'check';
  return {
    name: def.name,
    kind,
    message: expr.message,
    sql,
    columns: expr.paths.map(resolve),
    // A soft-deleted row must not keep a slug reserved, so uniqueness is partial there.
    ...(kind === 'unique' && partialWhere !== undefined ? { where: partialWhere } : {}),
    holds: (row) => expr.holds(asRow(row)),
  };
};

export const constraintName = (
  table: string,
  inv: { readonly name: string; readonly kind: InvariantKind },
): string => `${table}_${inv.name}_${inv.kind === 'unique' ? 'key' : 'check'}`;

/** The DDL the migration emits. One statement, terminated, ready to diff. */
export const toSql = <T>(table: string, inv: Invariant<T>): string | null => {
  if (inv.sql === null) return null;
  const name = constraintName(table, inv);
  if (inv.kind === 'check') {
    return `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${inv.sql});`;
  }
  const where = inv.where === undefined ? '' : ` WHERE ${inv.where}`;
  const columns = inv.columns.map((column) => `"${column}"`).join(', ');
  return `CREATE UNIQUE INDEX "${name}" ON "${table}" (${columns})${where};`;
};

export const invariantsToSql = <T>(table: string, invariants: readonly Invariant<T>[]): string =>
  invariants
    .map((inv) => toSql(table, inv))
    .filter((statement): statement is string => statement !== null)
    .join('\n');

/** Runs on every write. Reports every violation at once so one round trip fixes all. */
export const assertInvariants = <T>(
  entityName: string,
  invariants: readonly Invariant<T>[],
  row: T,
): void => {
  const failed = invariants.filter((inv) => !inv.holds(row));
  const first = failed[0];
  if (first === undefined) return;
  throw invariantViolated(entityName, first.name, failed.map((inv) => inv.message).join('; '));
};
