// Single responsibility: the tenant a change belongs to, read off the column its ENTITY declares
// (`$tenantColumn`), never off a property assumed to be called `orgId`. Every change producer —
// the write-ahead-log decoder, the in-process replicator, `recordPublisher` — and every live window
// ask here, so "which column is the tenant" has one answer: `@ultimat3/entity`'s.

import { entityForTable } from '@ultimat3/entity';

/** The tenant property of the entity stored in `table`, or `null` for an untenanted one. */
export const tenantColumnOfTable = (table: string): string | null =>
  entityForTable(table)?.$tenantColumn ?? null;

/**
 * The tenant `row` names in `column`, as the text an actor's `orgId` is. An integer tenant column
 * decodes as a number and is spelled as its digits; anything else names no tenant — which, on a
 * tenanted table, keeps the change out of every org-scoped window (`canAffect`).
 */
export function tenantIn(
  column: string | null,
  row: Readonly<Record<string, unknown>> | null,
): string | null {
  if (column === null || row === null) return null;
  const value = row[column];
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))) {
    return String(value);
  }
  return null;
}
