// Single responsibility: the refusals a generated DDL FRAGMENT earns before it is spliced into a
// statement — an index's direction, an index's partial predicate, and a generated column's
// expression. Split out of `errors.ts` for the reason `invariant-errors.ts` and
// `migration-errors.ts` were: that file is at its ceiling. All three carry `X_SQL_UNSAFE`, which
// `DB_OWNED_ERROR_CODES` there declares and registers — no new code, and none is needed: an
// operand TypeScript never saw reaching a statement text is one situation, and axiom 1 gives one
// situation one code.

import { describeValue } from '@ultimat3/core';
import { DbError } from './errors';

/**
 * A direction that is not one of the two. `X_SQL_UNSAFE` for the reason `indexMethodInvalid` uses
 * it: `create index … ("c" <order>)` takes no parameters, so the direction is SPLICED into the
 * statement text. `IndexDescriptionLike.order` crosses the tier seam from `@ultimat3/entity`
 * structurally and is validated by nothing on the way, and `snapshot-parse.ts` screens only the
 * RECORDED side — so a hand-edited `.snapshot.json` or a projection this package cannot typecheck
 * reaches `createIndex` unchecked, and `x db gen` writes the result into a file `ROLE=migrate`
 * runs.
 *
 * `describeValue`, never the value, for the reason `indexMethodInvalid` gives: this cause is
 * folded into a problem document and a log line.
 */
export const indexOrderInvalid = (index: string, received: unknown): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `the direction of index "${index}" must be 'asc' or 'desc'; got ${describeValue(received)}`,
    fix: `indexes: [{ on: ['<column>'], order: 'desc' }]   # or leave it out for the ascending default, then x db gen`,
    meta: { index },
  });

/**
 * A partial index predicate holding more than one command. Read through `statementsOf` — this
 * package's one lexer, so a `;` inside a string literal is data and not a second statement — and
 * refused before it is spliced into `where (…)`.
 *
 * The same screen `declaredChecks` (`check-ddl.ts`) applies to a CHECK's expression, on the same
 * seam: the text arrives from an entity's `indexes: [{ where }]`, from an `invariant(c.unique([…]))`
 * through `uniqueIndexOf`, or from a `.snapshot.json`. `invariant-ddl.ts` says one rule covers
 * every expression, and until this landed the index half had none.
 */
export const indexPredicateUnsafe = (index: string, count: number): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `the predicate of index "${index}" holds ${count} commands; a partial index takes one expression`,
    fix: `indexes: [{ on: ['<column>'], where: 'deleted_at is null' }]   # one expression, built with the column DSL, then x db gen`,
    meta: { index, count },
  });

/**
 * A generated column's expression holding more than one command, refused before it is spliced into
 * `generated always as (…) stored`. Same lexer and same argument as `indexPredicateUnsafe`: the
 * expression crosses the tier seam as text (`@ultimat3/entity`'s `.searchable()` builds one), and
 * a second command riding it is an injection rather than a typo.
 */
export const generatedExpressionUnsafe = (column: string, count: number): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `the expression of generated column "${column}" holds ${count} commands; a generated column is one expression`,
    fix: `give "${column}" a single expression — .searchable() or generated: 'lower("title")' — then x db gen`,
    meta: { column, count },
  });
