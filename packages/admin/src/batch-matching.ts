// "All matching" as ONE set-based call: an action that declares `matching` is handed the list's own
// `where` and answers `{ affected, remaining }` — the shape of a store's bounded bulk verb. Decided
// by the batch's gate, confirmed as a set, audited as one entry; `batch.ts` routes here.

import type { AdminDecision } from './authz';
import type { CrudCtx } from './crud';
import { type AdminListRequest, listWhere } from './list-scope';
import { ADMIN_DESTROY, CONFIRMATION_REQUIRED_REASON, confirmationToken } from './permissions';
import type { AdminAction, AdminActionCtx, AdminMatchingResult } from './registry';
import type { AdminResource } from './resource';

/** The reason the one entry of a set-based batch carries. */
export const BATCH_MATCHING_REASON = 'admin.batch.matching';
const MATCHING_FAILED_REASON = 'admin.error.action-failed';

/** The token a destructive set-based batch is typed against: the count is the store's to know. */
export const matchingConfirmationToken = (entity: string): string =>
  confirmationToken(entity, 'all matching');

export type MatchingAnswer =
  | { readonly ok: true; readonly result: AdminMatchingResult }
  | { readonly ok: false; readonly token: string; readonly decision: AdminDecision };

export interface MatchingInput {
  readonly resource: AdminResource;
  readonly action: AdminAction & Required<Pick<AdminAction, 'matching'>>;
  readonly ctx: CrudCtx;
  readonly request: Pick<AdminListRequest, 'scope' | 'filters'>;
  /** Already validated against the action's schema. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly confirmation?: string | undefined;
  /** The batch's own grant, decided before this is called. */
  readonly decision: AdminDecision;
}

export async function runMatching(args: MatchingInput): Promise<MatchingAnswer> {
  const { resource, action, ctx } = args;
  // `expected`, as the gate names it: a typed-to-confirm echo the page prints, not a secret.
  const expected = matchingConfirmationToken(resource.name);
  if (action.destructive === true && args.confirmation !== expected) {
    return {
      ok: false,
      token: expected,
      decision: {
        allowed: false,
        permission: ADMIN_DESTROY,
        reason: CONFIRMATION_REQUIRED_REASON,
        trace: [`confirmation: expected "${expected}"`],
      },
    };
  }
  // The list's own composition, the row scope first: an org-scoped operator's set is that org's.
  const { where } = listWhere(resource, ctx.actor, args.request);
  const actionCtx: AdminActionCtx = {
    requestId: ctx.requestId,
    actorId: ctx.actor.id,
    locale: ctx.actor.locale ?? 'en',
    timeZone: ctx.actor.timeZone ?? 'UTC',
  };
  const entry = {
    requestId: ctx.requestId,
    actor: ctx.actor,
    operation: action.name,
    kind: 'action',
    entity: resource.name,
    entityId: null,
    permission: args.decision.permission,
  } as const;
  let result: AdminMatchingResult;
  try {
    result = await action.matching({ where, input: args.input, ctx: actionCtx });
  } catch (error) {
    // The gate's rule: the failure is recorded before it travels, and nothing is read off it.
    await ctx.audit.append({
      ...entry,
      outcome: 'failed',
      reason: MATCHING_FAILED_REASON,
      diff: [],
    });
    throw error;
  }
  await ctx.audit.append({
    ...entry,
    outcome: 'allowed',
    reason: BATCH_MATCHING_REASON,
    diff: [
      { field: 'affected', before: null, after: result.affected },
      { field: 'remaining', before: null, after: result.remaining },
    ],
  });
  return { ok: true, result };
}
