// `entity({ readOnly: '<why>' })`: a table the app reads and never writes — legacy history behind a
// trigger that refuses every INSERT, a table another system owns. A reason, like `shared` and
// `scan`: blank is no reason. The repository refuses every write (`view-repo.ts`'s seam), and the
// exercise pass's seed graph leaves the table empty, as it does a view.

import { renderFixShellArg } from '@ultimat3/core';
import { EntityError } from './entity-error';

/**
 * Refused at declaration: a blank reason, and a second spelling of a narrower rule — a view
 * already refuses every write, and `appendOnly` admits the inserts this refuses.
 */
export const assertReadOnly = (
  entityName: string,
  readOnly: string | undefined,
  also: { readonly appendOnly: boolean; readonly view: boolean },
): string | null => {
  if (readOnly === undefined) return null;
  const refuse = (why: string, fix: string): never => {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `${entityName} declares readOnly ${why}`,
      fix,
    });
  };
  if (readOnly.trim() === '') {
    refuse(
      'with no reason: a blank reason says nothing about why the app never writes the table',
      `entity('${entityName}', { readOnly: '<why the app never writes it, e.g. legacy history a trigger closed>' }) — or drop readOnly`,
    );
  }
  if (also.view) {
    refuse(
      'and is a view: a view refuses every write already',
      `entity('${entityName}', { view }) — with the readOnly option removed`,
    );
  }
  if (also.appendOnly) {
    refuse(
      'and appendOnly: appendOnly admits the inserts readOnly refuses',
      `entity('${entityName}', { readOnly: '<why>' }) — with appendOnly removed, or appendOnly alone when the app appends`,
    );
  }
  return readOnly;
};

/** `X_ENTITY_READ_ONLY`: the write, the entity, and the reason its declaration gave. */
export const readOnlyRefused = (entityName: string, operation: string, reason: string) =>
  new EntityError({
    code: 'X_ENTITY_READ_ONLY',
    cause: `${entityName}.${operation}() — ${entityName} is declared readOnly (${reason}), so the app never writes a row of it`,
    fix: `x entities show ${renderFixShellArg(entityName, '<entity>')} --json   # write the table the app owns; drop readOnly from entity('<entity>', { … }) only once the table takes writes again`,
  });
