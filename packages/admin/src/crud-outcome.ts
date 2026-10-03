// The audit half of a CRUD call that did NOT write: a refusal, an input the schema rejected, a
// row that was not there, a repo that threw. Each leaves its entry and answers the result the
// caller renders — so `crud.ts` reads as the five steps of each operation and nothing else.

import {
  type AuditDraft,
  type AuditEntry,
  type AuditFieldDiff,
  type AuditLog,
  deniedDraft,
} from './audit';
import type { AdminDecision } from './authz';
import type { CrudCtx, CrudResult } from './crud';
import type { AdminOperation } from './permissions';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';
import { ROW_CHANGED_REASON } from './row-version';
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

/** What every entry of one audited write shares: who, what, on which table, under which grant. */
export type AuditedEntry = Pick<
  AuditDraft,
  'requestId' | 'actor' | 'operation' | 'kind' | 'entity' | 'permission'
>;

/**
 * Run a WRITE and append its entry as one unit where the log can make it one, and leave a `failed`
 * entry behind if either throws — the one shape for a CRUD write, an action's handler, a set-based
 * batch and a queued one.
 *
 * A mutation cannot append BEFORE the call the way a read does — that would record a write which
 * may never have happened. So the write and its entry go inside `audit.atomic`: a durable log
 * opens a transaction, so a row never changes without the entry naming who changed it, and an
 * entry never describes a write that rolled back. A sink that throws on the `allowed` entry rolls
 * the write back with it; the log then says `failed`, and so does the caller's error — it used to
 * say `failed` for an action that had committed, and an operator re-ran it.
 *
 * The `failed` entry is written OUTSIDE, after the rollback — inside, it would be rolled back with
 * the write it reports. Nothing about the thrown value is read or rendered (a `catch` binding holds
 * whatever an app threw, and `String()` of a prototype-less object throws from inside the block
 * that owes the auditor its entry); the caller gets it UNCHANGED, and an audit reason is a key.
 */
export async function atomicallyAudited<T>(
  audit: AuditLog,
  entry: AuditedEntry,
  reasons: { readonly allowed: string; readonly failed: string },
  /** The id of the row the write addresses, for the `failed` entry: `null` for a set or a create. */
  entityId: string | null,
  write: () => Promise<T>,
  /** The diff of what the write did, and the id of the row it left — known only afterwards. */
  written: (value: T) => {
    readonly entityId: string | null;
    readonly diff: readonly AuditFieldDiff[];
  },
): Promise<{ readonly value: T; readonly audit: AuditEntry }> {
  try {
    return await audit.atomic(async () => {
      const value = await write();
      const appended = await audit.append({
        ...entry,
        ...written(value),
        outcome: 'allowed',
        reason: reasons.allowed,
      });
      return { value, audit: appended };
    });
  } catch (error) {
    await audit.append({ ...entry, entityId, outcome: 'failed', reason: reasons.failed, diff: [] });
    throw error;
  }
}

/** A repo WRITE of one CRUD operation, through `atomicallyAudited`. */
export function auditedWrite<T>(
  // Only the NAME is read, so this stays invariance-free: `AdminResource<Row>` at four call
  // sites would need the generic threaded through for nothing.
  resource: { readonly name: string },
  op: AdminOperation,
  ctx: CrudCtx,
  entityId: string | null,
  decision: AdminDecision,
  write: () => Promise<T>,
  written: (value: T) => {
    readonly entityId: string | null;
    readonly diff: readonly AuditFieldDiff[];
  },
): Promise<{ readonly value: T; readonly audit: AuditEntry }> {
  return atomicallyAudited(
    ctx.audit,
    {
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: op,
      kind: 'operation',
      entity: resource.name,
      permission: decision.permission,
    },
    { allowed: decision.reason, failed: WRITE_FAILED_REASON },
    entityId,
    write,
    written,
  );
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

/** An update against a version the row no longer has — `crud.ts`'s optimistic check. */
export async function staleRow<Row extends AdminRow>(
  resource: AdminResource<Row>,
  ctx: CrudCtx,
  id: string,
  decision: AdminDecision,
  row: Row,
  version: string,
): Promise<CrudResult<Row>> {
  return {
    ok: false,
    kind: 'stale',
    row,
    version,
    audit: await ctx.audit.append({
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: 'update',
      kind: 'operation',
      entity: resource.name,
      entityId: id,
      permission: decision.permission,
      outcome: 'failed',
      reason: ROW_CHANGED_REASON,
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
