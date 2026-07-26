// Cross-entity search, derived: every resource's text fields are the index. No separate
// search config to drift from the entities, and no result an actor could not have opened —
// the same `admin:read` + `<entity>:read` pair gates the hit and the detail page it links to.

import type { CrudCtx } from './crud';
import { canOperate } from './crud';
import type { AdminFilter, AdminRow } from './registry';
import { rowId } from './registry';
import { type AdminResource, repoOf } from './resource';

/** Per resource, and per field within it. Search is a jump box, not a report. */
const MAX_FIELDS_PER_RESOURCE = 3;
const DEFAULT_LIMIT_PER_RESOURCE = 5;

export interface AdminSearchHit {
  readonly entity: string;
  readonly id: string;
  /** The row's label-field value. Already a string; the view does not format it. */
  readonly label: string;
  readonly matchedField: string;
  /** Mount-relative link to the detail page. */
  readonly href: string;
}

export interface AdminSearchResult {
  readonly term: string;
  readonly hits: readonly AdminSearchHit[];
  readonly searched: readonly string[];
  /** Resources left out, and why — so an operator is never silently shown a subset. */
  readonly skipped: readonly { readonly entity: string; readonly reason: string }[];
}

export interface AdminSearchInput {
  readonly term: string;
  readonly resources: readonly AdminResource[];
  readonly ctx: CrudCtx;
  readonly limitPerResource?: number;
}

/**
 * One query per searchable field rather than one query with an OR: the admin's query IR is
 * a conjunction by design (each filter maps to an indexed predicate), and three small
 * indexed lookups beat one unindexed disjunction.
 */
async function searchResource(
  resource: AdminResource,
  term: string,
  limit: number,
): Promise<readonly AdminSearchHit[]> {
  const repo = repoOf(resource);
  const fields = resource.searchFields.slice(0, MAX_FIELDS_PER_RESOURCE);
  const seen = new Set<string>();
  const hits: AdminSearchHit[] = [];

  for (const field of fields) {
    const where: readonly AdminFilter[] = [{ field: field.name, op: 'contains', value: term }];
    const rows = await repo.list({ where, sort: resource.defaultSort, limit });
    for (const row of rows) {
      const id = rowId(row, resource.idField);
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      hits.push({
        entity: resource.name,
        id,
        label: labelOf(row, resource),
        matchedField: field.name,
        href: `${resource.path}/${id}`,
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

function labelOf(row: AdminRow, resource: AdminResource): string {
  const value = row[resource.labelField];
  if (typeof value === 'string' && value !== '') return value;
  return rowId(row, resource.idField);
}

export async function adminSearch(input: AdminSearchInput): Promise<AdminSearchResult> {
  const term = input.term.trim();
  const limit = input.limitPerResource ?? DEFAULT_LIMIT_PER_RESOURCE;
  const searched: string[] = [];
  const skipped: { entity: string; reason: string }[] = [];
  const hits: AdminSearchHit[] = [];

  if (term === '') return { term, hits: [], searched: [], skipped: [] };

  for (const resource of input.resources) {
    if (!canOperate(resource, 'search', input.ctx)) {
      skipped.push({ entity: resource.name, reason: 'admin.search.skipped.forbidden' });
      continue;
    }
    if (resource.searchFields.length === 0) {
      skipped.push({ entity: resource.name, reason: 'admin.search.skipped.no-text-fields' });
      continue;
    }
    if (resource.repo === undefined) {
      skipped.push({ entity: resource.name, reason: 'admin.search.skipped.no-repo' });
      continue;
    }
    searched.push(resource.name);
    hits.push(...(await searchResource(resource, term, limit)));
  }

  return { term, hits, searched, skipped };
}
