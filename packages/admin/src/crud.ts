// The five CRUD operations, each one: policy → confirmation → validation → repo → audit.
// Views and MCP tools both call these, so there is one ordering of those five steps in the
// admin rather than one per surface.

import { type AuditEntry, type AuditLog, deniedDraft, diffRows } from './audit';
import { type AdminActor, type AdminAuthz, type AdminDecision, decideAll } from './authz';
import { type AdminPage, fetchPage, type PageRequest } from './pagination';
import {
  type AdminOperation,
  adminPermissionFor,
  CONFIRMATION_REQUIRED_REASON,
  confirmationToken,
  entityPermissionFor,
  isDestructive,
} from './permissions';
import type { AdminRow } from './registry';
import { type AdminResource, repoOf } from './resource';
import { type ValidationIssue, validateInput } from './validate';

export interface CrudCtx {
  readonly actor: AdminActor;
  readonly authz: AdminAuthz;
  readonly audit: AuditLog;
  readonly requestId: string;
}

export type CrudResult<Row extends AdminRow> =
  | { readonly ok: true; readonly row: Row | null; readonly audit: AuditEntry }
  | {
      readonly ok: false;
      readonly kind: 'denied';
      readonly decision: AdminDecision;
      readonly confirmationRequired: boolean;
      readonly audit: AuditEntry;
    }
  | {
      readonly ok: false;
      readonly kind: 'invalid';
      readonly issues: readonly ValidationIssue[];
      readonly audit: AuditEntry;
    };

export type ListResult<Row extends AdminRow> =
  | { readonly ok: true; readonly page: AdminPage<Row> }
  | { readonly ok: false; readonly kind: 'denied'; readonly decision: AdminDecision };

/** Both gates, always in this order: the admin-level one, then the entity-level one. */
export function permissionsForOperation(entity: string, op: AdminOperation): readonly string[] {
  return [adminPermissionFor(op), entityPermissionFor(entity, op)];
}

export function decideOperation(
  resource: AdminResource,
  op: AdminOperation,
  ctx: CrudCtx,
  id?: string,
): AdminDecision {
  return decideAll(ctx.authz, permissionsForOperation(resource.name, op), ctx.actor, {
    entity: resource.name,
    ...(id === undefined ? {} : { id }),
  });
}

/** `true` when the operation should be offered at all — nav, buttons, MCP tool list. */
export function canOperate(resource: AdminResource, op: AdminOperation, ctx: CrudCtx): boolean {
  return resource.operations.includes(op) && decideOperation(resource, op, ctx).allowed;
}

const redactedFields = (resource: AdminResource): readonly string[] =>
  resource.fields.filter((field) => field.sensitive).map((field) => field.name);

async function refuse<Row extends AdminRow>(
  resource: AdminResource<Row>,
  op: AdminOperation,
  ctx: CrudCtx,
  decision: AdminDecision,
  id: string | null,
  confirmationRequired = false,
): Promise<CrudResult<Row>> {
  return {
    ok: false,
    kind: 'denied',
    decision,
    confirmationRequired,
    audit: await ctx.audit.append(
      deniedDraft({
        requestId: ctx.requestId,
        actor: ctx.actor,
        operation: op,
        kind: 'operation',
        entity: resource.name,
        entityId: id,
        decision,
      }),
    ),
  };
}

export async function adminList<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  req: PageRequest = {},
): Promise<ListResult<Row>> {
  const decision = decideOperation(resource, 'list', ctx);
  if (!decision.allowed) return { ok: false, kind: 'denied', decision };
  return { ok: true, page: await fetchPage(resource, req) };
}

export async function adminDetail<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  id: string,
): Promise<CrudResult<Row>> {
  const decision = decideOperation(resource, 'detail', ctx, id);
  if (!decision.allowed) return refuse(resource, 'detail', ctx, decision, id);
  const row = await repoOf(resource).find(id);
  return {
    ok: true,
    row,
    audit: await ctx.audit.append({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: 'detail',
      kind: 'operation',
      entity: resource.name,
      entityId: id,
      permission: decision.permission,
      outcome: 'allowed',
      reason: decision.reason,
    }),
  };
}

export async function adminCreate<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  input: Readonly<Record<string, unknown>>,
): Promise<CrudResult<Row>> {
  const decision = decideOperation(resource, 'create', ctx);
  if (!decision.allowed) return refuse(resource, 'create', ctx, decision, null);

  const parsed = await validateInput(resource.entity.$schema, input);
  if (!parsed.ok) return invalid(resource, 'create', ctx, null, parsed.issues, decision);

  const row = await repoOf(resource).create(parsed.value);
  return {
    ok: true,
    row,
    audit: await ctx.audit.append({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: 'create',
      kind: 'operation',
      entity: resource.name,
      entityId: String(row[resource.idField] ?? ''),
      permission: decision.permission,
      outcome: 'allowed',
      reason: decision.reason,
      diff: diffRows(null, row, { redact: redactedFields(resource) }),
    }),
  };
}

export async function adminUpdate<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  id: string,
  patch: Readonly<Record<string, unknown>>,
): Promise<CrudResult<Row>> {
  const decision = decideOperation(resource, 'update', ctx, id);
  if (!decision.allowed) return refuse(resource, 'update', ctx, decision, id);

  const repo = repoOf(resource);
  const before = await repo.find(id);
  const parsed = await validateInput(resource.entity.$schema, { ...(before ?? {}), ...patch });
  if (!parsed.ok) return invalid(resource, 'update', ctx, id, parsed.issues, decision);

  const after = await repo.update(id, patch);
  return {
    ok: true,
    row: after,
    audit: await ctx.audit.append({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: 'update',
      kind: 'operation',
      entity: resource.name,
      entityId: id,
      permission: decision.permission,
      outcome: 'allowed',
      reason: decision.reason,
      diff: diffRows(before, after, { redact: redactedFields(resource) }),
    }),
  };
}

/** Destructive: the caller must echo `confirmationToken(entity, id)` or nothing happens. */
export async function adminDestroy<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  id: string,
  confirmation: string | undefined,
): Promise<CrudResult<Row>> {
  const decision = decideOperation(resource, 'delete', ctx, id);
  if (!decision.allowed) return refuse(resource, 'delete', ctx, decision, id);

  const expected = confirmationToken(resource.name, id);
  if (isDestructive('delete') && confirmation !== expected) {
    return refuse(
      resource,
      'delete',
      ctx,
      {
        allowed: false,
        permission: adminPermissionFor('delete'),
        reason: CONFIRMATION_REQUIRED_REASON,
        trace: [`confirmation: expected "${expected}"`],
      },
      id,
      true,
    );
  }

  const repo = repoOf(resource);
  const before = await repo.find(id);
  await repo.destroy(id);
  return {
    ok: true,
    row: null,
    audit: await ctx.audit.append({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: 'delete',
      kind: 'operation',
      entity: resource.name,
      entityId: id,
      permission: decision.permission,
      outcome: 'allowed',
      reason: decision.reason,
      diff: diffRows(before, null, { redact: redactedFields(resource) }),
    }),
  };
}

async function invalid<Row extends AdminRow>(
  resource: AdminResource<Row>,
  op: AdminOperation,
  ctx: CrudCtx,
  id: string | null,
  issues: readonly ValidationIssue[],
  decision: AdminDecision,
): Promise<CrudResult<Row>> {
  return {
    ok: false,
    kind: 'invalid',
    issues,
    audit: await ctx.audit.append({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: op,
      kind: 'operation',
      entity: resource.name,
      entityId: id,
      permission: decision.permission,
      outcome: 'failed',
      reason: 'admin.error.invalid-input',
      diff: [],
    }),
  };
}
