// Single responsibility: how an invariant DECIDES a row, in SQL's three values. Each operator over a
// NULL operand answers UNKNOWN, `iff` composes unknowns, and a rule holds unless it is false — what
// a CHECK does with the same row, so the app and the database never disagree about a NULL.

import type { Expr, Resolve, Row } from './expr';
import { isNullish } from './is-null';

/** `null` is SQL's UNKNOWN: an operator over a NULL operand answers it, and a CHECK passes on it. */
export type Verdict = (row: Row) => boolean | null;

/** Each rule built here, judged in three values — what an `iff` composes, before CHECK collapses it. */
const verdicts = new WeakMap<Expr, Verdict>();

/** A rule's three-valued verdict; one built elsewhere (structurally) is two-valued. */
export const verdictOf = (rule: Expr): Verdict => verdicts.get(rule) ?? ((row) => rule.holds(row));

/**
 * A rule holds unless it is FALSE — the CHECK's own reading, so a NULL the database stores is a NULL
 * the app accepts. `matches(/…/)` on a nullable column refused NULL here while its CHECK stored it.
 */
export const check = (
  paths: readonly (readonly string[])[],
  message: string,
  sql: (resolve: Resolve) => string | null,
  verdict: Verdict,
): Expr => {
  const built: Expr = {
    kind: 'check',
    paths,
    message,
    toSql: sql,
    holds: (row) => verdict(row) !== false,
  };
  verdicts.set(built, verdict);
  return built;
};

/** Unknown when the operand is NULL — every operator but `is [not] null`, which is total. */
export const unknownOnNull =
  (read: (row: Row) => unknown, holds: (value: unknown) => boolean): Verdict =>
  (row) => {
    const value = read(row);
    return isNullish(value) ? null : holds(value);
  };
