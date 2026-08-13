// The N+1 ledger: one count per statement shape per request, and a verdict once a shape crosses
// the threshold. Counting state hangs off the request's own `Ctx` in a `WeakMap`, so it is
// collected with the request and never swept. Installed by `x dev` and by nothing else — a
// production process pays the one `undefined` branch `@ultimat3/db`'s seam already costs (axiom 6).

import type { Ctx } from '@ultimat3/core';
import { assert, tryUseContext } from '@ultimat3/core';
import type { StatementAttribution, StatementEvent, StatementObserver } from '@ultimat3/db';

/**
 * Statements of one shape in one request before the loop is worth reporting. Five, because a page
 * that reads the same shape four times is a page with four reads and one that reads it fifty times
 * is a loop over rows — and the threshold has to sit far enough above the first number that a
 * fixed-arity render never trips it.
 */
export const DEFAULT_REPEAT_THRESHOLD = 5;

/** Verdicts retained. A dev diagnostic shows the recent loops; it does not page through history. */
const DEFAULT_LIMIT = 50;

/** One statement shape, repeated inside one request past the threshold. */
export interface RepeatedStatement {
  /** What was repeated: `members.findById` when attributed, else the statement's own text. */
  readonly fingerprint: string;
  /** Which loop this is, and therefore which fix a report can name. */
  readonly kind: 'read' | 'write';
  /** The entity and operation that compiled it, absent for hand-written SQL and queue traffic. */
  readonly attribution?: StatementAttribution | undefined;
  /** One of the statements, verbatim — the SQL a report shows under the fingerprint. */
  readonly sample: string;
  /** Statements of this shape the request has issued so far. Never below the threshold. */
  readonly count: number;
  /** The request the loop happened in; a report and its log line name the same one. */
  readonly requestId: string;
  readonly traceId: string;
}

export interface StatementLedger {
  /** Hand this to `setStatementObserver()`. */
  readonly observer: StatementObserver;
  /** Shapes that crossed the threshold, newest first. */
  repeats(): readonly RepeatedStatement[];
  reset(): void;
}

export interface StatementLedgerOptions {
  /** Statements of one shape in one request that trip a verdict. Default `5`. */
  readonly threshold?: number;
  /** Verdicts retained before the oldest is dropped. Default `50`. */
  readonly limit?: number;
}

/** The live count behind a `RepeatedStatement`: reported once, then still counting. */
interface RepeatGroup {
  readonly fingerprint: string;
  readonly kind: 'read' | 'write';
  readonly attribution: StatementAttribution | undefined;
  readonly sample: string;
  readonly requestId: string;
  readonly traceId: string;
  count: number;
}

const WHITESPACE = /\s+/g;
const LEADING_WORD = /^[A-Za-z]+/;

/**
 * The verbs that make a statement a write. A set of verbs and not a set of repository operations:
 * a soft delete is an `update`, an op list would drift with `@ultimat3/entity`'s method names, and
 * hand-written SQL carries no operation at all.
 */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'insert',
  'update',
  'delete',
  'upsert',
  'merge',
  'truncate',
  'copy',
]);

/**
 * The identity a loop repeats. An attributed statement groups by `entity.op`, because
 * `members.findById` fifty times is the report an author can act on and the SQL is one sample of
 * it — which is the whole reason `withStatementAttribution` exists. Everything else groups by its
 * own text, already `$n`-parameterized by `sql()`, with whitespace collapsed so a builder that
 * indents differently between two calls is still one shape rather than two.
 */
function fingerprintOf(event: StatementEvent): string {
  const attribution = event.attribution;
  if (attribution !== undefined) return `${attribution.entity}.${attribution.op}`;
  return event.text.replace(WHITESPACE, ' ').trim();
}

/**
 * Read or write, decided from the statement rather than from the operation above it, for the same
 * reason `statementSpanName` reads the verb: it is the one fact every statement carries, attributed
 * or not. A statement opening with a CTE reads as a read — naming `insertAll` in a fix for a loop
 * of `with … select` would be wrong more often than naming `preload` for a loop that writes.
 */
function kindOf(text: string): 'read' | 'write' {
  const verb = LEADING_WORD.exec(text.trimStart())?.[0]?.toLowerCase() ?? '';
  return WRITE_VERBS.has(verb) ? 'write' : 'read';
}

/**
 * Count statement shapes per request and report the ones that repeat past `threshold`.
 *
 * Three rules, each load-bearing. **Per request, keyed by the context object** — the map dies with
 * the `Ctx` that owns it, so a dev server up for a week accumulates nothing and no sweep has to
 * decide when a request ended. A statement issued outside a request (a migration, a boot probe, a
 * script) is not counted at all: "five of one shape" only means something inside one unit of work.
 * A `withChildContext` scope is its own key and therefore its own tally, which is the price of
 * keying on identity rather than on `requestId` and holding the counts forever.
 *
 * **An expected statement is not counted** — `expectedQueryLoop` suppresses a verdict, and this
 * ledger *is* the verdict. The statement is still sent, still observed and still a span, so the
 * timeline keeps showing the loop while the thing that warns is told the author already answered.
 *
 * **A shape is promoted exactly once**, on the statement that crosses the threshold, and the group
 * behind it keeps counting — so a loop of fifty is one verdict reading `count: 50`, not
 * forty-six verdicts. The report list is bounded and drops its oldest entry.
 */
export function createStatementLedger(options: StatementLedgerOptions = {}): StatementLedger {
  const threshold = options.threshold ?? DEFAULT_REPEAT_THRESHOLD;
  const limit = options.limit ?? DEFAULT_LIMIT;
  assert(
    Number.isInteger(threshold) && threshold >= 1,
    `createStatementLedger() was given a threshold of ${threshold}, which no statement count can reach`,
    'pass a whole number of statements: createStatementLedger({ threshold: 5 })',
  );
  assert(
    Number.isInteger(limit) && limit >= 1,
    `createStatementLedger() was given a limit of ${limit}, so no verdict could be kept`,
    'pass how many verdicts to retain: createStatementLedger({ limit: 50 })',
  );
  const byRequest = new WeakMap<Ctx, Map<string, RepeatGroup>>();
  const reported: RepeatGroup[] = [];

  const onStatement = (event: StatementEvent): void => {
    if (event.expected !== undefined) return;
    const ctx = tryUseContext();
    if (ctx === undefined) return;
    let groups = byRequest.get(ctx);
    if (groups === undefined) {
      groups = new Map();
      byRequest.set(ctx, groups);
    }
    const fingerprint = fingerprintOf(event);
    let group = groups.get(fingerprint);
    if (group === undefined) {
      group = {
        fingerprint,
        kind: kindOf(event.text),
        attribution: event.attribution,
        sample: event.text,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        count: 0,
      };
      groups.set(fingerprint, group);
    }
    // A statement that threw is still a statement: fifty identical timeouts are still a loop, and
    // one that reports them as four is a loop nobody is told about.
    group.count += 1;
    if (group.count !== threshold) return;
    reported.push(group);
    if (reported.length > limit) reported.shift();
  };

  return {
    observer: { onStatement },
    repeats(): readonly RepeatedStatement[] {
      // Snapshotted, because the groups behind these are still counting — and newest first,
      // matching the trace recorder: the loop that just happened is the one being looked at.
      return reported.map((group) => ({ ...group })).reverse();
    },
    reset(): void {
      reported.length = 0;
    },
  };
}
