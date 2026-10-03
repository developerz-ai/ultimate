// A batch: one action over many rows of one resource. Each row goes through the SAME gate as the
// button — policy, the action's `when`, its handler — and is audited on its own, and the answer
// counts what happened honestly: done, refused, failed, queued, and how many rows remain.

import { finiteCount } from '@ultimat3/core';
import { expectedQueryLoop } from '@ultimat3/db';
import { decideAction } from './action-gate';
import { invokeRowAction } from './action-row';
import type { AdminDecision } from './authz';
import { runMatching } from './batch-matching';
import { queueBatch } from './batch-queue';
import { type CrudCtx, decideOperation } from './crud';
import { type AdminListRequest, listWhere } from './list-scope';
import {
  ADMIN_DESTROY,
  ADMIN_WRITE,
  CONFIRMATION_REQUIRED_REASON,
  confirmationToken,
} from './permissions';
import type { AdminAction, AdminFilter } from './registry';
import { rowId } from './registry';
import { type AdminResource, repoOf } from './resource';
import { type ValidationIssue, validateInput } from './validate';

/**
 * The most rows one request runs INLINE for an action that declares no threshold. The list's own
 * page-size ceiling, so every checked row of one page always fits.
 */
export const MAX_BATCH_ROWS = 200;

/**
 * The most rows one request hands to the QUEUE, for an action that declares a threshold. The
 * number `@ultimat3/jobs` bounds its own bulk operations by (`MAX_BULK_ROWS`), restated because
 * that constant bounds a different statement.
 */
export const MAX_BATCH_QUEUED_ROWS = 1_000;

/** The reason an action that is not a batch action is refused the batch bar with. */
export const BATCH_NOT_OFFERED_REASON = 'admin.error.batch-not-offered';

export type BatchSelection =
  /** The rows an operator checked. */
  | { readonly kind: 'ids'; readonly ids: readonly string[] }
  /**
   * Every row the list's own scope and filters match — "all matching", not "all on this page".
   * `after` is where the previous request stopped: a batch whose rows stay in the filter must
   * still make progress, so the position is a row id and never "the first N again".
   */
  | {
      readonly kind: 'all';
      readonly request: Pick<AdminListRequest, 'scope' | 'filters'>;
      readonly after?: string;
    };

export type BatchRowOutcome = 'done' | 'refused' | 'failed';

export interface BatchRow {
  readonly id: string;
  readonly outcome: BatchRowOutcome;
  /** An i18n key: the gate's reason for a refusal, the failure's for a throw. */
  readonly reason: string;
}

export interface AdminBatchResult {
  readonly ok: true;
  /** Rows whose handler ran to the end. */
  readonly done: number;
  /** Rows the gate refused: the policy said no, or the action's `when` excludes the row. */
  readonly refused: number;
  /** Rows whose handler threw. */
  readonly failed: number;
  /** Rows handed to the queue instead of run here. Each is counted and audited when its job runs. */
  readonly queued: number;
  /** The jobs those rows were queued as, one per chunk. Empty for an inline batch. */
  readonly jobs: readonly string[];
  /** Rows the selection matched that this request did not reach. Run again from `after`. */
  readonly remaining: number;
  /** The row to continue after, when `remaining` is not 0. */
  readonly after: string | null;
  /** One line per row that was NOT done — what an operator acts on. */
  readonly rows: readonly BatchRow[];
}

export type AdminBatchAnswer =
  | AdminBatchResult
  | { readonly ok: false; readonly kind: 'denied'; readonly decision: AdminDecision }
  /** A destructive batch not yet confirmed: the token to type, and how many rows it covers. */
  | {
      readonly ok: false;
      readonly kind: 'confirm';
      readonly decision: AdminDecision;
      readonly token: string;
      /** `null` for a set-based "all matching" (`matching`): how many is the store's to answer. */
      readonly count: number | null;
    }
  | { readonly ok: false; readonly kind: 'invalid'; readonly issues: readonly ValidationIssue[] };

/** What a batch enqueues one chunk with. `batch-job.ts` implements it; a test passes its own. */
export type BatchEnqueue = (chunk: {
  readonly resource: AdminResource;
  readonly action: AdminAction;
  readonly ids: readonly string[];
  readonly input: Readonly<Record<string, unknown>>;
  readonly ctx: CrudCtx;
  readonly batchId: string;
  readonly index: number;
}) => Promise<string>;

export interface AdminBatchInput {
  readonly resource: AdminResource;
  readonly action: AdminAction;
  readonly ctx: CrudCtx;
  readonly selection: BatchSelection;
  /** The action's own input, already decoded. One input for every row. */
  readonly input?: Readonly<Record<string, unknown>>;
  /** Echo of `batchConfirmationToken(entity, count)` — required for a destructive action. */
  readonly confirmation?: string | undefined;
  /** Required by an action that declares a threshold; `batchEnqueue` is the shipped one. */
  readonly enqueue?: BatchEnqueue;
}

/** The declared threshold and chunk of a batch action, or `null` for one that always runs inline. */
export function batchPlan(
  action: Pick<AdminAction, 'name' | 'batch'>,
): { readonly threshold: number; readonly chunk: number } | null {
  if (action.batch === undefined || action.batch === true) return null;
  const subject = `the admin action "${action.name}"`;
  // At least 1 and finite: `n > NaN` is false for every n, so an unreadable threshold would run
  // every batch inline, whatever its size — the opposite of what declaring one is for.
  const threshold = finiteCount(subject, 'batch.threshold', action.batch.threshold, 1);
  return {
    threshold,
    chunk: finiteCount(subject, 'batch.chunk', action.batch.chunk ?? threshold, 1),
  };
}

/** The token a destructive batch makes the operator type: the entity and how many rows. */
export const batchConfirmationToken = (entity: string, count: number): string =>
  confirmationToken(entity, `${String(count)} rows`);

interface Selected {
  readonly ids: readonly string[];
  readonly remaining: number;
}

/** The rows one request takes, and how many of the selection are left behind it. */
async function select(
  resource: AdminResource,
  ctx: CrudCtx,
  selection: BatchSelection,
  limit: number,
): Promise<Selected> {
  if (selection.kind === 'ids') {
    const ids = [...new Set(selection.ids.filter((id) => id !== ''))];
    return { ids: ids.slice(0, limit), remaining: Math.max(0, ids.length - limit) };
  }
  const repo = repoOf(resource);
  // Row scope, then scope, then filters — the list's own `where`, so "all matching" is exactly
  // the rows the operator was looking at and never one their `rows` leaves out.
  const where = listWhere(resource, ctx.actor, selection.request).where;
  // By id, ascending: a position that survives rows leaving the filter as the batch changes them.
  const sort = { field: resource.idField, direction: 'asc' } as const;
  const after = selection.after;
  const rows = await repo.list({
    ...(where.length === 0 ? {} : { where }),
    sort,
    limit,
    ...(after === undefined ? {} : { after: { field: resource.idField, value: after, id: after } }),
  });
  const ids = rows.map((row) => rowId(row, resource.idField));
  const last = ids[ids.length - 1];
  if (ids.length < limit || last === undefined) return { ids, remaining: 0 };
  const beyond: readonly AdminFilter[] = [
    ...where,
    { field: resource.idField, op: 'gt', value: last },
  ];
  // Exact when the repo can count; otherwise one probe row says "there is more" and no number.
  const remaining =
    repo.count === undefined
      ? (await repo.list({ where: beyond, sort, limit: 1 })).length
      : await repo.count(beyond);
  return { ids, remaining };
}

/**
 * Run `action` over a selection of `resource`'s rows.
 *
 * Decided once for the batch — the action is a batch action, the actor may run it at all, the
 * confirmation matches, the input passes the action's schema — and then once PER ROW by
 * `invokeRowAction`, which is the button's own gate: a row the policy refuses or the action's
 * `when` excludes is counted `refused` and audited as a denial, a handler that throws is counted
 * `failed` and audited as one, and neither stops the rows after it.
 */
export async function runAdminBatch(input: AdminBatchInput): Promise<AdminBatchAnswer> {
  const { resource, action, ctx } = input;
  const subject = { entity: resource.name };
  const denied = (decision: AdminDecision): AdminBatchAnswer => ({
    ok: false,
    kind: 'denied',
    decision,
  });
  if (action.batch === undefined) {
    return denied({
      allowed: false,
      permission: action.destructive === true ? ADMIN_DESTROY : ADMIN_WRITE,
      reason: BATCH_NOT_OFFERED_REASON,
      trace: [`batch: ${action.name} does not declare batch`],
    });
  }
  const decision = decideAction(action, ctx.actor, ctx.authz, subject);
  if (!decision.allowed) return denied(decision);
  // "All matching" reads the list: an actor who may not list the table may not select from it.
  if (input.selection.kind === 'all') {
    const listing = decideOperation(resource, 'list', ctx);
    if (!listing.allowed) return denied(listing);
  }

  if (input.selection.kind === 'all' && action.matching !== undefined) {
    return matchingBatch(input, { ...action, matching: action.matching }, decision);
  }

  const plan = batchPlan(action);
  const selected = await select(
    resource,
    ctx,
    input.selection,
    plan === null ? MAX_BATCH_ROWS : MAX_BATCH_QUEUED_ROWS,
  );

  // Named `expected`, never `token`: it is a typed-to-confirm echo the page prints, not a secret.
  const expected = batchConfirmationToken(resource.name, selected.ids.length);
  if (action.destructive === true && input.confirmation !== expected) {
    return {
      ok: false,
      kind: 'confirm',
      token: expected,
      count: selected.ids.length,
      decision: {
        allowed: false,
        permission: ADMIN_DESTROY,
        reason: CONFIRMATION_REQUIRED_REASON,
        trace: [`confirmation: expected "${expected}"`],
      },
    };
  }

  // Once, before any row: an input the schema refuses is one answer, not one failure per row.
  let own = input.input ?? {};
  if (action.input !== undefined) {
    const parsed = await validateInput(action.input, own);
    if (!parsed.ok) return { ok: false, kind: 'invalid', issues: parsed.issues };
    own = parsed.value;
  }

  const last = selected.ids[selected.ids.length - 1] ?? null;
  const position = {
    remaining: selected.remaining,
    after: selected.remaining === 0 ? null : last,
  };

  if (plan !== null && selected.ids.length > plan.threshold && input.enqueue !== undefined) {
    const jobs = await queueBatch(
      { ...input, enqueue: input.enqueue },
      decision,
      plan.chunk,
      selected.ids,
      own,
    );
    return {
      ok: true,
      done: 0,
      refused: 0,
      failed: 0,
      queued: selected.ids.length,
      jobs,
      rows: [],
      ...position,
    };
  }

  const rows = await runBatchRows({ resource, action, ctx, ids: selected.ids, input: own });
  const count = (outcome: BatchRowOutcome): number =>
    rows.filter((row) => row.outcome === outcome).length;
  return {
    ok: true,
    done: count('done'),
    refused: count('refused'),
    failed: count('failed'),
    queued: 0,
    jobs: [],
    rows: rows.filter((row) => row.outcome !== 'done'),
    ...position,
  };
}

/** "All matching" through the action's own set-based verb: `batch-matching.ts`. */
async function matchingBatch(
  input: AdminBatchInput,
  action: AdminAction & Required<Pick<AdminAction, 'matching'>>,
  decision: AdminDecision,
): Promise<AdminBatchAnswer> {
  if (input.selection.kind !== 'all') return { ok: false, kind: 'denied', decision };
  let own = input.input ?? {};
  if (action.input !== undefined) {
    const parsed = await validateInput(action.input, own);
    if (!parsed.ok) return { ok: false, kind: 'invalid', issues: parsed.issues };
    own = parsed.value;
  }
  const answer = await runMatching({
    resource: input.resource,
    action,
    ctx: input.ctx,
    request: input.selection.request,
    input: own,
    confirmation: input.confirmation,
    decision,
  });
  if (!answer.ok) {
    return {
      ok: false,
      kind: 'confirm',
      token: answer.token,
      count: null,
      decision: answer.decision,
    };
  }
  return {
    ok: true,
    done: answer.result.affected,
    refused: 0,
    failed: 0,
    queued: 0,
    jobs: [],
    remaining: answer.result.remaining,
    // A set has no row to continue after: running it again IS the continuation.
    after: null,
    rows: [],
  };
}

/** The reason on a row whose handler threw — the gate's own, restated so a result names it. */
const ROW_FAILED_REASON = 'admin.error.action-failed';

export interface BatchRowsInput {
  readonly resource: AdminResource;
  readonly action: AdminAction;
  readonly ctx: CrudCtx;
  readonly ids: readonly string[];
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * One row through the gate. The batch already confirmed the whole selection, so each row is
 * handed its own token — the gate still compares it, and still refuses a row it does not match.
 */
export async function runBatchRow(input: BatchRowsInput, id: string): Promise<BatchRow> {
  const { resource, action, ctx } = input;
  try {
    const result = await invokeRowAction({
      resource,
      action,
      id,
      ctx,
      input: input.input,
      confirmation: confirmationToken(resource.name, id),
    });
    if (result.ok) return { id, outcome: 'done', reason: result.audit.reason };
    return {
      id,
      outcome: result.kind === 'invalid' ? 'failed' : 'refused',
      reason: result.kind === 'invalid' ? result.audit.reason : result.decision.reason,
    };
  } catch {
    // The gate already wrote the `failed` entry and re-threw. Nothing is read off the thrown
    // value: a batch reports a count and a key, and the next row is still owed its turn.
    return { id, outcome: 'failed', reason: ROW_FAILED_REASON };
  }
}

/**
 * Rows in order, one at a time: a handler is the app's, and nothing says it is safe to race.
 *
 * One row read and one handler per row, ON PURPOSE, and declared so: each row is decided on the
 * row as it is now — the policy and the action's `when` both read it — and a batched read before
 * the loop would decide row 40 on a state rows 1–39 may already have changed.
 */
export function runBatchRows(input: BatchRowsInput): Promise<readonly BatchRow[]> {
  return expectedQueryLoop(
    'an admin batch decides and runs each row on that row as it is now, one row at a time',
    async () => {
      const out: BatchRow[] = [];
      for (const id of input.ids) out.push(await runBatchRow(input, id));
      return out;
    },
  );
}
