// The refusals of the declared optimistic lock (`entity({ version })`): a write that read a row
// another write has since moved, and a write or declaration that would leave the lock with a hole.
// Codes and titles live in `entity-error.ts`'s registry; this file only builds the instances.

import { renderCauseValue } from '@ultimat3/core';
import { EntityError } from './entity-error';

/**
 * The lost update, caught: the write named the version it read, and the stored row is past it.
 * 409, as `X_STATE_CONFLICT`: the identical request succeeds after a re-read, which is exactly what
 * a 409 tells a client to do. `stored` is read back AFTER the statement refused, so it is the
 * diagnosis, never the decision.
 */
export const entityStale = (
  entityName: string,
  property: string,
  id: string,
  expected: unknown,
  stored: unknown,
): EntityError =>
  new EntityError({
    code: 'X_ENTITY_STALE',
    cause: `${entityName} ${id} was written with ${property} ${renderCauseValue(expected)}, and the stored row is at ${renderCauseValue(stored)} — another write landed after this one read the row`,
    fix: `const fresh = await db.${entityName}.findById(id)   # re-read, re-apply the change, and send fresh.${property} back with the patch`,
  });

/** `updateMany`'s form: one statement, so the rows it skipped are counted rather than named. */
export const entityStaleBatch = (
  entityName: string,
  property: string,
  stale: number,
  of: number,
): EntityError =>
  new EntityError({
    code: 'X_ENTITY_STALE',
    cause: `${entityName}.updateMany() named a ${property} for ${of} rows, and ${stale} of them are stored past it — another write landed after the batch was read; nothing was written`,
    fix: `const fresh = await db.${entityName}.where({ id: ids }).all()   # re-read the batch, rebuild each patch with its row's ${property}, then updateMany again`,
  });

/** The entity declared a lock, and this write's shape cannot honour it. */
export const versionMisused = (entityName: string, detail: string, fix: string): EntityError =>
  new EntityError({ code: 'X_ENTITY_VERSION_INVALID', cause: `${entityName}: ${detail}`, fix });
