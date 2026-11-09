// The `statements` fixture: every statement the test issues, counted by shape — and a shape that
// repeats past the threshold is a verdict raised when the fixture is disposed, so an N+1 fails the
// test that caused it instead of warning in a dev server nobody is watching.
//
// Both drivers report here: Postgres per statement, `memoryRepo` per repository operation, so a
// loop in a unit test on the in-memory driver is the same verdict under the same `entity.op`.
//
// Strict by construction: there is no `strict: true` to remember, because a fixture nobody
// destructured is a fixture nobody built. Opting in is naming `statements` in the test body.

import type { DbStatementEvent, StatementAttribution } from '@ultimat3/core';
import { captureStatementStacks, subscribe, type UltimateError } from '@ultimat3/core';

/** One statement, as this fixture kept it. Bound values are deliberately not retained. */
export interface ObservedStatement {
  /** What it is counted under: `members.findById` when attributed, else its own collapsed text. */
  readonly fingerprint: string;
  readonly kind: 'read' | 'write';
  /** The statement as sent, parameters still `$1..$n`. The memory driver sends none: its label. */
  readonly text: string;
  /** The entity and operation that compiled it; absent for hand-written SQL and queue traffic. */
  readonly attribution?: StatementAttribution | undefined;
  /** The `expectedQueryLoop()` reason in force when it was sent, absent outside every such scope. */
  readonly expected?: string | undefined;
}

/** One shape and how often the test issued it. */
export interface StatementShape {
  readonly fingerprint: string;
  readonly kind: 'read' | 'write';
  /** Every statement of this shape, expected ones included — this half measures, it never judges. */
  readonly count: number;
}

/**
 * `Disposable`: disposal unsubscribes from the bus and THROWS the first verdict, so the test fails
 * at its own teardown. `verdicts()` reads them before that.
 */
export interface TestStatements extends Disposable {
  /** Every N+1 verdict so far — one `X_N_PLUS_ONE_QUERY`/`_WRITE` per shape, in the order crossed. */
  verdicts(): readonly UltimateError[];
  /** Every statement issued since the fixture was built, in order. */
  all(): readonly ObservedStatement[];
  /** How many of one shape, or of everything when asked with no fingerprint. */
  count(fingerprint?: string): number;
  /** Shapes seen, most repeated first, ties by fingerprint — a stable list to assert against. */
  shapes(): readonly StatementShape[];
}

/** The live tally behind a `StatementShape`: what it measures, and what it judges. */
interface ShapeTally {
  readonly fingerprint: string;
  readonly kind: 'read' | 'write';
  /** Every statement of this shape. */
  count: number;
  /** The ones no `expectedQueryLoop()` scope covered — the only ones a verdict may count. */
  unexpected: number;
  /** Whether this shape already has its verdict. The flag, not the count: one verdict per shape. */
  failed: boolean;
}

/**
 * Install the strict detector for the length of one test.
 *
 * Three rules, each load-bearing and each different from `x dev`'s ledger for a stated reason.
 *
 * **The unit of work is the test, not the request.** The ledger keys its tally on the `Ctx` object
 * and ignores a statement issued outside a request; a unit test calls `posts.findById(id)` with no
 * request anywhere, which is exactly the loop it was written to catch — so this counts every
 * statement from the moment the fixture is built until it is disposed, whatever context it was
 * issued in.
 *
 * **The verdict counts only unexpected statements, the measurements count all of them.** An
 * `expectedQueryLoop(reason, fn)` scope is the one way to declare a loop deliberate (there is no
 * flag here and no second suppression), and it suppresses the *verdict* — the statements are still
 * sent, still observed, and still reported by `count()` and `shapes()`, because a test asserting
 * "this page issues two statements" must not see a different number depending on who declared what.
 *
 * **The verdict is raised at disposal, once per shape.** A `db.statement` subscriber's throw is
 * CONTAINED by the bus — an observer can never fail the work it observes — so the fixture records
 * the `X_N_PLUS_ONE_*` error when a shape crosses the threshold and throws the first one when it is
 * disposed (`using`, or the registered fixture's teardown). The loop runs to its end and every
 * statement is counted; a body that swallows every error cannot swallow this one, because it is
 * raised after the body. The error names the shape and its count, which is what points at the loop.
 *
 * The threshold is `@ultimat3/entity`'s `N_PLUS_ONE_THRESHOLD` and there is no knob: a loop that
 * fails a test and a loop that warns in `x dev` have to be the same loop.
 */
export async function testStatements(): Promise<TestStatements> {
  // Imported on demand, like every other fixture factory here: a `packages/core` test that never
  // names `statements` must not load the database layer or the entity registry to run.
  const db = await import('@ultimat3/db');
  const { N_PLUS_ONE_THRESHOLD, nPlusOne } = await import('@ultimat3/entity');
  const seen: ObservedStatement[] = [];
  const verdicts: UltimateError[] = [];
  let disposed = false;
  const tallies = new Map<string, ShapeTally>();

  const onStatement = (event: DbStatementEvent): void => {
    const fingerprint = db.statementFingerprint(event);
    const kind = db.statementKind(event.text);
    seen.push({
      fingerprint,
      kind,
      text: event.text,
      attribution: event.attribution,
      expected: event.expected,
    });
    let tally = tallies.get(fingerprint);
    if (tally === undefined) {
      tally = { fingerprint, kind, count: 0, unexpected: 0, failed: false };
      tallies.set(fingerprint, tally);
    }
    tally.count += 1;
    if (event.expected !== undefined) return;
    // A statement that threw is still a statement: fifty identical timeouts are still a loop.
    tally.unexpected += 1;
    if (tally.failed || tally.unexpected < N_PLUS_ONE_THRESHOLD) return;
    tally.failed = true;
    // `@ultimat3/entity`'s error, never one composed here: the `fix:` names the `preload` the
    // schema's own relations spell, and a second answer to "what ends this loop" would be one
    // the schema never agreed to.
    const verdict = nPlusOne({
      kind,
      subject: fingerprint,
      count: tally.unexpected,
      entity: event.attribution?.entity,
      op: event.attribution?.op,
    });
    // The stack the crossing statement was SENT from, not this subscriber's: an awaited driver
    // resumes with no caller frames, so only the funnel's capture names the looping line.
    if (event.callerStack !== undefined) {
      const frames = event.callerStack.split('\n').slice(1).join('\n');
      verdict.stack = `${verdict.name}: ${verdict.message}\n${frames}`;
    }
    verdicts.push(verdict);
  };
  // A subscriber on the bus, beside any outer one (`x dev`'s ledger, a harness) — never displacing
  // it, and released at dispose. It never throws: the bus would contain it.
  const unsubscribe = subscribe('db.statement', (event) => onStatement(event.payload));
  // For the fixture's lifetime only: a stack per statement is cost production never pays.
  const releaseStacks = captureStatementStacks();

  return {
    all: (): readonly ObservedStatement[] => [...seen],
    count: (fingerprint?: string): number =>
      fingerprint === undefined ? seen.length : (tallies.get(fingerprint)?.count ?? 0),
    shapes: (): readonly StatementShape[] =>
      [...tallies.values()]
        .map(({ fingerprint, kind, count }) => ({ fingerprint, kind, count }))
        .sort((left, right) =>
          left.count === right.count
            ? left.fingerprint.localeCompare(right.fingerprint)
            : right.count - left.count,
        ),
    verdicts: (): readonly UltimateError[] => [...verdicts],
    [Symbol.dispose]: (): void => {
      unsubscribe();
      releaseStacks();
      // Once: an explicit dispose inside a `using` scope must not raise the same verdict twice.
      if (disposed) return;
      disposed = true;
      const [first] = verdicts;
      if (first !== undefined) throw first;
    },
  };
}
