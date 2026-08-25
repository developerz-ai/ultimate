// Single responsibility: the two refusals an entity INVARIANT earns before its DDL exists — a name
// that cannot be an identifier, and a predicate holding a second command. Split out of `errors.ts`
// only because that file reached the 500-line ceiling; both carry `X_SQL_UNSAFE`, which
// `DB_OWNED_ERROR_CODES` there still declares and registers. No new code, and none is needed: an
// invariant name reaching a statement text is the same hazard a branch name or an isolation level
// is, and axiom 1 says one situation gets one code.

import { describeValue } from '@ultimat3/core';
import { DbError } from './errors';

/**
 * A name an invariant contributes to a statement — its own, or a column its `unique` list names —
 * that cannot be an identifier. `X_SQL_UNSAFE` for the reason `branchNameInvalid` uses it:
 * `create table` and `add constraint` take no parameters, so the name is SPLICED into the
 * statement text, and NOTHING validates an invariant name at declaration, so
 * `invariant('x" ); drop table t; --', …)` type-checks all the way to the generator. The identical
 * hole `columnName` carried when it was `meta.name ?? snake(property)` with only the first branch
 * checked, measured through `generateMigration` as a real `drop table`.
 *
 * Its own factory rather than `identifierUnsafe`, and that is the whole of its value — `identifier`
 * refuses the same string one call later, at every site that emits it. What only this one carries
 * is the REPAIR: `identifierUnsafe` says "pass a plain table/column name" to a caller holding a
 * name, and an author holding a schema module needs the `invariant()` call named instead. Pinned
 * on the `fix:` line, because a guard whose only value is its message is proven by nothing else.
 */
export const constraintNameUnsafe = (table: string, received: unknown): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `an invariant on "${table}" contributes ${describeValue(received)} to a statement, which cannot be a Postgres identifier`,
    fix: "invariant('post_slug_unique', c.unique(['slug']))   # every name is [A-Za-z_][A-Za-z0-9_$]*, then x db gen",
    meta: { table },
  });

/**
 * A constraint predicate holding more than one command. Read through `statementsOf` — this
 * package's one lexer, so a `;` inside a string literal is data and not a second statement — and
 * refused before it is spliced into `check (…)`. The predicate arrives from `Expr.toSql()` at tier
 * 2 or from a hand-built description, and an operand TypeScript never saw closing the parenthesis
 * is an injection rather than a typo, which is what `X_SQL_UNSAFE` is for.
 */
export const constraintExpressionUnsafe = (constraint: string, count: number): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `the predicate of constraint "${constraint}" holds ${count} commands; a CHECK is one expression`,
    fix: `invariant('${constraint}', c.column.atLeast(0))   # build the predicate with the column DSL, never as text`,
    meta: { constraint, count },
  });
