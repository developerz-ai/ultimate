// The queued half of a batch past its declared threshold: every chunk enqueued and the one entry
// naming them, as ONE audited unit, under a batch id DERIVED from the request's content — so a
// retry after a failed enqueue asks the queue for the chunks it already holds.

import { keyedFingerprint } from '@ultimat3/core';
import type { AdminDecision } from './authz';
import type { AdminBatchInput, BatchEnqueue } from './batch';
import { atomicallyAudited } from './crud-outcome';

/** The reason a queued batch's one entry carries. */
export const BATCH_QUEUED_REASON = 'admin.batch.queued';

/** The reason it carries when its chunks could not all be queued — the gate's own key. */
const BATCH_QUEUE_FAILED_REASON = 'admin.error.action-failed';

/**
 * A queued batch's id, DERIVED from what was asked — who, which action on which resource, these
 * rows, this input — never drawn at random. The chunk job's idempotency key is
 * `admin.batch:<batchId>:<index>`, so an operator retrying a request whose third enqueue failed
 * asks for chunks 0–2 under the keys they already hold, and the queue answers the jobs it has
 * instead of running those rows twice. The request id is deliberately NOT part of it: a retry is
 * a new request. Keyed (`keyedFingerprint`), because it is persisted in the queue beside the rows
 * it was derived from.
 */
export const batchIdOf = (
  input: Pick<AdminBatchInput, 'resource' | 'action' | 'ctx'>,
  ids: readonly string[],
  own: Readonly<Record<string, unknown>>,
): string =>
  keyedFingerprint(
    {
      entity: input.resource.name,
      action: input.action.name,
      actor: input.ctx.actor.id,
      org: input.ctx.actor.orgId ?? null,
      ids,
      input: own,
    },
    'admin.batch',
  );

/**
 * Enqueue `ids` in chunks of `chunk`, answering the job ids. The chunks and the entry ride one
 * `audit.atomic`: an enqueue joins the caller's transaction, so chunk 3 failing takes chunks 0–2
 * back out with it. Where nothing can roll back (the memory log), the derived `batchId` is what
 * makes the retry safe — a chunk already queued is the queue's duplicate, not a second run.
 */
export async function queueBatch(
  input: AdminBatchInput & { readonly enqueue: BatchEnqueue },
  decision: AdminDecision,
  chunk: number,
  ids: readonly string[],
  own: Readonly<Record<string, unknown>>,
): Promise<readonly string[]> {
  const { resource, action, ctx, enqueue } = input;
  const batchId = batchIdOf(input, ids, own);
  const { value } = await atomicallyAudited(
    ctx.audit,
    {
      requestId: ctx.requestId,
      actor: ctx.actor,
      operation: action.name,
      kind: 'action',
      entity: resource.name,
      permission: decision.permission,
    },
    { allowed: BATCH_QUEUED_REASON, failed: BATCH_QUEUE_FAILED_REASON },
    null,
    async () => {
      const queued: string[] = [];
      for (let at = 0; at < ids.length; at += chunk) {
        const slice = ids.slice(at, at + chunk);
        const index = at / chunk;
        queued.push(
          await enqueue({ resource, action, ids: slice, input: own, ctx, batchId, index }),
        );
      }
      return queued;
    },
    // Which job runs handle the chunks: each row's own entry is written when its job reaches it.
    (queued) => ({
      entityId: null,
      diff: [
        { field: 'rows', before: null, after: ids.length },
        { field: 'jobs', before: null, after: queued },
      ],
    }),
  );
  return value;
}
