// The refusals `entity({ appendOnly: true })` raises: a repository call that would change or remove
// a stored row, and a declaration that only means something under UPDATE. Each fix names the
// append that replaces the rewrite, or the edit that lifts the declaration.
import { EntityError, type EntityErrorCode } from './entity-error';

/** The refusal's code, exported so every test asserts the one literal. */
export const APPEND_ONLY_CODE: EntityErrorCode = 'X_ENTITY_APPEND_ONLY';

/** The repository calls that rewrite or remove a row — every one a `Repo` has. */
export type AppendOnlyRefusedCall =
  | 'update'
  | 'delete'
  | 'updateWhere'
  | 'deleteWhere'
  | 'upsertAll';

/** How to lift the rule, said once: the trigger goes with the flag, in a migration. */
const LIFT =
  'or, if these rows must change, remove appendOnly: true from the entity and run x db gen "allow row rewrites"';

const fixFor = (entityName: string, call: AppendOnlyRefusedCall): string => {
  if (call === 'upsertAll') {
    return `${entityName}.upsertAll(rows, { onConflict, onMatch: 'nothing' })   # a row already stored is skipped, never overwritten — ${LIFT}`;
  }
  const what = call === 'update' || call === 'updateWhere' ? 'the correction' : 'the reversal';
  return `${entityName}.insert({ … })   # append ${what} as a new row that names the one it supersedes — ${LIFT}`;
};

export const appendOnlyRefused = (entityName: string, call: AppendOnlyRefusedCall): EntityError =>
  new EntityError({
    code: APPEND_ONLY_CODE,
    cause:
      `${entityName}.${call}() would ${call.startsWith('delete') ? 'remove' : 'rewrite'} a stored row, ` +
      `and ${entityName} is declared appendOnly: true — its rows are written once and never ` +
      'changed or removed; the table trigger refuses the same statement in raw SQL',
    fix: fixFor(entityName, call),
  });

/**
 * A column that only means something when a row is UPDATED, on an entity whose rows never are.
 * Raised while the entity is being declared, so the fix is the edit, not a lookup of an entity
 * that does not exist yet.
 */
export const appendOnlyColumnRefused = (
  entityName: string,
  property: string,
  why: string,
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.${property}: ${why}, and ${entityName} is declared appendOnly: true — no row of it is ever updated`,
    fix: `entity('${entityName}', { columns, appendOnly: true })   # with ${property} removed from columns — or keep ${property} and drop appendOnly: true`,
  });
