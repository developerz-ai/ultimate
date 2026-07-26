// The invariant expression language. One declaration compiles to two enforcement points: a
// predicate the app runs on every write, and the SQL predicate the migration emits.
//
// Expressions are written against property keys (`c.likeCount`) and resolved to physical names
// (`like_count`) by `entity()`, because the author never writes a physical name.
//
// A JS predicate (`matches(isValidSlug)`, `satisfies(fn, [...])`) cannot be translated to SQL.
// It still runs in the app, and reports `sql: null` so `x verify` can warn that the database
// does not know this rule — silently pretending it reached Postgres would be worse.

import { invariantViolated } from './errors';

export type Row = Readonly<Record<string, unknown>>;

/** Property path -> physical column name. */
export type Resolve = (path: readonly string[]) => string;

export interface Expr {
  readonly kind: 'check' | 'unique';
  readonly paths: readonly (readonly string[])[];
  readonly message: string;
  /** `null` when the rule is a JS predicate the database cannot be told about. */
  toSql(resolve: Resolve): string | null;
  holds(row: Row): boolean;
}

interface Term {
  readonly path: readonly string[];
  readonly label: string;
  sql(resolve: Resolve): string;
  read(row: Row): unknown;
}

export interface ColumnExpr {
  /** `btrim(...)` in SQL, `.trim()` in the app — the same rule, both sides. */
  trimmed(): ColumnExpr;
  minLength(length: number): Expr;
  contains(value: string): Expr;
  /** A `RegExp` reaches the database; a function is app-only. */
  matches(pattern: RegExp | ((value: string) => boolean)): Expr;
  atLeast(value: number | bigint): Expr;
  eq(value: string | number | boolean | bigint | ColumnExpr): Expr;
  isTrue(): Expr;
  /** Money is two physical columns; these are how a rule names one of them. */
  readonly minor: ColumnExpr;
  readonly currency: ColumnExpr;
}

type RowPredicate = (...values: never[]) => boolean;

export type InvariantColumns = {
  readonly [column: string]: ColumnExpr;
} & {
  /** Decided by the database — a single row cannot see a duplicate. */
  unique(columns: readonly string[]): Expr;
  /** Lifts a domain predicate over several columns. App-only by construction. */
  satisfies(predicate: RowPredicate, columns: readonly string[]): Expr;
};

const terms = new WeakMap<ColumnExpr, Term>();

const walk = (row: Row, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (value, key) => (typeof value === 'object' && value !== null ? (value as Row)[key] : undefined),
    row,
  );

const literal = (value: unknown): string =>
  typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value);

const check = (
  paths: readonly (readonly string[])[],
  message: string,
  sql: (resolve: Resolve) => string | null,
  holds: (row: Row) => boolean,
): Expr => ({ kind: 'check', paths, message, toSql: sql, holds });

const isColumnExpr = (value: unknown): value is ColumnExpr =>
  typeof value === 'object' && value !== null && terms.has(value as ColumnExpr);

const expr = (term: Term): ColumnExpr => {
  const one = (
    message: string,
    sql: (resolve: Resolve) => string | null,
    holds: (value: unknown) => boolean,
  ): Expr => check([term.path], message, sql, (row) => holds(term.read(row)));

  const built: ColumnExpr = {
    trimmed: () =>
      expr({
        path: term.path,
        label: `trimmed ${term.label}`,
        sql: (resolve) => `btrim(${term.sql(resolve)})`,
        read: (row) => {
          const value = term.read(row);
          return typeof value === 'string' ? value.trim() : value;
        },
      }),

    minLength: (length) =>
      one(
        `${term.label} must be at least ${length} character${length === 1 ? '' : 's'}`,
        (resolve) => `char_length(${term.sql(resolve)}) >= ${length}`,
        (value) => typeof value === 'string' && value.length >= length,
      ),

    contains: (value) =>
      one(
        `${term.label} must contain ${literal(value)}`,
        (resolve) => `position(${literal(value)} in ${term.sql(resolve)}) > 0`,
        (actual) => typeof actual === 'string' && actual.includes(value),
      ),

    matches: (pattern) =>
      one(
        `${term.label} must match ${pattern instanceof RegExp ? pattern.source : pattern.name || 'the rule'}`,
        (resolve) =>
          pattern instanceof RegExp ? `${term.sql(resolve)} ~ ${literal(pattern.source)}` : null,
        (value) =>
          typeof value === 'string' &&
          (pattern instanceof RegExp ? pattern.test(value) : pattern(value)),
      ),

    atLeast: (bound) =>
      one(
        `${term.label} must be at least ${bound}`,
        (resolve) => `${term.sql(resolve)} >= ${bound}`,
        (value) => (typeof value === 'number' || typeof value === 'bigint') && value >= bound,
      ),

    eq: (other) =>
      isColumnExpr(other)
        ? sameAs(term, other)
        : one(
            `${term.label} must equal ${literal(other)}`,
            (resolve) => `${term.sql(resolve)} = ${literal(other)}`,
            (value) => value === other,
          ),

    isTrue: () =>
      one(
        `${term.label} must be true`,
        (resolve) => term.sql(resolve),
        (value) => value === true,
      ),

    get minor() {
      return part(term, 'minor');
    },
    get currency() {
      return part(term, 'currency');
    },
  };

  terms.set(built, term);
  return built;
};

const part = (term: Term, key: string): ColumnExpr =>
  expr({
    path: [...term.path, key],
    label: `${term.label}.${key}`,
    sql: (resolve) => resolve([...term.path, key]),
    read: (row) => walk(row, [...term.path, key]),
  });

const sameAs = (left: Term, other: ColumnExpr): Expr => {
  const right = terms.get(other);
  if (right === undefined) throw invariantViolated('invariant', 'eq', 'not a column expression');
  return check(
    [left.path, right.path],
    `${left.label} must equal ${right.label}`,
    (resolve) => `${left.sql(resolve)} = ${right.sql(resolve)}`,
    (row) => left.read(row) === right.read(row),
  );
};

const columnTerm = (property: string): Term => ({
  path: [property],
  label: property,
  sql: (resolve) => resolve([property]),
  read: (row) => row[property],
});

const unique = (columns: readonly string[]): Expr => ({
  kind: 'unique',
  paths: columns.map((column) => [column]),
  message: `${columns.join(', ')} must be unique`,
  toSql: (resolve) => columns.map((column) => resolve([column])).join(', '),
  // A single row cannot see a duplicate: the unique index is the authority.
  holds: () => true,
});

const satisfies = (predicate: RowPredicate, columns: readonly string[]): Expr =>
  check(
    columns.map((column) => [column]),
    `${columns.join(', ')} must satisfy ${predicate.name || 'the rule'}`,
    () => null,
    (row) =>
      Reflect.apply(
        predicate,
        undefined,
        columns.map((column) => row[column]),
      ) === true,
  );

/**
 * The `c` an invariant is written against. A Proxy so a typo in a column name is a
 * declaration-time error naming the columns that do exist, not `undefined is not a function`.
 */
export const invariantColumns = (
  entity: string,
  properties: readonly string[],
): InvariantColumns => {
  const known = new Set(properties);
  const helpers = { unique, satisfies };
  return new Proxy(helpers, {
    get(target, property) {
      if (property === 'unique' || property === 'satisfies') return target[property];
      if (typeof property !== 'string') return undefined;
      if (!known.has(property)) {
        throw invariantViolated(
          entity,
          'invariant',
          `no column "${property}"; declared columns are ${properties.join(', ')}`,
        );
      }
      return expr(columnTerm(property));
    },
  }) as InvariantColumns;
};
