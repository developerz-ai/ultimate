// A list walked page by page to its END, the way an operator clicking Next (or Previous) walks it —
// written once, run over the memory driver (`repo-entity-keyset.test.ts`) and over a real Postgres
// (`repo-entity-keyset.contract.test.ts`), so the two cannot hold different ideas of "every row".

import { type AdminPage, fetchPage } from './pagination';
import type { AdminRow, AdminSort } from './registry';
import type { AdminResource } from './resource';

/** More pages than any fixture holds: a walk that does not end is a defect, not a long table. */
const MAX_PAGES = 50;

const readOut = (row: AdminRow, field: string): string => String(row[field] ?? 'null');

/** Every page from the first, following `nextCursor`: the ids (or `field`) in the order served. */
export async function walkForward(
  resource: AdminResource,
  sort: AdminSort,
  field: string = resource.idField,
): Promise<readonly string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const served: AdminPage<AdminRow> = await fetchPage(resource, { sort, cursor });
    seen.push(...served.rows.map((row) => readOut(row, field)));
    if (!served.hasMore) return seen;
    cursor = served.nextCursor;
  }
  return seen;
}

/**
 * To the last page, then back through `prevCursor` to the first: the ids in SORT order, so a
 * correct walk answers exactly what `walkForward` did.
 */
export async function walkBackward(
  resource: AdminResource,
  sort: AdminSort,
): Promise<readonly string[]> {
  let cursor: string | null = null;
  let last = await fetchPage(resource, { sort, cursor });
  for (let page = 0; page < MAX_PAGES && last.hasMore; page += 1) {
    cursor = last.nextCursor;
    last = await fetchPage(resource, { sort, cursor });
  }
  const pages: (readonly string[])[] = [last.rows.map((row) => readOut(row, resource.idField))];
  let back = last.prevCursor;
  for (let page = 0; page < MAX_PAGES && back !== null; page += 1) {
    const served = await fetchPage(resource, { sort, cursor: back });
    pages.unshift(served.rows.map((row) => readOut(row, resource.idField)));
    back = served.prevCursor;
  }
  return pages.flat();
}
