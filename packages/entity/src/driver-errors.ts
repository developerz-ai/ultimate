// Single responsibility: the refusals a custom driver built with `defineDriver` meets, and the
// unique-violation a store raises for a duplicate key. The codes and titles live in
// `entity-error.ts` with every other entity code; these carry `meta.capability`, which
// `EntityError` has no slot for, so they are `UltimateError`s of their own.

import { renderCauseValue, UltimateError } from '@ultimat3/core';
import { type DbError, driverError, SQLSTATE } from '@ultimat3/db';
import type { EntityCore } from './entity';
import type { EntityErrorCode } from './entity-error';

/** One refusal of this file: an entity code, plus the capability or the store it names. */
export class DriverError extends UltimateError {
  override readonly name = 'DriverError';

  constructor(init: {
    code: EntityErrorCode;
    cause: string;
    fix: string;
    meta: Readonly<Record<string, unknown>>;
  }) {
    super(init);
  }
}

/** A call needs a capability the driver did not declare. Raised before the store is reached. */
export const driverUnsupported = (
  driverName: string,
  entityName: string,
  operation: string,
  capability: string,
): DriverError =>
  new DriverError({
    code: 'X_DRIVER_UNSUPPORTED',
    cause: `${entityName}.${operation}() needs '${capability}', and driver ${renderCauseValue(driverName)} does not declare it in defineDriver({ capabilities })`,
    fix: `defineDriver({ name: ${JSON.stringify(driverName)}, capabilities: [..., '${capability}'], repo })   # and implement it on the object repo() returns — or read ${entityName} through postgresDriver(), which has every capability`,
    meta: { capability, driver: driverName, entity: entityName, operation },
  });

/** A declared capability with nothing behind it: refused when the driver is defined. */
export const driverCapabilityMissing = (
  driverName: string,
  capability: string,
  member: string,
): DriverError =>
  new DriverError({
    code: 'X_DRIVER_CAPABILITY_MISSING',
    cause: `driver ${renderCauseValue(driverName)} declares '${capability}' and provides no ${member}`,
    fix: `defineDriver({ name: ${JSON.stringify(driverName)}, capabilities: [/* without '${capability}' */], repo })   # or implement ${member} on the object repo() returns`,
    meta: { capability, driver: driverName },
  });

/**
 * The store answered with a row the plan excludes. Refused, never filtered out: a driver that
 * ignores a tenant predicate also ignores it on writes, and a quiet filter would hide that.
 */
export const driverRowOutOfScope = (
  driverName: string,
  entityName: string,
  operation: string,
  column: string,
): DriverError =>
  new DriverError({
    code: 'X_DRIVER_ROW_OUT_OF_SCOPE',
    cause: `driver ${renderCauseValue(driverName)} answered ${entityName}.${operation}() with a row whose ${column} the plan excludes — its select() did not apply plan.where`,
    fix: "selectRows(entity, rows, read)   # return this from the store's select(): it applies every plan.where predicate in process (@ultimat3/entity/adapter); a native store applies each one itself",
    meta: { column, driver: driverName, entity: entityName, operation },
  });

/**
 * The refusal a store raises for a duplicate key: the error Postgres' `23505` becomes, built by the
 * same `driverError` from the same fields a server sends — so `code`, `sqlState()`,
 * `meta.sqlState` and `meta.constraint` read alike whatever stores the row. It used to carry no
 * SQLSTATE ("no server said it"), and every app race handler matching `sqlState(e) === '23505'`
 * passed in production and failed under the memory driver: two answers to one question.
 */
export const entityUniqueViolation = (entity: EntityCore, constraint: string): DbError =>
  driverError(`write into ${entity.$table}`, {
    code: SQLSTATE.uniqueViolation,
    constraint,
    message: `duplicate key value violates unique constraint "${constraint}"`,
  });
