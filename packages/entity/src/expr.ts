// The invariant expression language. One declaration compiles to two enforcement points: a
// predicate the app runs on every write, and the SQL predicate the migration emits.
//
// Expressions are written against property keys (`c.likeCount`) and resolved to physical names
// (`like_count`) by `entity()`, because the author never writes a physical name.
//
// A JS predicate (`matches(isValidSlug)`, `satisfies(fn, [...])`) cannot be translated to SQL.
// It still runs in the app, and reports `sql: null` so `x verify` can warn that the database
// does not know this rule — silently pretending it reached Postgres would be worse.
//
// A `RegExp` is the other case and it DOES reach SQL, because nothing about it is translated: the
// source `pattern.test` runs is the source spliced into the CHECK. `pattern-portability.ts` is what
// makes that legal, and `@ultimat3/db`'s `literal()` is what keeps the splice inside its own quotes.

import { literal as sqlLiteral } from '@ultimat3/db';
import { invariantViolated } from './errors';
import { isNullish } from './is-null';
import { DECIMAL_TEXT, numericOrder } from './numeric-compare';
import { unportableConstruct } from './pattern-portability';
import { refuseInvariant } from './refuse';
import type { ColumnMap } from './types';

/**
 * A declared operand as SQL TEXT. The escape itself is `@ultimat3/db`'s `literal()` — tier 1 owns
 * that rule and this is an ordinary downward import — and nothing here re-spells it; the wrapper
 * exists for two narrower reasons.
 *
 * It takes the four types a CHECK operand can be, rather than `unknown`: every call below already
 * knows which one it holds, and a widened parameter would put `String(someObject)` into statement
 * text as `[object Object]`. And it unwraps `.text`, because `Invariant.sql` is a bare string that
 * `@ultimat3/db` re-renders at DDL time — a `SqlFragment` cannot survive that round trip.
 */
const literal = (value: string | number | boolean | bigint): string =>
  typeof value === 'string' ? sqlLiteral(value).text : String(value);

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
  /** The column's row value is decimal TEXT (`bigint()`, `decimal()`), by its declared kind. */
  readonly decimal: boolean;
  sql(resolve: Resolve): string;
  read(row: Row): unknown;
}

export interface ColumnExpr {
  /** `btrim(col)` in SQL and its rule in the app: leading and trailing SPACES (U+0020) only. */
  trimmed(): ColumnExpr;
  minLength(length: number): Expr;
  contains(value: string): Expr;
  /**
   * A `RegExp` reaches the database as `~`/`~*` over its own source; a function is app-only. A
   * construct the two engines read differently is refused at declaration, never emitted as a
   * lookalike — `pattern-portability.ts` names the subset and why each exclusion is in it.
   */
  matches(pattern: RegExp | ((value: string) => boolean)): Expr;
  atLeast(value: number | bigint): Expr;
  eq(value: string | number | boolean | bigint | ColumnExpr): Expr;
  isTrue(): Expr;
  /**
   * `col is null` / `col is not null`, and the only pair in this vocabulary that is TOTAL over
   * NULL in both halves: Postgres' `IS NULL` answers true or false for every input including NULL,
   * and the app side reads absent and `null` as one value (`is-null.ts`). Every other operator
   * here answers NULL in SQL for a NULL operand, and a CHECK PASSES on NULL — which is why these
   * two are what an `iff` can be built out of.
   */
  isNull(): Expr;
  isNotNull(): Expr;
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
    // The pasted predicate drops `g` and `y`: `.test()` under either advances `lastIndex`, so the
    // rule would stop being a function of the row — the same reason the CHECK cannot carry them.
    refuseInvariant(
      'matches',
      `/${pattern.source}/${pattern.flags} carries the flag${flags.length === 1 ? '' : 's'} ` +
        `"${flags}", which Postgres has no operator for`,
      `drop the flag and fold the behaviour into the pattern, or pass a predicate instead: matches((value) => /${pattern.source}/${pattern.flags.replaceAll(/[gy]/g, '')}.test(value)) — app-only, and it reports sql: null. Never g or y in that predicate: .test() advances lastIndex, so one row's verdict depends on the row before it`,
    );
  }
  return pattern.ignoreCase ? '~*' : '~';
};

/**
 * The SQL a `RegExp` becomes — or the refusal naming the construct that would have made the two
 * halves mean different things.
 *
 * Nothing is TRANSLATED here and nothing ever should be: the string handed to `pattern.test` and
 * the string spliced into the CHECK are the SAME string, and `unportableConstruct` is what makes
 * that legal. Emitting a "close enough" POSIX rewrite of a JavaScript-only construct would ship two
 * rules under one name, which is strictly worse than the `assert` a predicate already gives you.
 *
 * Flags are judged first: a flag is a property of the whole pattern and a construct is one position
 * inside it, so the refusal an author can act on without reading an index goes out first.
 *
 * The source is spliced through `literal`, never quoted here, and a PATTERN is the sharpest case
 * for why that rule is `@ultimat3/db`'s and not a doubled quote: measured on 18.4, `'dd' ~ '^\d+$'`
 * is FALSE with `standard_conforming_strings` on and **TRUE** with it off, because the server
 * compiles `^d+$` — a CHECK enforcing a pattern the author never wrote, with no error anywhere.
 * A backslash is in almost every real pattern, so almost every real pattern depends on the `E'…'`
 * half. `pg-invariant-pattern.live.test.ts` runs that exact pair under both settings.
 */
const patternSql = (pattern: RegExp): string => {
  const operator = matchOperator(pattern);
  const unportable = unportableConstruct(pattern.source);
  const spelled = `/${pattern.source}/${pattern.flags}`;
  if (unportable !== undefined) {
    return refuseInvariant(
      'matches',
      `${spelled} uses ${unportable.construct} at index ${unportable.at}, which ${unportable.why} — the CHECK and pattern.test() would answer differently for the same row`,
      unportable.instead === undefined
        ? `matches((value) => ${spelled}.test(value))   # app-only: the rule stays in TS and reports sql: null, so no CHECK claims to enforce it`
        : `write ${unportable.instead} where ${spelled} has ${unportable.construct} — one meaning in both engines — then x db gen`,
    );
  }
  return `${operator} ${literal(pattern.source)}`;
};

const check = (
  paths: readonly (readonly string[])[],
  message: string,
  sql: (resolve: Resolve) => string | null,
  holds: (row: Row) => boolean,
): Expr => ({ kind: 'check', paths, message, toSql: sql, holds });

/**
 * A numeric operand a CHECK can spell. `NaN` and the infinities render as `col >= NaN` — a column
 * reference Postgres does not have — so they are refused on the line that wrote them.
 */
const finite = <T>(rule: 'atLeast' | 'eq', operand: T): T => {
  if (typeof operand === 'number' && !Number.isFinite(operand)) {
    refuseInvariant(
      rule,
      `${String(operand)} is not a number a CHECK can compare a column against`,
      `pass a finite number — c.total.${rule}(0) — or a bigint for a bound past 2^53: c.total.${rule}(9007199254740993n)`,
    );
  }
  return operand;
};

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
        decimal: term.decimal,
        label: `trimmed ${term.label}`,
        sql: (resolve) => `btrim(${term.sql(resolve)})`,
        read: (row) => {
          const value = term.read(row);
          // U+0020 only — what one-argument `btrim` strips. `.trim()` also removed tabs, newlines
          // and NBSP, so the app approved a row the CHECK then refused as a raw 23514.
          return typeof value === 'string' ? value.replace(/^ +| +$/g, '') : value;
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
      const emitted = pattern instanceof RegExp ? patternSql(pattern) : undefined;
      return one(
        `${term.label} must match ${pattern instanceof RegExp ? pattern.source : pattern.name || 'the rule'}`,
        (resolve) => (emitted === undefined ? null : `${term.sql(resolve)} ${emitted}`),
        (value) =>
          typeof value === 'string' &&
          (pattern instanceof RegExp ? pattern.test(value) : pattern(value)),
      );
    },

    atLeast: (bound) => {
      finite('atLeast', bound);
      return one(
        `${term.label} must be at least ${bound}`,
        (resolve) => `${term.sql(resolve)} >= ${bound}`,
        // By the column's KIND, never `typeof value`: a `bigint()`/`decimal()` row is decimal text,
        // so a number test failed every row the CHECK beside it accepts.
        (value) => (numericOrder(term.decimal, value, bound) ?? -1) >= 0,
      );
    },

    eq: (other) => {
      if (isColumnExpr(other)) return sameAs(term, other);
      finite('eq', other);
      // `col = 1.5` is numeric equality whatever spelled the operand, and on a decimal column so is
      // `col = '1.5'` — Postgres coerces the literal. Everything else is the value itself.
      const numeric = term.decimal || typeof other === 'number' || typeof other === 'bigint';
      return one(
        `${term.label} must equal ${literal(other)}`,
        (resolve) => `${term.sql(resolve)} = ${literal(other)}`,
        (value) =>
          numeric && typeof other !== 'boolean'
            ? numericOrder(term.decimal, value, other) === 0
            : value === other,
      );
    },

    isTrue: () =>
      one(
        `${term.label} must be true`,
        (resolve) => term.sql(resolve),
        (value) => value === true,
      ),

    isNull: () =>
      one(`${term.label} is not set`, (resolve) => `${term.sql(resolve)} is null`, isNullish),

    isNotNull: () =>
      one(
        `${term.label} is set`,
        (resolve) => `${term.sql(resolve)} is not null`,
        (value) => !isNullish(value),
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
    // A money part is a `number` (minor) or text (currency) — never decimal text.
    decimal: false,
    label: `${term.label}.${key}`,
    sql: (resolve) => resolve([...term.path, key]),
    read: (row) => walk(row, [...term.path, key]),
  });

const sameAs = (left: Term, other: ColumnExpr): Expr => {
  // `??` rather than an `if`: `eq` reaches here only past `isColumnExpr(other)`, which IS
  // `terms.has(other)`, so this refusal is unreachable and exists to narrow `right` off the map.
  const right =
    terms.get(other) ??
    refuseInvariant(
      'eq',
      'not a column expression',
      "pass a column of the same c — c.total.eq(c.subtotal) — or compare against a value: c.total.eq(0). A column of another entity cannot appear in this table's CHECK",
    );
  return check(
    [left.path, right.path],
    `${left.label} must equal ${right.label}`,
    (resolve) => `${left.sql(resolve)} = ${right.sql(resolve)}`,
    // Two numeric columns are equal when their NUMBERS are: `'2' = '2.00'` across a `bigint()` and
    // a `decimal()`, which `===` over the two row strings denied.
    (row) =>
      left.decimal || right.decimal
        ? numericOrder(true, left.read(row), right.read(row)) === 0
        : left.read(row) === right.read(row),
  );
};

const columnTerm = (property: string, decimal: boolean): Term => ({
  path: [property],
  decimal,
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
 * `a` and `b` hold together or not at all — the biconditional, rendered `(a) = (b)`, which is what
 * Postgres spells one as: `=` between two booleans IS iff there.
 *
 * A FUNCTION and not a method on `Expr`, for two reasons that both come from the type. `Expr` is
 * exported, so a required member is a breaking change to anything implementing it structurally; and
 * `kind: 'unique'` is an `Expr` whose `toSql` is a COLUMN LIST, so `c.unique([…]).iff(…)` would be a
 * method that exists on the type and is meaningless for some of its values. Refusing that operand in
 * one place beats putting the method where it cannot mean anything. Symmetric reads symmetric, too.
 *
 * **`=` and not `is not distinct from`, decided on a measurement.** With both operands total the two
 * are identical for all four boolean pairs. They part when an operand is NULL — a predicate on a
 * nullable column — and there `=` answers NULL, which a CHECK PASSES, while `is not distinct from`
 * answers false, which a CHECK REFUSES. The app side reads a NULL operand as false either way, so
 * the total form is the one that refuses a row TypeScript ACCEPTED: `(NULL) is not distinct from
 * (false)` is false where `false === false` is true. That is the raw `23514` in place of
 * `X_INVARIANT_VIOLATED` this whole file exists against, and it is why the more permissive spelling
 * is the safer one. `pg-invariant-null.live.test.ts` measures both.
 *
 * So an operand that can be NULL leaves the CHECK permissive — the language's one existing
 * disagreement, inherited here and not widened. `isNull()`/`isNotNull()` are total, which is what
 * makes a rule built from them exact.
 */
export const iff = (left: Expr, right: Expr): Expr => {
  for (const side of [left, right] as const) {
    if (side.kind !== 'unique') continue;
    // The columns it names, so the pasted line is the rule the author already meant to declare —
    // never a `<name>` for them to fill in, which is the placeholder `refuse.test.ts` refuses.
    //
    // `JSON.stringify` and never `'${column}'`: a column path is a VALUE reaching TypeScript
    // SOURCE, which is this file's own hazard one layer up. `columns: { "o'brien": text() }` is a
    // legal declaration and `unique()` is reached untyped besides, so a quote ends the literal and
    // the fix stops parsing; a backslash is the half doubling the quote would still have missed.
    // `errors.ts`'s `asLiteral` is the same rule for the same reason.
    const columns = side.paths.map((path) => path.join('.'));
    const list = columns.map((column) => JSON.stringify(column)).join(', ');
    const name = JSON.stringify(`${columns.join('_')}_unique`);
    refuseInvariant(
      'iff',
      `${side.message} is a unique constraint, whose SQL is a column list and not a predicate`,
      `invariant(${name}, c.unique([${list}]))   # uniqueness is its own invariant; iff takes two predicates, e.g. iff(c.status.eq('published'), c.publishedAt.isNotNull())`,
    );
  }
  const seen = new Set<string>();
  const paths: (readonly string[])[] = [];
  for (const path of [...left.paths, ...right.paths]) {
    const key = path.join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return check(
    paths,
    `${left.message} exactly when ${right.message}`,
    (resolve) => {
      // One app-only operand makes the WHOLE rule app-only: `(null) = (…)` is not a predicate, and
      // emitting half of a biconditional would enforce something the author never wrote.
      const a = left.toSql(resolve);
      const b = right.toSql(resolve);
      return a === null || b === null ? null : `(${a}) = (${b})`;
    },
    (row) => left.holds(row) === right.holds(row),
  );
};

/**
 * The `c` an invariant is written against. Still a Proxy even though `InvariantColumns<C>` now
 * catches a typo at compile time: a JS caller, a dynamically built rule and a `satisfies()` column
 * list all reach it untyped, and the thrown message names the columns that do exist rather than
 * failing later as `undefined is not a function`.
 *
 * It takes the column MAP, not a name list: a numeric rule is judged by the column's declared kind
 * (`numeric-compare.ts`), and the map is the only place that kind is written.
 */
export const invariantColumns = <C extends ColumnMap>(
  entity: string,
  columns: C,
): InvariantColumns<C> => {
  const properties = Object.keys(columns);
  const helpers = { unique, satisfies };
  return new Proxy(helpers, {
    get(target, property) {
      if (property === 'unique' || property === 'satisfies') return target[property];
      if (typeof property !== 'string') return undefined;
      // `Object.hasOwn`, never `columns[property]`: the name is caller data on the JS path, and a
      // plain read answers an `Object.prototype` member for `constructor`.
      const column = Object.hasOwn(columns, property) ? columns[property] : undefined;
      if (column === undefined) {
        throw invariantViolated(
          entity,
          'invariant',
          `no column "${property}"; declared columns are ${properties.join(', ')}`,
        );
      }
      return expr(columnTerm(property, DECIMAL_TEXT.has(column.$meta.kind)));
    },
  }) as unknown as InvariantColumns<C>;
};
