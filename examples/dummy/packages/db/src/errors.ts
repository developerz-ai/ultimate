/** Schema-layer error codes. Everything here is a programming error, not a user error. */

// No `docs:` at any declaration below. `UltimateError` fills it from
// `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for
// every code, never one per code, because a code lives on that page in a TABLE ROW and a row has
// no anchor. The `https://ultimate.dev/errors/<code>` links these classes built until 2026-08-23
// answered 404, host included, on every error this app has ever thrown.

import { defineError } from '@ultimat3/core';

/**
 * Thrown when a repo builds a statement against a tenant-scoped table without an org filter.
 * A cross-tenant read is the one bug class that must fail loudly rather than return rows. A 500
 * DECLARED, not one by omission: it is this app's bug, the monitor should hear of it, and the
 * caller learns only the code.
 */
export const TenantMissing = defineError<string>({
  code: 'X_DB_TENANT_MISSING',
  title: 'a tenant-scoped statement carries no org filter',
  status: 500,
  cause: (table) => `query on tenant-scoped table "${table}" has no orgId predicate`,
  fix: (table) =>
    `add .where({ orgId }) — or drop .tenant() from the ${table} entity if it is a catalog`,
});
