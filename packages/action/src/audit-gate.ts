/**
 * The only file in this package that calls an `AuditSink`, and the one place the "a sink may not
 * silently swallow" rule is spelled. Two failure policies, because an attempt that succeeded and
 * an attempt that already failed do not want the same answer.
 */

import { isUltimateError, logger } from '@ultimat3/core';
import type { AuditFailure, AuditOutcome, AuditRecord, AuditSink } from './audit';
import { getAuditSink } from './audit';
import { ActionDeniedError, AuditSinkFailedError, AuditSinkMissingError } from './errors';

/**
 * Resolved before the input parse, never after: an audited action that nothing can record must
 * refuse while it has still made no change. This is the only audit failure with no committed
 * write behind it, which is exactly why it is checked first.
 */
export function auditSinkFor(action: string): AuditSink {
  const sink = getAuditSink();
  if (sink === null) throw new AuditSinkMissingError(action);
  return sink;
}

/**
 * An authz refusal is `denied`; everything else that threw is `failed`, an unparsed input
 * included.
 *
 * TOTAL, the same rule core's `isThrownError` states: `instanceof` runs a `Proxy`'s
 * `getPrototypeOf` trap, and both callers ask this question inside a `catch` that is still
 * holding the app's own error — `execute`'s span attribute and the one place the `failed` record
 * is produced. A probe that threw there REPLACED the caller's throwable with its own `TypeError`,
 * so an app catching by `instanceof` upstream stopped matching. A value that refuses to be
 * examined is not evidence of a policy denial, so it fails closed to `failed`.
 */
export function auditOutcomeFor(error: unknown): AuditOutcome {
  try {
    return error instanceof ActionDeniedError ? 'denied' : 'failed';
  } catch {
    return 'failed';
  }
}

export function auditFailureFor(error: unknown): AuditFailure {
  return { code: isUltimateError(error) ? error.code : null, error };
}

/**
 * The record for an attempt that SUCCEEDED. A sink that refuses fails the invocation — the
 * deliberate opposite of `bustAfterCommit`, which absorbs its own failure because a stale cache
 * entry expires by TTL and the stack heals itself. Nothing heals a missing audit row: the only
 * process that held the facts has returned. So "if it isn't logged, it didn't happen" is enforced
 * on the caller rather than on a log line nobody reads.
 *
 * It is post-commit all the same, and the error says so instead of pretending the write was
 * rolled back. That is the honest half of the choice: what the caller gains is being TOLD.
 *
 * Whether a retry is SAFE is the record's own `idempotencyKey`, not the declaration's
 * `idempotent`. The key is non-null exactly when this invocation went through the idempotency
 * store, which is the one condition under which a retry replays instead of re-running a handler
 * that has already committed — and it is null both for a non-idempotent action and for an
 * idempotent one whose caller sent no header.
 */
export async function auditSettled(sink: AuditSink, record: AuditRecord): Promise<void> {
  try {
    await sink.write(record);
  } catch (error) {
    throw new AuditSinkFailedError(record.action, error, record.idempotencyKey !== null);
  }
}

/**
 * The record for an attempt that THREW. The sink's failure is reported and the original error is
 * the one the caller gets — replacing a denial with `X_AUDIT_SINK_FAILED` would hide the
 * `X_FORBIDDEN` from whoever has to act on it, and would answer a probing client differently
 * depending on whether the audit backend happened to be up, which is an oracle.
 *
 * Never a silent swallow: the log line is the same shape every other subsystem writes, so
 * `audit.sink.failed` is one alert rule over every action in the app.
 */
export async function auditThrew(sink: AuditSink, record: AuditRecord): Promise<void> {
  try {
    await sink.write(record);
  } catch (error) {
    // Core's logger, not `ctx.logger`: an HTTP `Ctx` is a cast request context that carries none,
    // the same reason `cache-gate.ts` gives. Never the record — rendering an input the sink just
    // choked on is the second throw this branch exists to prevent.
    logger.error('audit.sink.failed', {
      action: record.action,
      outcome: record.outcome,
      error,
    });
  }
}
