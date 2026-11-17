// Single responsibility: where a replicated change goes on the bus and what makes it publishable —
// the subject a change is published under, and the normalize step that drops the unusable and
// hoists the tenant out of the row. Split from `replicator.ts`, which re-exports both.

import { tenantColumnOfTable, tenantIn } from './change-tenant';
import type { ChangeEvent } from './changefeed';

export const CHANGE_SUBJECT_PREFIX = 'x.change';

/** Every change subject: what a `sync` node subscribes to. A changefeed subject, never a channel. */
export const CHANGE_SUBJECT_ALL = `${CHANGE_SUBJECT_PREFIX}.>`;

/** `x.change.<table>.<orgId>` — tenant in the subject, so fanout filters without parsing a row. */
export function changeSubject(change: ChangeEvent): string {
  return `${CHANGE_SUBJECT_PREFIX}.${change.table}.${change.orgId ?? '_'}`;
}

/**
 * Drops events the pipeline cannot use and hoists the tenant out of the row — from the column the
 * table's ENTITY declares (`change-tenant.ts`), never a property assumed to be `orgId`. It read
 * `row.orgId`, so a key-only DELETE on a `tenant: 'workspaceId'` table whose key holds an `orgId`
 * column was published as that org's change, and the real tenant's windows dropped it.
 */
export function normalize(change: ChangeEvent): ChangeEvent | null {
  // The one change that carries no row by design; nothing to hoist a tenant out of.
  if (change.op === 'truncate') return change;
  const row = change.after ?? change.before;
  if (!row) return null;
  if (change.op === 'insert' && change.after === null) return null;
  if (change.op === 'delete' && change.before === null) return null;
  if (change.orgId !== null) return change;
  const orgId = tenantIn(tenantColumnOfTable(change.table), row);
  return orgId === null ? change : { ...change, orgId };
}
