// The five CRUD operations, each one: policy → confirmation → validation → repo → audit.
// Views and MCP tools both call these, so there is one ordering of those five steps in the
// admin rather than one per surface.

import type { AuditEntry, AuditLog } from './audit';
import { type AdminActor, type AdminAuthz, type AdminDecision, decideAll } from './authz';
import { onlyFor, rowDiff, splitSecrets, withoutTenant, withTenant } from './crud-input';
import { auditedWrite, deniedEntry, invalid, missingRow, refuse } from './crud-outcome';
import { type AdminListRequest, findRow, listWhere } from './list-scope';
import { type AdminPage, fetchPage } from './pagination';
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
import type { AdminScope } from './resource-list';
import { outOfScopeDecision, writeOutsideScope } from './row-scope-write';
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
    }
  /**
   * An update or a delete of a row that is not there — gone, never existed, or outside this
   * actor's row scope, which are one answer on purpose. Nothing was written; the attempt is on
   * the log as `failed`, like every other write that did not happen.
   */
  | { readonly ok: false; readonly kind: 'missing'; readonly audit: AuditEntry };

export type ListResult<Row extends AdminRow> =
  | {
      readonly ok: true;
      readonly page: AdminPage<Row>;
      /** The scope the page was read under — the request's, or the resource's default. */
      readonly scope: AdminScope | null;
      readonly audit: AuditEntry;
    }
  | {
      readonly ok: false;
      readonly kind: 'denied';
      readonly decision: AdminDecision;
      readonly audit: AuditEntry;
    };

/** Both gates, always in this order: the admin-level one, then the entity-level one. */
export function permissionsForOperation(entity: string, op: AdminOperation): readonly string[] {
  const gate = adminPermissionFor(op);
  const own = entityPermissionFor(entity, op);
  // The dashboard and the search are gated on the admin itself, where the two halves are one
  // permission: `admin:read + admin:read` was what `x routes` printed for both.
  return gate === own ? [gate] : [gate, own];
}

export function decideOperation(
  resource: AdminResource,
  op: AdminOperation,
  ctx: CrudCtx,
  id?: string,
  /**
   * The row the surface ALREADY loaded, or `null` for "looked and found none". `undefined` means
   * not loaded at all — a list page, a create form, a nav button — and is left off the subject
   * entirely, because "there is no row here" and "there is a row and nobody loaded it" are
   * different facts and only the second is a bug. Every admin decision used to be evaluated
   * without one, so an ownership rule could not fire and the coarse `admin:read` + `<entity>:read`
   * pair was the only gate on a single row.
   */
  row?: AdminRow | null,
): AdminDecision {
  // First, before any grant is consulted: an operation the resource does not OFFER is refused for
  // everyone. `canOperate` checked this for the nav, the buttons and the MCP tools, and the three
  // direct write functions did not — a `['list', 'detail']` resource deleted a row through
  // `adminDestroy`. Here, every caller of this function asks it.
  if (!operationOffered(resource, op)) {
    return {
      allowed: false,
      permission: adminPermissionFor(op),
      reason: OPERATION_NOT_OFFERED_REASON,
      trace: [`operations: ${resource.name} does not offer ${op}`],
    };
  }
  return decideAll(ctx.authz, permissionsForOperation(resource.permission, op), ctx.actor, {
    entity: resource.name,
    ...(id === undefined ? {} : { id }),
    ...(row === undefined ? {} : { row }),
  });
}

/** Whether the resource declares this operation at all — the one answer, `decideOperation`'s. */
export const operationOffered = (resource: AdminResource, op: AdminOperation): boolean =>
  resource.operations.includes(op);

/** The key an operation the resource does not offer is refused with. */
export const OPERATION_NOT_OFFERED_REASON = 'admin.error.operation-not-offered';

/** `true` when the operation should be offered at all — nav, buttons, MCP tool list. */
export function canOperate(resource: AdminResource, op: AdminOperation, ctx: CrudCtx): boolean {
  return decideOperation(resource, op, ctx).allowed;
}

/** The key a required sealed column is refused with when a create names no value for it. */
const SECRET_REQUIRED_REASON = 'admin.error.secret-required';

/**
 * The one read that logged nothing, in either direction: `audit.ts` says denied and failed attempts
 * are logged too, and `adminDetail` below logs the allowed read as well — so a listing that walked
 * every row of a table left no trace, and a refused listing left no trace of the refusal either.
 * There is no `entityId`: the subject is the table, not a row.
 */
export async function adminList<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  req: AdminListRequest = {},
): Promise<ListResult<Row>> {
  const decision = decideOperation(resource, 'list', ctx);
  if (!decision.allowed) {
    return {
      ok: false,
      kind: 'denied',
      decision,
      audit: await ctx.audit.append(deniedEntry(resource, 'list', ctx, decision, null)),
    };
  }
  // Composed AFTER the decision: an actor who may not list the table learns nothing about which
  // scopes it declares from the refusal they get.
  const { scope, where } = listWhere(resource, ctx.actor, req);
  const page = await fetchPage(resource, {
    ...(req.cursor === undefined ? {} : { cursor: req.cursor }),
    ...(req.limit === undefined ? {} : { limit: req.limit }),
    ...(req.sort === undefined ? {} : { sort: req.sort }),
    ...(where.length === 0 ? {} : { where }),
  });
  return {
    ok: true,
    page,
    scope: scope ?? null,
    audit: await ctx.audit.append({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: 'list',
      kind: 'operation',
      entity: resource.name,
      entityId: null,
      permission: decision.permission,
      outcome: 'allowed',
      reason: decision.reason,
    }),
  };
}

export async function adminDetail<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  id: string,
): Promise<CrudResult<Row>> {
  // The row is loaded BEFORE the guard, the shape `packages/action/src/invoke.ts` uses for a
  // row-level `policy`: a rule that decides about a row cannot decide without one, and the
  // predicate has to stay synchronous. A denial still returns no row. Through the row scope: a
  // row this actor's `rows` leaves out is not found, exactly as a row that does not exist.
  const row = await findRow(resource, ctx.actor, id);
  const decision = decideOperation(resource, 'detail', ctx, id, row);
  if (!decision.allowed) return refuse(resource, 'detail', ctx, decision, id);
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

  const { open, secrets } = splitSecrets(
    resource,
    withTenant(resource, ctx, onlyFor(resource, 'create', input)),
  );
  const parsed = await validateInput(resource.entity.$schema, open);
  const unset: readonly ValidationIssue[] = resource.secretFields
    .filter((field) => field.required && !Object.hasOwn(secrets, field.name))
    .map((field) => ({
      path: field.name,
      message: 'a value is required: this column is sealed and has no default',
      messageKey: SECRET_REQUIRED_REASON,
    }));
  if (!parsed.ok || unset.length > 0) {
    const issues = [...(parsed.ok ? [] : parsed.issues), ...unset];
    return invalid(resource, 'create', ctx, null, issues, decision);
  }
  // `rows` narrows a write's RESULT too: a row this actor could not then read is not theirs to
  // create. Judged over what the schema validated, before the repo is asked for anything.
  const outside = writeOutsideScope(resource, ctx.actor, parsed.value);
  if (outside !== null) {
    const permission = entityPermissionFor(resource.permission, 'create');
    return refuse(resource, 'create', ctx, outOfScopeDecision(permission, outside), null);
  }

  const { value: row, audit } = await auditedWrite(
    resource,
    'create',
    ctx,
    null,
    decision,
    () => repoOf(resource).create({ ...parsed.value, ...secrets }),
    (made) => ({
      entityId: String(made[resource.idField] ?? ''),
      diff: rowDiff(resource, null, made, secrets),
    }),
  );
  return { ok: true, row, audit };
}

export async function adminUpdate<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  id: string,
  patch: Readonly<Record<string, unknown>>,
): Promise<CrudResult<Row>> {
  // `before` was already loaded here, just after the guard rather than before it — so the rule
  // that decides whether this actor may touch THIS row never saw the row.
  const repo = repoOf(resource);
  const before = await findRow(resource, ctx.actor, id);
  const decision = decideOperation(resource, 'update', ctx, id, before);
  if (!decision.allowed) return refuse(resource, 'update', ctx, decision, id);
  if (before === null) return missingRow(resource, 'update', ctx, id, decision);

  // `{ ...before }` carries no sealed value — a row's sealed properties are non-enumerable — and
  // `$schema` has no member for one, so the merged object is exactly what the schema describes.
  const { open, secrets } = splitSecrets(
    resource,
    withoutTenant(resource, onlyFor(resource, 'update', patch)),
  );
  const parsed = await validateInput(resource.entity.$schema, { ...before, ...open });
  if (!parsed.ok) return invalid(resource, 'update', ctx, id, parsed.issues, decision);

  // Write what the schema validated, not the caller's raw patch — a field the schema would
  // strip (undeclared, or normalized to a different value) must never reach the repo. Scoped
  // to the keys actually submitted, so a partial update stays partial rather than rewriting
  // every field of `before` too.
  // `Object.hasOwn`, not `key in`: `in` walks the prototype chain, so a patch naming `toString`,
  // `constructor` or `__proto__` put an inherited member into the object handed to `repo.update`
  // — the exact thing the paragraph above says cannot happen. Over MCP the transport refuses
  // those keys (`additionalProperties: false`), but `callAdminTool` and `adminUpdate` are both
  // public API and `mcp.ts` keeps its own gate for a direct call and a future transport.
  const submittedKeys = Object.keys(open);
  // The same rule as a create: an update may not MOVE a row out of the actor's own scope.
  const outside = writeOutsideScope(resource, ctx.actor, parsed.value, submittedKeys);
  if (outside !== null) {
    const permission = entityPermissionFor(resource.permission, 'update');
    return refuse(resource, 'update', ctx, outOfScopeDecision(permission, outside), id);
  }
  const validatedPatch: Readonly<Record<string, unknown>> = {
    ...Object.fromEntries(
      submittedKeys
        .filter((key) => Object.hasOwn(parsed.value, key))
        .map((key) => [key, parsed.value[key]]),
    ),
    ...secrets,
  };
  const { value: after, audit } = await auditedWrite(
    resource,
    'update',
    ctx,
    id,
    decision,
    () => repo.update(id, validatedPatch),
    (changed) => ({ entityId: id, diff: rowDiff(resource, before, changed, secrets) }),
  );
  return { ok: true, row: after, audit };
}

/** Destructive: the caller must echo `confirmationToken(entity, id)` or nothing happens. */
export async function adminDestroy<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  id: string,
  confirmation: string | undefined,
): Promise<CrudResult<Row>> {
  const repo = repoOf(resource);
  const before = await findRow(resource, ctx.actor, id);
  const decision = decideOperation(resource, 'delete', ctx, id, before);
  if (!decision.allowed) return refuse(resource, 'delete', ctx, decision, id);
  if (before === null) return missingRow(resource, 'delete', ctx, id, decision);

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

  const { audit } = await auditedWrite(
    resource,
    'delete',
    ctx,
    id,
    decision,
    () => repo.destroy(id),
    () => ({ entityId: id, diff: rowDiff(resource, before, null) }),
  );
  return { ok: true, row: null, audit };
}
