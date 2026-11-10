// Single responsibility: the two refusals `x db branch` raises — a branch that exists, and a name
// that is not one. Split from `errors.ts` at its line ceiling; `index.ts` re-exports both.

import { DbError } from './errors';

export const branchExists = (branch: string): DbError =>
  new DbError({
    code: 'X_BRANCH_EXISTS',
    cause: `database "${branch}" already exists`,
    fix: `x db branch delete ${branch}   # then re-create, or pick another name`,
    meta: { branch },
  });

/**
 * An unvalidated branch name is spliced into `CREATE DATABASE "<name>"`, so a bad name is an
 * injection vector, not a typo — hence `X_SQL_UNSAFE` rather than a validation code.
 */
export const branchNameInvalid = (branch: string): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `branch name "${branch}" is not [a-z0-9_-]+`,
    fix: 'x db branch create <name>   # lowercase letters, digits, underscore and dash only',
    meta: { branch },
  });
