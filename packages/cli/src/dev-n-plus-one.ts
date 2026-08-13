// The N+1 ledger: one count per statement shape per request, and a verdict once a shape crosses
// the threshold. Counting state hangs off the request's own `Ctx` in a `WeakMap`, so it is
// collected with the request and never swept. Installed by `x dev` and by nothing else — a
// production process pays the one `undefined` branch `@ultimat3/db`'s seam already costs (axiom 6).
// It counts and it warns once; what a verdict *means* — which code, which `fix:` — is
// `statement-loop.ts`'s, so all four surfaces read one answer.

import type { Ctx } from '@ultimat3/core';
import { assert, tryUseContext } from '@ultimat3/core';
import type { StatementAttribution, StatementEvent, StatementObserver } from '@ultimat3/db';
import { statementFingerprint, statementKind } from '@ultimat3/db';
import { N_PLUS_ONE_THRESHOLD } from '@ultimat3/entity';
import { loopFacts, warnLoop } from './statement-loop';

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
  /**
   * The same verdicts, for one request. What the browser overlay shows next to an error: a page
   * that looped names its loop on the page, not only in a terminal the author is not looking at.
   */
  repeatsFor(ctx: Ctx): readonly RepeatedStatement[];
  reset(): void;
}

export interface StatementLedgerOptions {
  /**
   * Statements of one shape in one request that trip a verdict. Defaults to
   * `N_PLUS_ONE_THRESHOLD` — `@ultimat3/entity`'s, so this ledger and the strict test fixture
   * cannot disagree about how many of one shape is a loop.
   */
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
  /** Whether this shape is already a verdict. The flag, not the count, so a `threshold` of 1 works. */
  promoted: boolean;
}

/** The verdict a surface reads, without the bookkeeping the group keeps for the ledger itself. */
const snapshot = (group: RepeatGroup): RepeatedStatement => ({
  fingerprint: group.fingerprint,
  kind: group.kind,
  attribution: group.attribution,
  sample: group.sample,
  count: group.count,
  requestId: group.requestId,
  traceId: group.traceId,
});

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
 *
 * Promotion is also the moment the log line goes out, and it is **one line per request per code**:
 * a request that loops three different shapes of read has three verdicts and one `X_N_PLUS_ONE_QUERY`
 * warning, because a log is read to learn that this request looped and the three shapes are what
 * `x dev`'s findings, `/_x` and the overlay are for. The line names the count as it stood when the
 * threshold was crossed; every other surface reads the count as it stands when asked.
 */
export function createStatementLedger(options: StatementLedgerOptions = {}): StatementLedger {
  const threshold = options.threshold ?? N_PLUS_ONE_THRESHOLD;
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
  // Which codes this request has already warned about. Its own map rather than a field on the
  // groups: the rule is one line per *code*, and the groups are per shape — three shapes of read
  // in one request share one warning and each keeps its own verdict.
  const warned = new WeakMap<Ctx, Set<string>>();
  const reported: RepeatGroup[] = [];

  const warnOnce = (ctx: Ctx, group: RepeatGroup): void => {
    const facts = loopFacts(snapshot(group));
    let codes = warned.get(ctx);
    if (codes === undefined) {
      codes = new Set();
      warned.set(ctx, codes);
    }
    if (codes.has(facts.code)) return;
    codes.add(facts.code);
    warnLoop(facts);
  };

  const onStatement = (event: StatementEvent): void => {
    if (event.expected !== undefined) return;
    const ctx = tryUseContext();
    if (ctx === undefined) return;
    let groups = byRequest.get(ctx);
    if (groups === undefined) {
      groups = new Map();
      byRequest.set(ctx, groups);
    }
    const fingerprint = statementFingerprint(event);
    let group = groups.get(fingerprint);
    if (group === undefined) {
      group = {
        fingerprint,
        kind: statementKind(event.text),
        attribution: event.attribution,
        sample: event.text,
        requestId: ctx.requestId,
        traceId: ctx.traceId,
        count: 0,
        promoted: false,
      };
      groups.set(fingerprint, group);
    }
    // A statement that threw is still a statement: fifty identical timeouts are still a loop, and
    // one that reports them as four is a loop nobody is told about.
    group.count += 1;
    if (group.promoted || group.count < threshold) return;
    group.promoted = true;
    reported.push(group);
    if (reported.length > limit) reported.shift();
    warnOnce(ctx, group);
  };

  return {
    observer: { onStatement },
    repeats(): readonly RepeatedStatement[] {
      // Snapshotted, because the groups behind these are still counting — and newest first,
      // matching the trace recorder: the loop that just happened is the one being looked at.
      return reported.map(snapshot).reverse();
    },
    repeatsFor(ctx: Ctx): readonly RepeatedStatement[] {
      // Read off this request's own tally rather than filtered out of `reported`, so a verdict the
      // bound already dropped is still shown on the page it happened on.
      const groups = byRequest.get(ctx);
      if (groups === undefined) return [];
      return [...groups.values()].filter((group) => group.promoted).map(snapshot);
    },
    reset(): void {
      reported.length = 0;
    },
  };
}
