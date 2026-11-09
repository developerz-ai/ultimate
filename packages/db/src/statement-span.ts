// Single responsibility: what one statement is to the rest of the process — a `db.<verb>` client
// span carrying OTel's stable database attributes, opened for EVERY statement (production has DB
// spans, not only `x dev`), and one `db.statement` event on the instrumentation bus once it has
// settled. Both drivers' funnels (`statement-funnel.ts`, `pglite.ts`) call `traceStatement` and
// nothing else, so the two cannot answer differently for the same statement.

import { instrument, SEMCONV, SEMCONV_VALUES, subscribed, withSpan } from '@ultimat3/core';
import { statementAttribution } from './attribution';
import { expectedQueryLoopReason } from './expected-loop';
import type { SqlFragment } from './sql';
import { statementVerb } from './statement-shape';

/**
 * `db.select`, `db.insert`, `db.begin` — low cardinality on purpose, so the flame reads at a glance
 * and a trace backend can still aggregate by name. `x dev`'s recorder reads the panel's kind off
 * the `db.` prefix. The full text rides on the span as `db.query.text`, never in its name.
 *
 * The verb is `statement-shape.ts`'s, the same read the N+1 detectors classify a statement with: a
 * text with no leading word is `db.statement` here and a read there, one scanner and two labels.
 */
export function statementSpanName(text: string): string {
  const verb = statementVerb(text);
  return `db.${verb === '' ? 'statement' : verb}`;
}

/**
 * Wraps the send, so the span's duration is the statement's and a failure is recorded on it rather
 * than inferred from the gap after it. `client` is the OTel kind (`INSTRUMENT_EVENTS`) — the
 * database is the remote peer. The text is parameterised (`$1..$n`); bound values never ride a
 * span. `db.collection.name` is not set: naming the table would need a second SQL reading.
 */
export function withStatementSpan<T>(text: string, send: () => Promise<T>): Promise<T> {
  const verb = statementVerb(text);
  return withSpan(statementSpanName(text), send, {
    kind: 'client',
    attributes: {
      [SEMCONV.dbSystemName]: SEMCONV_VALUES.dbSystemPostgres,
      [SEMCONV.dbQueryText]: text,
      ...(verb === '' ? {} : { [SEMCONV.dbOperationName]: verb.toUpperCase() }),
    },
  });
}

/**
 * The funnel's shell: the span always, the `db.statement` event only while somebody subscribes. A
 * production boot always has one — `subscribeSemconvMetrics` records the duration histogram — so a
 * statement there costs a clock read, a scope read, one event object and one histogram record;
 * with no subscriber at all it is one map read (axiom 6).
 *
 * A subscriber's throw is contained by the bus and never reaches the caller. The success-path emit
 * still sits OUTSIDE the `try`, so no emit could ever report a statement that succeeded as failed.
 */
export async function traceStatement<R>(
  fragment: SqlFragment,
  send: () => Promise<R>,
  rows: (result: R) => number,
  /**
   * `callerStack()` read at the funnel's ENTRY, before any queue or pool `await` — undefined, and
   * nothing built, unless a holder turned `captureStatementStacks()` on (never production).
   */
  callerStack: string | undefined,
): Promise<R> {
  if (!subscribed('db.statement')) return withStatementSpan(fragment.text, send);
  // Read here, not by the subscriber: the scopes are gone by the time a per-request detector
  // judges what it collected, so the reason and the attribution travel with the statement.
  const expected = expectedQueryLoopReason();
  const attribution = statementAttribution();
  const started = performance.now();
  let result: R;
  try {
    result = await withStatementSpan(fragment.text, send);
  } catch (error) {
    // A failed statement is still a statement: fifty identical timeouts are an N+1 of timeouts.
    instrument('db.statement', {
      text: fragment.text,
      values: fragment.values,
      durationMs: performance.now() - started,
      rows: 0,
      error,
      attribution,
      expected,
      callerStack,
    });
    throw error;
  }
  instrument('db.statement', {
    text: fragment.text,
    values: fragment.values,
    durationMs: performance.now() - started,
    rows: rows(result),
    attribution,
    expected,
    callerStack,
  });
  return result;
}
