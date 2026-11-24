// Single responsibility: a CHECK the server enforced on an entity's own invariant answers as that
// invariant. `insert` judges the whole row before the statement; a patch (`update`, `updateWhere`)
// only becomes a row on the server, so there the CHECK is the first judge and its `23514` is the
// same refusal — `X_INVARIANT_VIOLATED`, a 422, never `X_DB_STATEMENT_FAILED`, a 500.

import { isUltimateError } from '@ultimat3/core';
import { namesConstraint, sqlState } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';

/**
 * `check_violation`. Not a row of `@ultimat3/db`'s `SQLSTATE`: that table is the states the db
 * layer classifies into its own codes, and this one it leaves to the entity that declared the CHECK.
 */
const CHECK_VIOLATION = '23514';

/**
 * The invariant refusal `error` stands for, or `error` itself. Only a check this entity declares
 * is rewritten: a hand-written constraint the declaration does not know stays the server's
 * verdict, because no rule here can name what it means.
 */
export const asInvariantRefusal = (entity: EntityCore<unknown>, error: unknown): unknown => {
  if (sqlState(error) !== CHECK_VIOLATION || !isUltimateError(error)) return error;
  const constraint = error.meta?.['constraint'];
  if (typeof constraint !== 'string') return error;
  const rule = entity.$invariants.find(
    (inv) => inv.kind === 'check' && namesConstraint(entity.$table, inv, constraint),
  );
  return rule === undefined ? error : invariantViolated(entity.$name, rule.name, rule.message);
};
