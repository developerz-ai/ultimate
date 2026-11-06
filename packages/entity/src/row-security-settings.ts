// Single responsibility: the tenant every transaction carries when the database enforces row
// security — the same `tenant:` the repository already scopes by, handed to `@ultimat3/db`'s
// transaction-settings seam. A `crossTenant()` scope sets `x.cross`; no actor tenant sets nothing.

import { tryUseContext } from '@ultimat3/core';
import type { LocalSettings } from '@ultimat3/db';
import { crossTenantReason } from './cross-tenant';

/**
 * Read once per root transaction, at its BEGIN. Two limits, stated: a `crossTenant()` opened INSIDE
 * an open transaction does not reach that transaction (its settings were fixed at BEGIN), and a
 * raw `set_config('x.cross', 'on', true)` in the app's own process lifts the guard — this layer
 * catches forgetting, not hostile SQL already running inside the process.
 */
export function rowSecuritySettings(): LocalSettings | undefined {
  if (crossTenantReason() !== undefined) return { 'x.cross': 'on' };
  const orgId = tryUseContext()?.actor.orgId;
  if (orgId === undefined || orgId === null || orgId === '') return undefined;
  return { 'x.tenant': String(orgId) };
}
