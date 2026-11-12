// Single responsibility: the repository seam of an entity no row of which is written — a view
// (`X_ENTITY_VIEW_READ_ONLY`), a `readOnly` table (`X_ENTITY_READ_ONLY`) — every write rejecting
// before any statement exists, in both drivers, because both return through `appendOnlyRepo`. Reads pass through untouched; a spread keeps `MemoryRepo.reset()`.

import { renderFixShellArg } from '@ultimat3/core';
import { EntityError } from './entity-error';
import type { Repo } from './repo';

const WRITES = [
  'insert',
  'insertAll',
  'upsertAll',
  'update',
  'delete',
  'deleteWhere',
  'updateWhere',
  'insertAllCount',
  'upsertAllCount',
  'copyAll',
  'updateMany',
  'lock',
] as const;

export const viewReadOnly = (entityName: string, operation: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_VIEW_READ_ONLY',
    cause: `${entityName}.${operation}() — ${entityName} is a view (entity({ view })), a relation Postgres derives from its query, and no row of it can be written`,
    fix: `x entities show ${renderFixShellArg(entityName, '<entity>')} --json   # write the table its view.sql reads; the view answers on the next read (materialized: after its refreshView job runs)`,
  });

/** `repo` with every write rejecting `refusal(operation)` — a view's code unless told otherwise. */
export const readOnlyRepo = <Row, R extends Repo<Row>>(
  entityName: string,
  repo: R,
  refusal: (operation: string) => EntityError = (operation) => viewReadOnly(entityName, operation),
): R => {
  const refusing = Object.fromEntries(
    WRITES.map((operation) => [
      operation,
      async () => {
        throw refusal(operation);
      },
    ]),
  );
  // `lock` is a write's first half (`for update`, which Postgres refuses on a view anyway).
  return { ...repo, ...refusing };
};
