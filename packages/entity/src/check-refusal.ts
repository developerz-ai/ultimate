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

/** A table name without its schema: the server reports the relation's own name. */
const bareTable = (table: string): string => table.slice(table.lastIndexOf('.') + 1);

/**
 * The invariant refusal `error` stands for, or `error` itself. Only a check this entity declares
 * is rewritten: a hand-written constraint the declaration does not know stays the server's
 * verdict, because no rule here can name what it means. And only on the entity's own table: a
 * constraint name is unique per table, so a trigger's write to another table whose CHECK shares
 * a rule's name is that table's failure, not this rule's. A driver that names no table is judged
 * by the constraint alone, as before.
 */
export const asInvariantRefusal = (entity: EntityCore<unknown>, error: unknown): unknown => {
  if (sqlState(error) !== CHECK_VIOLATION || !isUltimateError(error)) return error;
  const constraint = error.meta?.['constraint'];
  if (typeof constraint !== 'string') return error;
  const table = error.meta?.['table'];
  if (typeof table === 'string' && table !== bareTable(entity.$table)) return error;
  const rule = entity.$invariants.find(
    (inv) => inv.kind === 'check' && namesConstraint(entity.$table, inv, constraint),
  );
  return rule === undefined ? error : invariantViolated(entity.$name, rule.name, rule.message);
};
