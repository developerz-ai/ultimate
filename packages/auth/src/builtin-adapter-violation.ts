// Single responsibility: an `x_users` (or `x_passkeys`) unique violation as the code `MemoryAuthAdapter` answers. One
// duplicate signup must not be `X_AUTH_WRITE_FAILED` under `x dev` and `X_DB_UNIQUE_VIOLATION` in
// production: an app that branches on the code passes its tests and misses on Postgres.

import { stringField } from '@ultimat3/core';
import { SQLSTATE, sqlState } from '@ultimat3/db';
import { type AuthError, authUniqueViolation } from './errors';

/**
 * The constraints `tables.ts` declares on `x_users` and `x_passkeys`, by the names Postgres gives them. Closed: a
 * unique index an app added to the table is the app's, and its violation travels on as the
 * database error it is rather than being reported as a column it does not cover.
 */
const UNIQUE_COLUMNS: ReadonlyMap<string, readonly [table: string, column: string]> = new Map([
  ['x_users_email_key', ['x_users', 'email']],
  ['x_users_external_id_key', ['x_users', 'external_id']],
  ['x_users_pkey', ['x_users', 'id']],
  // A credential id is globally unique (WebAuthn §7.1 step 22): a second registration of one.
  ['x_passkeys_pkey', ['x_passkeys', 'id']],
  ['x_passkey_evidence_pkey', ['x_passkey_evidence', 'id']],
]);

/** How deep `DbError.sourceError` may nest before the read stops — db's own bound. */
const MAX_WRAPS = 4;

/** The constraint the server named. db's wrap keeps the driver error on `sourceError`. */
function violatedConstraint(error: unknown): string | undefined {
  let value = error;
  for (let depth = 0; depth < MAX_WRAPS && value !== undefined && value !== null; depth += 1) {
    const constraint = stringField(value, 'constraint');
    if (constraint !== undefined) return constraint;
    value = typeof value === 'object' ? (value as { sourceError?: unknown }).sourceError : null;
  }
  return undefined;
}

/**
 * `undefined` for everything that is not one of those tables' own unique constraints, so the caller
 * rethrows what it caught. The SQLSTATE is read through db's `sqlState`, which decides by where
 * the error came from, never by the shape of a `code` field.
 */
export function usersUniqueViolation(operation: string, error: unknown): AuthError | undefined {
  if (sqlState(error) !== SQLSTATE.uniqueViolation) return undefined;
  const named = UNIQUE_COLUMNS.get(violatedConstraint(error) ?? '');
  return named === undefined ? undefined : authUniqueViolation(operation, named[0], named[1]);
}
