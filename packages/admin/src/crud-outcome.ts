// The audit half of a CRUD call that did NOT write: a refusal, an input the schema rejected, a
// row that was not there, a repo that threw. Each leaves its entry and answers the result the
// caller renders — so `crud.ts` reads as the five steps of each operation and nothing else.

import { type AuditEntry, type AuditFieldDiff, deniedDraft } from './audit';
import type { AdminDecision } from './authz';
import type { CrudCtx, CrudResult } from './crud';
import type { AdminOperation } from './permissions';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';
import type { ValidationIssue } from './validate';

export const deniedEntry = (
  resource: { readonly name: string },
  op: AdminOperation,
  ctx: CrudCtx,
  decision: AdminDecision,
  id: string | null,
) =>
  deniedDraft({
    requestId: ctx.requestId,
    actor: ctx.actor,
    operation: op,
    kind: 'operation',
    entity: resource.name,
    entityId: id,
    decision,
  });

export async function refuse<Row extends AdminRow>(
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
    audit: await ctx.audit.append(deniedEntry(resource, op, ctx, decision, id)),
  };
}

/** The reason on a `failed` entry. A key, never the database's message. */
const WRITE_FAILED_REASON = 'admin.audit.write-failed';

/**
 * Run a repo WRITE and append its entry — as one unit where the log can make it one — and leave a
 * `failed` entry behind if either throws.
 *
 * `AuditOutcome` has declared a `failed` member all along and this file emitted it in exactly one
 * place — `invalid()`, for a VALIDATION issue. A constraint violation, a statement that timed out
 * after committing, a connection dropped mid-write: each left no entry at all, which is the case
 * an auditor opens the log for. Both siblings already do this and each states the rule
 * (`search.ts`, `action-gate.ts`).
 *
 * A mutation cannot append BEFORE the call the way a read does — that would record a write which
 * may never have happened. So the write and its entry go inside `audit.atomic`: a durable log
 * opens a transaction, so a row never changes without the entry naming who changed it, and an
 * entry never describes a write that rolled back. The `failed` entry is written OUTSIDE it, after
 * the rollback — inside, it would be rolled back with the write it reports. Nothing about the
 * thrown value is read or rendered; the caller owns it, and an audit reason is a key.
 */
export async function auditedWrite<T>(
  // Only the NAME is read, so this stays invariance-free: `AdminResource<Row>` at four call
  // sites would need the generic threaded through for nothing.
  resource: { readonly name: string },
  op: AdminOperation,
  ctx: CrudCtx,
  entityId: string | null,
  decision: AdminDecision,
  write: () => Promise<T>,
  /** The diff of what the write did, and the id of the row it left — known only afterwards. */
  written: (value: T) => {
    readonly entityId: string | null;
    readonly diff: readonly AuditFieldDiff[];
  },
): Promise<{ readonly value: T; readonly audit: AuditEntry }> {
  const entry = {
    requestId: ctx.requestId,
    actor: ctx.actor,
    operation: op,
    kind: 'operation',
    entity: resource.name,
    permission: decision.permission,
  } as const;
  try {
    return await ctx.audit.atomic(async () => {
      const value = await write();
      const audit = await ctx.audit.append({
        ...entry,
        ...written(value),
        outcome: 'allowed',
        reason: decision.reason,
      });
      return { value, audit };
    });
  } catch (error) {
    await ctx.audit.append({
      ...entry,
      entityId,
      outcome: 'failed',
      reason: WRITE_FAILED_REASON,
      diff: [],
    });
    throw error;
  }
}

/** The key a write to a row that is not there is logged with. */
const ROW_MISSING_REASON = 'admin.error.row-missing';

export async function missingRow<Row extends AdminRow>(
  resource: AdminResource<Row>,
  op: AdminOperation,
  ctx: CrudCtx,
  id: string,
  decision: AdminDecision,
): Promise<CrudResult<Row>> {
  return {
    ok: false,
    kind: 'missing',
    audit: await ctx.audit.append({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: op,
      kind: 'operation',
      entity: resource.name,
      entityId: id,
      permission: decision.permission,
      outcome: 'failed',
      reason: ROW_MISSING_REASON,
      diff: [],
    }),
  };
}

export async function invalid<Row extends AdminRow>(
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
