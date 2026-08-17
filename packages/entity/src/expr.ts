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
import type { ColumnMap } from './types';

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

/**
 * A mapped type over the declared columns, never an index signature: under
 * `noUncheckedIndexedAccess` an index signature makes `c.title` `ColumnExpr | undefined`, so every
 * invariant needed a `!`. Mapped, `c.title` is a `ColumnExpr` and `c.titel` is a compile error
 * that suggests the real name. `entity()` supplies `C` because `invariants` is a callback — a
 * per-element `invariant(name, build)` call is checked before `C` is fixed, so `K` fell back to
 * `string` and nothing reached it.
 */
export type InvariantColumns<C extends ColumnMap = ColumnMap> = {
  readonly [K in keyof C]: ColumnExpr;
} & {
  /** Decided by the database — a single row cannot see a duplicate. */
  unique(columns: readonly (keyof C & string)[]): Expr;
  /** Lifts a domain predicate over several columns. App-only by construction. */
  satisfies(predicate: RowPredicate, columns: readonly (keyof C & string)[]): Expr;
};

const terms = new WeakMap<ColumnExpr, Term>();

const walk = (row: Row, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (value, key) => (typeof value === 'object' && value !== null ? (value as Row)[key] : undefined),
    row,
  );

const literal = (value: unknown): string =>
  typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value);

/**
 * The Postgres operator a `RegExp`'s flags mean — the second half of "one declaration, two
 * enforcement points". `toSql` used to emit `~ <pattern.source>` and nothing else, so
 * `c.slug.matches(/^[A-Z]+$/i)` approved `'abc'` in the app (`pattern.test`, flags intact) while
 * the CHECK it generated was case-SENSITIVE and refused the same row — the app's own invariant
 * bypassed, and the write coming back as a raw constraint error rather than
 * `X_INVARIANT_VIOLATED`.
 *
 * `i` is the one flag with an operator (`~*`). Every other flag is REFUSED rather than dropped:
 * `m` and `s` change what the pattern matches, `g` makes `pattern.test` stateful across calls so
 * even `holds` stops being a function of the row, and `u`/`v`/`y`/`d` have no POSIX equivalent at
 * all. A CHECK quietly missing a flag is the same disagreement one character along.
 */
const matchOperator = (pattern: RegExp): string => {
  const flags = pattern.flags.replaceAll('i', '');
  if (flags !== '') {
    throw invariantViolated(
      'invariant',
      'matches',
      `/${pattern.source}/${pattern.flags} carries the flag${flags.length === 1 ? '' : 's'} ` +
        `"${flags}", which Postgres has no operator for — drop it and fold the behaviour into ` +
        `the pattern, or pass a function instead: matches((value) => /${pattern.source}/${pattern.flags}.test(value)), which is app-only and reports sql: null`,
    );
  }
  return pattern.ignoreCase ? '~*' : '~';
};

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
        // `[...value].length`, never `value.length`: JS counts UTF-16 code units and
        // `char_length()` counts CHARACTERS, so `'👍'` was 2 here and 1 in Postgres — the app
        // approved a row the CHECK then refused, which reaches the caller as a raw constraint
        // error instead of `X_INVARIANT_VIOLATED`. Code points, not graphemes: that is what
        // Postgres counts, and agreeing with the database is the whole point of this file.
        (value) => typeof value === 'string' && [...value].length >= length,
      ),

    contains: (value) =>
      one(
        `${term.label} must contain ${literal(value)}`,
        (resolve) => `position(${literal(value)} in ${term.sql(resolve)}) > 0`,
        (actual) => typeof actual === 'string' && actual.includes(value),
      ),

    matches: (pattern) => {
      // Read at DECLARATION, not inside `toSql`: an unsupported flag is the author's mistake and
      // the entity file is where it is repaired, so the refusal lands on the line that wrote it
      // rather than during migration generation, where the entity name is all anyone would see.
      const emitted =
        pattern instanceof RegExp
          ? `${matchOperator(pattern)} ${literal(pattern.source)}`
          : undefined;
      return one(
        `${term.label} must match ${pattern instanceof RegExp ? pattern.source : pattern.name || 'the rule'}`,
        (resolve) => (emitted === undefined ? null : `${term.sql(resolve)} ${emitted}`),
        (value) =>
          typeof value === 'string' &&
          (pattern instanceof RegExp ? pattern.test(value) : pattern(value)),
      );
    },

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
 * The `c` an invariant is written against. Still a Proxy even though `InvariantColumns<C>` now
 * catches a typo at compile time: a JS caller, a dynamically built rule and a `satisfies()` column
 * list all reach it untyped, and the thrown message names the columns that do exist rather than
 * failing later as `undefined is not a function`.
 */
export const invariantColumns = <C extends ColumnMap>(
  entity: string,
  properties: readonly string[],
): InvariantColumns<C> => {
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
  }) as unknown as InvariantColumns<C>;
};
