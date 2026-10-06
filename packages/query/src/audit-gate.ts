/**
 * The only file in this package that calls an `AuditSink`: `query({ audit: true })` records every
 * call — allowed, denied, failed — into the one sink `@ultimat3/core` holds, in the record shape
 * `@ultimat3/action` writes. It observes the read path; it never forks it.
 */

import type { AuditOutcome, AuditRecord, AuditSink, Ctx } from '@ultimat3/core';
import { getAuditSink, isUltimateError, logger, normalizeAuditRecord } from '@ultimat3/core';
import { QueryAuditSinkFailedError, QueryAuditSinkMissingError } from './audit-errors';
import { QueryDeniedError } from './errors';
import type { QuerySurface } from './policy-gate';
import type { SqlSource } from './source';

/**
 * What the read path learns on the way through, for the record — the same two facts `invoke`'s
 * trace carries for an action, minus the idempotency key a read never has. Mutable on purpose:
 * `buildSource` fills `input`, the memo fills `replayed`, and reading them back out here is what
 * keeps the audited branch from becoming a second read path.
 */
export interface ReadTrace {
  input: unknown;
  replayed: boolean;
}

/** One audited call, resolved before anything is read: the sink, and what every record shares. */
export interface ReadAudit {
  readonly sink: AuditSink;
  readonly name: string;
  readonly ctx: Ctx;
  readonly surface: QuerySurface;
  readonly trace: ReadTrace;
}

/**
 * `null` when the read is not audited — not declared, or built `unenforced`, which has no caller
 * to attribute a sighting to (`explain`, the shared live window). Otherwise the sink, or
 * `X_QUERY_AUDIT_SINK_MISSING` BEFORE the input parse: an audited read nothing can record refuses
 * while it has still read nothing.
 */
export function readAuditFor(
  audit: boolean | undefined,
  unenforced: string | undefined,
  name: string,
  ctx: Ctx,
  surface: QuerySurface,
): ReadAudit | null {
  if (audit !== true || unenforced !== undefined) return null;
  const sink = getAuditSink();
  if (sink === null) throw new QueryAuditSinkMissingError(name);
  return { sink, name, ctx, surface, trace: { input: undefined, replayed: false } };
}

/**
 * One call, one record. A memo or cache hit is recorded like a miss — with `replayed: true` — and
 * that is the point of the option rather than an accident of where it sits: an audit of a read is
 * about WHO SAW WHAT, and a reader handed rows from the request memo saw them exactly as much as
 * the reader whose call executed the SQL. Recording only executions would answer "what did the
 * database compute", which no auditor asks.
 *
 * The failure policies are `@ultimat3/action`'s: a refused record of a denied or failed read is
 * logged and the original error still reaches the caller (replacing an `X_FORBIDDEN` would turn
 * the audit backend's health into an oracle); a refused record of an ALLOWED read withholds the
 * rows (`X_QUERY_AUDIT_SINK_FAILED`) — a read commits nothing, so refusing costs one retry.
 */
export async function audited<T>(audit: ReadAudit, run: () => Promise<T>): Promise<T> {
  // When the attempt began, from the context's clock — never `new Date()`.
  const at = audit.ctx.now();
  let value: T;
  try {
    value = await run();
  } catch (error) {
    await recordThrew(audit.sink, recordOf(audit, at, readOutcomeFor(error), error));
    throw error;
  }
  // Outside the `catch` on purpose, as in `invoke`: a refused record here describes the RECORD,
  // and letting it fall into that branch would write a second record claiming the read failed.
  await recordSettled(audit.sink, recordOf(audit, at, 'allowed', undefined));
  return value;
}

/**
 * The public `sourceFor`'s half: a build that refuses (denied, unparsed, rate-limited) is a call
 * that ended, recorded now because no `execute()` will follow; a build that succeeds records
 * nothing yet and hands back a source whose every execution is recorded.
 */
export async function auditedBuild<TRow>(
  audit: ReadAudit,
  build: () => Promise<SqlSource<TRow>>,
): Promise<SqlSource<TRow>> {
  const at = audit.ctx.now();
  let source: SqlSource<TRow>;
  try {
    source = await build();
  } catch (error) {
    await recordThrew(audit.sink, recordOf(audit, at, readOutcomeFor(error), error));
    throw error;
  }
  return auditedSource(source, audit);
}

/**
 * A source handed OUT of this package (`sourceFor`) for an audited read: every `execute()` is one
 * call and one record — `@ultimat3/mcp`'s served tool builds through `sourceFor` and executes once,
 * so its reads are recorded under `surface: 'mcp'` without a second path. `seek()` and `total()`
 * answer audited sources too, since `paginate` and a live build execute what those return.
 */
export function auditedSource<TRow>(source: SqlSource<TRow>, audit: ReadAudit): SqlSource<TRow> {
  // Each execution is its own call: a fresh trace, so one call's facts never leak into the next.
  const call = (): ReadAudit => ({ ...audit, trace: { ...audit.trace, replayed: false } });
  const { total, seek } = source;
  return {
    toSQL: () => source.toSQL(),
    shape: () => source.shape(),
    execute: () => audited(call(), () => source.execute()),
    ...(total === undefined ? {} : { total: () => auditedSource(total.call(source), audit) }),
    ...(seek === undefined
      ? {}
      : { seek: (after, limit) => auditedSource(seek.call(source, after, limit), audit) }),
  };
}

/**
 * An authz refusal is `denied`; everything else that threw is `failed`, an unparsed input and a
 * spent rate limit included — the same split `@ultimat3/action`'s `auditOutcomeFor` makes, and
 * TOTAL for the same reason: `instanceof` runs a `Proxy`'s trap, and a probe that threw inside
 * this `catch` would replace the caller's error with its own.
 */
export function readOutcomeFor(error: unknown): AuditOutcome {
  try {
    return error instanceof QueryDeniedError ? 'denied' : 'failed';
  } catch {
    return 'failed';
  }
}

function recordOf(audit: ReadAudit, at: Date, outcome: AuditOutcome, error: unknown): AuditRecord {
  return {
    at,
    name: audit.name,
    // The deprecated alias, written with the same value until 25.0.0 removes it (plan 101, M9).
    action: audit.name,
    primitive: 'query',
    mutator: false,
    surface: audit.surface,
    ctx: audit.ctx,
    // The PARSED input, exactly as an action's record carries it — never the raw payload, and
    // never the rows: a sink that persists redacts through `auditableInput`, the walk core's
    // credential table and `Secret` decide, and a result is absent from the record by design.
    input: audit.trace.input,
    idempotencyKey: null,
    replayed: audit.trace.replayed,
    outcome,
    failure:
      outcome === 'allowed' ? null : { code: isUltimateError(error) ? error.code : null, error },
  };
}

async function recordSettled(sink: AuditSink, record: AuditRecord): Promise<void> {
  try {
    await sink.write(record);
  } catch (error) {
    throw new QueryAuditSinkFailedError(normalizeAuditRecord(record).name, error);
  }
}

async function recordThrew(sink: AuditSink, record: AuditRecord): Promise<void> {
  try {
    await sink.write(record);
  } catch (error) {
    // The same line `@ultimat3/action` writes, so `audit.sink.failed` is one alert rule over every
    // audited primitive. Never the record: rendering an input the sink just choked on is the
    // second throw this branch exists to prevent.
    logger.error('audit.sink.failed', {
      query: normalizeAuditRecord(record).name,
      outcome: record.outcome,
      error,
    });
  }
}
