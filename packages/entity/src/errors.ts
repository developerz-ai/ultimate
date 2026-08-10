// The entity layer's stable error codes. Each factory produces the exact command
// that fixes the situation — `X_DB_DRIFT` is the flagship: it names the table, the
// column and the generator invocation.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const ENTITY_OWNED_ERROR_CODES = [
  'X_ENTITY_DUPLICATE',
  'X_INVARIANT_VIOLATED',
  'X_TENANCY_UNSCOPED',
  'X_NOT_FOUND',
] as const;

/**
 * `X_DB_DRIFT` is `@ultimat3/db`'s — drift is a fact about migrations, and this package imports db
 * rather than the other way round. `dbDrift()` below throws it; nothing here titles it, because a
 * second copy of the title is what lets the two packages disagree about what the code means.
 */
export const ENTITY_BORROWED_ERROR_CODES = ['X_DB_DRIFT'] as const;

/** Every code entity can throw: the ones it owns plus the one it borrows. */
export const ENTITY_ERROR_CODES = [
  ...ENTITY_OWNED_ERROR_CODES,
  ...ENTITY_BORROWED_ERROR_CODES,
] as const;

export type EntityOwnedErrorCode = (typeof ENTITY_OWNED_ERROR_CODES)[number];
export type EntityErrorCode = (typeof ENTITY_ERROR_CODES)[number];

export const ENTITY_ERROR_TITLES: Readonly<Record<EntityOwnedErrorCode, string>> = {
  X_ENTITY_DUPLICATE: 'two entities claim the same name',
  X_INVARIANT_VIOLATED: 'a domain invariant rejected this row',
  X_TENANCY_UNSCOPED: 'a tenant-scoped query has no org predicate',
  X_NOT_FOUND: 'no row for that id',
};

// Registered at module load, unconditionally, in one call. Without this the registry humanises the
// code and every surface renders a title this package never wrote; with a presence guard, a second
// package claiming one of these codes would silently win instead of throwing X_ERROR_CODE_DUPLICATE.
registerErrorCodes(
  Object.fromEntries(Object.entries(ENTITY_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export class EntityError extends UltimateError {
  override readonly name = 'EntityError';

  constructor(init: { code: EntityErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
    });
  }
}

export const entityDuplicate = (name: string, existingTable: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_DUPLICATE',
    cause: `entity "${name}" is already registered for table "${existingTable}"`,
    fix: `x entities list --json   # then rename one of the two entity({ name }) declarations`,
  });

export const invariantViolated = (
  entityName: string,
  invariantName: string,
  message: string,
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.${invariantName}: ${message}`,
    fix: `x entity explain ${entityName} --json   # shows the invariant and its SQL CHECK`,
  });

export const tenancyUnscoped = (entityName: string, operation: string): EntityError =>
  new EntityError({
    code: 'X_TENANCY_UNSCOPED',
    cause: `${entityName}.${operation}() was built without an org predicate but the entity has an orgId column`,
    fix: `pass { orgId } to ${entityName}.${operation}(), or wrap the plan with orgScoped(entity, orgId, plan)`,
  });

export const dbDrift = (tableName: string, columnName: string): EntityError =>
  new EntityError({
    code: 'X_DB_DRIFT',
    cause: `table "${tableName}" has column "${columnName}" not present in any migration`,
    fix: `x db gen "add ${columnName}"`,
  });

export const notFound = (entityName: string, id: string): EntityError =>
  new EntityError({
    code: 'X_NOT_FOUND',
    cause: `${entityName} ${id} does not exist (or is soft-deleted)`,
    fix: `x db query "select id from ${entityName} limit 5" --json   # confirm the id you expect`,
  });
