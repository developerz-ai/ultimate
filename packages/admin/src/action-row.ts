// One action on ONE row of a resource: the row is loaded through the row scope, and the gate
// decides on it. The detail page's button, each row of a batch and the MCP tool all call this, so
// "which row did the rule see" has one answer and a row outside `rows(actor)` is no row at all.

import { type InvokeResult, invokeAdminAction } from './action-gate';
import type { CrudCtx } from './crud';
import { findRow } from './list-scope';
import type { AdminAction } from './registry';
import type { AdminResource } from './resource';

export interface RowActionInput {
  readonly resource: AdminResource;
  readonly action: AdminAction;
  readonly id: string;
  readonly ctx: CrudCtx;
  /** The action's own input, already decoded. The row's `id` is added here. */
  readonly input?: Readonly<Record<string, unknown>>;
  readonly confirmation?: string | undefined;
}

export async function invokeRowAction(args: RowActionInput): Promise<InvokeResult<unknown>> {
  const { resource, action, id, ctx } = args;
  // Loaded before the guard, the shape `adminDetail` uses: a rule that decides about a row cannot
  // decide without one — and neither can the action's own `when`.
  const row = await findRow(resource, ctx.actor, id);
  return invokeAdminAction({
    action,
    input: { ...(args.input ?? {}), id },
    actor: ctx.actor,
    authz: ctx.authz,
    audit: ctx.audit,
    requestId: ctx.requestId,
    subject: { entity: resource.name, id, row },
    sealed: resource.secretFields.map((field) => field.name),
    ...(args.confirmation === undefined ? {} : { confirmation: args.confirmation }),
  });
}
