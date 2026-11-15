// Cross-entity search, derived: an entity's declared full-text index, then its text fields, are
// the index (`search-resource.ts`). No separate search config to drift from the entities, and no
// result an actor could not have opened — `admin:read` + `<entity>:read` gate hit and detail alike.

import { finiteCount, mapBounded } from '@ultimat3/core';
import { type AuditEntry, deniedDraft } from './audit';
import { adminDenied } from './authz';
import type { CrudCtx } from './crud';
import { decideOperation } from './crud';
import type { AdminResource } from './resource';
import { type AdminSearchHit, searchResource } from './search-resource';

export type { AdminSearchHit } from './search-resource';

const DEFAULT_LIMIT_PER_RESOURCE = 5;
/**
 * Resources read at once. Independent reads, so their latencies overlap rather than add — and a
 * bound, so an admin of fifty resources never holds fifty pool connections for one keystroke.
 */
const SEARCH_WIDTH = 4;

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

const SKIPPED_FORBIDDEN = 'admin.search.skipped.forbidden';
const SKIPPED_FAILED = 'admin.search.skipped.failed';

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

  // Decided and audited in resource order, every entry appended BEFORE any read — so a repo that
  // throws still leaves the record that the rows were asked for (`audit.ts`: if it isn't logged,
  // it didn't happen) — and only then read, side by side.
  const readable: AdminResource[] = [];
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
            decision: offered ? decision : adminDenied(decision.permission, SKIPPED_FORBIDDEN),
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
    readable.push(resource);
  }

  const answers = await mapBounded(
    readable,
    async (resource) => {
      try {
        return await searchResource(resource, ctx.actor, term, limit);
      } catch {
        // One resource whose repo fails is a resource this search could not read — listed, so the
        // operator is never silently shown a subset — never a 500 for every other one. Nothing is
        // read off the thrown value: a reason is a key.
        return undefined;
      }
    },
    { width: SEARCH_WIDTH },
  );
  for (const [index, resource] of readable.entries()) {
    const found = answers[index];
    if (found === undefined) {
      skipped.push({ entity: resource.name, reason: SKIPPED_FAILED });
      continue;
    }
    hits.push(...found);
    searched.push(resource.name);
  }

  return { term, hits, searched, skipped, audit };
}
