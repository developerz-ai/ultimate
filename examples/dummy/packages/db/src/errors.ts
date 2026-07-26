/** Schema-layer error codes. Everything here is a programming error, not a user error. */

import { UltimateError } from '@ultimat3/core';

export class DbError extends UltimateError {}

/**
 * Thrown when a repo builds a statement against a tenant-scoped table without an org filter.
 * A cross-tenant read is the one bug class that must fail loudly rather than return rows.
 */
export class TenantMissing extends DbError {
  constructor(table: string) {
    super({
      code: 'X_DB_TENANT_MISSING',
      cause: `query on tenant-scoped table "${table}" has no orgId predicate`,
      fix: `add .where({ orgId }) — or drop .tenant() from the ${table} entity if it is a catalog`,
      docs: 'https://ultimate.dev/errors/X_DB_TENANT_MISSING',
    });
  }
}
