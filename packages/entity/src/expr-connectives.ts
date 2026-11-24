// Single responsibility: the connectives over invariant expressions — `allOf` (and), `anyOf` (or),
// and the operand rules `iff` shares with them. One declaration still compiles to both enforcement
// points: a three-valued verdict the app runs and the SQL predicate a CHECK or a partial index
// carries, so "both null" and "at most one set" are one rule, never a hand-written index.

import type { Expr } from './expr';
import { check, type Verdict, verdictOf } from './expr-verdict';
import { refuseInvariant } from './refuse';

/**
 * Every operand of a combinator is a predicate: a `unique` is an `Expr` whose SQL is a COLUMN LIST,
 * so combining one is refused where it was written, naming the rule the author meant to declare.
 */
export const assertPredicates = (combinator: string, sides: readonly Expr[]): void => {
  for (const side of sides) {
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
      combinator,
      `${side.message} is a unique constraint, whose SQL is a column list and not a predicate`,
      `invariant(${name}, c.unique([${list}]))   # uniqueness is its own invariant; ${combinator} takes predicates, e.g. iff(c.status.eq('published'), c.publishedAt.isNotNull())`,
    );
  }
};

/** The paths every operand reads, each once, in the order they were first named. */
export const operandPaths = (sides: readonly Expr[]): readonly (readonly string[])[] => {
  const seen = new Set<string>();
  const paths: (readonly string[])[] = [];
  for (const path of sides.flatMap((side) => side.paths)) {
    // The whole segment list, never `join('.')`: a property literally named `amount.minor` and the
    // `minor` part of a money `amount` are two columns, and the dot would make them one.
    const key = JSON.stringify(path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  return paths;
};

/**
 * Two or more operands, or a combinator that combines nothing: `allOf(x)` is `x`, and writing it
 * says the author meant a second condition they left out.
 */
const assertOperands = (combinator: string, sides: readonly Expr[]): void => {
  if (sides.length >= 2) return;
  // The fix names only what the author already wrote: their one operand's own columns, never a
  // column this generator would be inventing for an entity it cannot see.
  const column = sides[0]?.paths[0]?.join('.');
  refuseInvariant(
    combinator,
    `takes two or more predicates, got ${sides.length}`,
    column === undefined
      ? `${combinator}(first, second)   # two predicates over this entity's columns, or none: drop the ${combinator}() call`
      : `unwrap ${combinator}(…) and pass its one predicate on ${JSON.stringify(column)} directly   # or add the second condition beside it inside ${combinator}(…)`,
  );
};

/**
 * One connective over its operands: SQL as each operand parenthesised and joined by `keyword`, and
 * the verdict in SQL's three values. One app-only operand makes the WHOLE rule app-only — emitting
 * the rest would enforce a rule the author never wrote, and a partial index refuses it by name.
 */
const connective = (
  combinator: string,
  keyword: 'and' | 'or',
  joiner: string,
  sides: readonly Expr[],
  verdict: (answers: readonly (boolean | null)[]) => boolean | null,
): Expr => {
  assertOperands(combinator, sides);
  assertPredicates(combinator, sides);
  const verdicts: readonly Verdict[] = sides.map(verdictOf);
  return check(
    operandPaths(sides),
    sides.map((side) => side.message).join(joiner),
    (resolve) => {
      const parts = sides.map((side) => side.toSql(resolve));
      return parts.some((part) => part === null)
        ? null
        : parts.map((part) => `(${part})`).join(` ${keyword} `);
    },
    (row) => verdict(verdicts.map((judge) => judge(row))),
  );
};

/**
 * Every operand holds: `allOf(c.a.isNull(), c.b.isNull())` — "both unset", rendered
 * `(a is null) and (b is null)`. Three-valued as SQL's `and`: false when any operand is false,
 * else unknown when any is unknown (which a CHECK passes), else true. For a rule, two invariants
 * are the same conjunction; this is for where one predicate must say it — an index `where`, or
 * inside `anyOf`/`iff`.
 */
export const allOf = (...sides: readonly Expr[]): Expr =>
  connective('allOf', 'and', ', and ', sides, (answers) =>
    answers.includes(false) ? false : answers.includes(null) ? null : true,
  );

/**
 * At least one operand holds: `anyOf(c.a.isNull(), c.b.isNull())` — "at most one of the two set",
 * rendered `(a is null) or (b is null)`. Three-valued as SQL's `or`: true when any operand is
 * true, else unknown when any is unknown, else false.
 */
export const anyOf = (...sides: readonly Expr[]): Expr =>
  connective('anyOf', 'or', ', or ', sides, (answers) =>
    answers.includes(true) ? true : answers.includes(null) ? null : false,
  );
