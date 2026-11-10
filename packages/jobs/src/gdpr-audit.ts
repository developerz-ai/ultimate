// The erase of a person is a sensitive mutation, so `subjectErase()` writes it to the `auditSink`
// port when one is installed: an `allowed` record per completed erase and a `failed` one per
// attempt that threw. The input is the subject's entity and the run id — never the key, which an
// app may make an email. At least once: `idempotencyKey` (`<job>:<runId>`) is what a sink dedupes on.

import type { AuditRecord, Ctx } from '@ultimat3/core';
import { AUDIT_SINK_FAILED_EVENT, auditFailureOf, getAuditSink, logger } from '@ultimat3/core';
import type { StepApi } from './steps-api';

export interface EraseAuditInput {
  /** The job's durable name: the record's `name`. */
  readonly job: string;
  /** The subject's ENTITY name — which kind of person, never which one. */
  readonly subject: string;
  /** The run: what an auditor joins to `x jobs show`, and the sink's dedupe key. */
  readonly runId: string;
  readonly ctx: Ctx;
}

/**
 * `AuditRecord.primitive` is `'action' | 'query'` in core; an erase is a write, so `'action'`,
 * and `surface: 'job'` says which projection ran it — the pair an `agentJob` write records too.
 */
const recordOf = (input: EraseAuditInput, error: unknown, failed: boolean): AuditRecord => ({
  at: input.ctx.now(),
  name: input.job,
  primitive: 'action',
  mutator: false,
  surface: 'job',
  ctx: input.ctx,
  input: { subject: input.subject, run: input.runId },
  idempotencyKey: `${input.job}:${input.runId}`,
  replayed: false,
  outcome: failed ? 'failed' : 'allowed',
  failure: failed ? auditFailureOf(error) : null,
});

/** Run `erase`, then record it: `allowed` once it completed, `failed` for an attempt that threw. */
export async function auditedErase<R>(
  input: EraseAuditInput,
  step: StepApi,
  erase: () => Promise<R>,
): Promise<R> {
  let report: R;
  try {
    report = await erase();
  } catch (error: unknown) {
    // The erase's own error wins; a sink that also refuses is logged, as action's gate logs it.
    const record = recordOf(input, error, true);
    await Promise.resolve()
      .then(() => getAuditSink()?.write(record))
      .catch((sinkError: unknown) => {
        logger.error(AUDIT_SINK_FAILED_EVENT, {
          action: record.name,
          outcome: record.outcome,
          error: sinkError,
        });
      });
    throw error;
  }
  const sink = getAuditSink();
  // Its own step, so a replay after it landed writes nothing; a write that landed and then lost its
  // checkpoint is written again under the same `idempotencyKey`. A sink that refuses on EVERY
  // attempt can hold no record at all — the dead-lettered run (`x jobs show`) is the trail, and the
  // refusal is logged here as action's audit gate logs it.
  if (sink !== null) {
    await step
      .run('audit', async () => sink.write(recordOf(input, null, false)))
      .catch((error: unknown) => {
        logger.error(AUDIT_SINK_FAILED_EVENT, { action: input.job, outcome: 'allowed', error });
        throw error;
      });
  }
  return report;
}
