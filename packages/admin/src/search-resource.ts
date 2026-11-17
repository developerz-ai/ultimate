// One resource's answer to the search box: its declared full-text index first (`search_tsv`, GIN,
// one statement), then one `contains` per text field to fill a short page — so a whole word and a
// substring ("ali" → "Alice") both find the row. At most 1 + `MAX_FIELDS_PER_RESOURCE` statements.

import { isUltimateError } from '@ultimat3/core';
import { expectedQueryLoop } from '@ultimat3/db';
import type { AdminActor } from './authz';
import { rowWhere } from './list-scope';
import type { AdminFilter, AdminRepo, AdminRow } from './registry';
import { rowId } from './registry';
import { labelOf } from './relations';
import { type AdminResource, repoOf } from './resource';
import { rowPath } from './row-path';

/** Per resource, and per field within it. Search is a jump box, not a report. */
const MAX_FIELDS_PER_RESOURCE = 3;

export interface AdminSearchHit {
  readonly entity: string;
  readonly id: string;
  /** The row's label-field value. Already a string; the view does not format it. */
  readonly label: string;
  /** The text field a `contains` matched, or the vector column for a full-text hit. */
  readonly matchedField: string;
  /** Mount-relative link to the detail page. */
  readonly href: string;
}

/**
 * The full-text read, or `[]` where it cannot run: no vector, a repo with no `search`, or the
 * memory driver — which refuses a vector match (`X_SEARCH_IN_MEMORY`) rather than answer one
 * Postgres would not, so there the `contains` loop is the whole answer. Any other failure is
 * the resource's failure, as a `contains` read's is.
 */
async function vectorRows(
  resource: AdminResource,
  repo: AdminRepo<AdminRow>,
  where: readonly AdminFilter[],
  term: string,
  limit: number,
): Promise<readonly AdminRow[]> {
  if (repo.search === undefined || (resource.entity.$search ?? null) === null) return [];
  try {
    return await repo.search({ term, where, sort: resource.defaultSort, limit });
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_SEARCH_IN_MEMORY') return [];
    throw error;
  }
}

/**
 * One `contains` per searchable field rather than one query with an OR: the admin's query IR is a
 * conjunction by design, and each field's `contains` is the entity's case-insensitive `ilike` —
 * served by that column's `gin_trgm_ops` index where the app declared one (`X_QUERY_UNINDEXED`
 * names the declaration where it did not), which one OR across columns could not use.
 *
 * That argument is declared to the runtime and not only to the reader — `expectedQueryLoop`
 * carries it onto every statement the loop issues, so a statement diagnostic reports the loops
 * nobody argued for and never this one. The scope ends with the loop: anything the repo does
 * afterwards is judged normally.
 */
export async function searchResource(
  resource: AdminResource,
  actor: AdminActor,
  term: string,
  limit: number,
): Promise<readonly AdminSearchHit[]> {
  const repo = repoOf(resource);
  // The resource's row scope rides every lookup, the vector's included: a hit is a row, and a row
  // this actor's `rows` leaves out is not one they may be told exists.
  const visible = rowWhere(resource, actor);
  const seen = new Set<string>();
  const hits: AdminSearchHit[] = [];
  const take = (rows: readonly AdminRow[], matchedField: string): boolean => {
    for (const row of rows) {
      const id = rowId(row, resource.idField);
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      hits.push({
        entity: resource.name,
        id,
        label: labelOf(row, resource),
        matchedField,
        href: rowPath(resource.path, id),
      });
      if (hits.length >= limit) return true;
    }
    return false;
  };

  return expectedQueryLoop(
    'admin search runs one indexed lookup per text field, which beats one unindexed OR',
    async () => {
      const vector = resource.entity.$search?.column;
      if (vector !== undefined) {
        if (take(await vectorRows(resource, repo, visible, term, limit), vector)) return hits;
      }
      for (const field of resource.searchFields.slice(0, MAX_FIELDS_PER_RESOURCE)) {
        const where: readonly AdminFilter[] = [
          ...visible,
          { field: field.name, op: 'contains', value: term },
        ];
        const rows = await repo.list({ where, sort: resource.defaultSort, limit });
        if (take(rows, field.name)) return hits;
      }
      return hits;
    },
  );
}
