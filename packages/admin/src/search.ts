// Cross-entity search, derived: every resource's text fields are the index. No separate
// search config to drift from the entities, and no result an actor could not have opened —
// the same `admin:read` + `<entity>:read` pair gates the hit and the detail page it links to.

import { finiteCount } from '@ultimat3/core';
import { expectedQueryLoop } from '@ultimat3/db';
import { type AuditEntry, deniedDraft } from './audit';
import { denied } from './authz';
import type { CrudCtx } from './crud';
import { decideOperation } from './crud';
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
  /**
   * One entry per resource this call decided about: allowed, or refused. Search read rows out of
   * every readable entity and wrote NOTHING, on either path — while `permissions.ts` carries
   * `audited: true` for it, `audit.ts` says denied attempts are logged too, and `CLAUDE.md` says
   * "every admin operation is audited, reads included". Shaped like `adminList`'s: the subject is
   * the table, so there is no `entityId`.
   */
  readonly audit: readonly AuditEntry[];
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
 *
 * That argument is declared to the runtime and not only to the reader — `expectedQueryLoop`
 * carries it onto every statement the loop issues, so a statement diagnostic reports the loops
 * nobody argued for and never this one. At most `MAX_FIELDS_PER_RESOURCE` queries, and the scope
 * ends with the loop: anything the repo does afterwards is judged normally.
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

  return expectedQueryLoop(
    'admin search runs one indexed lookup per text field, which beats one unindexed OR',
    async () => {
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
    },
  );
}

function labelOf(row: AdminRow, resource: AdminResource): string {
  const value = row[resource.labelField];
  if (typeof value === 'string' && value !== '') return value;
  return rowId(row, resource.idField);
}

const SKIPPED_FORBIDDEN = 'admin.search.skipped.forbidden';

export async function adminSearch(input: AdminSearchInput): Promise<AdminSearchResult> {
  const { ctx } = input;
  const term = input.term.trim();
  // Both consumers of this number fail silently on a `NaN`, in opposite directions:
  // `hits.length >= NaN` is false, so the early return never fires and every field of every
  // resource is queried, and `repo.list({ limit: NaN })` hands the repo a limit no `LIMIT` clause
  // carries. At least 1 — a cap of zero is a search that is guaranteed to find nothing.
  const limit = finiteCount(
    'adminSearch',
    'limitPerResource',
    input.limitPerResource ?? DEFAULT_LIMIT_PER_RESOURCE,
    1,
  );
  const searched: string[] = [];
  const skipped: { entity: string; reason: string }[] = [];
  const hits: AdminSearchHit[] = [];
  const audit: AuditEntry[] = [];

  // Nothing was decided and nothing was read, so there is nothing to log: an empty term never
  // reaches a repo.
  if (term === '') return { term, hits: [], searched: [], skipped: [], audit: [] };

  for (const resource of input.resources) {
    const offered = resource.operations.includes('search');
    const decision = decideOperation(resource, 'search', ctx);
    if (!offered || !decision.allowed) {
      skipped.push({ entity: resource.name, reason: SKIPPED_FORBIDDEN });
      audit.push(
        await ctx.audit.append(
          deniedDraft({
            requestId: ctx.requestId,
            actor: ctx.actor,
            operation: 'search',
            kind: 'operation',
            entity: resource.name,
            entityId: null,
            // A resource that does not OFFER search was refused by the registry, not by a policy,
            // and the decision object would otherwise read `allow` on a denied entry.
            decision: offered ? decision : denied(decision.permission, SKIPPED_FORBIDDEN),
          }),
        ),
      );
      continue;
    }
    // Neither of these is an authorization event: the resource is searchable in principle and has
    // no text index or no repo to ask. They stay in `skipped` and out of the log.
    if (resource.searchFields.length === 0) {
      skipped.push({ entity: resource.name, reason: 'admin.search.skipped.no-text-fields' });
      continue;
    }
    if (resource.repo === undefined) {
      skipped.push({ entity: resource.name, reason: 'admin.search.skipped.no-repo' });
      continue;
    }
    searched.push(resource.name);
    // Appended BEFORE the read, so a repo that throws still leaves the record that the rows were
    // asked for — `audit.ts`: if it isn't logged, it didn't happen.
    audit.push(
      await ctx.audit.append({
        requestId: ctx.requestId,
        actor: ctx.actor,
        operation: 'search',
        kind: 'operation',
        entity: resource.name,
        entityId: null,
        permission: decision.permission,
        outcome: 'allowed',
        reason: decision.reason,
      }),
    );
    hits.push(...(await searchResource(resource, term, limit)));
  }

  return { term, hits, searched, skipped, audit };
}
